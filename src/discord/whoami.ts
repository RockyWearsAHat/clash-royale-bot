import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommand } from './commands.js';
import type { AppContext } from '../types.js';
import { infoEmbed } from './ui.js';

export const WhoAmICommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('whoami')
    .setDescription('Show your linked Clash Royale account.'),
  async execute(ctx: AppContext, interaction: ChatInputCommandInteraction) {
    const row = ctx.db
      .prepare('SELECT player_tag FROM user_links WHERE discord_user_id = ?')
      .get(interaction.user.id) as { player_tag: string } | undefined;

    if (!row) {
      await interaction.reply({
        embeds: [infoEmbed('Not linked yet', 'Use `/join` to link your Clash Royale player tag.')],
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      embeds: [infoEmbed('Linked account', `Player tag: **${row.player_tag}**`)],
      ephemeral: true,
    });
  },
};
