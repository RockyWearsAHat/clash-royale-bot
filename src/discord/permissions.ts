import { ChannelType, PermissionFlagsBits, type Client, type Guild } from 'discord.js';
import type { AppContext } from '../types.js';

export async function enforceChannelPermissions(ctx: AppContext, client: Client, guild: Guild) {
  const meUser = client.user;
  if (!meUser) throw new Error('Client user not ready');
  const meMember = await guild.members.fetchMe();

  const general = await guild.channels.fetch(ctx.cfg.CHANNEL_GENERAL_ID).catch(() => null);
  const verification = await guild.channels
    .fetch(ctx.cfg.CHANNEL_VERIFICATION_ID)
    .catch(() => null);
  const warLogs = await guild.channels.fetch(ctx.cfg.CHANNEL_WAR_LOGS_ID).catch(() => null);
  const announcements = await guild.channels
    .fetch(ctx.cfg.CHANNEL_ANNOUNCEMENTS_ID)
    .catch(() => null);

  const problems: string[] = [];

  const safeEdit = async (label: string, ch: any, overwriteId: string, perms: any) => {
    try {
      await ch.permissionOverwrites.edit(overwriteId, perms);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      problems.push(`${label}: failed to edit overwrites for ${overwriteId}: ${msg}`);
    }
  };

  const canView = (ch: any): boolean => {
    const perms = ch?.permissionsFor(meMember);
    return Boolean(perms?.has(PermissionFlagsBits.ViewChannel));
  };

  const canManageOverwrites = (ch: any): boolean => {
    const perms = ch?.permissionsFor(meMember);
    return Boolean(perms?.has(PermissionFlagsBits.ManageChannels));
  };

  if (!general)
    problems.push(`General channel id not found in guild: ${ctx.cfg.CHANNEL_GENERAL_ID}`);
  if (!verification)
    problems.push(`Verification channel id not found in guild: ${ctx.cfg.CHANNEL_VERIFICATION_ID}`);
  if (!warLogs)
    problems.push(`War logs channel id not found in guild: ${ctx.cfg.CHANNEL_WAR_LOGS_ID}`);
  if (!announcements)
    problems.push(
      `Announcements channel id not found in guild: ${ctx.cfg.CHANNEL_ANNOUNCEMENTS_ID}`,
    );

  // Verification (who-are-you): keep channel visible so private threads don't "vanish",
  // but prevent posting in the channel itself.
  if (verification && verification.type === ChannelType.GuildText) {
    if (!canView(verification)) problems.push('Verification: bot cannot view channel');
    if (!canManageOverwrites(verification))
      problems.push('Verification: bot lacks Manage Channels permission');

    if (canManageOverwrites(verification)) {
      // Allow clan roles + vanquished to view (needed to access private threads).
      for (const roleId of [
        ctx.cfg.ROLE_VANQUISHED_ID,
        ctx.cfg.ROLE_MEMBER_ID,
        ctx.cfg.ROLE_ELDER_ID,
        ctx.cfg.ROLE_COLEADER_ID,
        ctx.cfg.ROLE_LEADER_ID,
      ]) {
        await safeEdit('Verification', verification, roleId, {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          SendMessagesInThreads: true,
        });
      }

      await safeEdit('Verification', verification, meUser.id, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
        ManageMessages: true,
      });
    }
  }

  // General: member+ can access, vanquished cannot.
  if (general && general.type === ChannelType.GuildText) {
    if (!canView(general)) problems.push('General: bot cannot view channel');
    if (!canManageOverwrites(general))
      problems.push('General: bot lacks Manage Channels permission');

    if (canManageOverwrites(general)) {
      await safeEdit('General', general, ctx.cfg.ROLE_VANQUISHED_ID, {
        ViewChannel: false,
      });

      for (const roleId of [
        ctx.cfg.ROLE_MEMBER_ID,
        ctx.cfg.ROLE_ELDER_ID,
        ctx.cfg.ROLE_COLEADER_ID,
        ctx.cfg.ROLE_LEADER_ID,
      ]) {
        await safeEdit('General', general, roleId, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          UseApplicationCommands: true,
        });
      }

      await safeEdit('General', general, meUser.id, {
        ViewChannel: true,
        SendMessages: true,
        ManageMessages: true,
        ReadMessageHistory: true,
      });
    }
  }

  // War logs: elder/co-leader read-only, leader full.
  if (warLogs && warLogs.type === ChannelType.GuildText) {
    if (!canView(warLogs)) problems.push('War logs: bot cannot view channel');
    if (!canManageOverwrites(warLogs))
      problems.push('War logs: bot lacks Manage Channels permission');

    if (canManageOverwrites(warLogs)) {
      // Hide war logs by default; grant access only to elder+.
      // Note: @everyone role ID === guild ID.
      await safeEdit('War logs', warLogs, guild.id, {
        ViewChannel: false,
      });

      for (const roleId of [ctx.cfg.ROLE_ELDER_ID, ctx.cfg.ROLE_COLEADER_ID]) {
        await safeEdit('War logs', warLogs, roleId, {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: true,
          SendMessagesInThreads: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          UseApplicationCommands: true,
        });
      }

      await safeEdit('War logs', warLogs, ctx.cfg.ROLE_LEADER_ID, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
        ManageMessages: true,
        UseApplicationCommands: true,
      });

      // Keep vanquished out of war logs.
      await safeEdit('War logs', warLogs, ctx.cfg.ROLE_VANQUISHED_ID, {
        ViewChannel: false,
      });

      await safeEdit('War logs', warLogs, meUser.id, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
        ManageMessages: true,
        SendMessagesInThreads: true,
        CreatePublicThreads: true,
      });
    }
  }

  // Announcements: ensure bot can post.
  if (announcements && announcements.type === ChannelType.GuildText) {
    if (!canView(announcements)) problems.push('Announcements: bot cannot view channel');
    if (!canManageOverwrites(announcements))
      problems.push('Announcements: bot lacks Manage Channels permission');

    if (canManageOverwrites(announcements)) {
      await safeEdit('Announcements', announcements, meUser.id, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
      });

      // Do not force @everyone settings; leave server preference.
      await safeEdit('Announcements', announcements, ctx.cfg.ROLE_VANQUISHED_ID, {
        ViewChannel: false,
      });
    }
  }

  if (problems.length) {
    throw new Error(
      `Cannot enforce channel permissions. Fix the following (or set PERMISSIONS_ENFORCE_ON_STARTUP=false):\n- ${problems.join(
        '\n- ',
      )}`,
    );
  }
}
