import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { loadConfig } from './config.js';
import { openDb, migrate } from './db.js';
import { dbAudit } from './db.js';
import { ClashApi } from './clashApi.js';
import type { AppContext } from './types.js';
import { registerHandlers } from './discord/commands.js';
import {
  handleLinkPreferenceInteraction,
  handleLinkPreferenceModalSubmit,
  handleChangeTagModalSubmit,
  handleProfileInteraction,
  handleVerificationEntryMessage,
  handleVerificationThreadMessage,
  handleVerifyTagButton,
  ensureVerificationThreadForUser,
  recreateProfileThreadForUser,
  refreshProfileThreadMainMenuMessage,
  refreshOpenNicknameMenuIfAny,
  repairVerificationThreadsOnce,
  unarchiveAllTrackedThreads,
  deleteProfileThreadForUser,
} from './discord/join.js';
import { WarLogsCommand, WarStatsCommand } from './discord/warstats.js';
import { handleWarlogsPublishButton } from './discord/warstats.js';
import { StatsCommand, handleStatsPublishButton } from './discord/stats.js';
import { NotifyNoMoreCommand, NotifyWhenSpotCommand } from './discord/spotNotify.js';
import { PingUnusedDecksCommand } from './discord/pingUnusedDecks.js';
import { startScheduler } from './jobs/scheduler.js';
import { enforceChannelPermissions } from './discord/permissions.js';
import { syncRolesOnce, enforceUnlinkedMemberRoleReset } from './discord/roleSync.js';
import { maybeRunNicknameToTagMigration } from './discord/nicknameMigration.js';
import { listGuildMembersPage } from './discord/guildMembers.js';
import { dbDeleteJobState, dbGetJobState, dbSetJobState } from './db.js';
import { AdminUnlinkCommand, handleAdminUnlinkSelect } from './discord/adminUnlink.js';

const cfg = loadConfig();
const db = openDb(cfg.SQLITE_PATH);
migrate(db);

const clash = new ClashApi(cfg.CLASH_API_TOKEN);

const ctx: AppContext = { cfg, db, clash };

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

registerHandlers(client, ctx, [
  StatsCommand,
  WarStatsCommand,
  WarLogsCommand,
  NotifyWhenSpotCommand,
  NotifyNoMoreCommand,
  PingUnusedDecksCommand,
  AdminUnlinkCommand,
]);

client.on('guildMemberAdd', async (member) => {
  try {
    if (member.guild.id !== cfg.GUILD_ID) return;
    if (member.user.bot) return;

    const linked = ctx.db
      .prepare('SELECT 1 FROM user_links WHERE discord_user_id = ?')
      .get(member.id) as { 1: number } | undefined;
    if (linked) return;

    // Unlinked users should immediately be isolated to verification threads only.
    await enforceUnlinkedMemberRoleReset(ctx, member);

    await ensureVerificationThreadForUser(ctx, client, member.id);
  } catch {
    // ignore
  }
});

// Delete profile/verification threads when users leave the server.
client.on('guildMemberRemove', async (member) => {
  try {
    if (member.guild.id !== cfg.GUILD_ID) return;
    if (member.user.bot) return;

    await deleteProfileThreadForUser(ctx, client, member.id);

    // Also remove user_link if they were linked (optional cleanup)
    ctx.db.prepare('DELETE FROM user_links WHERE discord_user_id = ?').run(member.id);

    // Remove from spot subscriptions too
    ctx.db.prepare('DELETE FROM spot_subscriptions WHERE discord_user_id = ?').run(member.id);
  } catch {
    // ignore
  }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    if (newMember.guild.id !== cfg.GUILD_ID) return;
    if (newMember.user.bot) return;

    // Only act on display name changes (nickname/global display changes).
    const before = String((oldMember as any)?.displayName ?? '');
    const after = String((newMember as any)?.displayName ?? '');
    if (before === after) return;

    const linked = ctx.db
      .prepare('SELECT 1 FROM user_links WHERE discord_user_id = ?')
      .get(newMember.id) as { 1: number } | undefined;
    if (!linked) return;

    await refreshProfileThreadMainMenuMessage(ctx, newMember.guild, newMember.id);
    await refreshOpenNicknameMenuIfAny(ctx, newMember.guild, newMember.id);
  } catch {
    // ignore
  }
});

client.on('messageCreate', async (msg) => {
  try {
    await handleVerificationEntryMessage(ctx, msg);
    await handleVerificationThreadMessage(ctx, msg);
  } catch {
    // ignore invalid messages
  }
});

// Immediately unarchive profile threads when Discord auto-archives them.
// This makes threads effectively "never archive".
client.on('threadUpdate', async (oldThread, newThread) => {
  try {
    // Only care about threads that just became archived.
    if (!newThread.archived || oldThread.archived) return;
    if (newThread.parentId !== cfg.CHANNEL_VERIFICATION_ID) return;

    // Check if this is a tracked profile thread.
    const pointers = ctx.db
      .prepare("SELECT key FROM job_state WHERE key LIKE 'verify:thread:%' AND value = ?")
      .all(newThread.id) as Array<{ key: string }>;

    if (pointers.length > 0) {
      await newThread
        .setArchived(false, 'Profile threads should never archive')
        .catch(() => undefined);
    }
  } catch {
    // ignore
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('verifytag:')) {
        await handleVerifyTagButton(ctx, interaction);
        return;
      }
      await handleLinkPreferenceInteraction(ctx, interaction);
      await handleProfileInteraction(ctx, interaction);
      await handleStatsPublishButton(ctx, interaction);
      await handleWarlogsPublishButton(ctx, interaction);
    }

    if (interaction.isStringSelectMenu()) {
      await handleAdminUnlinkSelect(ctx, interaction);
    }

    if (interaction.isModalSubmit()) {
      await handleLinkPreferenceModalSubmit(ctx, interaction);
      await handleChangeTagModalSubmit(ctx, interaction);
    }
  } catch {
    // ignore
  }
});

client.once('ready', async () => {
  try {
    console.log(`Logged in as ${client.user?.tag}`);

    let guild: any;
    try {
      guild = await client.guilds.fetch(cfg.GUILD_ID);
    } catch {
      guild = null;
    }

    // Always enforce channel permissions on startup so operators don't need to run a manual command.
    try {
      if (guild) await enforceChannelPermissions(ctx, client, guild);
      console.log('Channel permission overwrites enforced.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('Failed to enforce channel permissions:', msg);
    }

    // Keep roles aligned immediately on startup (not just on the first cron tick).
    try {
      if (guild) await syncRolesOnce(ctx, guild);
    } catch {
      // ignore
    }

    // Unarchive any profile threads that were archived while the bot was offline.
    // This runs early so threads are visible before other operations try to access them.
    try {
      await unarchiveAllTrackedThreads(ctx, client);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('Failed to unarchive threads on startup:', msg);
    }

    // Create threads for all currently-unlinked members (no manual command required).
    // Runs once at startup; safe to re-run due to job_state reuse.
    (async () => {
      try {
        if (!guild) guild = await client.guilds.fetch(cfg.GUILD_ID);

        // Optional one-time migration: nickname -> clan tag -> user_links.
        // Runs before thread reconciliation so newly-linked users get proper threads.
        await maybeRunNicknameToTagMigration(ctx, guild);

        // Re-sync roles after migration so permissions/visibility update quickly.
        await syncRolesOnce(ctx, guild);

        const linkedRows = ctx.db.prepare('SELECT discord_user_id FROM user_links').all() as Array<{
          discord_user_id: string;
        }>;
        const linkedIds = new Set(linkedRows.map((r) => r.discord_user_id));

        // First, ensure linked users have an up-to-date profile thread.
        // This re-renders the state-machine UI on every boot.
        for (const row of linkedRows) {
          if (cfg.DEV_RECREATE_PROFILE_THREADS) {
            await recreateProfileThreadForUser(ctx, client, row.discord_user_id);
          } else {
            await ensureVerificationThreadForUser(ctx, client, row.discord_user_id);
          }
          await new Promise((r) => setTimeout(r, 250));
        }

        // Validation/repair pass: clean up duplicates and ensure members can access their canonical thread.
        // No recreations are performed here.
        try {
          await repairVerificationThreadsOnce(ctx, client);
        } catch {
          // ignore
        }

        // Ensure unlinked users stay isolated and have a verification thread on every startup.
        // Uses REST pagination (avoids gateway opcode 8) and always scans the full guild
        // so state cannot drift over time.
        let after: string | undefined = undefined;
        while (true) {
          const page = await listGuildMembersPage(guild, { after, limit: 1000 });
          if (!page.length) break;

          for (const member of page) {
            if (member.user.bot) continue;
            if (linkedIds.has(member.id)) continue;

            await enforceUnlinkedMemberRoleReset(ctx, member);
            await ensureVerificationThreadForUser(ctx, client, member.id);
            await new Promise((r) => setTimeout(r, 250));
          }

          after = page[page.length - 1]?.id;
        }

        // Final cleanup: the unlinked scan can create new threads; delete any bot-only or unusable ones.
        try {
          await repairVerificationThreadsOnce(ctx, client);
        } catch {
          // ignore
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('Startup task failed:', msg);
        dbAudit(ctx.db, 'startup_task_error', msg);
      }
    })();

    startScheduler(ctx, client);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('FATAL ERROR in ready handler:', msg, e);
  }
});

await client.login(cfg.DISCORD_TOKEN);
