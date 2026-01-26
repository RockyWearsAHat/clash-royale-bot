import { ChannelType, type Client } from 'discord.js';
import type { AppContext } from '../types.js';
import {
  dbGetJobState,
  dbSetJobState,
  dbListSpotSubscribers,
  dbUnsubscribeFromSpots,
} from '../db.js';

const MAX_CLAN_SIZE = 50;
// Don't ping the same user more than once per 6 hours to avoid spam.
const PER_USER_COOLDOWN_MS = 6 * 60 * 60 * 1000;

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
  const ch = await guild.channels.fetch(ctx.cfg.CHANNEL_NON_MEMBER_ID).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) return;

  const subscribers = dbListSpotSubscribers(ctx.db);

  // Only ping users who are still in the server and still have the vanquished role.
  // Also clean up subscriptions for users who left the server, or who clearly have
  // clan access again (i.e. they have a clan role).
  // Additionally, enforce a per-user cooldown to avoid spamming the same user repeatedly.
  const pingable: string[] = [];
  const now = Date.now();
  for (const id of subscribers) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (!member) {
      dbUnsubscribeFromSpots(ctx.db, id);
      continue;
    }

    const hasClanRole =
      member.roles.cache.has(ctx.cfg.ROLE_MEMBER_ID) ||
      member.roles.cache.has(ctx.cfg.ROLE_ELDER_ID) ||
      member.roles.cache.has(ctx.cfg.ROLE_COLEADER_ID) ||
      member.roles.cache.has(ctx.cfg.ROLE_LEADER_ID);
    if (hasClanRole) {
      dbUnsubscribeFromSpots(ctx.db, id);
      continue;
    }

    if (member.roles.cache.has(ctx.cfg.ROLE_NON_MEMBER_ID)) {
      // Check per-user cooldown to avoid repeated pings.
      const lastPingKey = `spots:user_last_ping:${id}`;
      const lastPingRaw = dbGetJobState(ctx.db, lastPingKey);
      const lastPing = lastPingRaw ? Number(lastPingRaw) : 0;
      if (Number.isFinite(lastPing) && now - lastPing < PER_USER_COOLDOWN_MS) {
        continue; // Skip this user - they were pinged recently.
      }
      pingable.push(id);
    }
  }

  const mentions = pingable.length ? pingable.map((id) => `<@${id}>`).join(' ') : '';
  const plural = openSlots === 1 ? '' : 's';

  // Only post if there's something to announce (either pings or just the status).
  // If no one is pingable (all on cooldown), just update the state without posting.
  if (pingable.length > 0) {
    await ch
      .send({
        content: `${mentions}\n\nOpen clan spot detected: **${openSlots}** slot${plural} open.`,
        allowedMentions: { users: pingable },
      })
      .catch(() => undefined);

    // Record per-user ping timestamps.
    for (const id of pingable) {
      dbSetJobState(ctx.db, `spots:user_last_ping:${id}`, String(now));
    }
  }

  dbSetJobState(ctx.db, stateKey, String(openSlots));
}
