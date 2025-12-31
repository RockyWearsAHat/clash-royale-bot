# StupidDiscordBot (Clash Royale)

A Discord bot that:

- Links Discord users to Clash Royale player tags
- Polls the Clash Royale API for clan membership & roles
- Keeps Discord roles in sync (member/elder/co-leader/leader)
- Logs war participation (delta updates + end-of-day snapshots)
- Provides slash commands for linking and stats

Key commands:

- `/join` — link your Discord user to a Clash Royale player tag
- `/whoami` — show your linked tag
- `/unlink` — remove your linked tag
- `/warstats` (alias: `/warlogs`) — show current war stats (restricted to the war-logs channel)
- `/enforce-perms` — admin-only permission overwrite enforcement

## Prereqs

- Node.js 20+
- A Discord server where you have admin
- Clash Royale API token (https://developer.clashroyale.com/)

## Setup (local)

1. Install deps

- `npm i`

2. Create `.env`

- Copy `.env.example` to `.env` and fill values.
  - You must set `CHANNEL_GENERAL_ID` (member+ access), `CHANNEL_WAR_LOGS_ID`, `CHANNEL_ANNOUNCEMENTS_ID`, and `CHANNEL_VERIFICATION_ID`.

3. Create the Discord application + bot

- Discord Developer Portal → New Application
- Bot → Reset Token → put it in `DISCORD_TOKEN`
- OAuth2 → URL Generator → scopes: `bot`, `applications.commands`
- Bot permissions (minimum to start testing):
  - Manage Roles
  - Manage Channels (if you want the bot to adjust permissions later)
  - Read Message History
  - Send Messages
  - Create Public Threads
  - Manage Threads
- Privileged Gateway Intents:
  - Server Members Intent: ON
  - Message Content Intent: ON (needed for thread-based tag capture)

4. Register slash commands (guild-scoped for fast iteration)

- `npm run register:commands`

5. Run the bot

- `npm run dev`

## Testing flow

- Run `/join` → bot creates a thread in `CHANNEL_VERIFICATION_ID`
- Post your player tag (like `#ABC123`) in that thread
- The bot validates via Clash API, saves the mapping, and archives the thread
- Role sync runs every minute and will apply/remove roles based on clan data

## Permissions enforcement

- If `PERMISSIONS_ENFORCE_ON_STARTUP=true`, the bot will attempt to apply channel overwrites on startup.
- Important: the bot must be able to see/edit those channels at least once (give it `View Channel` + `Manage Channels` or `Administrator`), otherwise Discord will reject overwrite edits.
- Admin-only command: `/enforce-perms` to run the permission enforcement manually and get a detailed report.

## Notes

- Clash API requires you to whitelist your public IP in the developer portal.
- If you run the bot from home and your IP changes, requests will start failing until you update the whitelist.
- SQLite DB files are local-only and intentionally ignored by git (`bot.sqlite`, `bot.sqlite-wal`, `bot.sqlite-shm`).
