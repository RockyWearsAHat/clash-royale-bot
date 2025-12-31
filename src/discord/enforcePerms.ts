import {
  PermissionsBitField,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { SlashCommand } from './commands.js';
import type { AppContext } from '../types.js';
import { enforceChannelPermissions } from './permissions.js';

export const EnforcePermsCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('enforce-perms')
    .setDescription(
      'Admin-only: enforce channel permission overwrites for general/war-logs/announcements.',
    ),
  async execute(ctx: AppContext, interaction: ChatInputCommandInteraction) {
    const perms = interaction.memberPermissions;
    if (!perms?.has(PermissionsBitField.Flags.Administrator)) {
      await interaction.reply({ content: 'Admin only.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const guild = await interaction.client.guilds.fetch(ctx.cfg.GUILD_ID);
    try {
      await enforceChannelPermissions(ctx, interaction.client, guild);
      await interaction.editReply('Permissions enforced successfully.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Keep within Discord 2000 char limit
      const clipped = msg.length > 1800 ? `${msg.slice(0, 1800)}…` : msg;
      await interaction.editReply(clipped);
    }
  },
};
