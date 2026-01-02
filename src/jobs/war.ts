import { ChannelType, EmbedBuilder } from 'discord.js';
import type { Client } from 'discord.js';
import type { AppContext } from '../types.js';
import { dbGetJobState, dbInsertWarHistoryIfMissing, dbSetJobState } from '../db.js';

type ParticipantSnapshot = {
  decksUsed?: number;
  fame?: number;
  repairs?: number;
  boatAttacks?: number;
  name?: string;
};

type WarDaySnapshotHistoryEntry = {
  key: string; // e.g. warDay:<periodEndTime>
  endRaw: string;
  endAtIso: string;
  capturedAtIso: string;
  periodType?: string;
  dayIndex?: number;
  snapshot: Record<string, ParticipantSnapshot>;
};

const scheduledWarDaySnapshots = new Map<string, NodeJS.Timeout>();

let currentWarEndpointState: 'unknown' | 'gone' | 'ok' = 'unknown';
let currentWarGoneLogged = false;

function isCurrentWarGoneError(err: unknown): boolean {
  const msg = typeof (err as any)?.message === 'string' ? (err as any).message : String(err);
  return (
    /Clash API error\s+410\s+Gone/i.test(msg) || /endpoint has been permanently removed/i.test(msg)
  );
}

async function tryGetCurrentWarEndTime(
  ctx: AppContext,
): Promise<{ raw?: string; at?: Date } | null> {
  if (currentWarEndpointState === 'gone') return null;

  try {
    const currentWar = await ctx.clash.getCurrentWar(ctx.cfg.CLASH_CLAN_TAG, { cacheBust: true });
    currentWarEndpointState = 'ok';
    const t = findWarEndTimeFromCurrentWar(currentWar);
    return t.raw && t.at ? t : null;
  } catch (err) {
    if (isCurrentWarGoneError(err)) {
      currentWarEndpointState = 'gone';
      if (!currentWarGoneLogged) {
        currentWarGoneLogged = true;
        console.log(
          '[war] Note: Clash removed /currentwar (410 Gone). End-time scheduling will rely on river race end fields when present, otherwise rollover snapshots.',
        );
      }
    }
    return null;
  }
}

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

    out.set(tag, {
      decksUsed: pickMaxNumber(p, [
        'decksUsed',
        'decksUsedToday',
        'decksUsedThisDay',
        'decksUsedThisPeriod',
        'decksUsedInPeriod',
        'decksUsedInDay',
      ]),
      fame: pickMaxNumber(p, ['fame', 'fameToday', 'currentFame']),
      repairs: pickMaxNumber(p, ['repairs', 'repairsToday', 'repairPoints', 'repairPointsToday']),
      boatAttacks: pickMaxNumber(p, ['boatAttacks', 'boatAttacksToday']),
      name: typeof p?.name === 'string' && p.name.trim() ? p.name.trim() : undefined,
    });
  }
  return out;
}

function parseClashApiTime(raw: unknown): Date | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;

  // Clash often uses e.g. 20240101T235959.000Z
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/);
  if (m) {
    const [, yy, mo, dd, hh, mm, ss] = m;
    const iso = `${yy}-${mo}-${dd}T${hh}:${mm}:${ss}Z`;
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

function findPeriodEndTime(payload: any): { raw?: string; at?: Date } {
  const raw =
    (typeof payload?.periodEndTime === 'string' && payload.periodEndTime) ||
    (typeof payload?.sectionEndTime === 'string' && payload.sectionEndTime) ||
    (typeof payload?.endTime === 'string' && payload.endTime) ||
    undefined;
  const at = parseClashApiTime(raw);
  return { raw, at: at ?? undefined };
}

function findWarEndTimeFromCurrentWar(payload: any): { raw?: string; at?: Date } {
  const raw =
    typeof payload?.warEndTime === 'string' && payload.warEndTime ? payload.warEndTime : undefined;
  const at = parseClashApiTime(raw);
  return { raw, at: at ?? undefined };
}

function formatDurationHhMm(ms: number): string {
  const totalSec = Math.max(0, Math.trunc(ms / 1000));
  const hh = Math.trunc(totalSec / 3600);
  const mm = Math.trunc((totalSec % 3600) / 60);
  return `${String(hh).padStart(2, '0')}h${String(mm).padStart(2, '0')}m`;
}

function toLocalDateTimeLabel(d: Date): string {
  try {
    return d.toLocaleString(undefined, { timeZoneName: 'short' });
  } catch {
    return d.toISOString();
  }
}

function inferEndAtFromLastSnapshotKey(ctx: AppContext, nowMs = Date.now()): Date | undefined {
  const prevKey = dbGetJobState(ctx.db, 'war:day_snapshot:last_key');
  if (!prevKey || typeof prevKey !== 'string') return undefined;
  const m = prevKey.match(/^warDay:(.+)$/);
  if (!m) return undefined;
  const prevAt = parseClashApiTime(m[1]);
  if (!prevAt) return undefined;

  const nextAt = new Date(prevAt.getTime() + 24 * 60 * 60 * 1000);
  const nextMs = nextAt.getTime();
  if (!Number.isFinite(nextMs)) return undefined;

  // Only accept if plausibly upcoming (avoid scheduling far in the future/past).
  const minMs = nowMs + 5 * 60_000;
  const maxMs = nowMs + 36 * 60 * 60_000;
  if (nextMs < minMs || nextMs > maxMs) return undefined;
  return nextAt;
}

function inferResetTimeUtc(cfg: AppContext['cfg'], nowMs = Date.now()): Date | undefined {
  const hhmm =
    typeof (cfg as any).WAR_DAY_RESET_UTC === 'string' ? (cfg as any).WAR_DAY_RESET_UTC : undefined;
  if (!hhmm) return undefined;

  const [hhStr, mmStr] = hhmm.split(':');
  const hh = Number(hhStr);
  const mm = Number(mmStr);

  const now = new Date(nowMs);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  let reset = new Date(Date.UTC(y, m, d, hh, mm, 0, 0));
  if (reset.getTime() <= nowMs) reset = new Date(Date.UTC(y, m, d + 1, hh, mm, 0, 0));
  return reset;
}

function currentPeriodKey(payload: any): string {
  const periodTypeRaw = typeof payload?.periodType === 'string' ? payload.periodType : undefined;
  const periodType = periodTypeRaw?.trim().toLowerCase() || 'unknown';
  const sectionIndex = toFiniteInt(payload?.sectionIndex);
  const dayIndex = toFiniteInt(payload?.dayIndex) ?? toFiniteInt(payload?.warDay);
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

  const prevRaw = dbGetJobState(ctx.db, 'war:day_snapshot:last_snapshot');
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

  const roster = await ctx.clash.getClanMembers(ctx.cfg.CLASH_CLAN_TAG).catch(() => []);
  const nameByTag = new Map<string, string>();
  for (const m of roster) {
    const tag = normalizeTagUpper(m.tag);
    if (tag) nameByTag.set(tag, m.name);
  }

  const tags = roster.length
    ? roster.map((m) => normalizeTagUpper(m.tag)).filter((t): t is string => Boolean(t))
    : Array.from(current.keys());
  const scored = tags.map((tag) => {
    const before = prev.get(tag) ?? {};
    const after = current.get(tag) ?? {};
    const dFame = clampNonNegative((after.fame ?? 0) - (before.fame ?? 0));
    const dDecks = clampNonNegative((after.decksUsed ?? 0) - (before.decksUsed ?? 0));
    return { tag, dFame, dDecks };
  });

  scored.sort((a, b) => b.dFame - a.dFame || b.dDecks - a.dDecks || a.tag.localeCompare(b.tag));

  const lines: string[] = [];
  const noBattles: string[] = [];
  for (const { tag, dFame, dDecks } of scored) {
    const name = nameByTag.get(tag) ?? tag;
    lines.push(`• **${name}**: ${dFame} points`);
    if (dDecks <= 0 && dFame <= 0) noBattles.push(`${name}`);
  }

  const header = `War day snapshot (ending ${endAt.toLocaleString()}):`;
  const chunks = chunkEmbedDescriptions([`**${header}**`, ...lines]);

  const starter = await channel.send({ content: header }).catch(() => null);
  const thread = starter
    ? await starter
        .startThread({
          name: `War day summary — ${endAt.toLocaleDateString()}`,
          autoArchiveDuration: 1440,
          reason: 'War day snapshot thread',
        })
        .catch(() => null)
    : null;
  const target: any = thread ?? channel;

  const noBattlesText = noBattles.length
    ? noBattles.length > 40
      ? `${noBattles.slice(0, 40).join(', ')} … (+${noBattles.length - 40} more)`
      : noBattles.join(', ')
    : '(none)';

  const ts = new Date();
  for (let i = 0; i < chunks.length; i += 1) {
    const embed = new EmbedBuilder()
      .setTitle('War Day Summary')
      .setDescription(chunks[i])
      .setFooter({ text: ts.toLocaleString() });
    if (i === 0) embed.addFields({ name: 'No battles', value: noBattlesText });
    if (chunks.length > 1) embed.setAuthor({ name: `Part ${i + 1} of ${chunks.length}` });
    await target.send({ embeds: [embed] }).catch(() => undefined);
  }

  const serialized = serializeParticipants(current);
  dbSetJobState(ctx.db, 'war:day_snapshot:last_snapshot', JSON.stringify(serialized));
  dbSetJobState(ctx.db, snapshotKey, key);

  const payloadDayIndex = inferWarDayIndex(payload, current);
  const periodType = typeof payload?.periodType === 'string' ? payload.periodType : undefined;
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
  const keyNow = currentPeriodKey(payload);
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

  // In some "colosseum" weeks, fields like dayIndex/sectionIndex are not a per-day index.
  // Infer the day from cumulative decks used instead.
  if (periodType === 'colosseum') {
    let maxTotal = 0;
    for (const snap of participants.values()) {
      const total =
        typeof snap?.decksUsed === 'number' && Number.isFinite(snap.decksUsed) ? snap.decksUsed : 0;
      if (total > maxTotal) maxTotal = total;
    }
    const inferred = Math.max(1, Math.ceil((maxTotal || 1) / 4));
    return clampWarDayIndex(inferred);
  }

  const direct = toFiniteInt(payload?.dayIndex) ?? toFiniteInt(payload?.warDay);
  if (direct !== undefined) return clampWarDayIndex(direct);

  const sectionIndex = toFiniteInt(payload?.sectionIndex);
  if (sectionIndex !== undefined && sectionIndex >= 1 && sectionIndex <= 5) return sectionIndex;

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

async function maybePostWarDayEndSnapshot(
  ctx: AppContext,
  client: Client,
  payload: any,
  current: Map<string, ParticipantSnapshot>,
) {
  if (!isRegularWarBattleDay(payload)) return;

  const periodTypeRaw = typeof payload?.periodType === 'string' ? payload.periodType : undefined;
  const periodType = periodTypeRaw?.trim().toLowerCase();

  // Prefer exact timing from /currentwar.warEndTime.
  let endRaw: string | undefined;
  let endAt: Date | undefined;
  let endSource: 'currentwar' | 'riverrace' | 'none' = 'none';

  const currentWarEnd = await tryGetCurrentWarEndTime(ctx);
  if (currentWarEnd?.raw && currentWarEnd?.at) {
    endRaw = currentWarEnd.raw;
    endAt = currentWarEnd.at;
    endSource = 'currentwar';
  }

  if (!endRaw || !endAt) {
    const t2 = findPeriodEndTime(payload);
    if (t2.raw && t2.at) {
      endRaw = t2.raw;
      endAt = t2.at;
      endSource = 'riverrace';
    }
  }

  // If we can't find an end time, rely on rollover snapshots.
  if (!endRaw || !endAt) return;

  const msLeft = endAt.getTime() - Date.now();
  // Schedule once per period end time. This lets us schedule immediately on startup
  // (even if the period ends hours from now) and naturally repeats once per day.
  if (!(msLeft > 0)) return;

  const snapshotKey = `war:day_snapshot:last_key`;
  const key = `warDay:${endRaw}`;
  const prevKey = dbGetJobState(ctx.db, snapshotKey);
  if (prevKey === key) return;

  // If we're extremely close already, post immediately (best-effort).
  if (msLeft <= 5_000) {
    console.log(
      `[war] Snapshot too close to end; posting immediately (periodType=${periodType ?? 'unknown'}, source=${endSource}, endAtLocal=${toLocalDateTimeLabel(endAt)}, firesIn=${formatDurationHhMm(msLeft)})`,
    );
    await postWarDaySnapshotNow(ctx, client, key, endAt, snapshotKey);
    return;
  }

  // Schedule exactly once per endTime key.
  if (scheduledWarDaySnapshots.has(key)) return;
  const delay = Math.max(msLeft - 1_500, 0); // aim ~1.5s before end
  const timeout = setTimeout(() => {
    scheduledWarDaySnapshots.delete(key);
    void postWarDaySnapshotNow(ctx, client, key, endAt, snapshotKey).catch(() => undefined);
  }, delay);
  scheduledWarDaySnapshots.set(key, timeout);

  console.log(
    `[war] Scheduled end-of-day snapshot (periodType=${periodType ?? 'unknown'}, source=${endSource}, key=${key}, endAtLocal=${toLocalDateTimeLabel(endAt)}, firesIn=${formatDurationHhMm(delay)})`,
  );
}

// Called on startup to ensure the end-of-period snapshot is scheduled immediately
// (instead of waiting until the last minute cron tick).
export async function primeWarDaySnapshotSchedule(ctx: AppContext, client: Client) {
  const payload = await ctx.clash.getCurrentRiverRace(ctx.cfg.CLASH_CLAN_TAG);
  const current = extractParticipants(payload);
  const periodTypeRaw = typeof payload?.periodType === 'string' ? payload.periodType : undefined;
  const periodType = periodTypeRaw?.trim().toLowerCase();

  // Show the user whether we can schedule off an exact warEndTime.
  let endAt: Date | undefined;
  let endSource: 'currentwar' | 'riverrace' | 'none' = 'none';

  const currentWarEnd = await tryGetCurrentWarEndTime(ctx);
  if (currentWarEnd?.at) {
    endAt = currentWarEnd.at;
    endSource = 'currentwar';
  }
  if (!endAt) {
    const t2 = findPeriodEndTime(payload);
    if (t2.at) {
      endAt = t2.at;
      endSource = 'riverrace';
    }
  }

  if (endAt) {
    const msLeft = endAt.getTime() - Date.now();
    console.log(
      `[war] Startup: end time available (periodType=${periodType ?? 'unknown'}, source=${endSource}, endAtLocal=${toLocalDateTimeLabel(endAt)}, firesIn=${formatDurationHhMm(msLeft)})`,
    );
  } else {
    const cwNote = currentWarEndpointState === 'gone' ? ' /currentwar removed (410 Gone),' : '';
    console.log(
      `[war] Startup:${cwNote} no end time available (periodType=${periodType ?? 'unknown'}). Will capture minute snapshots and post the final snapshot on detected period change.`,
    );
  }
  await maybePostWarDayEndSnapshot(ctx, client, payload, current);
}

async function postWarDaySnapshotNow(
  ctx: AppContext,
  client: Client,
  key: string,
  endAt: Date,
  snapshotKey: string,
) {
  // Final dedupe check (covers timer + poll races)
  const prevKey = dbGetJobState(ctx.db, snapshotKey);
  if (prevKey === key) return;

  const guild = await client.guilds.fetch(ctx.cfg.GUILD_ID);
  const channel = await guild.channels.fetch(ctx.cfg.CHANNEL_WAR_LOGS_ID);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  // Fetch fresh data right at the end for maximum accuracy.
  const payload = await ctx.clash.getCurrentRiverRace(ctx.cfg.CLASH_CLAN_TAG);
  const current = extractParticipants(payload);

  const { raw: endRaw2, at: endAt2FromApi } = findPeriodEndTime(payload);
  const endAt2 = endAt2FromApi ?? inferResetTimeUtc(ctx.cfg);
  if (!isRegularWarBattleDay(payload)) return;

  // If the API provides an end-time, use it as the canonical dedupe key.
  if (endRaw2 && `warDay:${endRaw2}` !== key) return;

  // If the API omits end-time fields, fall back to the configured UTC reset time.
  // Guard against posting at the wrong time by requiring the scheduled endAt
  // and the computed reset time to be very close.
  if (!endRaw2) {
    if (!endAt2) return;
    const driftMs = Math.abs(endAt2.getTime() - endAt.getTime());
    if (driftMs > 2 * 60_000) return;
  }

  const prevRaw = dbGetJobState(ctx.db, 'war:day_snapshot:last_snapshot');
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

  const roster = await ctx.clash.getClanMembers(ctx.cfg.CLASH_CLAN_TAG).catch(() => []);
  const nameByTag = new Map<string, string>();
  for (const m of roster) {
    const tag = normalizeTagUpper(m.tag);
    if (tag) nameByTag.set(tag, m.name);
  }

  const tags = roster.length
    ? roster.map((m) => normalizeTagUpper(m.tag)).filter((t): t is string => Boolean(t))
    : Array.from(current.keys());
  const scored = tags.map((tag) => {
    const before = prev.get(tag) ?? {};
    const after = current.get(tag) ?? {};
    const dFame = clampNonNegative((after.fame ?? 0) - (before.fame ?? 0));
    const dDecks = clampNonNegative((after.decksUsed ?? 0) - (before.decksUsed ?? 0));
    return { tag, dFame, dDecks };
  });

  scored.sort((a, b) => b.dFame - a.dFame || b.dDecks - a.dDecks || a.tag.localeCompare(b.tag));

  const lines: string[] = [];
  const noBattles: string[] = [];
  for (const { tag, dFame, dDecks } of scored) {
    const name = nameByTag.get(tag) ?? tag;
    lines.push(`• **${name}**: ${dFame} points`);
    if (dDecks <= 0 && dFame <= 0) noBattles.push(`${name}`);
  }

  const ts = new Date();
  const header = `War day snapshot (ending ${endAt.toLocaleString()}):`;
  const chunks = chunkEmbedDescriptions([`**${header}**`, ...lines]);

  // Snapshots go into a thread to keep #war-logs readable.
  const starter = await channel.send({ content: header }).catch(() => null);
  const thread = starter
    ? await starter
        .startThread({
          name: `War day summary — ${endAt.toLocaleDateString()}`,
          autoArchiveDuration: 1440,
          reason: 'War day snapshot thread',
        })
        .catch(() => null)
    : null;
  const target: any = thread ?? channel;

  const noBattlesText = noBattles.length
    ? noBattles.length > 40
      ? `${noBattles.slice(0, 40).join(', ')} … (+${noBattles.length - 40} more)`
      : noBattles.join(', ')
    : '(none)';

  for (let i = 0; i < chunks.length; i += 1) {
    const embed = new EmbedBuilder()
      .setTitle('War Day Summary')
      .setDescription(chunks[i])
      .setFooter({ text: ts.toLocaleString() });
    if (i === 0) embed.addFields({ name: 'No battles', value: noBattlesText });
    if (chunks.length > 1) embed.setAuthor({ name: `Part ${i + 1} of ${chunks.length}` });
    await target.send({ embeds: [embed] }).catch(() => undefined);
  }

  // Persist baseline for next day and dedupe key.
  const serialized: Record<string, ParticipantSnapshot> = {};
  for (const [tag, snap] of current.entries()) {
    const norm = normalizeTagUpper(tag);
    if (norm) serialized[norm] = snap;
  }
  dbSetJobState(ctx.db, 'war:day_snapshot:last_snapshot', JSON.stringify(serialized));
  dbSetJobState(ctx.db, snapshotKey, key);

  // Also keep a rolling history for user-facing queries.
  const payloadDayIndex = inferWarDayIndex(payload, current);
  const periodType = typeof payload?.periodType === 'string' ? payload.periodType : undefined;
  appendSnapshotHistory(ctx, {
    key,
    endRaw: String(endRaw2),
    endAtIso: endAt.toISOString(),
    capturedAtIso: new Date().toISOString(),
    periodType,
    dayIndex: payloadDayIndex,
    snapshot: serialized,
  });
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

  // If it's a war day and we're within ~1 minute of period end, post the snapshot.
  await maybePostWarDayEndSnapshot(ctx, client, payload, next);

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
}
