import cron from 'node-cron';
import type { Client } from 'discord.js';
import type { AppContext } from '../types.js';
import { syncRolesOnce } from '../discord/roleSync.js';
import { reconcileVerificationThreadForUser } from '../discord/join.js';
import { pollWarOnce } from './war.js';

export function startScheduler(ctx: AppContext, client: Client) {
  cron.schedule(ctx.cfg.ROLE_SYNC_CRON, async () => {
    try {
      const guild = await client.guilds.fetch(ctx.cfg.GUILD_ID);
      await syncRolesOnce(ctx, guild);

      // If a linked user deleted/left their profile thread (and the verification channel is hidden),
      // recreate/re-open it automatically.
      const linked = ctx.db.prepare('SELECT discord_user_id FROM user_links').all() as Array<{
        discord_user_id: string;
      }>;
      for (const row of linked) {
        await reconcileVerificationThreadForUser(ctx, client, row.discord_user_id);
        await new Promise((r) => setTimeout(r, 150));
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
