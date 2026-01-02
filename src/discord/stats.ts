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
import { infoEmbed } from './ui.js';

function statsPublishCustomId(invokerUserId: string, playerTag: string): string {
  const tagNoHash = String(playerTag ?? '')
    .trim()
    .toUpperCase()
    .replace(/^#/, '');
  const token = randomUUID();
  return `publish:stats:${invokerUserId}:${tagNoHash}:${token}`;
}

type StatsPublishCache = {
  invokerUserId: string;
  createdAtIso: string;
  tagNoHash: string;
  embeds: any[];
};

function publishCacheKey(token: string): string {
  return `stats:publish_cache:${token}`;
}

function writePublishCache(ctx: AppContext, token: string, cache: StatsPublishCache) {
  ctx.db
    .prepare('INSERT OR REPLACE INTO job_state(key, value) VALUES(?, ?)')
    .run(publishCacheKey(token), JSON.stringify(cache));
}

function readPublishCache(ctx: AppContext, token: string): StatsPublishCache | null {
  const raw = ctx.db
    .prepare('SELECT value FROM job_state WHERE key = ?')
    .get(publishCacheKey(token)) as { value: string } | undefined;
  if (!raw?.value) return null;
  try {
    const obj = JSON.parse(raw.value);
    return obj && typeof obj === 'object' ? (obj as StatsPublishCache) : null;
  } catch {
    return null;
  }
}

function deletePublishCache(ctx: AppContext, token: string) {
  ctx.db.prepare('DELETE FROM job_state WHERE key = ?').run(publishCacheKey(token));
}

function buildStatsPublishRow(customId: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId)
      .setLabel(disabled ? 'Posted' : 'Post publicly')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

function getBaseChannelId(interaction: { channel: any }): string | null {
  const ch = interaction.channel;
  if (!ch) return null;
  return ch.isThread() ? ch.parentId : ch.type === ChannelType.GuildText ? ch.id : null;
}

function buildStatsEmbed(player: any): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('Player Stats');
  embed.setDescription(`**${player.name}** (${player.tag})`);

  embed.addFields(
    { name: 'Trophies', value: fmt(player.trophies), inline: true },
    { name: 'Best', value: fmt(player.bestTrophies), inline: true },
    { name: 'Level', value: fmt(player.expLevel), inline: true },
    { name: 'Wins', value: fmt(player.wins), inline: true },
    { name: 'Losses', value: fmt(player.losses), inline: true },
    { name: 'Battles', value: fmt(player.battleCount), inline: true },
    { name: '3-Crown Wins', value: fmt(player.threeCrownWins), inline: true },
    { name: 'Donations', value: fmt(player.donations), inline: true },
    { name: 'Received', value: fmt(player.donationsReceived), inline: true },
  );

  if (player.clan?.name) {
    embed.addFields({
      name: 'Clan',
      value: `${player.clan.name}${player.clan.role ? ` (${player.clan.role})` : ''}`,
      inline: false,
    });
  }

  return embed;
}

export async function handleStatsPublishButton(ctx: AppContext, interaction: ButtonInteraction) {
  const id = interaction.customId;
  if (!id.startsWith('publish:stats:')) return;

  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'This button must be used in a server.', ephemeral: true });
    return;
  }

  const parts = id.split(':');
  const invokerUserId = parts[2] ?? '';
  const tagPart = parts[3] ?? '';
  const token = parts[4] ?? '';

  if (!invokerUserId || interaction.user.id !== invokerUserId) {
    await interaction.reply({
      content: 'Only the user who ran the command can use this button.',
      ephemeral: true,
    });
    return;
  }

  const baseChannelId = getBaseChannelId(interaction);
  if (!baseChannelId || baseChannelId !== ctx.cfg.CHANNEL_GENERAL_ID) {
    await interaction.reply({
      content: `Please run /stats in <#${ctx.cfg.CHANNEL_GENERAL_ID}> to post publicly.`,
      ephemeral: true,
    });
    return;
  }

  if (!interaction.channel || !interaction.channel.isTextBased()) {
    await interaction.reply({ content: 'This must be used in a text channel.', ephemeral: true });
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

  const cacheTtlMs = 15 * 60_000;
  let embeds: EmbedBuilder[] | null = null;

  if (token) {
    const cache = readPublishCache(ctx, token);
    const createdAtMs = cache?.createdAtIso ? new Date(cache.createdAtIso).getTime() : NaN;
    const fresh = cache && Number.isFinite(createdAtMs) && Date.now() - createdAtMs <= cacheTtlMs;
    const invokerOk = cache?.invokerUserId === invokerUserId;
    const tagOk =
      cache?.tagNoHash ===
      String(tagPart ?? '')
        .trim()
        .toUpperCase();

    if (fresh && invokerOk && tagOk) {
      try {
        embeds = (cache.embeds ?? []).map((e) => EmbedBuilder.from(e));
      } catch {
        embeds = null;
      }
    }
  }

  if (!embeds || embeds.length === 0) {
    // Fall back to re-fetching (should be rare; e.g. cache expired or bot restarted).
    const tag = normalizeTag(tagPart);
    let player: any;
    try {
      player = await ctx.clash.getPlayer(tag);
    } catch {
      await interaction.followUp({
        content: `Could not fetch player data for **${tag}** right now. Try again shortly.`,
        ephemeral: true,
      });
      return;
    }
    embeds = [buildStatsEmbed(player)];
  } else if (token) {
    // Consume cache after successful reuse to keep job_state small.
    try {
      deletePublishCache(ctx, token);
    } catch {
      // ignore
    }
  }

  const commandName = (interaction.message as any)?.interaction?.commandName ?? 'stats';
  await interaction.channel.send({
    content: `*${interaction.user.toString()}* used **/${commandName}**:\n`,
    embeds,
  });

  try {
    await interaction.editReply({ content: 'Posted publicly.', embeds: [], components: [] });
  } catch {
    // ignore
  }
}

function fmt(n: unknown): string {
  return typeof n === 'number' && Number.isFinite(n) ? String(n) : '—';
}

function normalizeName(s: string): string {
  return String(s ?? '')
    .trim()
    .toLowerCase();
}

function looksLikeTag(s: string): boolean {
  const t = String(s ?? '').trim();
  if (!t) return false;
  const up = t.toUpperCase();
  return /^#?[0289PYLQGRJCUV]{5,}$/.test(up);
}

function normalizeTag(s: string): string {
  const up = String(s ?? '')
    .trim()
    .toUpperCase();
  if (!up) return up;
  return up.startsWith('#') ? up : `#${up}`;
}

async function resolveTargetTag(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<{ tag?: string; errorEmbed?: EmbedBuilder }> {
  const query = interaction.options.getString('player');

  // Default: self (linked user).
  if (!query) {
    const row = ctx.db
      .prepare('SELECT player_tag FROM user_links WHERE discord_user_id = ?')
      .get(interaction.user.id) as { player_tag: string } | undefined;

    if (!row?.player_tag) {
      return {
        errorEmbed: infoEmbed(
          'Not linked yet',
          'Your Discord account is not linked to a Clash Royale player tag.',
        ),
      };
    }
    return { tag: row.player_tag };
  }

  // 1) Name search within clan roster (exact -> partial).
  const roster = await ctx.clash.getClanMembers(ctx.cfg.CLASH_CLAN_TAG).catch(() => []);
  const needle = normalizeName(query);
  const exact = roster.filter((m) => normalizeName(m.name) === needle);
  const candidates = exact.length
    ? exact
    : roster.filter((m) => normalizeName(m.name).includes(needle));

  if (candidates.length > 1) {
    const shown = candidates.slice(0, 15);
    const list = shown.map((m) => `• ${m.name}`).join('\n');
    const more =
      candidates.length > shown.length ? `\n… (+${candidates.length - shown.length} more)` : '';
    return {
      errorEmbed: infoEmbed(
        'Ambiguous name',
        `Multiple clan members matched **${query}**. Try a more specific name.\n\n${list}${more}`,
      ),
    };
  }

  if (candidates.length === 1) {
    return { tag: candidates[0].tag };
  }

  // 2) If no name match, attempt tag lookup (no # required). Only if it looks like a valid tag.
  if (looksLikeTag(query)) {
    const tag = normalizeTag(query);
    const player = await ctx.clash.getPlayer(tag).catch(() => null);
    if (!player) {
      return { errorEmbed: infoEmbed('Not found', `Could not find a player for tag **${tag}**.`) };
    }
    return { tag: player.tag };
  }

  // 3) Neither name nor tag.
  return {
    errorEmbed: infoEmbed(
      'No match',
      `No clan member matched **${query}**, and it doesn't look like a valid player tag. Try a more specific name, or paste a tag (e.g. #ABC123).`,
    ),
  };
}

export const StatsCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show player stats (defaults to your linked account).')
    .addStringOption((o) =>
      o
        .setName('player')
        .setDescription('Clan member name (or a player tag like #ABC123)')
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

    if (baseChannelId !== ctx.cfg.CHANNEL_GENERAL_ID) {
      await interaction.reply({
        content: `Please run this in <#${ctx.cfg.CHANNEL_GENERAL_ID}>.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const resolved = await resolveTargetTag(ctx, interaction);
    if (!resolved.tag) {
      await interaction.editReply({ embeds: resolved.errorEmbed ? [resolved.errorEmbed] : [] });
      return;
    }

    const player = await ctx.clash.getPlayer(resolved.tag);

    const embed = buildStatsEmbed(player);
    const customId = statsPublishCustomId(interaction.user.id, player.tag);
    const parts = customId.split(':');
    const token = parts[4] ?? '';
    if (token) {
      try {
        const tagNoHash = String(player.tag ?? '')
          .trim()
          .toUpperCase()
          .replace(/^#/, '');
        writePublishCache(ctx, token, {
          invokerUserId: interaction.user.id,
          createdAtIso: new Date().toISOString(),
          tagNoHash,
          embeds: [embed.toJSON()],
        });
      } catch {
        // ignore cache failures; publish button will fall back to re-fetch.
      }
    }
    const row = buildStatsPublishRow(customId);

    await interaction.editReply({ embeds: [embed], components: [row] });
  },
};
