import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { WarLogsCommand, WarStatsCommand } from './discord/warstats.js';
import { StatsCommand } from './discord/stats.js';
import { RetryLastSnapshotCommand } from './discord/retryLastSnapshot.js';
import { NotifyNoMoreCommand, NotifyWhenSpotCommand } from './discord/spotNotify.js';
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const cfg = loadConfig();

const commands = [
  StatsCommand.data,
  WarStatsCommand.data,
  WarLogsCommand.data,
  RetryLastSnapshotCommand.data,
  NotifyWhenSpotCommand.data,
  NotifyNoMoreCommand.data,
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(cfg.DISCORD_TOKEN);

type CommandPermissionType = 1 | 2 | 3;
type CommandPermission = {
  id: string;
  type: CommandPermissionType;
  permission: boolean;
};

function buildChannelAllowlistPermissions(
  guildId: string,
  allowedChannelIds: string[],
): CommandPermission[] {
  // SAFETY:
  // If we set @everyone=false here and the channel allowlist doesn't apply correctly,
  // non-admin users effectively lose the command everywhere (admins/owners still see it).
  //
  // To keep per-channel visibility WITHOUT lockouts, we:
  // - set @everyone=true
  // - explicitly disable the command in every other channel (type=3, permission=false)
  // - explicitly enable it in allowed channels
  //
  // This is limited by Discord to ~100 permission entries per command.
  void allowedChannelIds;
  return [{ id: guildId, type: 1, permission: true }];
}

function getRedirectUri(): URL {
  const raw = cfg.DISCORD_OAUTH_REDIRECT_URI?.trim() || 'http://127.0.0.1:53134/oauth2/callback';
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`DISCORD_OAUTH_REDIRECT_URI must be http(s), got: ${url.protocol}`);
  }
  return url;
}

function buildAuthorizeUrl(redirectUri: URL, state: string): string {
  const authorize = new URL('https://discord.com/api/oauth2/authorize');
  authorize.searchParams.set('client_id', cfg.DISCORD_APP_ID);
  authorize.searchParams.set('redirect_uri', redirectUri.toString());
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set(
    'scope',
    ['applications.commands.permissions.update', 'identify'].join(' '),
  );
  authorize.searchParams.set('prompt', 'consent');
  authorize.searchParams.set('state', state);
  return authorize.toString();
}

async function waitForOAuthCode(redirectUri: URL, expectedState: string): Promise<string> {
  const port = Number(redirectUri.port || (redirectUri.protocol === 'https:' ? '443' : '80'));
  const expectedPath = redirectUri.pathname;

  return await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        if (!req.url) {
          res.statusCode = 400;
          res.end('Bad request');
          return;
        }

        const incoming = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
        if (incoming.pathname !== expectedPath) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        const code = incoming.searchParams.get('code');
        const state = incoming.searchParams.get('state');
        const error = incoming.searchParams.get('error');

        if (error) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(`OAuth error: ${error}`);
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code || !state) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Missing code/state');
          return;
        }

        if (state !== expectedState) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('State mismatch');
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(
          '<!doctype html><html><body><h3>Success</h3><p>You can close this tab and return to your terminal.</p></body></html>',
        );

        server.close();
        resolve(code);
      } catch (e) {
        server.close();
        reject(e);
      }
    });

    server.on('error', (e) => {
      reject(e);
    });

    server.listen(port, redirectUri.hostname, () => {
      // ready
    });

    // 2 minute timeout.
    const timeout = setTimeout(
      () => {
        server.close();
        reject(new Error('OAuth flow timed out waiting for callback.'));
      },
      2 * 60 * 1000,
    );

    server.on('close', () => clearTimeout(timeout));
  });
}

async function exchangeCodeForToken(code: string, redirectUri: URL): Promise<string> {
  if (!cfg.DISCORD_OAUTH_CLIENT_SECRET) {
    throw new Error('Missing DISCORD_OAUTH_CLIENT_SECRET (required to exchange OAuth code).');
  }

  const body = new URLSearchParams();
  body.set('client_id', cfg.DISCORD_APP_ID);
  body.set('client_secret', cfg.DISCORD_OAUTH_CLIENT_SECRET);
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', redirectUri.toString());

  const resp = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  const json = (await resp.json()) as {
    access_token?: string;
    token_type?: string;
    scope?: string;
  };

  if (!json.access_token) {
    throw new Error('Token exchange response missing access_token.');
  }

  // Discord returns token_type "Bearer".
  return json.access_token;
}

async function getPermissionsBearerToken(): Promise<string | null> {
  if (cfg.DISCORD_COMMAND_PERMISSIONS_BEARER_TOKEN) {
    return cfg.DISCORD_COMMAND_PERMISSIONS_BEARER_TOKEN;
  }

  // If no secret is configured, we can't do the interactive flow.
  if (!cfg.DISCORD_OAUTH_CLIENT_SECRET) {
    return null;
  }

  const redirectUri = getRedirectUri();
  const state = randomBytes(16).toString('hex');

  const authorizeUrl = buildAuthorizeUrl(redirectUri, state);
  console.log('\nPer-channel command permissions require a user OAuth2 Bearer token.');
  console.log('1) Open this URL in your browser and authorize:');
  console.log(authorizeUrl);
  console.log(`2) After approving, you will be redirected to: ${redirectUri.toString()}`);
  console.log('Waiting for callback...\n');

  const code = await waitForOAuthCode(redirectUri, state);
  const accessToken = await exchangeCodeForToken(code, redirectUri);
  return accessToken;
}

async function applyCommandPermissions(
  guildId: string,
  commandIdsByName: Map<string, string>,
): Promise<void> {
  const bearer = await getPermissionsBearerToken();
  if (!bearer) {
    console.log(
      'Skipping per-channel command permissions (set DISCORD_COMMAND_PERMISSIONS_BEARER_TOKEN, or set DISCORD_OAUTH_CLIENT_SECRET + DISCORD_OAUTH_REDIRECT_URI for interactive flow).',
    );
    return;
  }

  const permsRest = new REST({ version: '10', authPrefix: 'Bearer' }).setToken(bearer);

  const allChannels = (await rest.get(Routes.guildChannels(guildId)).catch(() => [])) as Array<{
    id: string;
    type?: number;
  }>;
  const allChannelIds = Array.isArray(allChannels)
    ? allChannels.map((c) => String((c as any)?.id ?? '')).filter((id) => id && id !== guildId)
    : [];

  const buildGuildWideChannelDenyList = (allowedChannelIds: string[]): CommandPermission[] => {
    const allowed = new Set(allowedChannelIds);
    const disallowed = allChannelIds.filter((id) => !allowed.has(id));

    // Discord caps permission entries per command.
    const MAX_ENTRIES = 100;
    const total = 1 + disallowed.length + allowedChannelIds.length;
    if (total > MAX_ENTRIES) {
      console.log(
        `Skipping per-channel command visibility: guild has ${allChannelIds.length} channels, which would require ${total} permission entries (> ${MAX_ENTRIES}).`,
      );
      return [{ id: guildId, type: 1, permission: true }];
    }

    return [
      // Enable for everyone by default.
      { id: guildId, type: 1, permission: true },
      // Disable in all other channels.
      ...disallowed.map((id) => ({ id, type: 3 as const, permission: false })),
      // Enable in allowed channels.
      ...allowedChannelIds.map((id) => ({ id, type: 3 as const, permission: true })),
    ];
  };

  const statsId = commandIdsByName.get('stats');
  const warstatsId = commandIdsByName.get('warstats');
  const warlogsId = commandIdsByName.get('warlogs');
  const notifyWhenSpotId = commandIdsByName.get('notifywhenspot');
  const notifyNoMoreId = commandIdsByName.get('notifynomore');

  if (!statsId || !warstatsId || !warlogsId || !notifyWhenSpotId || !notifyNoMoreId) {
    throw new Error(
      `Could not resolve all command IDs. Found: stats=${statsId}, warstats=${warstatsId}, warlogs=${warlogsId}, notifywhenspot=${notifyWhenSpotId}, notifynomore=${notifyNoMoreId}`,
    );
  }

  const statsPerms = buildGuildWideChannelDenyList([cfg.CHANNEL_GENERAL_ID]);
  const warPerms = buildGuildWideChannelDenyList([cfg.CHANNEL_WAR_LOGS_ID]);
  const nonMemberPerms = buildGuildWideChannelDenyList([cfg.CHANNEL_NON_MEMBER_ID]);

  const payload = [
    { id: statsId, permissions: statsPerms },
    { id: warstatsId, permissions: warPerms },
    { id: warlogsId, permissions: warPerms },
    { id: notifyWhenSpotId, permissions: nonMemberPerms },
    { id: notifyNoMoreId, permissions: nonMemberPerms },
  ];

  // Batch endpoint is disabled; apply per-command.
  for (const { id, permissions } of payload) {
    const route: `/${string}` = `/applications/${cfg.DISCORD_APP_ID}/guilds/${guildId}/commands/${id}/permissions`;
    await permsRest.put(route, { body: { permissions } });
  }
}

async function main() {
  const guildId = cfg.GUILD_ID;

  await rest.put(Routes.applicationGuildCommands(cfg.DISCORD_APP_ID, guildId), {
    body: commands,
  });

  const registered = (await rest.get(
    Routes.applicationGuildCommands(cfg.DISCORD_APP_ID, guildId),
  )) as Array<{ id: string; name: string }>;

  const commandIdsByName = new Map(registered.map((c) => [c.name, c.id] as const));
  await applyCommandPermissions(guildId, commandIdsByName);

  console.log(`Registered ${commands.length} command(s) for guild ${guildId}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
