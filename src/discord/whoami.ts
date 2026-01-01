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
        embeds: [
          infoEmbed(
            'Not linked yet',
            'The bot will create a verification thread for you automatically. Open your thread and paste your player tag (example: `#ABC123`).',
          ),
        ],
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
