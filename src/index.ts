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
  ensureVerificationThreadForUser,
  recreateProfileThreadForUser,
  refreshProfileThreadMainMenuMessage,
  refreshOpenNicknameMenuIfAny,
  repairVerificationThreadsOnce,
} from './discord/join.js';
import { WarLogsCommand, WarStatsCommand } from './discord/warstats.js';
import { handleWarlogsPublishButton } from './discord/warstats.js';
import { StatsCommand, handleStatsPublishButton } from './discord/stats.js';
import { NotifyNoMoreCommand, NotifyWhenSpotCommand } from './discord/spotNotify.js';
import { startScheduler } from './jobs/scheduler.js';
import { enforceChannelPermissions } from './discord/permissions.js';
import { syncRolesOnce, enforceUnlinkedMemberVanquished } from './discord/roleSync.js';
import { maybeRunNicknameToTagMigration } from './discord/nicknameMigration.js';
import { listGuildMembersPage } from './discord/guildMembers.js';
import { dbDeleteJobState, dbGetJobState, dbSetJobState } from './db.js';

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
]);

client.on('guildMemberAdd', async (member) => {
  try {
    if (member.guild.id !== cfg.GUILD_ID) return;
    if (member.user.bot) return;

    const linked = ctx.db
      .prepare('SELECT 1 FROM user_links WHERE discord_user_id = ?')
      .get(member.id) as { 1: number } | undefined;
    if (linked) return;

    // Unlinked users should immediately be vanquished.
    await enforceUnlinkedMemberVanquished(ctx, member);

    await ensureVerificationThreadForUser(ctx, client, member.id);
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

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      await handleLinkPreferenceInteraction(ctx, interaction);
      await handleProfileInteraction(ctx, interaction);
      await handleStatsPublishButton(ctx, interaction);
      await handleWarlogsPublishButton(ctx, interaction);
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

      // Ensure unlinked users get vanquished + a verification thread.
      // Uses REST pagination (avoids gateway opcode 8) and checkpoints progress.
      const scanDoneKey = 'startup:unlinked_scan:done';
      const scanAfterKey = 'startup:unlinked_scan:after';
      const scanDone = dbGetJobState(ctx.db, scanDoneKey);
      let after = dbGetJobState(ctx.db, scanAfterKey) || undefined;

      if (scanDone !== 'true') {
        while (true) {
          const page = await listGuildMembersPage(guild, { after, limit: 1000 });
          if (!page.length) break;

          for (const member of page) {
            if (member.user.bot) continue;
            if (linkedIds.has(member.id)) continue;

            await enforceUnlinkedMemberVanquished(ctx, member);
            await ensureVerificationThreadForUser(ctx, client, member.id);
            await new Promise((r) => setTimeout(r, 250));
          }

          after = page[page.length - 1]?.id;
          if (after) dbSetJobState(ctx.db, scanAfterKey, after);
        }

        dbSetJobState(ctx.db, scanDoneKey, 'true');
        dbDeleteJobState(ctx.db, scanAfterKey);
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
});

await client.login(cfg.DISCORD_TOKEN);
