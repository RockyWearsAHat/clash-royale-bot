import { ChannelType, type Client } from 'discord.js';
import type { AppContext } from '../types.js';
import { dbGetJobState, dbSetJobState, dbListSpotSubscribers } from '../db.js';

const MAX_CLAN_SIZE = 50;

export async function pollEmptySpotsOnce(ctx: AppContext, client: Client): Promise<void> {
  const roster = await ctx.clash.getClanMembers(ctx.cfg.CLASH_CLAN_TAG);
  const openSlots = Math.max(0, MAX_CLAN_SIZE - roster.length);

  const stateKey = 'spots:last_announced_open_slots';
  const lastRaw = dbGetJobState(ctx.db, stateKey);
  const last = lastRaw ? Number(lastRaw) : 0;
  const lastSlots = Number.isFinite(last) && last >= 0 ? last : 0;

  // No open spots: store 0 so the next open spot triggers.
  if (!openSlots) {
    if (lastSlots !== 0) dbSetJobState(ctx.db, stateKey, '0');
    return;
  }

  // Only announce when NEW spots open (i.e., open slots increased since last check).
  // Examples:
  // - 0 -> 1: announce
  // - 1 -> 1: no
  // - 2 -> 1: no (but store 1 so 1->2 can announce later)
  if (openSlots <= lastSlots) {
    if (openSlots !== lastSlots) dbSetJobState(ctx.db, stateKey, String(openSlots));
    return;
  }

  const guild = await client.guilds.fetch(ctx.cfg.GUILD_ID);
  const ch = await guild.channels.fetch(ctx.cfg.CHANNEL_VANQUISHED_ID).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) return;

  const subscribers = dbListSpotSubscribers(ctx.db);
  const mentions = subscribers.length ? subscribers.map((id) => `<@${id}>`).join(' ') : '';
  const plural = openSlots === 1 ? '' : 's';

  await ch
    .send({
      content: `${mentions}${mentions ? '\n\n' : ''}Open clan spot detected: **${openSlots}** slot${plural} open.`,
      allowedMentions: { users: subscribers },
    })
    .catch(() => undefined);

  dbSetJobState(ctx.db, stateKey, String(openSlots));
}
