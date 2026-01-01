import type { Guild, GuildMember } from 'discord.js';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfterMs(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/retry\s+after\s+([0-9.]+)\s+seconds?/i);
  if (!m) return undefined;
  const sec = Number(m[1]);
  if (!Number.isFinite(sec) || sec <= 0) return undefined;
  return Math.ceil(sec * 1000);
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  // Best-effort retry for Discord "rate limited" errors.
  // discord.js often auto-retries REST 429s, but gateway member-chunk requests can still throw.
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const waitMs = parseRetryAfterMs(err);
      if (!waitMs) throw err;
      // Add small jitter so multiple loops don't synchronize.
      const jitter = Math.floor(Math.random() * 250);
      await sleep(waitMs + jitter);
      if (attempt === 6) throw err;
      // continue
      void label;
    }
  }
  // unreachable
  throw new Error('unreachable');
}

/**
 * Lists a page of guild members without using the gateway REQUEST_GUILD_MEMBERS (opcode 8).
 * Uses REST pagination when available.
 */
export async function listGuildMembersPage(
  guild: Guild,
  opts: { after?: string; limit?: number },
): Promise<GuildMember[]> {
  const afterRaw = String(opts.after ?? '').trim();
  // Discord expects a snowflake string of digits for `after`.
  const after = /^[0-9]{10,}$/.test(afterRaw) ? afterRaw : undefined;
  const limit = opts.limit ?? 1000;

  const mgr: any = guild.members as any;
  if (typeof mgr.list === 'function') {
    const coll = await withRetry('guild.members.list', async () =>
      mgr.list(after ? { limit, after } : { limit }),
    );
    const out: GuildMember[] = [];
    for (const m of (coll?.values?.() ?? []) as Iterable<GuildMember>) out.push(m);
    return out;
  }

  // Fallback: gateway-based full fetch (may be rate limited on larger guilds).
  // Only used if discord.js doesn't expose REST listing in this environment.
  await withRetry('guild.members.fetch', async () => guild.members.fetch());
  return [...guild.members.cache.values()];
}
