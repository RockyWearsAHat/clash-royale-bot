# StupidDiscordBot (Clash Royale)

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)](https://discord.js.org/)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)

A production-style Discord bot for a single Clash Royale clan.
It links Discord users to player tags, syncs roles from the clan roster, and posts war participation logs.

## Features

- Self-managed onboarding: unlinked users automatically get a verification/profile thread (no commands needed)
- Role sync: assigns Discord roles based on link status and current clan membership/role
- War monitoring: posts participation deltas + snapshots to a dedicated logs channel
- Utilities: channel permission enforcement + open-spot notification subscriptions

## Prerequisites

- Node.js 20+
- A Discord server where you have admin
- A Clash Royale API token: https://developer.clashroyale.com/ (requires whitelisting your public IP)

## Quick start (non-coder friendly)

1. Create your config file

- Copy `.env.example` to `.env`
- Fill in:
  - `DISCORD_TOKEN`, `DISCORD_APP_ID`
  - `CLASH_API_TOKEN`, `CLASH_CLAN_TAG`
  - `GUILD_ID`
  - Channel IDs: `CHANNEL_GENERAL_ID`, `CHANNEL_VERIFICATION_ID`, `CHANNEL_WAR_LOGS_ID`, `CHANNEL_ANNOUNCEMENTS_ID`, `CHANNEL_NON_MEMBER_ID`
  - Role IDs: `ROLE_NON_MEMBER_ID`, `ROLE_MEMBER_ID`, `ROLE_ELDER_ID`, `ROLE_COLEADER_ID`, `ROLE_LEADER_ID`

2. Double-click the launcher for your OS

- Windows: `run-bot.bat`
- macOS: `run-bot.command`
- Linux: `run-bot.desktop`

That’s it. The launcher will install dependencies (if needed), build the bot, register slash commands, and start it.

## Run

### One-click launchers

- Windows (double-click): `run-bot.bat`
- macOS (double-click): `run-bot.command`
- Linux (double-click): `run-bot.desktop`

Each launcher runs the same flow: install (if needed) → build → register commands → start.

Optional flags (via environment variables) for one-click launchers:

- `INSTALL_AND_REGISTER=1` (default) — install deps + register commands
- `INSTALL_AND_REGISTER=0` — skip install + skip command registration

Advanced overrides (only set these if you need to override `INSTALL_AND_REGISTER`):

- `SKIP_INSTALL=1` — skip `npm install`
- `REGISTER_COMMANDS=0` — skip command registration

### Terminal

- macOS/Linux: `bash ./run-bot.sh`
- Any OS with Node: `node ./scripts/run-bot.mjs`

## Commands

- `/stats` — clan roster + stats utilities (available in the general channel)
- `/warstats` — current war stats (available in the war-logs channel)
- `/warlogs` — war log publishing utilities (available in the war-logs channel)
- `/notifywhenspot` — subscribe to be pinged when the clan has an open spot (available in the non-member channel)
- `/notifynomore` — unsubscribe from open-spot notifications

## How it works (high level)

- Persistence: SQLite tables for user links and job state checkpoints
- Sync loop: scheduled jobs pull clan/war data from the Clash API and apply idempotent updates
- Source of truth: clan roster determines the target clan role; `.env` maps clan role → Discord role IDs

## Onboarding flow

1. A user joins the server (or speaks in the verification channel)
2. The bot creates (or reuses) a private verification/profile thread for that user
3. The user pastes their player tag (example: `#ABC123`) in the thread
4. The bot validates the tag via the Clash API and stores a link in SQLite
5. Role sync updates their Discord role(s) automatically

## Notes

- If `PERMISSIONS_ENFORCE_ON_STARTUP=true`, the bot will attempt to apply channel overwrites on startup.
  - Ensure the bot can see/edit those channels at least once, otherwise Discord will reject overwrite edits.
- SQLite DB files are local-only and intentionally ignored by git (`bot.sqlite`, `bot.sqlite-wal`, `bot.sqlite-shm`).

## Development

- Install deps: `npm i`
- Register commands: `npm run register:commands`
- Run with hot reload: `npm run dev`
