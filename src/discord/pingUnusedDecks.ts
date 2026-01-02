import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { AppContext } from '../types.js';
import { errorEmbed, safeReply } from './ui.js';

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

type ParticipantSnapshot = {
  tag: string;
  name?: string;
  decksUsedToday?: number;
};

function extractParticipants(payload: any): ParticipantSnapshot[] {
  const participants = payload?.clan?.participants;
  if (!Array.isArray(participants)) return [];

  const out: ParticipantSnapshot[] = [];
  for (const p of participants) {
    const tag = normalizeTagUpper(p?.tag ?? p?.playerTag ?? p?.memberTag);
    if (!tag) continue;

    const decksUsedToday = pickMaxNumber(p, [
      'decksUsedToday',
      'decksUsedThisDay',
      'decksUsedInDay',
      'decksUsedThisPeriodToday',
    ]);

    const name = typeof p?.name === 'string' && p.name.trim() ? p.name.trim() : undefined;

    out.push({ tag, name, decksUsedToday });
  }
  return out;
}

function clampNonNegativeInt(n: number | undefined): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n as number));
}

function inferIsWarDay(payload: any): boolean {
  const periodTypeRaw = typeof payload?.periodType === 'string' ? payload.periodType : undefined;
  const periodType = periodTypeRaw?.trim().toLowerCase();
  if (periodType === 'warday') return true;
  if (periodType === 'colosseum') return true;
  if (periodType === 'training' || periodType === 'prepday') return false;
  if (periodType && periodType.includes('war')) return true;

  // Heuristic fallback: if we see any decksUsedToday field, assume we're on a battle day.
  const participants = extractParticipants(payload);
  for (const p of participants) {
    if (typeof p.decksUsedToday === 'number' && Number.isFinite(p.decksUsedToday)) return true;
  }
  return false;
}

function chunkMentions(mentions: string[], header: string, maxLen = 1900): string[] {
  const chunks: string[] = [];
  let cur = header;

  for (const m of mentions) {
    const next = cur ? `${cur} ${m}` : m;
    if (next.length > maxLen) {
      if (cur) chunks.push(cur);
      cur = `${header} ${m}`.trim();
    } else {
      cur = next;
    }
  }

  if (cur) chunks.push(cur);
  return chunks;
}

export const PingUnusedDecksCommand = {
  data: new SlashCommandBuilder()
    .setName('pingunuseddecks')
    .setDescription('Ping linked members who still have war decks remaining today.')
    .addStringOption((opt) =>
      opt
        .setName('message')
        .setDescription('Announcement message appended after the pings.')
        .setRequired(false),
    ),

  async execute(ctx: AppContext, interaction: ChatInputCommandInteraction) {
    if (!interaction.inGuild() || !interaction.guild) {
      await safeReply(interaction, {
        ephemeral: true,
        embeds: [errorEmbed('Guild only', 'This command can only be used inside the server.')],
      });
      return;
    }

    // Hard gate: only allow this command in the announcements channel itself.
    if (interaction.channelId !== ctx.cfg.CHANNEL_ANNOUNCEMENTS_ID) {
      await safeReply(interaction, {
        ephemeral: true,
        embeds: [
          errorEmbed(
            'Wrong channel',
            `Use this command in <#${ctx.cfg.CHANNEL_ANNOUNCEMENTS_ID}>.`,
          ),
        ],
      });
      return;
    }

    // Permission gate: invoker must be able to send messages in the announcements channel.
    const announcements = await interaction.guild.channels
      .fetch(ctx.cfg.CHANNEL_ANNOUNCEMENTS_ID)
      .catch(() => null);

    if (!announcements || announcements.type !== ChannelType.GuildText) {
      await safeReply(interaction, {
        ephemeral: true,
        embeds: [
          errorEmbed(
            'Announcements channel missing',
            `I can\'t find the announcements channel (CHANNEL_ANNOUNCEMENTS_ID=${ctx.cfg.CHANNEL_ANNOUNCEMENTS_ID}).`,
          ),
        ],
      });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const perms = member ? announcements.permissionsFor(member) : null;
    const canSend = Boolean(
      perms?.has(PermissionFlagsBits.ViewChannel) && perms?.has(PermissionFlagsBits.SendMessages),
    );

    if (!canSend) {
      await safeReply(interaction, {
        ephemeral: true,
        embeds: [
          errorEmbed(
            'Not allowed',
            'You must be able to send messages in the announcements channel to use this command.',
          ),
        ],
      });
      return;
    }

    const rawMessage = interaction.options.getString('message') ?? '';
    const message = rawMessage.trim()
      ? rawMessage.trim()
      : 'You have decks remaining in war, please get them done.';

    // Pull the live war payload.
    const payload = await ctx.clash
      .getCurrentRiverRace(ctx.cfg.CLASH_CLAN_TAG, { cacheBust: true })
      .catch((e) => {
        throw new Error(
          `Failed to fetch current river race: ${e instanceof Error ? e.message : String(e)}`,
        );
      });

    if (!inferIsWarDay(payload)) {
      await safeReply(interaction, {
        ephemeral: true,
        embeds: [
          errorEmbed(
            'Not a war day',
            'This only works during war battle days (when players have decks to use).',
          ),
        ],
      });
      return;
    }

    const participants = extractParticipants(payload);

    // Build tag->discord mapping (normalize tags to uppercase).
    const linkRows = ctx.db
      .prepare('SELECT discord_user_id, player_tag FROM user_links')
      .all() as Array<{ discord_user_id: string; player_tag: string }>;

    const tagToDiscord = new Map<string, string>();
    for (const row of linkRows) {
      const t = normalizeTagUpper(row.player_tag);
      if (!t) continue;
      tagToDiscord.set(t, row.discord_user_id);
    }

    const mentions: string[] = [];
    let missingLinks = 0;
    let unknownDecks = 0;

    for (const p of participants) {
      const used = p.decksUsedToday;
      if (used === undefined) {
        unknownDecks++;
        continue;
      }

      const usedInt = clampNonNegativeInt(used);
      const remaining = Math.max(0, 4 - usedInt);
      if (remaining <= 0) continue;

      const discordId = tagToDiscord.get(p.tag);
      if (!discordId) {
        missingLinks++;
        continue;
      }

      mentions.push(`<@${discordId}>`);
    }

    if (!mentions.length) {
      await safeReply(interaction, {
        ephemeral: true,
        content:
          'No linked users were found with decks remaining today.' +
          (missingLinks || unknownDecks
            ? ` (Missing links: ${missingLinks}, unknown deck counts: ${unknownDecks})`
            : ''),
      });
      return;
    }

    const chunks = chunkMentions(mentions, '', 1800);

    // Post to announcements channel (and confirm to invoker).
    for (let i = 0; i < chunks.length; i++) {
      const prefix = chunks[i].trim();
      const content = i === chunks.length - 1 ? `${prefix}\n\n${message}` : prefix;
      await announcements.send({ content });
    }

    await safeReply(interaction, {
      ephemeral: true,
      content:
        `Posted ${mentions.length} pings in announcements.` +
        (missingLinks || unknownDecks
          ? ` (Missing links: ${missingLinks}, unknown deck counts: ${unknownDecks})`
          : ''),
    });
  },
};
