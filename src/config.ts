import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APP_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1).optional(),

  CLASH_API_TOKEN: z.string().min(1),
  CLASH_CLAN_TAG: z.string().min(2),

  GUILD_ID: z.string().min(1),
  CHANNEL_GENERAL_ID: z.string().min(1),
  CHANNEL_VERIFICATION_ID: z.string().min(1),
  CHANNEL_WAR_LOGS_ID: z.string().min(1),
  CHANNEL_ANNOUNCEMENTS_ID: z.string().min(1),

  ROLE_VANQUISHED_ID: z.string().min(1),
  ROLE_MEMBER_ID: z.string().min(1),
  ROLE_ELDER_ID: z.string().min(1),
  ROLE_COLEADER_ID: z.string().min(1),
  ROLE_LEADER_ID: z.string().min(1),

  SQLITE_PATH: z.string().min(1).default('bot.sqlite'),

  ROLE_SYNC_CRON: z.string().min(1).default('*/1 * * * *'),
  WAR_POLL_CRON: z.string().min(1).default('*/1 * * * *'),

  PERMISSIONS_ENFORCE_ON_STARTUP: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v ?? 'true') === 'true'),

  HIDE_VERIFICATION_CHANNEL_AFTER_LINK: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v ?? 'true') === 'true'),
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
