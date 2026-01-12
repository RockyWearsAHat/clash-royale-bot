import {
  ActionRowBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { randomUUID } from 'crypto';
import type { SlashCommand } from './commands.js';
import type { AppContext } from '../types.js';
import { ensureVerificationThreadForUser } from './join.js';
import { enforceUnlinkedMemberRoleReset } from './roleSync.js';
import { dbDeleteJobState, dbGetJobState, dbSetJobState } from '../db.js';

const STATE_TTL_MS = 15 * 60_000;

const stateKey = (token: string) => `admin_unlink:state:${token}`;

type AdminCandidate = {
  userId: string;
  playerTag: string;
  playerName?: string | null;
};

type AdminUnlinkState = {
  token: string;
  createdAt: number;
  invokerId: string;
  options: AdminCandidate[];
};

function normalizeName(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function extractCandidateStrings(displayName: string): string[] {
  const raw = String(displayName ?? '').trim();
  if (!raw) return [];

  const withoutParens = raw.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  const parts = withoutParens
    .split(/\||•|·|:|\/|\\|-|–|—/g)
    .map((p) => p.trim())
    .filter(Boolean);

  const candidates = new Set<string>();
  candidates.add(raw);
  if (parts[0]) candidates.add(parts[0]);
  if (withoutParens.trim()) candidates.add(withoutParens.trim());
  return [...candidates];
}

function normalizedCandidates(...strings: string[]): string[] {
  const merged: string[] = [];
  for (const s of strings) merged.push(...extractCandidateStrings(s));
  const out = new Set<string>();
  for (const s of merged) {
    const n = normalizeName(s);
    if (n) out.add(n);
    const stripped = n.replace(/\d+$/g, '');
    if (stripped) out.add(stripped);
  }
  return [...out];
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 0;
  const d = levenshtein(a, b);
  return 1 - d / maxLen;
}

function bestScore(queryNorms: string[], target: string | undefined | null): number {
  if (!target) return 0;
  const targetNorms = normalizedCandidates(target);
  if (!targetNorms.length) targetNorms.push(normalizeName(target));

  let best = 0;
  for (const q of queryNorms) {
    if (!q) continue;
    for (const t of targetNorms) {
      if (!t) continue;
      if (t.includes(q) || q.includes(t)) {
        best = Math.max(best, 0.99);
      } else {
        best = Math.max(best, similarity(q, t));
      }
    }
  }
  return best;
}

function truncateLabel(label: string, max = 90) {
  const trimmed = label.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function isAuthorized(member: GuildMember, ctx: AppContext): boolean {
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const allowed = [ctx.cfg.ROLE_LEADER_ID, ctx.cfg.ROLE_COLEADER_ID];
  return allowed.some((roleId) => roleId && member.roles.cache.has(roleId));
}

function writeState(ctx: AppContext, state: AdminUnlinkState) {
  dbSetJobState(ctx.db, stateKey(state.token), JSON.stringify(state));
}

function readState(ctx: AppContext, token: string): AdminUnlinkState | null {
  const raw = dbGetJobState(ctx.db, stateKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AdminUnlinkState;
  } catch {
    return null;
  }
}

function deleteState(ctx: AppContext, token: string) {
  dbDeleteJobState(ctx.db, stateKey(token));
}

async function unlinkDiscordUser(
  ctx: AppContext,
  client: import('discord.js').Client,
  userId: string,
): Promise<AdminCandidate | null> {
  const existing = ctx.db
    .prepare('SELECT player_tag, player_name FROM user_links WHERE discord_user_id = ?')
    .get(userId) as { player_tag: string; player_name?: string | null } | undefined;
  if (!existing) return null;

  ctx.db.prepare('DELETE FROM user_links WHERE discord_user_id = ?').run(userId);

  try {
    const guild = await client.guilds.fetch(ctx.cfg.GUILD_ID);
    const member = await guild.members.fetch(userId);
    await enforceUnlinkedMemberRoleReset(ctx, member);
  } catch {
    // ignore
  }

  // Ensure their verification/profile thread immediately reflects the
  // unlinked state so there is no confusing limbo.
  try {
    await ensureVerificationThreadForUser(ctx, client, userId);
  } catch {
    // ignore
  }

  return { userId, playerTag: existing.player_tag, playerName: existing.player_name };
}

export const AdminUnlinkCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('admin-unlink')
    .setDescription('Admin: unlink a user by Clash name')
    .addStringOption((opt) =>
      opt
        .setName('clash_name')
        .setDescription('Clash Royale player name to search')
        .setRequired(true),
    )
    .setDMPermission(false),
  async execute(ctx: AppContext, interaction: ChatInputCommandInteraction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'Run this inside the server.', ephemeral: true });
      return;
    }

    const guild = await interaction.client.guilds.fetch(ctx.cfg.GUILD_ID);
    const invoker = await guild.members.fetch(interaction.user.id);
    if (!isAuthorized(invoker, ctx)) {
      await interaction.reply({
        content: 'You are not allowed to run this command.',
        ephemeral: true,
      });
      return;
    }

    const query = interaction.options.getString('clash_name', true).trim();
    const queryNorms = normalizedCandidates(query);
    if (!queryNorms.length) {
      await interaction.reply({ content: 'Please provide a valid player name.', ephemeral: true });
      return;
    }

    const rows = ctx.db
      .prepare('SELECT discord_user_id, player_tag, player_name FROM user_links')
      .all() as Array<{ discord_user_id: string; player_tag: string; player_name?: string | null }>;

    const matches = rows
      .map((row) => ({
        userId: row.discord_user_id,
        playerTag: row.player_tag,
        playerName: row.player_name,
        score: bestScore(queryNorms, row.player_name),
      }))
      .filter((m) => m.score >= 0.7)
      .sort((a, b) => b.score - a.score)
      .slice(0, 25);

    if (!matches.length) {
      await interaction.reply({ content: 'No linked users matched that name.', ephemeral: true });
      return;
    }

    if (matches.length === 1 || matches[0].score - matches[1].score >= 0.1) {
      const target = matches[0];
      const result = await unlinkDiscordUser(ctx, interaction.client, target.userId);
      if (!result) {
        await interaction.reply({ content: 'This player is no longer linked.', ephemeral: true });
        return;
      }

      await interaction.reply({
        content: `Unlinked **${result.playerName ?? result.playerTag}** (${result.playerTag}).`,
        ephemeral: true,
      });
      return;
    }

    const token = randomUUID();
    const state: AdminUnlinkState = {
      token,
      createdAt: Date.now(),
      invokerId: interaction.user.id,
      options: matches,
    };
    writeState(ctx, state);

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`adminunlink:${token}`)
      .setPlaceholder('Select a player to unlink')
      .addOptions(
        matches.map((m) => ({
          label: truncateLabel(`${m.playerName ?? 'Unknown'} • ${m.playerTag}`),
          description: truncateLabel(m.userId),
          value: m.userId,
        })),
      );

    await interaction.reply({
      content: 'Multiple matches found. Select the user to unlink.',
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
      ephemeral: true,
    });
  },
};

export async function handleAdminUnlinkSelect(
  ctx: AppContext,
  interaction: StringSelectMenuInteraction,
) {
  if (!interaction.customId.startsWith('adminunlink:')) return;

  const token = interaction.customId.split(':')[1];
  if (!token) {
    await interaction.reply({ content: 'Selection is invalid.', ephemeral: true });
    return;
  }

  const state = readState(ctx, token);
  if (!state) {
    await interaction.reply({
      content: 'Selection expired. Run the command again.',
      ephemeral: true,
    });
    return;
  }

  if (state.invokerId !== interaction.user.id) {
    await interaction.reply({
      content: 'Only the admin who ran the command can use this menu.',
      ephemeral: true,
    });
    return;
  }

  if (Date.now() - state.createdAt > STATE_TTL_MS) {
    deleteState(ctx, token);
    await interaction.reply({
      content: 'Selection expired. Run the command again.',
      ephemeral: true,
    });
    return;
  }

  const selectedUserId = interaction.values?.[0];
  const option = state.options.find((o) => o.userId === selectedUserId);
  if (!selectedUserId || !option) {
    await interaction.reply({ content: 'Selection not found. Try again.', ephemeral: true });
    return;
  }

  const result = await unlinkDiscordUser(ctx, interaction.client, option.userId);
  deleteState(ctx, token);

  if (!result) {
    await interaction
      .update({ content: 'Player already unlinked.', components: [] })
      .catch(() => undefined);
    return;
  }

  await interaction
    .update({
      content: `Unlinked **${result.playerName ?? result.playerTag}** (${result.playerTag}).`,
      components: [],
    })
    .catch(() => undefined);
}
