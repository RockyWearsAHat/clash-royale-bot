import { ChannelType, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommand } from './commands.js';
import type { AppContext } from '../types.js';
import { dbSubscribeToSpots, dbUnsubscribeFromSpots } from '../db.js';
import { infoEmbed, successEmbed } from './ui.js';

function getBaseChannelId(interaction: ChatInputCommandInteraction): string | null {
  const ch = interaction.channel;
  if (!ch) return null;
  if (ch.isThread()) return ch.parentId;
  if (ch.type === ChannelType.GuildText) return ch.id;
  return null;
}

async function enforceVanquishedChannel(
  ctx: AppContext,
  interaction: ChatInputCommandInteraction,
): Promise<boolean> {
  if (!interaction.inGuild()) return false;

  const baseChannelId = getBaseChannelId(interaction);
  if (!baseChannelId) {
    await interaction.reply({
      content: 'This command must be run in a server text channel.',
      ephemeral: true,
    });
    return false;
  }

  if (baseChannelId !== ctx.cfg.CHANNEL_VANQUISHED_ID) {
    await interaction.reply({
      content: `Please run this in <#${ctx.cfg.CHANNEL_VANQUISHED_ID}>.`,
      ephemeral: true,
    });
    return false;
  }

  return true;
}

export const NotifyWhenSpotCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('notifywhenspot')
    .setDescription('Subscribe to be notified when the clan has an open spot.'),
  async execute(ctx: AppContext, interaction: ChatInputCommandInteraction) {
    if (!(await enforceVanquishedChannel(ctx, interaction))) return;

    const res = dbSubscribeToSpots(ctx.db, interaction.user.id);

    await interaction.reply({
      ephemeral: true,
      embeds: [
        res.alreadySubscribed
          ? infoEmbed('Already subscribed', "You'll be pinged when a spot opens up.")
          : successEmbed('Subscribed', "You'll be pinged when a spot opens up."),
      ],
    });
  },
};

export const NotifyNoMoreCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('notifynomore')
    .setDescription('Unsubscribe from open-spot notifications.'),
  async execute(ctx: AppContext, interaction: ChatInputCommandInteraction) {
    if (!(await enforceVanquishedChannel(ctx, interaction))) return;

    const res = dbUnsubscribeFromSpots(ctx.db, interaction.user.id);

    await interaction.reply({
      ephemeral: true,
      embeds: [
        res.wasSubscribed
          ? successEmbed('Unsubscribed', "You won't be pinged for open spots anymore.")
          : infoEmbed('Not subscribed', "You weren't subscribed to open-spot notifications."),
      ],
    });
  },
};
