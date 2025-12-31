import {
  Colors,
  EmbedBuilder,
  type BaseMessageOptions,
  type InteractionReplyOptions,
  type RepliableInteraction,
} from 'discord.js';

function clip(input: string, maxLen: number): string {
  const s = String(input ?? '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

export function errorEmbed(title: string, message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Red)
    .setTitle(title)
    .setDescription(clip(message, 3900));
}

export function infoEmbed(title: string, message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Blurple)
    .setTitle(title)
    .setDescription(clip(message, 3900));
}

export function successEmbed(title: string, message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle(title)
    .setDescription(clip(message, 3900));
}

export async function safeReply(
  interaction: RepliableInteraction,
  options: InteractionReplyOptions,
): Promise<void> {
  if (!interaction.isRepliable()) return;

  if ((interaction as any).deferred || (interaction as any).replied) {
    await interaction.followUp(options).catch(() => undefined);
    return;
  }

  await interaction.reply(options).catch(() => undefined);
}

export function chunkLinesForEmbed(lines: string[], maxLen = 3900): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of lines) {
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > maxLen) {
      if (cur) out.push(cur);
      cur = line;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : ['(none)'];
}

export function asCodeBlock(text: string, lang = ''): string {
  const cleaned = String(text ?? '').replaceAll('```', '\\`\\`\\`');
  return `\n\n\u0060\u0060\u0060${lang}\n${cleaned}\n\u0060\u0060\u0060`;
}

export function clipForMessageContent(text: string, maxLen = 1900): string {
  return clip(String(text ?? ''), maxLen);
}

export function asMessage(content: string): BaseMessageOptions {
  return { content: clipForMessageContent(content) };
}
