import type { Guild, GuildMember } from 'discord.js';
import type { AppContext } from '../types.js';
import type { ClashClanMemberRole } from '../clashApi.js';
import { dbGetJobState, dbSetJobState } from '../db.js';

function roleIdForClanRole(ctx: AppContext, role: ClashClanMemberRole): string {
  switch (role) {
    case 'member':
      return ctx.cfg.ROLE_MEMBER_ID;
    case 'elder':
      return ctx.cfg.ROLE_ELDER_ID;
    case 'coLeader':
      return ctx.cfg.ROLE_COLEADER_ID;
    case 'leader':
      return ctx.cfg.ROLE_LEADER_ID;
  }
}

function allClanRoleIds(ctx: AppContext): string[] {
  return [
    ctx.cfg.ROLE_MEMBER_ID,
    ctx.cfg.ROLE_ELDER_ID,
    ctx.cfg.ROLE_COLEADER_ID,
    ctx.cfg.ROLE_LEADER_ID,
  ];
}

function currentClanRoleKey(ctx: AppContext, member: GuildMember): ClashClanMemberRole | undefined {
  const ids = member.roles.cache;
  if (ids.has(ctx.cfg.ROLE_LEADER_ID)) return 'leader';
  if (ids.has(ctx.cfg.ROLE_COLEADER_ID)) return 'coLeader';
  if (ids.has(ctx.cfg.ROLE_ELDER_ID)) return 'elder';
  if (ids.has(ctx.cfg.ROLE_MEMBER_ID)) return 'member';
  return undefined;
}

function desiredKeyFromClanRole(role?: ClashClanMemberRole): string {
  return role ?? 'vanquished';
}

export async function syncRolesOnce(ctx: AppContext, guild: Guild) {
  const members = await ctx.clash.getClanMembers(ctx.cfg.CLASH_CLAN_TAG);
  const clanByTag = new Map(members.map((m) => [m.tag.toUpperCase(), m]));

  const linked = ctx.db
    .prepare('SELECT discord_user_id, player_tag FROM user_links')
    .all() as Array<{
    discord_user_id: string;
    player_tag: string;
  }>;

  for (const link of linked) {
    const discordMember = await guild.members.fetch(link.discord_user_id).catch(() => undefined);
    if (!discordMember) continue;

    const clanMember = clanByTag.get(link.player_tag.toUpperCase());

    const desired = desiredKeyFromClanRole(clanMember?.role);
    const current = desiredKeyFromClanRole(currentClanRoleKey(ctx, discordMember));
    const hasVanquished = discordMember.roles.cache.has(ctx.cfg.ROLE_VANQUISHED_ID);
    const currentVanquished = hasVanquished && current === 'vanquished';
    const desiredVanquished = desired === 'vanquished';

    // If already correct, do nothing (and don't build up "pending" state).
    const alreadyCorrect = current === desired && currentVanquished === desiredVanquished;
    if (alreadyCorrect) {
      // Keep the pending state aligned to reduce surprise after restarts.
      dbSetJobState(
        ctx.db,
        `role_sync:pending:${link.discord_user_id}`,
        JSON.stringify({ desired, n: 2 }),
      );
      continue;
    }

    // Settling: require the same desired state for 2 consecutive sync cycles.
    const pendingKey = `role_sync:pending:${link.discord_user_id}`;
    const pendingRaw = dbGetJobState(ctx.db, pendingKey);
    let pendingDesired: string | undefined;
    let n = 0;
    if (pendingRaw) {
      try {
        const obj = JSON.parse(pendingRaw) as { desired?: string; n?: number };
        pendingDesired = typeof obj.desired === 'string' ? obj.desired : undefined;
        n = typeof obj.n === 'number' && Number.isFinite(obj.n) ? obj.n : 0;
      } catch {
        // ignore
      }
    }

    if (pendingDesired !== desired) {
      dbSetJobState(ctx.db, pendingKey, JSON.stringify({ desired, n: 1 }));
      continue;
    }

    const nextN = Math.min((n || 0) + 1, 5);
    dbSetJobState(ctx.db, pendingKey, JSON.stringify({ desired, n: nextN }));
    if (nextN < 2) continue;

    await applyMemberRoles(ctx, discordMember, clanMember?.role);
  }
}

export async function enforceUnlinkedMemberVanquished(ctx: AppContext, member: GuildMember) {
  if (member.user.bot) return;
  await applyMemberRoles(ctx, member, undefined);
}

export async function enforceLinkedMemberRoles(
  ctx: AppContext,
  member: GuildMember,
  clanRole?: ClashClanMemberRole,
) {
  if (member.user.bot) return;
  await applyMemberRoles(ctx, member, clanRole);
}

async function applyMemberRoles(
  ctx: AppContext,
  member: GuildMember,
  clanRole?: ClashClanMemberRole,
) {
  const clanRoleIds = allClanRoleIds(ctx);

  const desiredClanRoleId = clanRole ? roleIdForClanRole(ctx, clanRole) : null;
  const hasVanquished = member.roles.cache.has(ctx.cfg.ROLE_VANQUISHED_ID);
  const shouldBeVanquished = !clanRole;

  // Remove any clan roles that aren't the desired one.
  const toRemove: string[] = [];
  for (const rid of clanRoleIds) {
    if (!member.roles.cache.has(rid)) continue;
    if (desiredClanRoleId && rid === desiredClanRoleId) continue;
    toRemove.push(rid);
  }

  // Ensure vanquished is correct.
  if (shouldBeVanquished) {
    if (!hasVanquished) {
      await member.roles.add(ctx.cfg.ROLE_VANQUISHED_ID).catch(() => undefined);
    }
  } else {
    if (hasVanquished) {
      await member.roles.remove(ctx.cfg.ROLE_VANQUISHED_ID).catch(() => undefined);
    }
  }

  if (toRemove.length) await member.roles.remove(toRemove).catch(() => undefined);

  // Add desired clan role if missing.
  if (desiredClanRoleId && !member.roles.cache.has(desiredClanRoleId)) {
    await member.roles.add(desiredClanRoleId).catch(() => undefined);
  }
}
