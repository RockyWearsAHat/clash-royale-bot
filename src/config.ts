import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APP_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1).optional(),

  // Optional: OAuth2 Bearer token used to update application command permissions
  // (channel-level enable/disable so slash command suggestions match availability).
  // Note: Discord requires a Bearer token with the `applications.commands.permissions.update` scope.
  DISCORD_COMMAND_PERMISSIONS_BEARER_TOKEN: z.string().min(1).optional(),

  // Optional: if set, `npm run register:commands` can run an interactive OAuth2 flow
  // to obtain a short-lived Bearer token for applying command permissions.
  // You must add the redirect URI to your Discord application settings.
  DISCORD_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  DISCORD_OAUTH_REDIRECT_URI: z.string().min(1).optional(),

  CLASH_API_TOKEN: z.string().min(1),
  CLASH_CLAN_TAG: z.string().min(2),

  GUILD_ID: z.string().min(1),
  CHANNEL_GENERAL_ID: z.string().min(1),
  CHANNEL_VERIFICATION_ID: z.string().min(1),
  CHANNEL_WAR_LOGS_ID: z.string().min(1),
  CHANNEL_ANNOUNCEMENTS_ID: z.string().min(1),
  CHANNEL_VANQUISHED_ID: z.string().min(1),

  ROLE_VANQUISHED_ID: z.string().min(1),
  ROLE_MEMBER_ID: z.string().min(1),
  ROLE_ELDER_ID: z.string().min(1),
  ROLE_COLEADER_ID: z.string().min(1),
  ROLE_LEADER_ID: z.string().min(1),

  SQLITE_PATH: z.string().min(1).default('bot.sqlite'),

  ROLE_SYNC_CRON: z.string().min(1).default('*/1 * * * *'),
  WAR_POLL_CRON: z.string().min(1).default('*/1 * * * *'),

  WARLOGS_DEBUG: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v ?? 'false') === 'true'),
  // Comma-separated roster names to debug in /warlogs (e.g. "Natedawg, Alice").
  WARLOGS_DEBUG_PLAYERS: z
    .string()
    .optional()
    .transform((v) => v ?? ''),

  PERMISSIONS_ENFORCE_ON_STARTUP: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v ?? 'true') === 'true'),

  // If set, permissions will be enforced on a schedule (in addition to startup).
  // Keep this relatively infrequent to reduce Discord API churn.
  PERMISSIONS_ENFORCE_CRON: z.string().min(1).default('*/1 * * * *'),

  HIDE_VERIFICATION_CHANNEL_AFTER_LINK: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v ?? 'true') === 'true'),

  // Dev-only helper: if true, recreates all linked users' profile threads at startup
  // so the latest UI revisions are applied.
  DEV_RECREATE_PROFILE_THREADS: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v ?? 'false') === 'true'),

  // One-time helper: attempt to create links by matching guild display names
  // to Clash Royale names in the clan roster.
  MIGRATE_NICKNAME_TO_TAG: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v ?? 'false') === 'true'),

  // If true, run the migration even if it was already marked done.
  MIGRATE_NICKNAME_TO_TAG_FORCE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v ?? 'false') === 'true'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(): AppConfig {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${msg}`);
  }

  // normalize clan tag
  const cfg = parsed.data;
  if (!cfg.CLASH_CLAN_TAG.startsWith('#')) {
    (cfg as any).CLASH_CLAN_TAG = `#${cfg.CLASH_CLAN_TAG}`;
  }
  return cfg;
}
