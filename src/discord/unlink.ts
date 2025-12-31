import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommand } from './commands.js';
import type { AppContext } from '../types.js';
import { successEmbed } from './ui.js';

export const UnlinkCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Remove your linked player tag.'),
  async execute(ctx: AppContext, interaction: ChatInputCommandInteraction) {
    ctx.db.prepare('DELETE FROM user_links WHERE discord_user_id = ?').run(interaction.user.id);
    await interaction.reply({
      embeds: [successEmbed('Unlinked', 'Your Clash Royale link has been removed.')],
      ephemeral: true,
    });
  },
};
