import cron from 'node-cron';
import type { Client } from 'discord.js';
import type { AppContext } from '../types.js';
import { syncRolesOnce } from '../discord/roleSync.js';
import { reconcileVerificationThreadForUser } from '../discord/join.js';
import { enforceChannelPermissions } from '../discord/permissions.js';
import { pollWarOnce } from './war.js';
import { dbGetJobState, dbSetJobState } from '../db.js';

export function startScheduler(ctx: AppContext, client: Client) {
  cron.schedule(ctx.cfg.PERMISSIONS_ENFORCE_CRON, async () => {
    try {
      const guild = await client.guilds.fetch(ctx.cfg.GUILD_ID);
      await enforceChannelPermissions(ctx, client, guild);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.db
        .prepare('INSERT INTO audit_log(type, message) VALUES(?, ?)')
        .run('perms_enforce_error', msg);
    }
  });

  cron.schedule(ctx.cfg.ROLE_SYNC_CRON, async () => {
    try {
      const guild = await client.guilds.fetch(ctx.cfg.GUILD_ID);
      await syncRolesOnce(ctx, guild);

      // Reconcile profile threads occasionally (not every minute) to avoid API churn and "spammy" edits.
      const lastKey = 'verify:reconcile:last_ms';
      const lastRaw = dbGetJobState(ctx.db, lastKey);
      const last = lastRaw ? Number(lastRaw) : 0;
      const shouldRun = !Number.isFinite(last) || Date.now() - last > 30 * 60_000;
      if (shouldRun) {
        dbSetJobState(ctx.db, lastKey, String(Date.now()));
        const linked = ctx.db.prepare('SELECT discord_user_id FROM user_links').all() as Array<{
          discord_user_id: string;
        }>;
        for (const row of linked) {
          await reconcileVerificationThreadForUser(ctx, client, row.discord_user_id);
          await new Promise((r) => setTimeout(r, 150));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.db
        .prepare('INSERT INTO audit_log(type, message) VALUES(?, ?)')
        .run('role_sync_error', msg);
    }
  });

  cron.schedule(ctx.cfg.WAR_POLL_CRON, async () => {
    try {
      await pollWarOnce(ctx, client);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.db
        .prepare('INSERT INTO audit_log(type, message) VALUES(?, ?)')
        .run('war_poll_error', msg);
    }
  });
}
