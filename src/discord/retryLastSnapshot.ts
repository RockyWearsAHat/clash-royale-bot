import { ChannelType, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommand } from './commands.js';
import type { AppContext } from '../types.js';
import { infoEmbed } from './ui.js';
import { renderWarLogsEmbedsForSnapshot } from './warstats.js';

type SnapshotHistoryEntry = {
  key?: string;
  endAtIso?: string;
  periodType?: string;
  dayIndex?: number;
  snapshot?: Record<string, any>;
};

function inferColosseumDayIndexFromSnapshot(snapshot: Record<string, any>): number | undefined {
  const entries = Object.values(snapshot ?? {});
  if (!entries.length) return undefined;

  let maxTotal = 0;
  let maxToday = 0;
  let anyTodayObserved = false;

  for (const snap of entries) {
    const totalRaw = (snap as any)?.decksUsed;
    const total = typeof totalRaw === 'number' && Number.isFinite(totalRaw) ? totalRaw : 0;
    if (total > maxTotal) maxTotal = total;

    const todayRaw = (snap as any)?.decksUsedToday;
    const todayDefined = typeof todayRaw === 'number' && Number.isFinite(todayRaw);
    if (todayDefined) anyTodayObserved = true;
    const today = todayDefined ? (todayRaw as number) : 0;
    if (today > maxToday) maxToday = today;
  }

  const isResetBoundary = anyTodayObserved && maxToday === 0 && maxTotal > 0 && maxTotal % 4 === 0;
  const inferred = isResetBoundary
    ? Math.floor(maxTotal / 4) + 1
    : Math.max(1, Math.ceil((maxTotal || 1) / 4));

  if (!Number.isFinite(inferred)) return undefined;
  const i = Math.trunc(inferred);
  if (i < 1 || i > 5) return undefined;
  return i;
}

function getBaseChannelId(interaction: { channel: any }): string | null {
  const ch = interaction.channel;
  if (!ch) return null;
  return ch.isThread() ? ch.parentId : ch.type === ChannelType.GuildText ? ch.id : null;
}

function readLatestSnapshotHistoryEntry(ctx: AppContext): SnapshotHistoryEntry | null {
  const raw = ctx.db
    .prepare('SELECT value FROM job_state WHERE key = ?')
    .get('war:day_snapshot:history') as { value: string } | undefined;

  if (!raw?.value) return null;

  let arr: any;
  try {
    arr = JSON.parse(raw.value);
  } catch {
    return null;
  }

  if (!Array.isArray(arr) || arr.length === 0) return null;

  const entries: SnapshotHistoryEntry[] = arr.filter((e) => e && typeof e === 'object');
  if (!entries.length) return null;

  // Prefer latest by endAtIso timestamp.
  const sorted = entries
    .map((e) => {
      const t = e.endAtIso ? new Date(String(e.endAtIso)).getTime() : NaN;
      return { e, t: Number.isFinite(t) ? t : -Infinity };
    })
    .sort((a, b) => b.t - a.t);

  return sorted[0]?.e ?? null;
}

function filterOutWarOverview(embeds: EmbedBuilder[]): EmbedBuilder[] {
  return embeds.filter((e) => {
    try {
      const title = (e as any)?.toJSON?.()?.title ?? '';
      return String(title) !== 'War Overview';
    } catch {
      return true;
    }
  });
}

export const RetryLastSnapshotCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('retrylastsnapshot')
    .setDescription('Re-post the most recent saved war-day snapshot (war-logs only).'),

  async execute(ctx: AppContext, interaction: ChatInputCommandInteraction) {
    if (!interaction.inGuild()) return;

    if (!interaction.channel || !interaction.channel.isTextBased()) {
      await interaction.reply({
        ephemeral: true,
        embeds: [infoEmbed('Not a text channel', 'Run this in the war-logs channel.')],
      });
      return;
    }

    const baseChannelId = getBaseChannelId(interaction);
    if (!baseChannelId || baseChannelId !== ctx.cfg.CHANNEL_WAR_LOGS_ID) {
      await interaction.reply({
        ephemeral: true,
        content: `Please run this in <#${ctx.cfg.CHANNEL_WAR_LOGS_ID}>.`,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const latest = readLatestSnapshotHistoryEntry(ctx);
    if (!latest?.snapshot || !latest.endAtIso) {
      await interaction.editReply({
        embeds: [
          infoEmbed(
            'No snapshot found',
            'There is no saved snapshot yet. The bot must be running near the end of a war day to capture one.',
          ),
        ],
      });
      return;
    }

    const endAt = new Date(String(latest.endAtIso));
    if (!Number.isFinite(endAt.getTime())) {
      await interaction.editReply({
        embeds: [infoEmbed('Snapshot invalid', 'The saved snapshot timestamp was invalid.')],
      });
      return;
    }

    const roster = await ctx.clash.getClanMembers(ctx.cfg.CLASH_CLAN_TAG).catch(() => []);

    // Minimal payload is fine because we supply a snapshot override.
    const payload = {
      periodType: latest.periodType,
    } as any;

    const pt = typeof latest.periodType === 'string' ? latest.periodType.trim().toLowerCase() : '';
    const dayIndex =
      pt === 'colosseum'
        ? inferColosseumDayIndexFromSnapshot(latest.snapshot)
        : typeof latest.dayIndex === 'number'
          ? latest.dayIndex
          : undefined;

    const render = await renderWarLogsEmbedsForSnapshot(
      ctx,
      {
        payload,
        log: null,
        roster,
        snapshot: latest.snapshot,
        snapshotEndAt: endAt,
        warDayIndex: dayIndex,
        periodType: latest.periodType,
      },
      { includeRecord: false },
    );

    if (!render.ok) {
      await interaction.editReply({ embeds: render.errorEmbeds });
      return;
    }

    const channel = interaction.channel;
    const first = filterOutWarOverview(render.firstEmbeds);

    await channel.send({
      content: `*${interaction.user.toString()}* used **/retrylastsnapshot**:\n`,
      embeds: first,
    });
    for (const e of render.continuationEmbeds) {
      await channel.send({ embeds: [e] });
    }

    await interaction.editReply({
      embeds: [infoEmbed('Posted', 'Re-posted the most recent saved snapshot.')],
    });
  },
};
