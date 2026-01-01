import Database from 'better-sqlite3';

export type Db = Database.Database;

export function openDb(sqlitePath: string): Db {
  const db = new Database(sqlitePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function migrate(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_links (
      discord_user_id TEXT PRIMARY KEY,
      player_tag TEXT NOT NULL UNIQUE,
      player_name TEXT,
      custom_display_name TEXT,
      display_preference TEXT NOT NULL DEFAULT 'discord',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS spot_subscriptions (
      discord_user_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS war_history (
      war_key TEXT PRIMARY KEY,
      clan_tag TEXT NOT NULL,
      season_id INTEGER,
      section_index INTEGER,
      created_date TEXT,
      rank INTEGER,
      inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
      raw_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      type TEXT NOT NULL,
      message TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS trg_user_links_updated
    AFTER UPDATE ON user_links
    FOR EACH ROW
    BEGIN
      UPDATE user_links SET updated_at = datetime('now') WHERE discord_user_id = OLD.discord_user_id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_spot_subscriptions_updated
    AFTER UPDATE ON spot_subscriptions
    FOR EACH ROW
    BEGIN
      UPDATE spot_subscriptions
      SET updated_at = datetime('now')
      WHERE discord_user_id = OLD.discord_user_id;
    END;
  `);

  // Best-effort migration for older DBs that predate new columns.
  const cols = db.prepare("SELECT name FROM pragma_table_info('user_links')").all() as Array<{
    name: string;
  }>;
  const colSet = new Set(cols.map((c) => c.name));

  if (!colSet.has('player_name')) {
    db.exec(`ALTER TABLE user_links ADD COLUMN player_name TEXT;`);
  }
  if (!colSet.has('custom_display_name')) {
    db.exec(`ALTER TABLE user_links ADD COLUMN custom_display_name TEXT;`);
  }
  if (!colSet.has('display_preference')) {
    db.exec(
      `ALTER TABLE user_links ADD COLUMN display_preference TEXT NOT NULL DEFAULT 'discord';`,
    );
  }
}

export function dbSubscribeToSpots(db: Db, discordUserId: string): { alreadySubscribed: boolean } {
  const existing = db
    .prepare('SELECT 1 FROM spot_subscriptions WHERE discord_user_id = ?')
    .get(discordUserId) as { 1: number } | undefined;
  if (existing) return { alreadySubscribed: true };

  db.prepare(
    `INSERT INTO spot_subscriptions(discord_user_id)
     VALUES(?)
     ON CONFLICT(discord_user_id) DO NOTHING`,
  ).run(discordUserId);

  return { alreadySubscribed: false };
}

export function dbListSpotSubscribers(db: Db): string[] {
  const rows = db
    .prepare('SELECT discord_user_id FROM spot_subscriptions ORDER BY updated_at DESC')
    .all() as Array<{ discord_user_id: string }>;
  return rows.map((r) => r.discord_user_id);
}

export function dbUnsubscribeFromSpots(db: Db, discordUserId: string): { wasSubscribed: boolean } {
  const info = db
    .prepare('DELETE FROM spot_subscriptions WHERE discord_user_id = ?')
    .run(discordUserId);
  return { wasSubscribed: info.changes > 0 };
}

export function dbGetJobState(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM job_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function dbSetJobState(db: Db, key: string, value: string) {
  db.prepare(
    `INSERT INTO job_state(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value);
}

export function dbDeleteJobState(db: Db, key: string) {
  db.prepare('DELETE FROM job_state WHERE key = ?').run(key);
}

export function dbAudit(db: Db, type: string, message: string) {
  db.prepare('INSERT INTO audit_log(type, message) VALUES(?, ?)').run(type, message);
}

export type WarHistoryRow = {
  war_key: string;
  clan_tag: string;
  season_id: number | null;
  section_index: number | null;
  created_date: string | null;
  rank: number | null;
};

export function dbInsertWarHistoryIfMissing(db: Db, row: WarHistoryRow & { raw_json: string }) {
  db.prepare(
    `INSERT INTO war_history(
       war_key, clan_tag, season_id, section_index, created_date, rank, raw_json
     ) VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(war_key) DO NOTHING`,
  ).run(
    row.war_key,
    row.clan_tag,
    row.season_id,
    row.section_index,
    row.created_date,
    row.rank,
    row.raw_json,
  );
}
