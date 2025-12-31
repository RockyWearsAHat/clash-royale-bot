import {
  ChannelType,
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { SlashCommand } from './commands.js';
import type { AppContext } from '../types.js';

type ParticipantSnapshot = { decksUsed?: number; fame?: number; repairs?: number };

function safeNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

function extractParticipants(payload: any): Map<string, ParticipantSnapshot> {
  const participants = payload?.clan?.participants;
  if (!Array.isArray(participants)) return new Map();

  const out = new Map<string, ParticipantSnapshot>();
  for (const p of participants) {
    const tag = typeof p?.tag === 'string' ? p.tag.toUpperCase() : undefined;
    if (!tag) continue;

    out.set(tag, {
      decksUsed: safeNumber(p.decksUsed ?? p.decksUsedToday ?? p.decksUsedThisDay),
      fame: safeNumber(p.fame),
      repairs: safeNumber(p.repairs),
    });
  }
  return out;
}

function pct(n: number): string {
  if (!Number.isFinite(n)) return '0%';
  return `${n.toFixed(1)}%`;
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

    await interaction.deferReply({ ephemeral: false });

    const [payload, log, roster] = await Promise.all([
      ctx.clash.getCurrentRiverRace(ctx.cfg.CLASH_CLAN_TAG),
      ctx.clash.getRiverRaceLog(ctx.cfg.CLASH_CLAN_TAG),
      ctx.clash.getClanMembers(ctx.cfg.CLASH_CLAN_TAG).catch(() => []),
    ]);

    const participants = extractParticipants(payload);

    const nameByTag = new Map<string, string>();
    for (const m of roster) nameByTag.set(m.tag.toUpperCase(), m.name);

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
      ? roster.map((m) => m.tag.toUpperCase())
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
      lines.push(`- ${name} (${tag}): ${fame} points`);
      if ((decks ?? 0) <= 0 && (fame ?? 0) <= 0) noBattles.push(`${name} (${tag})`);
    }

    const header = 'Current day participation (points):';
    const chunks = chunkLines(header, lines);
    await interaction.editReply({ embeds: [embed], content: chunks[0] });
    for (const extra of chunks.slice(1)) {
      await interaction.followUp({ content: extra });
    }

    await interaction.followUp({
      content: noBattles.length ? `No battles: ${noBattles.join(', ')}` : 'No battles: (none)',
    });
  },
};

export const WarLogsCommand: SlashCommand = {
  data: new SlashCommandBuilder().setName('warlogs').setDescription('Alias of /warstats.'),
  async execute(ctx: AppContext, interaction: ChatInputCommandInteraction) {
    return await WarStatsCommand.execute(ctx, interaction);
  },
};
