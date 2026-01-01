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

function toFiniteInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
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
  const periodType = typeof payload?.periodType === 'string' ? payload.periodType : undefined;
  if (periodType !== 'warDay') return false;

  // Common fields seen across payload variants.
  const idx =
    toFiniteInt(payload?.periodIndex) ??
    toFiniteInt(payload?.dayIndex) ??
    toFiniteInt(payload?.warDay) ??
    toFiniteInt(payload?.sectionIndex);

  // If we can't find an index, fall back to periodType alone.
  if (idx === undefined) return true;

  return idx >= 1 && idx <= 4;
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

  const { raw: endRaw, at: endAt } = findPeriodEndTime(payload);
  if (!endRaw || !endAt) return;

  const msLeft = endAt.getTime() - Date.now();
  // We poll on a minute cron; when we enter the last minute, schedule a one-off post
  // as close to the end as possible.
  if (!(msLeft > 0 && msLeft <= 60_000)) return;

  const snapshotKey = `war:day_snapshot:last_key`;
  const key = `warDay:${endRaw}`;
  const prevKey = dbGetJobState(ctx.db, snapshotKey);
  if (prevKey === key) return;

  // If we're extremely close already, post immediately (best-effort).
  if (msLeft <= 5_000) {
    await postWarDaySnapshotNow(ctx, client, key, endAt, snapshotKey);
    return;
  }

  // Schedule exactly once per endTime key.
  if (scheduledWarDaySnapshots.has(key)) return;
  const delay = Math.max(msLeft - 1_500, 0); // aim ~1.5s before end
  const t = setTimeout(() => {
    scheduledWarDaySnapshots.delete(key);
    void postWarDaySnapshotNow(ctx, client, key, endAt, snapshotKey).catch(() => undefined);
  }, delay);
  scheduledWarDaySnapshots.set(key, t);
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

  const { raw: endRaw2 } = findPeriodEndTime(payload);
  if (!isRegularWarBattleDay(payload)) return;
  if (!endRaw2 || `warDay:${endRaw2}` !== key) return;

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
  const payloadDayIndex =
    toFiniteInt(payload?.periodIndex) ??
    toFiniteInt(payload?.dayIndex) ??
    toFiniteInt(payload?.warDay) ??
    toFiniteInt(payload?.sectionIndex);
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

  const changes = diffSnapshots(prev, next);
  // Keep war-logs quiet on prep/training days.
  if (isBattleDay && changes.length) {
    const lines = changes.map(({ tag, before, after }) => {
      const bDecks = before?.decksUsed ?? 0;
      const aDecks = after.decksUsed ?? bDecks;
      const bFame = before?.fame ?? 0;
      const aFame = after.fame ?? bFame;
      const dDecks = aDecks - bDecks;
      const dFame = aFame - bFame;

      const parts: string[] = [];
      if (Number.isFinite(dDecks) && dDecks !== 0)
        parts.push(`decks ${dDecks > 0 ? '+' : ''}${dDecks}`);
      if (Number.isFinite(dFame) && dFame !== 0) parts.push(`fame ${dFame > 0 ? '+' : ''}${dFame}`);
      if (!parts.length) parts.push('updated');

      const label = after.name ? `**${after.name}**` : `**${tag}**`;
      return `${label}: ${parts.join(', ')}`;
    });

    const ts = new Date();
    const chunks = chunkEmbedDescriptions(lines);
    for (let i = 0; i < chunks.length; i += 1) {
      const embed = new EmbedBuilder()
        .setTitle('War Participation Update')
        .setDescription(chunks[i])
        .setFooter({ text: ts.toLocaleString() });
      if (chunks.length > 1) embed.setAuthor({ name: `Part ${i + 1} of ${chunks.length}` });
      await channel.send({ embeds: [embed] }).catch(() => undefined);
    }
  }

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
        const idx =
          toFiniteInt(payload?.periodIndex) ??
          toFiniteInt(payload?.dayIndex) ??
          toFiniteInt(payload?.warDay) ??
          toFiniteInt(payload?.sectionIndex);

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
