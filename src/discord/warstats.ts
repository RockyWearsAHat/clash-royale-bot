import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
} from 'discord.js';
import { randomUUID } from 'crypto';
import type { SlashCommand } from './commands.js';
import type { AppContext } from '../types.js';
import { asCodeBlock, chunkLinesForEmbed, infoEmbed } from './ui.js';

type ParticipantSnapshot = {
  decksUsed?: number;
  decksUsedToday?: number;
  fame?: number;
  repairs?: number;
  boatAttacks?: number;
};

type MinuteCapture = {
  capturedAtIso?: string;
  periodKey?: string;
  periodType?: string;
  sectionIndex?: number;
  payload?: any;
  snapshot?: Record<string, ParticipantSnapshot>;
};

type SnapshotHistoryEntry = {
  key?: string;
  endRaw?: string;
  endAtIso?: string;
  capturedAtIso?: string;
  periodType?: string;
  dayIndex?: number;
  snapshot?: Record<string, ParticipantSnapshot>;
};

type ParsedDayRef =
  | { kind: 'live' }
  | { kind: 'latest' }
  | { kind: 'daysAgo'; days: number }
  | { kind: 'warDay'; day: number }
  | { kind: 'prepDay'; day: number };

type ResolvedParticipants = {
  participants?: Map<string, ParticipantSnapshot>;
  label: string;
  warDayIndex?: number;
  periodType?: string;
  snapshotEndAtMs?: number;
  source: 'snapshot' | 'live';
  note?: string;
};

type WarStatsRenderResult =
  | {
      ok: true;
      firstEmbeds: EmbedBuilder[];
      continuationEmbeds: EmbedBuilder[];
    }
  | {
      ok: false;
      errorEmbeds: EmbedBuilder[];
    };

function safeNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function readLatestMinuteCapture(ctx: AppContext): MinuteCapture | null {
  const raw = ctx.db
    .prepare('SELECT value FROM job_state WHERE key = ?')
    .get('war:period:last_capture') as { value: string } | undefined;
  if (!raw?.value) return null;
  try {
    const obj = JSON.parse(raw.value);
    return obj && typeof obj === 'object' ? (obj as MinuteCapture) : null;
  } catch {
    return null;
  }
}

function snapshotRecordToParticipants(rec: Record<string, ParticipantSnapshot> | undefined) {
  return snapshotRecordToMap(rec);
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

function normalizeName(raw: string): string {
  return raw.trim().toLowerCase();
}

function findRawParticipantByTag(payload: any, tagUpper: string): any | undefined {
  const participants = payload?.clan?.participants;
  if (!Array.isArray(participants)) return undefined;
  for (const p of participants) {
    const t = normalizeTagUpper(p?.tag ?? p?.playerTag ?? p?.memberTag);
    if (t === tagUpper) return p;
  }
  return undefined;
}

function extractParticipants(payload: any): Map<string, ParticipantSnapshot> {
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
    ]);
    const decksUsedOverall = pickMaxNumber(p, [
      'decksUsedThisPeriod',
      'decksUsedInPeriod',
      'decksUsed',
      'decksUsedThisSection',
    ]);

    out.set(tag, {
      decksUsed: decksUsedOverall ?? decksUsedToday ?? 0,
      decksUsedToday,
      fame: pickMaxNumber(p, ['fame', 'fameToday', 'currentFame']),
      repairs: pickMaxNumber(p, ['repairs', 'repairsToday', 'repairPoints', 'repairPointsToday']),
      boatAttacks: pickMaxNumber(p, ['boatAttacks', 'boatAttacksToday']),
    });
  }
  return out;
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return '0%';
  return `${n.toFixed(1)}%`;
}

function clipLabel(input: string, maxLen: number): string {
  const s = String(input ?? '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

function formatNoBattles(names: string[], maxItems = 30): string {
  if (!names.length) return '(none)';
  if (names.length <= maxItems) return names.join(', ');
  return `${names.slice(0, maxItems).join(', ')} … (+${names.length - maxItems} more)`;
}

function inferPhaseFromPayload(payload: any): 'warDay' | 'prepDay' {
  const periodTypeRaw = typeof payload?.periodType === 'string' ? payload.periodType : undefined;
  const periodType = periodTypeRaw?.trim().toLowerCase();

  // Prefer explicit periodType when present.
  if (periodType === 'warday') return 'warDay';
  if (periodType === 'colosseum') return 'warDay';
  if (periodType === 'training' || periodType === 'prepday') return 'prepDay';

  // Heuristic: if the payload exposes an in-range war-day index (1-4), treat as battle day.
  // This guards against API variants where periodType differs or is missing.
  const idx = clampWarDayIndex(inferCurrentDayIndex(payload));
  if (idx !== undefined) return 'warDay';

  // Final fallback: some variants still include "war" in the periodType.
  if (periodType && periodType.includes('war')) return 'warDay';

  return 'prepDay';
}

function clampWarDayIndex(n: number | undefined): number | undefined {
  if (!Number.isFinite(n)) return undefined;
  const i = Math.trunc(n as number);
  if (i < 1 || i > 5) return undefined;
  return i;
}

function decksAvailableForWarDay(dayIndex: number | undefined): number {
  // If we can't infer the day, default to day 1 (4 decks) to avoid overstating availability.
  const idx = clampWarDayIndex(dayIndex) ?? 1;
  return idx * 4;
}

function clampNonNegative(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

function padLeft(input: string, width: number): string {
  const s = String(input ?? '');
  if (s.length >= width) return s;
  return `${' '.repeat(width - s.length)}${s}`;
}

function padRight(input: string, width: number): string {
  const s = String(input ?? '');
  if (s.length >= width) return s;
  return `${s}${' '.repeat(width - s.length)}`;
}

function padCenter(input: string, width: number): string {
  const s = String(input ?? '');
  if (s.length >= width) return s;
  const left = Math.floor((width - s.length) / 2);
  const right = width - s.length - left;
  return `${' '.repeat(left)}${s}${' '.repeat(right)}`;
}

const COL_FAME_W = 6;
const COL_TODAY_W = 7;
const COL_TOTAL_W = 7;
const COL_NAME_W = 24;

function buildWarDayParticipationRows(
  scored: Array<{
    tag: string;
    fame: number;
    decksUsedToday: number;
    decksTotalUsed: number;
    decksTotalAvail: number;
  }>,
  nameByTag: Map<string, string>,
): string[] {
  const rows: string[] = [];
  for (const { tag, fame, decksUsedToday, decksTotalUsed, decksTotalAvail } of scored) {
    const nameRaw = nameByTag.get(tag) ?? tag;
    const name = padRight(clipLabel(nameRaw, COL_NAME_W), COL_NAME_W);

    const todayLabel = `${clampNonNegative(decksUsedToday)}/4`;
    const totalLabel = `${clampNonNegative(decksTotalUsed)}/${decksTotalAvail}`;
    rows.push(
      `${padRight(String(clampNonNegative(fame)), COL_FAME_W)}  ${padRight(todayLabel, COL_TODAY_W)}  ${padRight(totalLabel, COL_TOTAL_W)}  ${name}`,
    );
  }
  return rows;
}

function buildPrepDayParticipationRows(
  scored: Array<{ tag: string; decksUsedToday: number }>,
  nameByTag: Map<string, string>,
): string[] {
  const rows: string[] = [];
  for (const { tag, decksUsedToday } of scored) {
    const nameRaw = nameByTag.get(tag) ?? tag;
    const name = padRight(clipLabel(nameRaw, COL_NAME_W), COL_NAME_W);
    const todayLabel = `${clampNonNegative(decksUsedToday)}/4`;
    rows.push(`${padRight(todayLabel, COL_TODAY_W)}  ${name}`);
  }
  return rows;
}

function chunkTableForEmbed(header: string, rows: string[], maxLen = 3850): string[] {
  const out: string[] = [];
  let cur: string[] = [];

  const render = (bodyRows: string[]): string => {
    const text = bodyRows.length ? `${header}\n${bodyRows.join('\n')}` : header;
    return asCodeBlock(text, '');
  };

  for (const row of rows) {
    const nextRows = cur.length ? [...cur, row] : [row];
    const candidateLen = render(nextRows).length;
    if (candidateLen > maxLen) {
      if (cur.length) out.push(render(cur));
      cur = [row];
    } else {
      cur = nextRows;
    }
  }
  if (cur.length) out.push(render(cur));
  return out.length ? out : [render(['(none)'])];
}

function toFiniteInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}

function inferCurrentDayIndex(payload: any): number | undefined {
  const periodTypeRaw = typeof payload?.periodType === 'string' ? payload.periodType : undefined;
  const periodType = periodTypeRaw?.trim().toLowerCase();

  // In some "colosseum" weeks, fields like dayIndex/sectionIndex are not a per-day index.
  // Infer the day from cumulative decks used instead.
  if (periodType === 'colosseum') {
    const participants = extractParticipants(payload);
    let maxTotal = 0;
    for (const snap of participants.values()) {
      const total =
        typeof snap?.decksUsed === 'number' && Number.isFinite(snap.decksUsed) ? snap.decksUsed : 0;
      if (total > maxTotal) maxTotal = total;
    }
    const inferred = Math.max(1, Math.ceil((maxTotal || 1) / 4));
    return clampWarDayIndex(inferred);
  }

  // Many payloads expose a 1-based warDay/dayIndex. Prefer those.
  const direct = toFiniteInt(payload?.dayIndex) ?? toFiniteInt(payload?.warDay);
  if (direct !== undefined) return direct;

  // Some variants use sectionIndex (1..4); treat that as day index.
  const sectionIndex = toFiniteInt(payload?.sectionIndex);
  if (sectionIndex !== undefined && sectionIndex >= 1 && sectionIndex <= 5) return sectionIndex;

  // No further inference for regular war days (avoid guessing from deck totals).
  return undefined;
}

function parseRelativeDayInput(raw: string): ParsedDayRef | null {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!s) return null;

  const wordToInt = (w: string): number | undefined => {
    switch (w) {
      case 'zero':
        return 0;
      case 'one':
      case 'a':
      case 'an':
        return 1;
      case 'two':
        return 2;
      case 'three':
        return 3;
      case 'four':
        return 4;
      case 'five':
        return 5;
      case 'six':
        return 6;
      case 'seven':
        return 7;
      case 'eight':
        return 8;
      case 'nine':
        return 9;
      case 'ten':
        return 10;
      case 'couple':
        return 2;
      case 'few':
        return 3;
      default:
        return undefined;
    }
  };

  if (s === 'today' || s === 'now' || s === 'current' || s === 'live') return { kind: 'live' };
  if (
    s === 'last' ||
    s === 'latest' ||
    s === 'previous' ||
    s === 'prev' ||
    s === 'last war day' ||
    s === 'last warday' ||
    s === 'last war'
  )
    return { kind: 'latest' };
  if (s === 'yesterday') return { kind: 'daysAgo', days: 1 };

  const ago = s.match(/^(\d{1,2})\s*(?:d|day|days)\s*ago$/);
  if (ago) {
    const days = Number(ago[1]);
    if (Number.isFinite(days) && days >= 0) return { kind: 'daysAgo', days };
  }

  const agoWords = s.match(
    /^(zero|one|two|three|four|five|six|seven|eight|nine|ten|a|an|couple|few)\s*(?:d|day|days)\s*ago$/,
  );
  if (agoWords) {
    const n = wordToInt(agoWords[1]);
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return { kind: 'daysAgo', days: n };
  }

  const days = s.match(/^(\d{1,2})\s*(?:d|day|days)$/);
  if (days) {
    const n = Number(days[1]);
    if (Number.isFinite(n) && n >= 0) return { kind: 'daysAgo', days: n };
  }

  const daysWords = s.match(
    /^(zero|one|two|three|four|five|six|seven|eight|nine|ten|a|an|couple|few)\s*(?:d|day|days)$/,
  );
  if (daysWords) {
    const n = wordToInt(daysWords[1]);
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return { kind: 'daysAgo', days: n };
  }

  // Accept "prep day 1" (training) as a synonym for live prep-day view.
  if (s === 'prep' || s === 'training' || s === 'prep day') return { kind: 'prepDay', day: 1 };

  const prep =
    s.match(/^prep\s*(?:day\s*)?(\d{1,2})$/) ?? s.match(/^training\s*(?:day\s*)?(\d{1,2})$/);
  if (prep) {
    const day = Number(prep[1]);
    if (Number.isFinite(day) && day >= 1) return { kind: 'prepDay', day };
  }

  const war =
    s.match(/^(?:last\s+)?war\s*day\s*(\d{1,2})$/) ??
    s.match(/^(?:last\s+)?warday\s*(\d{1,2})$/) ??
    s.match(/^(?:last\s+)?war\s*(\d{1,2})$/) ??
    s.match(/^wd\s*(\d{1,2})$/);
  if (war) {
    const day = Number(war[1]);
    if (Number.isFinite(day) && day >= 1 && day <= 5) return { kind: 'warDay', day };
  }

  return null;
}

function warstatsPublishCustomId(invokerUserId: string, parsed: ParsedDayRef | null): string {
  const kind = parsed?.kind ?? 'default';
  const n =
    parsed && (parsed.kind === 'daysAgo' || parsed.kind === 'warDay' || parsed.kind === 'prepDay')
      ? parsed.kind === 'daysAgo'
        ? parsed.days
        : parsed.day
      : 0;
  const token = randomUUID();
  return `publish:warlogs:${invokerUserId}:${kind}:${n}:${token}`;
}

function decodeWarstatsPublishRef(kind: string, nRaw: string): ParsedDayRef | null {
  const n = Number(nRaw);
  const num = Number.isFinite(n) ? Math.trunc(n) : 0;

  switch (kind) {
    case 'default':
      return null;
    case 'live':
      return { kind: 'live' };
    case 'latest':
      return { kind: 'latest' };
    case 'daysAgo':
      return { kind: 'daysAgo', days: Math.max(0, num) };
    case 'warDay':
      if (num >= 1 && num <= 5) return { kind: 'warDay', day: num };
      return null;
    case 'prepDay':
      if (num >= 1) return { kind: 'prepDay', day: num };
      return null;
    default:
      return null;
  }
}

function buildWarstatsPublishRow(customId: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(disabled ? 'Posted' : 'Post publicly')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

type WarlogsPublishCache = {
  invokerUserId: string;
  createdAtIso: string;
  parsedKind: string;
  parsedN: number;
  firstEmbeds: any[];
  continuationEmbeds: any[];
};

function publishCacheKey(token: string): string {
  return `war:publish_cache:${token}`;
}

function writePublishCache(ctx: AppContext, token: string, cache: WarlogsPublishCache) {
  ctx.db
    .prepare('INSERT OR REPLACE INTO job_state(key, value) VALUES(?, ?)')
    .run(publishCacheKey(token), JSON.stringify(cache));
}

function readPublishCache(ctx: AppContext, token: string): WarlogsPublishCache | null {
  const raw = ctx.db
    .prepare('SELECT value FROM job_state WHERE key = ?')
    .get(publishCacheKey(token)) as { value: string } | undefined;
  if (!raw?.value) return null;
  try {
    const obj = JSON.parse(raw.value);
    return obj && typeof obj === 'object' ? (obj as WarlogsPublishCache) : null;
  } catch {
    return null;
  }
}

function deletePublishCache(ctx: AppContext, token: string) {
  ctx.db.prepare('DELETE FROM job_state WHERE key = ?').run(publishCacheKey(token));
}

function renderWarStatsEmbedsFromData(
  ctx: AppContext,
  args: {
    parsed: ParsedDayRef | null;
    dayArgRaw: string | null;
    payload: any;
    log: any;
    roster: any[];
  },
): WarStatsRenderResult {
  const { parsed, dayArgRaw, payload, log, roster } = args;

  if (dayArgRaw && !parsed) {
    return {
      ok: false,
      errorEmbeds: [
        infoEmbed(
          'Invalid day format',
          "I couldn't understand that `day` value. Try one of: `live`, `yesterday`, `2 days ago`, `war day 4`, `wd4`, `last`, `prep day 1`.",
        ),
      ],
    };
  }

  const currentDayIndex = inferCurrentDayIndex(payload);
  const livePhase = inferPhaseFromPayload(payload);
  const livePeriodTypeRaw =
    typeof payload?.periodType === 'string' ? payload.periodType : undefined;
  const livePeriodType = livePeriodTypeRaw?.trim().toLowerCase();
  const liveParticipants = extractParticipants(payload);
  const resolved = parsed
    ? resolveParticipantsForRef(ctx, parsed, liveParticipants)
    : ({ label: 'live', participants: liveParticipants, source: 'live' } as ResolvedParticipants);
  const participants = resolved.participants;

  if (!participants || participants.size === 0) {
    return {
      ok: false,
      errorEmbeds: [
        infoEmbed(
          'No war participant data available',
          resolved.note ??
            'I could not find a saved snapshot for that request, and the live API response did not include participants.',
        ),
      ],
    };
  }

  const nameByTag = new Map<string, string>();
  for (const m of roster) {
    const tag = normalizeTagUpper(m.tag);
    if (tag) nameByTag.set(tag, m.name);
  }

  const items: any[] = Array.isArray(log?.items) ? log.items : [];
  const clanTag = ctx.cfg.CLASH_CLAN_TAG.toUpperCase();

  // Overall win rate (use recorded history if present, otherwise fall back to API log).
  const recordedAgg = ctx.db
    .prepare(
      `SELECT
           COALESCE(SUM(CASE WHEN rank = 1 THEN 1 ELSE 0 END), 0) AS wins,
           COALESCE(SUM(CASE WHEN rank IS NOT NULL AND rank <> 1 THEN 1 ELSE 0 END), 0) AS losses
         FROM war_history
         WHERE clan_tag = ?`,
    )
    .get(clanTag) as { wins: number; losses: number } | undefined;

  let wins = recordedAgg?.wins ?? 0;
  let losses = recordedAgg?.losses ?? 0;

  if (wins + losses === 0) {
    for (const it of items) {
      const standings: any[] = Array.isArray(it?.standings) ? it.standings : [];
      const ours = standings.find((s) => String(s?.clan?.tag ?? '').toUpperCase() === clanTag);
      const rank = typeof ours?.rank === 'number' ? ours.rank : undefined;
      if (!rank) continue;
      if (rank === 1) wins += 1;
      else losses += 1;
    }
    if (wins + losses === 0 && items.length > 0) losses = items.length - wins;
  }

  const warsCount = wins + losses;
  const winRate = warsCount > 0 ? (wins / warsCount) * 100 : 0;

  const viewPhase: 'warDay' | 'prepDay' =
    parsed?.kind === 'prepDay'
      ? 'prepDay'
      : parsed && parsed.kind !== 'live'
        ? 'warDay'
        : livePhase;

  const dayIdx =
    resolved.warDayIndex ??
    (viewPhase === 'warDay' ? clampWarDayIndex(currentDayIndex) : undefined);

  const viewPeriodTypeRaw = resolved.periodType ?? livePeriodTypeRaw;
  const viewPeriodType =
    typeof viewPeriodTypeRaw === 'string' ? viewPeriodTypeRaw.trim().toLowerCase() : undefined;
  const warDayLabelBase = viewPeriodType === 'colosseum' ? 'Colosseum day' : 'War day';

  const labelDate = (() => {
    const ms =
      typeof resolved.snapshotEndAtMs === 'number' && Number.isFinite(resolved.snapshotEndAtMs)
        ? resolved.snapshotEndAtMs
        : Date.now();
    const d = new Date(ms);
    try {
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return d.toISOString().slice(0, 10);
    }
  })();

  const phaseLabel =
    viewPhase === 'prepDay'
      ? 'Prep day'
      : dayIdx
        ? `${warDayLabelBase} ${dayIdx}`
        : viewPeriodType === 'colosseum'
          ? 'Colosseum'
          : 'War day';

  const phaseLabelDated = viewPhase === 'prepDay' ? phaseLabel : `${phaseLabel} (${labelDate})`;

  const viewLabel =
    parsed && parsed.kind === 'live' ? phaseLabelDated : parsed ? resolved.label : phaseLabelDated;

  const embed = infoEmbed('War Overview', viewLabel)
    .setTimestamp(new Date())
    .addFields(
      { name: 'Win rate', value: warsCount > 0 ? pct(winRate) : '—', inline: true },
      { name: 'Record', value: warsCount > 0 ? `${wins}-${losses}` : '—', inline: true },
    );

  if (resolved.note) embed.addFields({ name: 'Note', value: resolved.note, inline: false });

  const noBattles: string[] = [];

  const tags = roster.length
    ? roster.map((m) => normalizeTagUpper(m.tag)).filter((t): t is string => Boolean(t))
    : Array.from(participants.keys());

  let participationTitle = `${phaseLabelDated} participation`;
  let participationChunks: string[] = [];

  if (viewPhase === 'prepDay') {
    const scored = tags
      .map((tag) => {
        const snap = participants.get(tag) ?? {};
        const decksUsedToday = snap.decksUsedToday ?? snap.decksUsed ?? 0;
        return { tag, decksUsedToday };
      })
      .sort((a, b) => (b.decksUsedToday ?? 0) - (a.decksUsedToday ?? 0));

    for (const { tag, decksUsedToday } of scored) {
      const snap = participants.get(tag) ?? {};
      const name = nameByTag.get(tag) ?? tag;
      const fame = snap.fame ?? 0;
      if ((decksUsedToday ?? 0) <= 0 && (fame ?? 0) <= 0) noBattles.push(name);
    }

    const header = `${padRight('TODAY', COL_TODAY_W)}  ${padRight('PLAYER', COL_NAME_W)}`;
    const rows = buildPrepDayParticipationRows(scored, nameByTag);
    participationChunks = chunkTableForEmbed(header, rows);
  } else {
    const decksTotalAvail = decksAvailableForWarDay(dayIdx);

    // If viewing a historical snapshot, try to derive "today" (that war day) decks
    // as a diff against the previous day's snapshot.
    let prevSnapshotTotals: Map<string, ParticipantSnapshot> | undefined;
    if (resolved.source === 'snapshot' && resolved.snapshotEndAtMs && dayIdx && dayIdx > 1) {
      const history = readSnapshotHistory(ctx)
        .filter((e) => e && typeof e.endAtIso === 'string' && e.snapshot)
        .map((e) => {
          const t = new Date(String(e.endAtIso)).getTime();
          const di = typeof e.dayIndex === 'number' ? e.dayIndex : undefined;
          return { e, t: Number.isFinite(t) ? t : NaN, dayIndex: di };
        })
        .filter((x) => Number.isFinite(x.t));

      const candidates = history
        .filter(
          (x) =>
            x.dayIndex === dayIdx - 1 &&
            typeof x.e.snapshot === 'object' &&
            x.t < (resolved.snapshotEndAtMs as number) &&
            (resolved.snapshotEndAtMs as number) - x.t <= 60 * 60 * 1000 * 60,
        )
        .sort((a, b) => b.t - a.t);

      const pickedPrev = candidates[0];
      if (pickedPrev) prevSnapshotTotals = snapshotRecordToMap(pickedPrev.e.snapshot as any);
    }

    const scored = tags
      .map((tag) => {
        const snap = participants.get(tag) ?? {};
        const fame = snap.fame ?? 0;
        const decksTotalUsed = snap.decksUsed ?? 0;

        let decksUsedToday = snap.decksUsedToday ?? 0;
        if (resolved.source === 'snapshot') {
          const prev = prevSnapshotTotals?.get(tag);
          const prevTotal = prev?.decksUsed ?? 0;
          decksUsedToday = clampNonNegative(decksTotalUsed - prevTotal);
        }

        // Cap to a single war-day worth of decks.
        if (decksUsedToday > 4) decksUsedToday = 4;

        return { tag, fame, decksUsedToday, decksTotalUsed, decksTotalAvail };
      })
      .sort(
        (a, b) =>
          (b.fame ?? 0) - (a.fame ?? 0) ||
          (b.decksTotalUsed ?? 0) - (a.decksTotalUsed ?? 0) ||
          (b.decksUsedToday ?? 0) - (a.decksUsedToday ?? 0),
      );

    for (const { tag, decksUsedToday } of scored) {
      const name = nameByTag.get(tag) ?? tag;
      if ((decksUsedToday ?? 0) <= 0) noBattles.push(name);
    }

    const header = `${padRight('FAME', COL_FAME_W)}  ${padRight('TODAY', COL_TODAY_W)}  ${padRight('TOTAL', COL_TOTAL_W)}  ${padRight('PLAYER', COL_NAME_W)}`;
    const rows = buildWarDayParticipationRows(scored, nameByTag);
    participationChunks = chunkTableForEmbed(header, rows);
  }

  const noBattlesText = formatNoBattles(noBattles);
  const firstParticipation = infoEmbed(participationTitle, participationChunks[0]).addFields({
    name: `No activity (${noBattles.length})`,
    value: noBattlesText,
    inline: false,
  });

  const continuationEmbeds = participationChunks
    .slice(1)
    .map((extra) => infoEmbed('Participation — continued', extra));

  return { ok: true, firstEmbeds: [embed, firstParticipation], continuationEmbeds };
}

async function renderWarStatsEmbeds(
  ctx: AppContext,
  parsed: ParsedDayRef | null,
  dayArgRaw: string | null,
): Promise<WarStatsRenderResult> {
  if (dayArgRaw && !parsed) {
    return {
      ok: false,
      errorEmbeds: [
        infoEmbed(
          'Invalid day format',
          "I couldn't understand that `day` value. Try one of: `live`, `yesterday`, `2 days ago`, `war day 4`, `wd4`, `last`, `prep day 1`.",
        ),
      ],
    };
  }

  // Try live API first; if it fails (rate limit, network, etc.) or comes back without
  // participants, gracefully fall back to the latest minute snapshot captured by the job.
  let payload: any | null = null;
  let payloadFromMinute = false;

  try {
    payload = await ctx.clash.getCurrentRiverRace(ctx.cfg.CLASH_CLAN_TAG, { cacheBust: true });
  } catch {
    payload = null;
  }

  const liveParticipants = payload
    ? extractParticipants(payload)
    : new Map<string, ParticipantSnapshot>();
  if (!payload || liveParticipants.size === 0) {
    const cap = readLatestMinuteCapture(ctx);
    const snapParticipants = snapshotRecordToParticipants(cap?.snapshot);
    if (cap && snapParticipants.size > 0) {
      payloadFromMinute = true;
      payload = cap.payload ?? {
        periodType: cap.periodType,
        sectionIndex: cap.sectionIndex,
      };
    }
  }

  // Best-effort for supporting data; never block rendering on these.
  const [log, roster] = await Promise.all([
    ctx.clash.getRiverRaceLog(ctx.cfg.CLASH_CLAN_TAG, { cacheBust: true }).catch(() => null),
    ctx.clash.getClanMembers(ctx.cfg.CLASH_CLAN_TAG).catch(() => []),
  ]);

  if (!payload) {
    return {
      ok: false,
      errorEmbeds: [
        infoEmbed(
          'War data unavailable',
          'Could not fetch live river race data, and no recent minute snapshot is available yet.',
        ),
      ],
    };
  }

  // If we are falling back for a live view, ensure the participants come from the minute snapshot.
  if (payloadFromMinute) {
    const cap = readLatestMinuteCapture(ctx);
    const snapParticipants = snapshotRecordToParticipants(cap?.snapshot);
    // Inject the snapshot participants into payload shape expected by extractParticipants.
    // We avoid mutating the payload too deeply; only provide the participants array.
    if (snapParticipants.size > 0) {
      (payload as any) = {
        ...(payload as any),
        clan: {
          ...(payload as any).clan,
          participants: Array.from(snapParticipants.entries()).map(([tag, snap]) => ({
            tag,
            ...snap,
          })),
        },
      };
    }
  }

  return renderWarStatsEmbedsFromData(ctx, { parsed, dayArgRaw, payload, log, roster });
}

export async function handleWarlogsPublishButton(ctx: AppContext, interaction: ButtonInteraction) {
  const id = interaction.customId;
  if (!id.startsWith('publish:warlogs:')) return;

  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'This button must be used in a server.', ephemeral: true });
    return;
  }

  const parts = id.split(':');
  const invokerUserId = parts[2] ?? '';
  const kind = parts[3] ?? '';
  const nRaw = parts[4] ?? '0';
  const token = parts[5] ?? '';

  if (!invokerUserId || interaction.user.id !== invokerUserId) {
    await interaction.reply({
      content: 'Only the user who ran the command can use this button.',
      ephemeral: true,
    });
    return;
  }

  if (!interaction.channel || !interaction.channel.isTextBased()) {
    await interaction.reply({ content: 'This must be used in a text channel.', ephemeral: true });
    return;
  }

  const baseChannelId = interaction.channel.isThread()
    ? interaction.channel.parentId
    : interaction.channel.type === ChannelType.GuildText
      ? interaction.channel.id
      : null;

  if (!baseChannelId || baseChannelId !== ctx.cfg.CHANNEL_WAR_LOGS_ID) {
    await interaction.reply({
      content: `Please run /warlogs in <#${ctx.cfg.CHANNEL_WAR_LOGS_ID}> to post publicly.`,
      ephemeral: true,
    });
    return;
  }

  const parsed = decodeWarstatsPublishRef(kind, nRaw);

  // Note: "default" intentionally decodes to null (live view).
  if (kind !== 'default' && !parsed) {
    await interaction.reply({
      content: 'That publish button is no longer valid. Please re-run the command.',
      ephemeral: true,
    });
    return;
  }

  // Ephemeral messages are not reliably deletable. Immediately clear the UI so the
  // "private menu" disappears and users can't double-post.
  try {
    await interaction.update({ content: 'Posting publicly…', embeds: [], components: [] });
  } catch {
    try {
      await interaction.deferUpdate();
    } catch {
      // ignore
    }
  }

  let render: WarStatsRenderResult;
  // Prefer cached embeds from the original command run to avoid a second Clash API call.
  // If the cache is missing/expired, fall back to rendering again.
  const cacheTtlMs = 15 * 60_000;
  if (token) {
    const cache = readPublishCache(ctx, token);
    const createdAtMs = cache?.createdAtIso ? new Date(cache.createdAtIso).getTime() : NaN;
    const fresh = cache && Number.isFinite(createdAtMs) && Date.now() - createdAtMs <= cacheTtlMs;
    const invokerOk = cache?.invokerUserId === invokerUserId;

    if (fresh && invokerOk) {
      try {
        const firstEmbeds = (cache.firstEmbeds ?? []).map((e) => EmbedBuilder.from(e));
        const continuationEmbeds = (cache.continuationEmbeds ?? []).map((e) =>
          EmbedBuilder.from(e),
        );
        render = { ok: true, firstEmbeds, continuationEmbeds };
      } catch {
        render = {
          ok: false,
          errorEmbeds: [infoEmbed('War logs unavailable', 'Publish cache was invalid.')],
        };
      }
    } else {
      render = {
        ok: false,
        errorEmbeds: [infoEmbed('War logs unavailable', 'Publish cache not found.')],
      };
    }
  } else {
    render = {
      ok: false,
      errorEmbeds: [infoEmbed('War logs unavailable', 'Publish cache not found.')],
    };
  }

  if (!render.ok) {
    try {
      render = await renderWarStatsEmbeds(ctx, parsed, null);
    } catch {
      await interaction.followUp({
        content: 'Failed to build war logs right now. Try again shortly.',
        ephemeral: true,
      });
      return;
    }
  } else if (token) {
    // Consume cache after successful reuse to keep job_state small.
    try {
      deletePublishCache(ctx, token);
    } catch {
      // ignore
    }
  }

  if (!render.ok) {
    try {
      await interaction.editReply({ embeds: render.errorEmbeds, components: [] });
    } catch {
      // ignore
    }
    return;
  }

  const commandName = (interaction.message as any)?.interaction?.commandName ?? 'warlogs';
  const first = await interaction.channel.send({
    content: `*${interaction.user.toString()}* used **/${commandName}**:\n`,
    embeds: render.firstEmbeds,
  });
  for (const e of render.continuationEmbeds) {
    await interaction.channel.send({ embeds: [e] });
  }

  try {
    await interaction.editReply({ content: 'Posted publicly.', embeds: [], components: [] });
  } catch {
    // ignore
  }
}

function readSnapshotHistory(ctx: AppContext): SnapshotHistoryEntry[] {
  const raw = ctx.db
    .prepare('SELECT value FROM job_state WHERE key = ?')
    .get('war:day_snapshot:history') as { value: string } | undefined;
  if (!raw?.value) return [];
  try {
    const arr = JSON.parse(raw.value);
    return Array.isArray(arr) ? (arr as SnapshotHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function snapshotRecordToMap(rec: Record<string, ParticipantSnapshot> | undefined) {
  const out = new Map<string, ParticipantSnapshot>();
  if (!rec) return out;
  for (const [tag, snap] of Object.entries(rec)) {
    const norm = normalizeTagUpper(tag);
    if (!norm) continue;
    out.set(norm, snap ?? {});
  }
  return out;
}

function resolveParticipantsForRef(
  ctx: AppContext,
  ref: ParsedDayRef,
  liveParticipants: Map<string, ParticipantSnapshot>,
): ResolvedParticipants {
  if (ref.kind === 'live' || ref.kind === 'prepDay') {
    const label = ref.kind === 'prepDay' ? 'Prep day' : 'Live';
    return { label, participants: liveParticipants, source: 'live' };
  }

  const history = readSnapshotHistory(ctx)
    .filter((e) => e && typeof e.endAtIso === 'string' && e.snapshot)
    .map((e) => {
      const t = new Date(String(e.endAtIso)).getTime();
      return { e, t: Number.isFinite(t) ? t : NaN };
    })
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => b.t - a.t);

  const haveSnapshots = history.length > 0;

  const missingSnapshot = (requestLabel: string): ResolvedParticipants => {
    return {
      label: requestLabel,
      source: 'snapshot',
      note: 'No saved snapshot found for that historical request yet. This bot can only show past war-day participation if it was running near the end of that war day and captured a snapshot.',
    };
  };

  if (!haveSnapshots) {
    return missingSnapshot(ref.kind === 'latest' ? 'latest war day' : 'snapshot');
  }

  if (ref.kind === 'latest') {
    const picked = history[0];
    if (!picked) return missingSnapshot('latest war day');
    const dayIdx = typeof picked.e.dayIndex === 'number' ? picked.e.dayIndex : undefined;
    const pt =
      typeof picked.e.periodType === 'string'
        ? picked.e.periodType.trim().toLowerCase()
        : undefined;
    const base = pt === 'colosseum' ? 'Colosseum day' : 'War day';
    const dayLabel = dayIdx ? `${base} ${dayIdx}` : pt === 'colosseum' ? 'Colosseum' : 'War day';
    return {
      label: `Latest — ${dayLabel}`,
      participants: snapshotRecordToMap(picked.e.snapshot as any),
      warDayIndex: dayIdx,
      periodType: typeof picked.e.periodType === 'string' ? picked.e.periodType : undefined,
      snapshotEndAtMs: picked.t,
      source: 'snapshot',
    };
  }

  if (ref.kind === 'warDay') {
    const matches = history.filter(
      (x) => (typeof x.e.dayIndex === 'number' ? x.e.dayIndex : undefined) === ref.day,
    );
    const picked = matches[0];
    if (!picked) return missingSnapshot(`war day ${ref.day}`);
    const pt =
      typeof picked.e.periodType === 'string'
        ? picked.e.periodType.trim().toLowerCase()
        : undefined;
    const base = pt === 'colosseum' ? 'Colosseum day' : 'War day';
    return {
      label: `${base} ${ref.day}`,
      participants: snapshotRecordToMap(picked.e.snapshot as any),
      warDayIndex: ref.day,
      periodType: typeof picked.e.periodType === 'string' ? picked.e.periodType : undefined,
      snapshotEndAtMs: picked.t,
      source: 'snapshot',
    };
  }

  // daysAgo -> pick closest snapshot to now - N days.
  const target = Date.now() - ref.days * 24 * 60 * 60 * 1000;
  let best: { e: SnapshotHistoryEntry; t: number; diff: number } | undefined;
  for (const x of history) {
    const diff = Math.abs(x.t - target);
    if (!best || diff < best.diff) best = { e: x.e, t: x.t, diff };
  }

  // Guard: if the closest snapshot is extremely far away, treat as missing.
  const MAX_DIFF_MS = 36 * 60 * 60 * 1000;
  if (!best || best.diff > MAX_DIFF_MS) {
    return missingSnapshot(`${ref.days} days ago`);
  }

  const dayIdx = typeof best.e.dayIndex === 'number' ? best.e.dayIndex : undefined;
  const pt =
    typeof best.e.periodType === 'string' ? best.e.periodType.trim().toLowerCase() : undefined;
  const base = pt === 'colosseum' ? 'Colosseum day' : 'War day';
  const dayLabel = dayIdx ? `${base} ${dayIdx}` : pt === 'colosseum' ? 'Colosseum' : 'War day';
  return {
    label: `${ref.days} days ago — ${dayLabel}`,
    participants: snapshotRecordToMap(best.e.snapshot as any),
    warDayIndex: dayIdx,
    periodType: typeof best.e.periodType === 'string' ? best.e.periodType : undefined,
    snapshotEndAtMs: best.t,
    source: 'snapshot',
  };
}

export const WarStatsCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('warstats')
    .setDescription('Show live clan war stats and participation summary (war-logs only).')
    .addStringOption((o) =>
      o
        .setName('day')
        .setDescription("Relative day (e.g. '2 days ago', 'war day 4', 'prep day 1')")
        .setRequired(false),
    ),

  async execute(ctx: AppContext, interaction: ChatInputCommandInteraction) {
    if (!interaction.inGuild()) return;

    if (!interaction.channel) {
      await interaction.reply({
        content: 'This command must be run in a server text channel.',
        ephemeral: true,
      });
      return;
    }

    const baseChannelId = interaction.channel.isThread()
      ? interaction.channel.parentId
      : interaction.channel.type === ChannelType.GuildText
        ? interaction.channel.id
        : null;

    if (!baseChannelId) {
      await interaction.reply({
        content: 'This command must be run in a server text channel.',
        ephemeral: true,
      });
      return;
    }

    const allowed = baseChannelId === ctx.cfg.CHANNEL_WAR_LOGS_ID;

    if (!allowed) {
      await interaction.reply({
        content: `Please run this in <#${ctx.cfg.CHANNEL_WAR_LOGS_ID}>.`,
        ephemeral: true,
      });
      return;
    }

    // Keep stats clean & non-intrusive in the war-logs channel.
    await interaction.deferReply({ ephemeral: true });

    const dayArg = interaction.options.getString('day');
    const parsed = dayArg ? parseRelativeDayInput(dayArg) : null;

    // Fetch once for rendering.
    const [payload, log, roster] = await Promise.all([
      ctx.clash.getCurrentRiverRace(ctx.cfg.CLASH_CLAN_TAG, { cacheBust: true }),
      ctx.clash.getRiverRaceLog(ctx.cfg.CLASH_CLAN_TAG, { cacheBust: true }),
      ctx.clash.getClanMembers(ctx.cfg.CLASH_CLAN_TAG).catch(() => []),
    ]);

    const render = renderWarStatsEmbedsFromData(ctx, {
      parsed,
      dayArgRaw: dayArg,
      payload,
      log,
      roster,
    });
    if (!render.ok) {
      await interaction.editReply({ embeds: render.errorEmbeds });
      return;
    }

    const customId = warstatsPublishCustomId(interaction.user.id, parsed);
    const parts = customId.split(':');
    const token = parts[5] ?? '';
    if (token) {
      try {
        const kind = parsed?.kind ?? 'default';
        const n =
          parsed &&
          (parsed.kind === 'daysAgo' || parsed.kind === 'warDay' || parsed.kind === 'prepDay')
            ? parsed.kind === 'daysAgo'
              ? parsed.days
              : parsed.day
            : 0;
        writePublishCache(ctx, token, {
          invokerUserId: interaction.user.id,
          createdAtIso: new Date().toISOString(),
          parsedKind: kind,
          parsedN: n,
          firstEmbeds: render.firstEmbeds.map((e) => e.toJSON()),
          continuationEmbeds: render.continuationEmbeds.map((e) => e.toJSON()),
        });
      } catch {
        // ignore cache failures; publish button will fall back to re-render.
      }
    }
    const row = buildWarstatsPublishRow(customId);

    await interaction.editReply({ embeds: render.firstEmbeds, components: [row] });

    for (const e of render.continuationEmbeds) {
      await interaction.followUp({ ephemeral: true, embeds: [e] });
    }
  },
};

export const WarLogsCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('warlogs')
    .setDescription('Alias of /warstats.')
    .addStringOption((o) =>
      o
        .setName('day')
        .setDescription("Relative day (e.g. '2 days ago', 'war day 4', 'prep day 1')")
        .setRequired(false),
    ),
  async execute(ctx: AppContext, interaction: ChatInputCommandInteraction) {
    return await WarStatsCommand.execute(ctx, interaction);
  },
};
