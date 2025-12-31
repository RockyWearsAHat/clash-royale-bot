import { SlashCommandBuilder, type ChatInputCommandInteraction, type Client } from 'discord.js';
import type { AppContext } from '../types.js';

export type SlashCommand = {
  data: SlashCommandBuilder;
  execute: (ctx: AppContext, interaction: ChatInputCommandInteraction) => Promise<void>;
};

export async function registerHandlers(client: Client, ctx: AppContext, commands: SlashCommand[]) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.find((c) => c.data.name === interaction.commandName);
    if (!command) return;

    try {
      await command.execute(ctx, interaction);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction
            .followUp({ content: `Error: ${msg}`, ephemeral: true })
            .catch(() => undefined);
        } else {
          await interaction
            .reply({ content: `Error: ${msg}`, ephemeral: true })
            .catch(() => undefined);
        }
      }
    }
  });
}
