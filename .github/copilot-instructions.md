# StupidDiscordBot (Clash Royale) — Copilot Instructions

## Project goal

A Discord bot for a single Clash Royale clan that:

- Tracks war participation and posts logs to a dedicated channel.
- Manages Discord access by syncing roles from the clan roster.
- Onboards members by linking Discord users → Clash Royale player tags.
- Restricts non-clan members to a “vanquished” area.
- Posts announcements as war phases approach / begin.

Primary rule: **Clan data is the source of truth** for role (member/elder/co-leader/leader). Discord roles should be corrected automatically.

## Key behaviors (product spec)

### 1) User linking / onboarding

- A user runs `/join`.
- Bot creates a thread in the verification channel and asks for their player tag.
- User posts a tag (example `#ABC123`).
- Bot validates via Clash API `/players/{tag}` and stores `discord_user_id -> player_tag`.
- Bot indicates whether the player is currently in the clan.
- Thread is archived after successful link.

### 2) Access control

- Non-members (linked user not currently in the clan roster) get the **vanquished** role.
- Members get **member/elder/co-leader/leader** roles synced from clan roster.
- Channels:
  - General: member+ should have access.
  - War logs: elder+ read-only, leader full perms.
  - Announcements: bot posts; typical setup is everyone read.

### 3) Role syncing

- Every minute (configurable cron):
  - Pull clan roster from Clash API `/clans/{tag}/members`.
  - For each linked Discord user, assign exactly one clan role (or vanquished).
  - Remove stale clan roles if the user’s clan role changed.

### 4) War monitoring + logs

- Every minute (configurable cron):
  - Pull current river race `/clans/{tag}/currentriverrace`.
  - Compute participation status per clan member (decks used / fame / similar signals depending on the payload).
  - Post summary/deltas into war-logs channel.
  - Use persisted checkpoints so the same info isn’t spammed repeatedly.

### 5) Announcements

- Detect phase changes from current river race (e.g., training → warDay).
- Post “war day soon” and “war day started” announcements.
- De-duplicate announcements via a persisted job state.

## Architecture

- Runtime: Node.js 20+, TypeScript, Discord.js v14.
- Persistence: SQLite (better-sqlite3).
- Scheduling: node-cron.
- Config: `.env` loaded via dotenv and validated via zod.

### Core modules

- src/index.ts: boot, Discord client, handlers, scheduler start
- src/config.ts: env parsing/validation
- src/db.ts: sqlite open + migrations + job state helpers
- src/clashApi.ts: Clash Royale API client
- src/discord/\*: commands and sync logic
- src/jobs/\*: cron scheduling and periodic jobs

## Data model (SQLite)

- user_links
  - discord_user_id (PK)
  - player_tag (unique)
  - created_at / updated_at
- job_state
  - key (PK)
  - value
  - updated_at
- audit_log
  - id, ts, type, message

## Environment / configuration

See `.env.example`.

Important:

- Clash Royale API requires whitelisting your public IP.
- Discord requires Server Members intent for role syncing, and Message Content intent if using thread message parsing.

## Development milestones (suggested order)

1. Bot scaffolding + slash commands registration (DONE in repo)
2. Onboarding via /join thread + tag validation (DONE in repo)
3. SQLite schema + job_state helpers (DONE in repo)
4. Role sync job: linked users → clan roles / vanquished (DONE in repo)
5. Channel permission enforcement (apply overwrites in code; verify carefully)
6. War participation computation + log posting (implement + de-dup)
7. Announcements on phase transitions (implement + de-dup)
8. Hardening: rate limits, retries/backoff, structured logging, audit entries

## Coding standards / guardrails

- Keep changes minimal and focused; don’t add extra UX beyond the spec.
- Prefer idempotent jobs (safe to run every minute without duplicating side effects).
- Persist checkpoints (job_state) for any operation that posts messages.
- Validate inputs; normalize tags to `#...` and uppercase.
- Avoid scanning all guild members every minute; instead act on linked users.

## Operational notes

- This bot is intended to run continuously (local machine, VPS, or container).
- If Clash API requests fail, role syncing should fail “softly” (log error, retry next cycle).
