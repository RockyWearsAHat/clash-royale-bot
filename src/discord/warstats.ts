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

export const WarStatsCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('warstats')
    .setDescription('Show live clan war stats and participation summary (war-logs only).'),

  async execute(ctx: AppContext, interaction: ChatInputCommandInteraction) {
    if (!interaction.inGuild()) return;

    if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
      await interaction.reply({
        content: 'This command must be run in a server text channel.',
        ephemeral: true,
      });
      return;
    }

    if (interaction.channel.id !== ctx.cfg.CHANNEL_WAR_LOGS_ID) {
      await interaction.reply({
        content: `Please run this in <#${ctx.cfg.CHANNEL_WAR_LOGS_ID}>.`,
        ephemeral: true,
      });
      return;
    }

    // Keep stats clean & non-intrusive in the war-logs channel.
    await interaction.deferReply({ ephemeral: true });

    const [payload, log, roster] = await Promise.all([
      ctx.clash.getCurrentRiverRace(ctx.cfg.CLASH_CLAN_TAG),
      ctx.clash.getRiverRaceLog(ctx.cfg.CLASH_CLAN_TAG),
      ctx.clash.getClanMembers(ctx.cfg.CLASH_CLAN_TAG).catch(() => []),
    ]);

    const participants = extractParticipants(payload);

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

    const firstParticipation = infoEmbed(
      'Participation (today)',
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
  data: new SlashCommandBuilder().setName('warlogs').setDescription('Alias of /warstats.'),
  async execute(ctx: AppContext, interaction: ChatInputCommandInteraction) {
    return await WarStatsCommand.execute(ctx, interaction);
  },
};
