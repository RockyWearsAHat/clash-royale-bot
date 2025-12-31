import type { Guild, GuildMember } from 'discord.js';
import type { AppContext } from '../types.js';
import type { ClashClanMemberRole } from '../clashApi.js';

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
    await applyMemberRoles(ctx, discordMember, clanMember?.role);
  }
}

async function applyMemberRoles(
  ctx: AppContext,
  member: GuildMember,
  clanRole?: ClashClanMemberRole,
) {
  const clanRoleIds = allClanRoleIds(ctx);
  const shouldBeVanquished = !clanRole;

  // Remove all clan roles first; then add the correct one.
  const toRemove: string[] = [];
  for (const rid of clanRoleIds) {
    if (member.roles.cache.has(rid)) toRemove.push(rid);
  }

  if (toRemove.length) await member.roles.remove(toRemove).catch(() => undefined);

  if (clanRole) {
    await member.roles.add(roleIdForClanRole(ctx, clanRole)).catch(() => undefined);
    if (member.roles.cache.has(ctx.cfg.ROLE_VANQUISHED_ID)) {
      await member.roles.remove(ctx.cfg.ROLE_VANQUISHED_ID).catch(() => undefined);
    }
  } else if (shouldBeVanquished) {
    if (!member.roles.cache.has(ctx.cfg.ROLE_VANQUISHED_ID)) {
      await member.roles.add(ctx.cfg.ROLE_VANQUISHED_ID).catch(() => undefined);
    }
  }
}
