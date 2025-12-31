import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommand } from './commands.js';
import type { AppContext } from '../types.js';

export const UnlinkCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Remove your linked player tag.'),
  async execute(ctx: AppContext, interaction: ChatInputCommandInteraction) {
    ctx.db.prepare('DELETE FROM user_links WHERE discord_user_id = ?').run(interaction.user.id);
    await interaction.reply({ content: 'Unlinked your player tag.', ephemeral: true });
  },
};
