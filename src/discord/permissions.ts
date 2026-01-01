import { ChannelType, PermissionFlagsBits, type Client, type Guild } from 'discord.js';
import type { AppContext } from '../types.js';

export async function enforceChannelPermissions(ctx: AppContext, client: Client, guild: Guild) {
  const meUser = client.user;
  if (!meUser) throw new Error('Client user not ready');
  const meMember = await guild.members.fetchMe();

  // Note: @everyone role ID === guild ID.
  const everyoneRoleId = guild.id;

  const general = await guild.channels.fetch(ctx.cfg.CHANNEL_GENERAL_ID).catch(() => null);
  const verification = await guild.channels
    .fetch(ctx.cfg.CHANNEL_VERIFICATION_ID)
    .catch(() => null);
  const warLogs = await guild.channels.fetch(ctx.cfg.CHANNEL_WAR_LOGS_ID).catch(() => null);
  const announcements = await guild.channels
    .fetch(ctx.cfg.CHANNEL_ANNOUNCEMENTS_ID)
    .catch(() => null);
  const vanquished = await guild.channels.fetch(ctx.cfg.CHANNEL_VANQUISHED_ID).catch(() => null);

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
  if (!vanquished)
    problems.push(`Vanquished channel id not found in guild: ${ctx.cfg.CHANNEL_VANQUISHED_ID}`);

  // Verification (who-are-you): keep channel visible so private threads don't "vanish",
  // but prevent posting in the channel itself.
  if (verification && verification.type === ChannelType.GuildText) {
    if (!canView(verification)) problems.push('Verification: bot cannot view channel');
    if (!canManageOverwrites(verification))
      problems.push('Verification: bot lacks Manage Channels permission');

    if (canManageOverwrites(verification)) {
      // Ensure unlinked users can access the verification channel + threads.
      await safeEdit('Verification', verification, everyoneRoleId, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
        SendMessagesInThreads: true,
      });

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
        ManageThreads: true,
        CreatePrivateThreads: true,
        CreatePublicThreads: true,
        SendMessagesInThreads: true,
      });
    }
  }

  // General: member+ can access, vanquished cannot.
  if (general && general.type === ChannelType.GuildText) {
    if (!canView(general)) problems.push('General: bot cannot view channel');
    if (!canManageOverwrites(general))
      problems.push('General: bot lacks Manage Channels permission');

    if (canManageOverwrites(general)) {
      // Lock out unlinked users (@everyone) from general.
      await safeEdit('General', general, everyoneRoleId, {
        ViewChannel: false,
      });

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
      await safeEdit('War logs', warLogs, everyoneRoleId, {
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
      // Ensure unlinked users can view announcements.
      await safeEdit('Announcements', announcements, everyoneRoleId, {
        ViewChannel: true,
        ReadMessageHistory: true,
      });

      await safeEdit('Announcements', announcements, meUser.id, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
      });
    }
  }

  // Vanquished: unlinked users can view; clan roles cannot.
  // Note: true Discord admins bypass overwrites and will still be able to view.
  if (vanquished && vanquished.type === ChannelType.GuildText) {
    if (!canView(vanquished)) problems.push('Vanquished: bot cannot view channel');
    if (!canManageOverwrites(vanquished))
      problems.push('Vanquished: bot lacks Manage Channels permission');

    if (canManageOverwrites(vanquished)) {
      // Allow unlinked users (no roles) to see vanquished.
      await safeEdit('Vanquished', vanquished, everyoneRoleId, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
        UseApplicationCommands: true,
      });

      // Keep all clan roles out (member/elder/co-leader/leader).
      for (const roleId of [
        ctx.cfg.ROLE_MEMBER_ID,
        ctx.cfg.ROLE_ELDER_ID,
        ctx.cfg.ROLE_COLEADER_ID,
        ctx.cfg.ROLE_LEADER_ID,
      ]) {
        await safeEdit('Vanquished', vanquished, roleId, {
          ViewChannel: false,
        });
      }

      // Allow explicitly-vanquished users too.
      await safeEdit('Vanquished', vanquished, ctx.cfg.ROLE_VANQUISHED_ID, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
        UseApplicationCommands: true,
      });

      await safeEdit('Vanquished', vanquished, meUser.id, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
        ManageMessages: true,
      });
    }
  }

  if (problems.length) {
    throw new Error(
      `Cannot enforce channel permissions. Fix the following:\n- ${problems.join('\n- ')}`,
    );
  }
}
