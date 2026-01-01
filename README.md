# StupidDiscordBot (Clash Royale)

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)](https://discord.js.org/)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)

A production-style Discord bot for a single Clash Royale clan.
It links Discord users to player tags, syncs roles from the clan roster, and posts war participation logs.

## Features

- Onboarding: `/join` creates a verification thread and links a Discord user → player tag
- Role sync: periodically assigns **member/elder/co-leader/leader** (or **vanquished**) based on clan roster
- War monitoring: posts participation deltas + snapshots to a dedicated logs channel
- Admin utilities: permissions enforcement and unlinking

## Tech stack

- Node.js 20+, TypeScript
- Discord.js v14
- SQLite via `better-sqlite3`
- Scheduling via `node-cron`
- Config via `.env` + zod validation

## Prerequisites

- Node.js 20+
- Discord server where you have admin
- Clash Royale API token: https://developer.clashroyale.com/
  - Requires whitelisting your public IP

## Setup

1. Install dependencies

- `npm i`

2. Configure environment

- Copy `.env.example` to `.env` and fill values.
- Required channel IDs include `CHANNEL_GENERAL_ID`, `CHANNEL_WAR_LOGS_ID`, `CHANNEL_ANNOUNCEMENTS_ID`, and `CHANNEL_VERIFICATION_ID`.

3. Create the Discord application + bot

- Discord Developer Portal → New Application
- Bot → Reset Token → put it in `DISCORD_TOKEN`
- OAuth2 → URL Generator → scopes: `bot`, `applications.commands`
- Privileged Gateway Intents:
  - Server Members Intent: ON
  - Message Content Intent: ON (needed for thread-based tag capture)

4. Register slash commands (guild-scoped for fast iteration)

- `npm run register:commands`

## Run

### One-click launchers

- Windows (double-click): `run-bot.bat`
- macOS (double-click): `run-bot.command`
- Linux (double-click): `run-bot.desktop`

Each launcher runs the same flow: install (if needed) → build → start.

Optional flags (via environment variables):

- `SKIP_INSTALL=1` — skip `npm install`
- `REGISTER_COMMANDS=1` — run `npm run register:commands` before starting

### Terminal

- macOS/Linux: `bash ./run-bot.sh`
- Any OS with Node: `node ./scripts/run-bot.mjs`

## Commands

- `/join` — link your Discord user to a Clash Royale player tag
- `/whoami` — show your linked tag
- `/unlink` — remove your linked tag
- `/warstats` (alias: `/warlogs`) — show current war stats (restricted to the war-logs channel)
- `/enforce-perms` — admin-only permission overwrite enforcement

## How it works (high level)

- Persistence: SQLite tables for user links and job state checkpoints
- Sync loop: scheduled jobs pull clan/war data from the Clash API and apply idempotent updates
- Source of truth: clan roster determines Discord roles; Discord is corrected automatically

## Notes

- If `PERMISSIONS_ENFORCE_ON_STARTUP=true`, the bot will attempt to apply channel overwrites on startup.
  - Ensure the bot can see/edit those channels at least once, otherwise Discord will reject overwrite edits.
- SQLite DB files are local-only and intentionally ignored by git (`bot.sqlite`, `bot.sqlite-wal`, `bot.sqlite-shm`).
