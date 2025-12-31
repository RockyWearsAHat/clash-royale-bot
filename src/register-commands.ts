import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { JoinCommand } from './discord/join.js';
import { UnlinkCommand } from './discord/unlink.js';
import { WhoAmICommand } from './discord/whoami.js';
import { EnforcePermsCommand } from './discord/enforcePerms.js';
import { WarLogsCommand, WarStatsCommand } from './discord/warstats.js';

const cfg = loadConfig();

const commands = [
  JoinCommand.data,
  UnlinkCommand.data,
  WhoAmICommand.data,
  EnforcePermsCommand.data,
  WarStatsCommand.data,
  WarLogsCommand.data,
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(cfg.DISCORD_TOKEN);

async function main() {
  const guildId = cfg.DISCORD_GUILD_ID ?? cfg.GUILD_ID;

  await rest.put(Routes.applicationGuildCommands(cfg.DISCORD_APP_ID, guildId), {
    body: commands,
  });

  console.log(`Registered ${commands.length} command(s) for guild ${guildId}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
