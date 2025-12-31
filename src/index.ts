import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { loadConfig } from './config.js';
import { openDb, migrate } from './db.js';
import { ClashApi } from './clashApi.js';
import type { AppContext } from './types.js';
import { registerHandlers } from './discord/commands.js';
import {
  JoinCommand,
  handleLinkPreferenceInteraction,
  handleLinkPreferenceModalSubmit,
  handleProfileInteraction,
  handleVerificationEntryMessage,
  handleVerificationThreadMessage,
  ensureVerificationThreadForUser,
} from './discord/join.js';
import { UnlinkCommand } from './discord/unlink.js';
import { WhoAmICommand } from './discord/whoami.js';
import { EnforcePermsCommand } from './discord/enforcePerms.js';
import { WarLogsCommand, WarStatsCommand } from './discord/warstats.js';
import { startScheduler } from './jobs/scheduler.js';
import { enforceChannelPermissions } from './discord/permissions.js';

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
  JoinCommand,
  UnlinkCommand,
  WhoAmICommand,
  EnforcePermsCommand,
  WarStatsCommand,
  WarLogsCommand,
]);

client.on('guildMemberAdd', async (member) => {
  try {
    if (member.guild.id !== cfg.GUILD_ID) return;
    if (member.user.bot) return;

    const linked = ctx.db
      .prepare('SELECT 1 FROM user_links WHERE discord_user_id = ?')
      .get(member.id) as { 1: number } | undefined;
    if (linked) return;

    await ensureVerificationThreadForUser(ctx, client, member.id);
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
    }

    if (interaction.isModalSubmit()) {
      await handleLinkPreferenceModalSubmit(ctx, interaction);
    }
  } catch {
    // ignore
  }
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  if (cfg.PERMISSIONS_ENFORCE_ON_STARTUP) {
    try {
      const guild = await client.guilds.fetch(cfg.GUILD_ID);
      await enforceChannelPermissions(ctx, client, guild);
      console.log('Channel permission overwrites enforced.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('Failed to enforce channel permissions:', msg);
    }
  }

  // Create threads for all currently-unlinked members so they don't need to type /join.
  // Runs once at startup; safe to re-run due to job_state reuse.
  (async () => {
    try {
      const guild = await client.guilds.fetch(cfg.GUILD_ID);
      await guild.members.fetch();

      const linkedRows = ctx.db.prepare('SELECT discord_user_id FROM user_links').all() as Array<{
        discord_user_id: string;
      }>;
      const linkedIds = new Set(linkedRows.map((r) => r.discord_user_id));

      // First, ensure linked users have an up-to-date profile thread.
      // This re-renders the state-machine UI on every boot.
      for (const row of linkedRows) {
        await ensureVerificationThreadForUser(ctx, client, row.discord_user_id);
        await new Promise((r) => setTimeout(r, 250));
      }

      for (const member of guild.members.cache.values()) {
        if (member.user.bot) continue;
        if (linkedIds.has(member.id)) continue;
        await ensureVerificationThreadForUser(ctx, client, member.id);
        // Small delay to reduce the chance of hitting Discord rate limits.
        await new Promise((r) => setTimeout(r, 250));
      }
    } catch {
      // ignore
    }
  })();

  startScheduler(ctx, client);
});

await client.login(cfg.DISCORD_TOKEN);
