import { ChannelType } from 'discord.js';
import type { Client } from 'discord.js';
import type { AppContext } from '../types.js';
import { dbGetJobState, dbInsertWarHistoryIfMissing, dbSetJobState } from '../db.js';
import { renderWarLogsEmbedsForSnapshot } from '../discord/warstats.js';
import { getZonedYmdHm, parseTimeOfDayWithTimeZone } from '../time.js';

type ParticipantSnapshot = {
  decksUsed?: number;
  decksUsedToday?: number;
  fame?: number;
  repairs?: number;
  boatAttacks?: number;
  name?: string;
};

type WarDaySnapshotHistoryEntry = {
  key: string;
  endRaw: string;
  endAtIso: string;
  capturedAtIso: string;
  periodType?: string;
  dayIndex?: number;
  snapshot: Record<string, ParticipantSnapshot>;
};

// Snapshot strategy: capture minute snapshots and post the final snapshot when a
// period change is detected (rollover). No timing-based scheduling.

function clampNonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function chunkLines(header: string, lines: string[], maxLen = 1900): string[] {
  const out: string[] = [];
  let cur = header;
  for (const line of lines) {
    if ((cur + '\n' + line).length > maxLen) {
      out.push(cur);
      cur = header + '\n' + line;
    } else {
      cur += '\n' + line;
    }
  }
  out.push(cur);
  return out;
}

function chunkEmbedDescriptions(lines: string[], maxLen = 3900): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of lines) {
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > maxLen) {
      if (cur) out.push(cur);
      cur = line;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function safeNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function normalizeTagUpper(raw: unknown): string | undefined {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return undefined;
  const up = s.toUpperCase();
  return up.startsWith('#') ? up : `#${up}`;
}

function pickMaxNumber(obj: any, keys: string[]): number | undefined {
  let best: number | undefined;
  for (const k of keys) {
    const v = obj?.[k];
    const n = safeNumber(v);
    if (n === undefined) continue;
    best = best === undefined ? n : Math.max(best, n);
  }
  return best;
}

function extractParticipants(payload: any): Map<string, ParticipantSnapshot> {
  // Clash payload shape varies a bit; we try common fields.
  const participants = payload?.clan?.participants;
  if (!Array.isArray(participants)) return new Map();

  const out = new Map<string, ParticipantSnapshot>();
  for (const p of participants) {
    const tag = normalizeTagUpper(p?.tag ?? p?.playerTag ?? p?.memberTag);
    if (!tag) continue;

    const decksUsedToday = pickMaxNumber(p, [
      'decksUsedToday',
      'decksUsedThisDay',
      'decksUsedInDay',
      'decksUsedThisPeriodToday',
    ]);

    const decksUsedOverall = pickMaxNumber(p, [
      'decksUsedThisPeriod',
      'decksUsedInPeriod',
      'decksUsed',
      'decksUsedThisSection',
      'decksUsedInSection',
    ]);

    out.set(tag, {
      decksUsed: decksUsedOverall ?? decksUsedToday,
      decksUsedToday,
      fame: pickMaxNumber(p, ['fame', 'fameToday', 'currentFame']),
      repairs: pickMaxNumber(p, ['repairs', 'repairsToday', 'repairPoints', 'repairPointsToday']),
      boatAttacks: pickMaxNumber(p, ['boatAttacks', 'boatAttacksToday']),
      name: typeof p?.name === 'string' && p.name.trim() ? p.name.trim() : undefined,
    });
  }
  return out;
}

function toLocalDateTimeLabel(d: Date): string {
  try {
    return d.toLocaleString(undefined, { timeZoneName: 'short' });
  } catch {
    return d.toISOString();
  }
}

function currentPeriodKey(payload: any, participants?: Map<string, ParticipantSnapshot>): string {
  const periodTypeRaw = typeof payload?.periodType === 'string' ? payload.periodType : undefined;
  const periodType = periodTypeRaw?.trim().toLowerCase() || 'unknown';
  const sectionIndex = toFiniteInt(payload?.sectionIndex);
  const directDayIndex = toFiniteInt(payload?.dayIndex) ?? toFiniteInt(payload?.warDay);
  const inferredDayIndex =
    directDayIndex === undefined && participants
      ? inferWarDayIndex(payload, participants)
      : undefined;
  const dayIndex = directDayIndex ?? inferredDayIndex;
  // Keep this stable across payload variants while still changing when the day changes.
  return `${periodType}:${sectionIndex ?? 'na'}:${dayIndex ?? 'na'}`;
}

function serializeParticipants(
  current: Map<string, ParticipantSnapshot>,
): Record<string, ParticipantSnapshot> {
  const serialized: Record<string, ParticipantSnapshot> = {};
  for (const [tag, snap] of current.entries()) {
    const norm = normalizeTagUpper(tag);
    if (norm) serialized[norm] = snap;
  }
  return serialized;
}

async function postWarDaySnapshotFromCaptured(
  ctx: AppContext,
  client: Client,
  args: {
    key: string;
    endAt: Date;
    payload: any;
    current: Map<string, ParticipantSnapshot>;
  },
) {
  const { key, endAt, payload, current } = args;

  const snapshotKey = `war:day_snapshot:last_key`;
  const prevKey = dbGetJobState(ctx.db, snapshotKey);
  if (prevKey === key) return;

  const guild = await client.guilds.fetch(ctx.cfg.GUILD_ID);
  const channel = await guild.channels.fetch(ctx.cfg.CHANNEL_WAR_LOGS_ID);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  if (!isRegularWarBattleDay(payload)) return;

  const roster = await ctx.clash.getClanMembers(ctx.cfg.CLASH_CLAN_TAG).catch(() => []);
  const log = await ctx.clash.getRiverRaceLog(ctx.cfg.CLASH_CLAN_TAG).catch(() => null);
  const snapshot = serializeParticipants(current);
  const payloadDayIndex = inferWarDayIndex(payload, current);
  const periodType = typeof payload?.periodType === 'string' ? payload.periodType : undefined;

  const render = await renderWarLogsEmbedsForSnapshot(
    ctx,
    {
      payload,
      log,
      roster,
      snapshot,
      snapshotEndAt: endAt,
      warDayIndex: payloadDayIndex,
      periodType,
    },
    { includeRecord: false },
  );

  if (!render.ok) {
    // Fail softly; this should never block future snapshots.
    const msg = render.errorEmbeds?.[0] ? 'War logs unavailable' : 'War logs unavailable';
    await channel.send({ content: msg }).catch(() => undefined);
  } else {
    const filteredFirst = (render.firstEmbeds ?? []).filter((e) => {
      try {
        const title = (e as any)?.toJSON?.()?.title ?? '';
        return String(title) !== 'War Overview';
      } catch {
        return true;
      }
    });

    if (filteredFirst.length) {
      await channel.send({ embeds: filteredFirst }).catch(() => undefined);
    }
    for (const e of render.continuationEmbeds) {
      await channel.send({ embeds: [e] }).catch(() => undefined);
    }
  }

  const serialized = serializeParticipants(current);
  dbSetJobState(ctx.db, 'war:day_snapshot:last_snapshot', JSON.stringify(serialized));
  dbSetJobState(ctx.db, snapshotKey, key);

  appendSnapshotHistory(ctx, {
    key,
    endRaw: endAt.toISOString(),
    endAtIso: endAt.toISOString(),
    capturedAtIso: new Date().toISOString(),
    periodType,
    dayIndex: payloadDayIndex,
    snapshot: serialized,
  });
}

async function maybePostSnapshotOnPeriodChange(
  ctx: AppContext,
  client: Client,
  payload: any,
  current: Map<string, ParticipantSnapshot>,
) {
  const keyNow = currentPeriodKey(payload, current);
  const lastKey = dbGetJobState(ctx.db, 'war:period:last_key');
  const lastCaptureRaw = dbGetJobState(ctx.db, 'war:period:last_capture');

  if (lastKey && lastKey !== keyNow && lastCaptureRaw) {
    try {
      const parsed = JSON.parse(lastCaptureRaw) as {
        capturedAtIso: string;
        periodKey: string;
        periodType?: string;
        sectionIndex?: number;
        payload?: any;
        snapshot: Record<string, ParticipantSnapshot>;
      };
      const capturedAt = new Date(String(parsed.capturedAtIso));
      if (Number.isFinite(capturedAt.getTime()) && parsed.snapshot && parsed.periodKey) {
        const prevMap = new Map<string, ParticipantSnapshot>();
        for (const [tag, snap] of Object.entries(parsed.snapshot)) {
          const norm = normalizeTagUpper(tag);
          if (norm) prevMap.set(norm, snap ?? {});
        }

        const prevPayload = parsed.payload ?? {
          periodType: parsed.periodType,
          sectionIndex: parsed.sectionIndex,
        };

        // Guard: during upgrades, older versions stored period keys without a day index (":na").
        // When we introduce inferred-day keys, we can observe a synthetic "period change" even though
        // we haven't actually crossed a real day boundary. Avoid posting a bogus snapshot in that case.
        const prevDay = inferWarDayIndex(prevPayload, prevMap);
        const nowDay = inferWarDayIndex(payload, current);
        const prevSection = toFiniteInt((prevPayload as any)?.sectionIndex);
        const nowSection = toFiniteInt(payload?.sectionIndex);
        const prevPt =
          typeof (prevPayload as any)?.periodType === 'string'
            ? String((prevPayload as any).periodType)
                .trim()
                .toLowerCase()
            : typeof parsed.periodType === 'string'
              ? String(parsed.periodType).trim().toLowerCase()
              : undefined;
        const nowPt =
          typeof payload?.periodType === 'string'
            ? payload.periodType.trim().toLowerCase()
            : undefined;

        const isKeyMigrationOnly =
          String(lastKey).endsWith(':na') &&
          prevDay !== undefined &&
          nowDay !== undefined &&
          prevDay === nowDay &&
          (prevSection ?? 'na') === (nowSection ?? 'na') &&
          (prevPt ?? 'na') === (nowPt ?? 'na');

        if (isKeyMigrationOnly) {
          console.log(
            `[war] Period key changed due to inferred-day upgrade (${String(lastKey)} -> ${keyNow}); skipping snapshot post (still dayIndex=${nowDay}).`,
          );
        } else {
          const snapshotKey = `warDay:${parsed.periodKey}`;
          console.log(
            `[war] Period changed (${String(lastKey)} -> ${keyNow}); posting rollover snapshot for previous periodKey=${parsed.periodKey} atLocal=${toLocalDateTimeLabel(capturedAt)}`,
          );
          await postWarDaySnapshotFromCaptured(ctx, client, {
            key: snapshotKey,
            endAt: capturedAt,
            payload: prevPayload,
            current: prevMap,
          });
        }
      }
    } catch {
      // ignore
    }
  }

  // Persist current capture for the next rollover detection.
  const nowIso = new Date().toISOString();
  const capture = {
    capturedAtIso: nowIso,
    periodKey: keyNow,
    periodType: typeof payload?.periodType === 'string' ? payload.periodType : undefined,
    sectionIndex: toFiniteInt(payload?.sectionIndex),
    payload,
    snapshot: serializeParticipants(current),
  };
  dbSetJobState(ctx.db, 'war:period:last_key', keyNow);
  dbSetJobState(ctx.db, 'war:period:last_capture', JSON.stringify(capture));
}

function toFiniteInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}

function clampWarDayIndex(n: number | undefined): number | undefined {
  if (!Number.isFinite(n)) return undefined;
  const i = Math.trunc(n as number);
  if (i < 1 || i > 5) return undefined;
  return i;
}

function inferWarDayIndex(
  payload: any,
  participants: Map<string, ParticipantSnapshot>,
): number | undefined {
  const periodTypeRaw = typeof payload?.periodType === 'string' ? payload.periodType : undefined;
  const periodType = periodTypeRaw?.trim().toLowerCase();
  const stateRaw = typeof payload?.state === 'string' ? payload.state : undefined;
  const state = stateRaw?.trim().toLowerCase();

  // In some "colosseum" weeks, fields like dayIndex/sectionIndex are not a per-day index.
  // Infer the day from cumulative decks used instead.
  if (periodType === 'colosseum') {
    let maxTotal = 0;
    let maxToday = 0;
    let anyTodayObserved = false;
    for (const snap of participants.values()) {
      const total =
        typeof snap?.decksUsed === 'number' && Number.isFinite(snap.decksUsed) ? snap.decksUsed : 0;
      if (total > maxTotal) maxTotal = total;

      const todayDefined =
        typeof snap?.decksUsedToday === 'number' && Number.isFinite(snap.decksUsedToday);
      if (todayDefined) anyTodayObserved = true;
      const today = todayDefined ? (snap.decksUsedToday as number) : 0;
      if (today > maxToday) maxToday = today;
    }

    // Special case: immediately after daily reset, totals may still be exactly a multiple of 4,
    // while the per-day counter is 0. This lets us detect the new day *before* anyone uses a deck.
    const isResetBoundary =
      anyTodayObserved && maxToday === 0 && maxTotal > 0 && maxTotal % 4 === 0;
    const inferred = isResetBoundary
      ? Math.floor(maxTotal / 4) + 1
      : Math.max(1, Math.ceil((maxTotal || 1) / 4));
    return clampWarDayIndex(inferred);
  }

  const direct = toFiniteInt(payload?.dayIndex) ?? toFiniteInt(payload?.warDay);
  if (direct !== undefined) return clampWarDayIndex(direct);

  const sectionIndex = toFiniteInt(payload?.sectionIndex);
  if (sectionIndex !== undefined) {
    if (sectionIndex >= 1 && sectionIndex <= 5) return sectionIndex;

    const isWarBattlePeriod =
      periodType === 'warday' ||
      (!!periodType && periodType.includes('war') && periodType !== 'colosseum') ||
      (!periodType && state === 'warday');

    if (isWarBattlePeriod && sectionIndex >= 0 && sectionIndex <= 4) {
      return clampWarDayIndex(sectionIndex + 1);
    }
  }

  // No further inference for regular war days (avoid guessing from deck totals).
  return undefined;
}

function readSnapshotHistory(ctx: AppContext): WarDaySnapshotHistoryEntry[] {
  const raw = dbGetJobState(ctx.db, 'war:day_snapshot:history');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as WarDaySnapshotHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function writeSnapshotHistory(ctx: AppContext, entries: WarDaySnapshotHistoryEntry[]) {
  // Keep small and bounded (job_state row size is limited by SQLite page size).
  const MAX = 50;
  const trimmed = entries.slice(-MAX);
  dbSetJobState(ctx.db, 'war:day_snapshot:history', JSON.stringify(trimmed));
}

function appendSnapshotHistory(ctx: AppContext, entry: WarDaySnapshotHistoryEntry) {
  const entries = readSnapshotHistory(ctx);
  // De-dupe by key.
  const filtered = entries.filter((e) => e?.key !== entry.key);
  filtered.push(entry);
  writeSnapshotHistory(ctx, filtered);
}

// "Regular" river-race battle days are days 1-4 (not prep/training).
// The Clash payloads vary; we best-effort detect a day index.
function isRegularWarBattleDay(payload: any): boolean {
  const periodTypeRaw = typeof payload?.periodType === 'string' ? payload.periodType : undefined;
  const periodType = periodTypeRaw?.trim().toLowerCase();

  // Common fields seen across payload variants.
  const idx =
    toFiniteInt(payload?.dayIndex) ??
    toFiniteInt(payload?.warDay) ??
    toFiniteInt(payload?.sectionIndex);

  // If we have a clear battle-day index, trust it.
  // NOTE: some variants use a 5th day (colosseum).
  if (idx !== undefined) return idx >= 1 && idx <= 5;

  // Otherwise, fall back to periodType-based inference.
  if (periodType === 'warday' || periodType === 'colosseum') return true;
  if (periodType && periodType.includes('war') && !periodType.includes('train')) return true;

  // If we can't find an index, fall back to periodType alone.
  return false;
}

function buildWarKey(clanTagUpper: string, item: any): string {
  const seasonId = typeof item?.seasonId === 'number' ? item.seasonId : null;
  const sectionIndex = typeof item?.sectionIndex === 'number' ? item.sectionIndex : null;
  const createdDate = typeof item?.createdDate === 'string' ? item.createdDate : null;
  return `${clanTagUpper}:${seasonId ?? 'na'}:${sectionIndex ?? 'na'}:${createdDate ?? 'na'}`;
}

function extractOurRank(clanTagUpper: string, item: any): number | null {
  const standings: any[] = Array.isArray(item?.standings) ? item.standings : [];
  const ours = standings.find((s) => String(s?.clan?.tag ?? '').toUpperCase() === clanTagUpper);
  const rank = typeof ours?.rank === 'number' ? ours.rank : null;
  return rank;
}

async function ingestRiverRaceLog(ctx: AppContext) {
  const clanTagUpper = ctx.cfg.CLASH_CLAN_TAG.toUpperCase();
  const log = await ctx.clash.getRiverRaceLog(ctx.cfg.CLASH_CLAN_TAG);
  const items: any[] = Array.isArray(log?.items) ? log.items : [];
  for (const it of items) {
    const warKey = buildWarKey(clanTagUpper, it);
    const seasonId = typeof it?.seasonId === 'number' ? it.seasonId : null;
    const sectionIndex = typeof it?.sectionIndex === 'number' ? it.sectionIndex : null;
    const createdDate = typeof it?.createdDate === 'string' ? it.createdDate : null;
    const rank = extractOurRank(clanTagUpper, it);

    dbInsertWarHistoryIfMissing(ctx.db, {
      war_key: warKey,
      clan_tag: clanTagUpper,
      season_id: seasonId,
      section_index: sectionIndex,
      created_date: createdDate,
      rank,
      raw_json: JSON.stringify(it ?? {}),
    });
  }
}

// Called on startup to ensure the end-of-period snapshot is scheduled immediately
// (instead of waiting until the last minute cron tick).
export async function primeWarDaySnapshotSchedule(ctx: AppContext, client: Client) {
  const payload = await ctx.clash.getCurrentRiverRace(ctx.cfg.CLASH_CLAN_TAG);
  const current = extractParticipants(payload);
  const periodTypeRaw = typeof payload?.periodType === 'string' ? payload.periodType : undefined;
  const periodType = periodTypeRaw?.trim().toLowerCase();
  console.log(
    `[war] Startup: rollover mode enabled (periodType=${periodType ?? 'unknown'}). Will capture minute snapshots and post the final snapshot on detected period change.`,
  );
  await maybePostSnapshotOnPeriodChange(ctx, client, payload, current);
}

function diffSnapshots(
  prev: Map<string, ParticipantSnapshot>,
  next: Map<string, ParticipantSnapshot>,
) {
  const changes: Array<{ tag: string; before?: ParticipantSnapshot; after: ParticipantSnapshot }> =
    [];
  for (const [tag, after] of next.entries()) {
    const before = prev.get(tag);
    const changed =
      !before ||
      before.decksUsed !== after.decksUsed ||
      before.fame !== after.fame ||
      before.repairs !== after.repairs;

    if (changed) changes.push({ tag, before, after });
  }
  return changes;
}

export async function pollWarOnce(ctx: AppContext, client: Client) {
  const guild = await client.guilds.fetch(ctx.cfg.GUILD_ID);
  const channel = await guild.channels.fetch(ctx.cfg.CHANNEL_WAR_LOGS_ID);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const payload = await ctx.clash.getCurrentRiverRace(ctx.cfg.CLASH_CLAN_TAG);
  const periodType = typeof payload?.periodType === 'string' ? payload.periodType : undefined;
  const isBattleDay = isRegularWarBattleDay(payload);

  // Best-effort: keep an accumulated war history in SQLite.
  await ingestRiverRaceLog(ctx).catch(() => undefined);

  const next = extractParticipants(payload);

  // Always maintain a last-known snapshot so we can post an accurate "rollover"
  // snapshot even if the API doesn't give us an explicit end time.
  await maybePostSnapshotOnPeriodChange(ctx, client, payload, next);

  const prevRaw = dbGetJobState(ctx.db, 'war:last_participants');
  const prev = new Map<string, ParticipantSnapshot>();
  if (prevRaw) {
    try {
      const obj = JSON.parse(prevRaw) as Record<string, ParticipantSnapshot>;
      for (const [tag, snap] of Object.entries(obj)) {
        const norm = normalizeTagUpper(tag);
        if (norm) prev.set(norm, snap);
      }
    } catch {
      // ignore
    }
  }

  // Intentionally do NOT post minute-by-minute participation updates.
  // The war-logs channel should only receive the final snapshot per war day.

  // Persist next snapshot
  const serialized: Record<string, ParticipantSnapshot> = {};
  for (const [tag, snap] of next.entries()) {
    const norm = normalizeTagUpper(tag);
    if (norm) serialized[norm] = snap;
  }
  dbSetJobState(ctx.db, 'war:last_participants', JSON.stringify(serialized));

  // Announcements based on periodType changes.
  if (periodType) {
    const prevPeriod = dbGetJobState(ctx.db, 'war:last_period_type');
    if (prevPeriod !== periodType) {
      dbSetJobState(ctx.db, 'war:last_period_type', periodType);

      const ann = await guild.channels.fetch(ctx.cfg.CHANNEL_ANNOUNCEMENTS_ID);
      if (ann && ann.type === ChannelType.GuildText) {
        // Only announce the start of the regular war battle days (day 1).
        const idx = inferWarDayIndex(payload, next);

        if (prevPeriod && isBattleDay && (idx === undefined || idx === 1)) {
          await ann
            .send({
              content: '@everyone War day started — do your battles.',
              allowedMentions: { parse: ['everyone'] },
            })
            .catch(() => undefined);
        }
      }
    }
  }

  // Optional: time-based war-day reminder announcement.
  // Posts at the configured local time once per local date (in the specified timezone).
  if (ctx.cfg.WAR_DAY_NOTIFICATION_TIME) {
    const parsed = parseTimeOfDayWithTimeZone(ctx.cfg.WAR_DAY_NOTIFICATION_TIME);
    if (parsed.ok && isBattleDay) {
      const now = new Date();
      const zoned = getZonedYmdHm(now, parsed.value.timeZone);

      if (zoned.hour === parsed.value.hour && zoned.minute === parsed.value.minute) {
        const lastDateKey = 'war:war_day_notification:last_date';
        const lastDate = dbGetJobState(ctx.db, lastDateKey);
        if (lastDate !== zoned.ymd) {
          const ann = await guild.channels.fetch(ctx.cfg.CHANNEL_ANNOUNCEMENTS_ID);
          if (ann && ann.type === ChannelType.GuildText) {
            const idx = inferWarDayIndex(payload, next);
            const dayLabel = Number.isFinite(idx) ? ` (Day ${idx})` : '';
            await ann
              .send({
                content: `@everyone War reminder${dayLabel} — do your battles.`,
                allowedMentions: { parse: ['everyone'] },
              })
              .catch(() => undefined);
            dbSetJobState(ctx.db, lastDateKey, zoned.ymd);
            dbSetJobState(ctx.db, 'war:war_day_notification:last_sent_at', now.toISOString());
          }
        }
      }
    }
  }
}
