import {
  PermissionsBitField,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { SlashCommand } from './commands.js';
import type { AppContext } from '../types.js';
import { enforceChannelPermissions } from './permissions.js';
import { asCodeBlock, errorEmbed, successEmbed } from './ui.js';

export const EnforcePermsCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('enforce-perms')
    .setDescription(
      'Admin-only: enforce channel permission overwrites for general/war-logs/announcements/verification/vanquished.',
    ),
  async execute(ctx: AppContext, interaction: ChatInputCommandInteraction) {
    const perms = interaction.memberPermissions;
    if (!perms?.has(PermissionsBitField.Flags.Administrator)) {
      await interaction.reply({
        ephemeral: true,
        embeds: [errorEmbed('Nope', 'This command is admin-only.')],
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const guild = await interaction.client.guilds.fetch(ctx.cfg.GUILD_ID);
    try {
      await enforceChannelPermissions(ctx, interaction.client, guild);
      await interaction.editReply({
        embeds: [successEmbed('Done', 'Permissions were enforced successfully.')],
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const clipped = msg.length > 1500 ? `${msg.slice(0, 1500)}…` : msg;
      await interaction.editReply({
        embeds: [
          errorEmbed(
            'Permission enforcement failed',
            `Discord rejected one or more overwrite edits.${asCodeBlock(clipped)}`,
          ),
        ],
      });
    }
  },
};
