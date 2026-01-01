import {
  ChannelType,
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { SlashCommand } from './commands.js';
import type { AppContext } from '../types.js';
import { chunkLinesForEmbed, infoEmbed } from './ui.js';

type ParticipantSnapshot = {
  decksUsed?: number;
  fame?: number;
  repairs?: number;
  boatAttacks?: number;
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
  source: 'snapshot' | 'live';
  note?: string;
};

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
    });
  }
  return out;
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return '0%';
  return `${n.toFixed(1)}%`;
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
  return (
    toFiniteInt(payload?.periodIndex) ??
    toFiniteInt(payload?.dayIndex) ??
    toFiniteInt(payload?.warDay) ??
    toFiniteInt(payload?.sectionIndex)
  );
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
    if (Number.isFinite(day) && day >= 1 && day <= 4) return { kind: 'warDay', day };
  }

  return null;
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
    const label = ref.kind === 'prepDay' ? `prep day ${ref.day}` : 'live';
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
    const endAt = new Date(picked.t);
    const dayIdx = typeof picked.e.dayIndex === 'number' ? picked.e.dayIndex : undefined;
    const dayLabel = dayIdx && dayIdx >= 1 && dayIdx <= 4 ? `war day ${dayIdx}` : 'war day';
    return {
      label: `${dayLabel} (snapshot ending ${endAt.toLocaleString()})`,
      participants: snapshotRecordToMap(picked.e.snapshot as any),
      source: 'snapshot',
    };
  }

  if (ref.kind === 'warDay') {
    const matches = history.filter(
      (x) => (typeof x.e.dayIndex === 'number' ? x.e.dayIndex : undefined) === ref.day,
    );
    const picked = matches[0];
    if (!picked) return missingSnapshot(`war day ${ref.day}`);
    const endAt = new Date(picked.t);
    return {
      label: `war day ${ref.day} (snapshot ending ${endAt.toLocaleString()})`,
      participants: snapshotRecordToMap(picked.e.snapshot as any),
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

  const endAt = new Date(best.t);
  const dayIdx = typeof best.e.dayIndex === 'number' ? best.e.dayIndex : undefined;
  const dayLabel = dayIdx && dayIdx >= 1 && dayIdx <= 4 ? `war day ${dayIdx}` : 'snapshot';
  return {
    label: `${ref.days} days ago (${dayLabel}, ending ${endAt.toLocaleString()})`,
    participants: snapshotRecordToMap(best.e.snapshot as any),
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

    if (dayArg && !parsed) {
      await interaction.editReply({
        embeds: [
          infoEmbed(
            'Invalid day format',
            "I couldn't understand that `day` value. Try one of: `live`, `yesterday`, `2 days ago`, `war day 4`, `wd4`, `last`, `prep day 1`.",
          ),
        ],
      });
      return;
    }

    const [payload, log, roster] = await Promise.all([
      ctx.clash.getCurrentRiverRace(ctx.cfg.CLASH_CLAN_TAG),
      ctx.clash.getRiverRaceLog(ctx.cfg.CLASH_CLAN_TAG),
      ctx.clash.getClanMembers(ctx.cfg.CLASH_CLAN_TAG).catch(() => []),
    ]);

    const currentDayIndex = inferCurrentDayIndex(payload);
    const liveParticipants = extractParticipants(payload);
    const resolved = parsed
      ? resolveParticipantsForRef(ctx, parsed, liveParticipants)
      : ({ label: 'live', participants: liveParticipants, source: 'live' } as ResolvedParticipants);
    const participants = resolved.participants;

    if (!participants || participants.size === 0) {
      await interaction.editReply({
        embeds: [
          infoEmbed(
            'No war participant data available',
            resolved.note ??
              'I could not find a saved snapshot for that request, and the live API response did not include participants.',
          ),
        ],
      });
      return;
    }

    const nameByTag = new Map<string, string>();
    for (const m of roster) {
      const tag = normalizeTagUpper(m.tag);
      if (tag) nameByTag.set(tag, m.name);
    }

    if (ctx.cfg.WARLOGS_DEBUG) {
      const debugTargets = ctx.cfg.WARLOGS_DEBUG_PLAYERS.split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const periodType = typeof payload?.periodType === 'string' ? payload.periodType : undefined;
      const idx =
        (typeof payload?.periodIndex !== 'undefined' ? payload.periodIndex : undefined) ??
        (typeof payload?.dayIndex !== 'undefined' ? payload.dayIndex : undefined) ??
        (typeof payload?.warDay !== 'undefined' ? payload.warDay : undefined) ??
        (typeof payload?.sectionIndex !== 'undefined' ? payload.sectionIndex : undefined);

      const rawParticipants: any[] = Array.isArray(payload?.clan?.participants)
        ? payload.clan.participants
        : [];
      const sampleTags = rawParticipants
        .slice(0, 10)
        .map((p) => normalizeTagUpper(p?.tag ?? p?.playerTag ?? p?.memberTag) ?? '(missing tag)');

      console.log(
        '[warlogs debug] periodType=%s idx=%s participants=%d sampleTags=%j',
        periodType ?? '(unknown)',
        idx ?? '(unknown)',
        rawParticipants.length,
        sampleTags,
      );

      if (debugTargets.length) {
        const rosterByName = new Map<string, { tag: string; name: string }>();
        for (const m of roster) {
          const t = normalizeTagUpper(m.tag);
          if (!t) continue;
          rosterByName.set(normalizeName(m.name), { tag: t, name: m.name });
        }

        for (const targetName of debugTargets) {
          const rosterHit = rosterByName.get(normalizeName(targetName));
          if (!rosterHit) {
            console.log('[warlogs debug] roster lookup failed for name=%j', targetName);
            continue;
          }

          const raw = findRawParticipantByTag(payload, rosterHit.tag);
          const snap = participants.get(rosterHit.tag);
          const decks = snap?.decksUsed ?? 0;
          const fame = snap?.fame ?? 0;
          const repairs = snap?.repairs ?? 0;
          const boatAttacks = snap?.boatAttacks ?? 0;
          const wouldBeNoBattles = decks <= 0 && fame <= 0 && repairs <= 0 && boatAttacks <= 0;
          console.log(
            '[warlogs debug] player=%s tag=%s inParticipantsMap=%s decks=%s fame=%s repairs=%s rawKeys=%j',
            rosterHit.name,
            rosterHit.tag,
            String(Boolean(snap)),
            String(snap?.decksUsed ?? '(none)'),
            String(snap?.fame ?? '(none)'),
            String(snap?.repairs ?? '(none)'),
            raw ? Object.keys(raw) : '(no raw participant entry)',
          );
          console.log(
            '[warlogs debug] computed wouldBeNoBattles=%s (decks=%s fame=%s repairs=%s boatAttacks=%s)',
            String(wouldBeNoBattles),
            String(decks),
            String(fame),
            String(repairs),
            String(boatAttacks),
          );
          if (raw) {
            console.log(
              '[warlogs debug] raw decksUsed=%s decksUsedToday=%s decksUsedThisDay=%s',
              String(raw?.decksUsed ?? '(missing)'),
              String(raw?.decksUsedToday ?? '(missing)'),
              String(raw?.decksUsedThisDay ?? '(missing)'),
            );
            console.log('[warlogs debug] rawParticipant=%j', raw);
          }
        }
      }
    }

    const items: any[] = Array.isArray(log?.items) ? log.items : [];
    const clanTag = ctx.cfg.CLASH_CLAN_TAG.toUpperCase();

    const warsInLog = items.length;
    let wins = 0;
    let losses = 0;

    for (const it of items) {
      const standings: any[] = Array.isArray(it?.standings) ? it.standings : [];
      const ours = standings.find((s) => String(s?.clan?.tag ?? '').toUpperCase() === clanTag);
      const rank = typeof ours?.rank === 'number' ? ours.rank : undefined;
      if (!rank) continue;
      if (rank === 1) wins += 1;
      else losses += 1;
    }

    // If ranks were missing, fall back to losses = total - wins.
    if (wins + losses === 0 && warsInLog > 0) {
      losses = warsInLog - wins;
    }

    const winPct = warsInLog > 0 ? (wins / warsInLog) * 100 : 0;

    const recordedWars = (
      ctx.db.prepare('SELECT COUNT(*) AS n FROM war_history WHERE clan_tag = ?').get(clanTag) as
        | { n: number }
        | undefined
    )?.n;

    const recordedAgg = ctx.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN rank = 1 THEN 1 ELSE 0 END), 0) AS wins,
           COALESCE(SUM(CASE WHEN rank IS NOT NULL AND rank <> 1 THEN 1 ELSE 0 END), 0) AS losses
         FROM war_history
         WHERE clan_tag = ?`,
      )
      .get(clanTag) as { wins: number; losses: number } | undefined;

    const recordedWins = recordedAgg?.wins ?? 0;
    const recordedLosses = recordedAgg?.losses ?? 0;
    const recordedCount = recordedWars ?? 0;
    const recordedWinPct = recordedCount > 0 ? (recordedWins / recordedCount) * 100 : 0;

    const embed = new EmbedBuilder()
      .setTitle('War Stats')
      .setDescription(`As of ${new Date().toLocaleString()}`)
      .addFields(
        { name: 'Recorded wars', value: String(recordedCount), inline: true },
        { name: 'W-L (recorded)', value: `${recordedWins}-${recordedLosses}`, inline: true },
        { name: 'Win % (recorded)', value: pct(recordedWinPct), inline: true },
        { name: 'Wars in API log', value: `${warsInLog} (latest only)`, inline: true },
        { name: 'W-L (log)', value: `${wins}-${losses}`, inline: true },
        { name: 'Win % (log)', value: pct(winPct), inline: true },
      );

    if (parsed) {
      embed.addFields({
        name: 'Requested',
        value: `${dayArg} → ${resolved.label}`,
        inline: false,
      });
    }
    embed.addFields({
      name: 'Data source',
      value: resolved.source === 'snapshot' ? 'Saved snapshot' : 'Live API',
      inline: true,
    });
    if (resolved.note) {
      embed.addFields({ name: 'Note', value: resolved.note, inline: false });
    }

    if (warsInLog > 0) {
      embed.setFooter({
        text: 'Recorded wars accumulate from when this bot started tracking. Clash /riverracelog only returns the latest 10 wars; lifetime totals are not exposed.',
      });
    }

    const lines: string[] = [];
    const noBattles: string[] = [];

    const tags = roster.length
      ? roster.map((m) => normalizeTagUpper(m.tag)).filter((t): t is string => Boolean(t))
      : Array.from(participants.keys());
    const scored = tags.map((tag) => {
      const snap = participants.get(tag) ?? {};
      const fame = snap.fame ?? 0;
      const decks = snap.decksUsed ?? 0;
      return { tag, fame, decks };
    });

    scored.sort((a, b) => (b.fame ?? 0) - (a.fame ?? 0) || (b.decks ?? 0) - (a.decks ?? 0));

    for (const { tag, fame, decks } of scored) {
      const name = nameByTag.get(tag) ?? tag;
      lines.push(`• **${name}**: ${fame} points`);
      const snap = participants.get(tag) ?? {};
      const repairs = snap.repairs ?? 0;
      const boatAttacks = snap.boatAttacks ?? 0;
      if ((decks ?? 0) <= 0 && (fame ?? 0) <= 0 && repairs <= 0 && boatAttacks <= 0)
        noBattles.push(`${name}`);
    }

    const participationChunks = chunkLinesForEmbed(lines);
    const noBattlesText = noBattles.length ? noBattles.join(', ') : '(none)';

    const participationTitle = parsed
      ? `Participation (${resolved.label})`
      : currentDayIndex && typeof currentDayIndex === 'number'
        ? `Participation (today, day ${currentDayIndex})`
        : 'Participation (today)';

    const firstParticipation = infoEmbed(
      participationTitle,
      participationChunks[0] + `\n\n**No battles:** ${noBattlesText}`,
    );

    await interaction.editReply({ embeds: [embed, firstParticipation] });

    for (const extra of participationChunks.slice(1)) {
      await interaction.followUp({
        ephemeral: true,
        embeds: [infoEmbed('Participation (cont.)', extra)],
      });
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
