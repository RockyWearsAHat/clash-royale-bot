import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';

const sqlitePath = process.env.SQLITE_PATH || 'bot.sqlite';
const cwd = process.cwd();
const absSqlitePath = path.resolve(cwd, sqlitePath);

const files = [absSqlitePath, `${absSqlitePath}-wal`, `${absSqlitePath}-shm`];

async function rmIfExists(p) {
  try {
    await fs.rm(p);
    console.log(`Removed ${p}`);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return;
    throw e;
  }
}

async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch (e) {
    if (e && e.code === 'ENOENT') return false;
    throw e;
  }
}

function loadLinkedUsersFromDb(dbPath) {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_links'")
      .get();
    if (!hasTable) return [];
    const rows = db.prepare('SELECT discord_user_id FROM user_links').all();
    return rows.map((r) => String(r.discord_user_id));
  } finally {
    db.close();
  }
}

async function cleanupDiscordForUsers(userIds) {
  const token = process.env.DISCORD_TOKEN;
  const guildId = process.env.GUILD_ID;
  const verificationChannelId = process.env.CHANNEL_VERIFICATION_ID;

  const roleIds = [
    process.env.ROLE_VANQUISHED_ID,
    process.env.ROLE_MEMBER_ID,
    process.env.ROLE_ELDER_ID,
    process.env.ROLE_COLEADER_ID,
    process.env.ROLE_LEADER_ID,
  ].filter(Boolean);

  if (!token || !guildId) {
    console.log('Skipping Discord cleanup: DISCORD_TOKEN or GUILD_ID not set in .env');
    return;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  await client.login(token);
  try {
    const guild = await client.guilds.fetch(guildId);
    const verificationChannel = verificationChannelId
      ? await guild.channels.fetch(verificationChannelId).catch(() => null)
      : null;

    for (const userId of userIds) {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;

      // Remove bot-managed roles.
      const toRemove = roleIds.filter((rid) => member.roles.cache.has(rid));
      if (toRemove.length) {
        await member.roles.remove(toRemove).catch(() => undefined);
      }

      // Restore access to the verification channel by removing the user overwrite.
      if (verificationChannel && verificationChannel.isTextBased?.()) {
        await verificationChannel.permissionOverwrites.delete(userId).catch(() => undefined);
      }
    }

    console.log(`Discord cleanup complete for ${userIds.length} user(s).`);
  } finally {
    await client.destroy();
  }
}

async function main() {
  let linkedUserIds = [];
  if (await fileExists(absSqlitePath)) {
    try {
      linkedUserIds = loadLinkedUsersFromDb(absSqlitePath);
      console.log(`Found ${linkedUserIds.length} linked user(s) in DB.`);
    } catch (e) {
      console.warn('Could not read linked users from DB; continuing with file deletion only.');
    }
  }

  if (linkedUserIds.length) {
    await cleanupDiscordForUsers(linkedUserIds);
  }

  for (const f of files) {
    await rmIfExists(f);
  }

  console.log('DB reset complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
