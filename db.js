import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, 'data.sqlite'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS groups (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL,
    color TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tables (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL,
    shape TEXT NOT NULL DEFAULT 'round',   -- 'round' | 'rect'
    seats INTEGER NOT NULL DEFAULT 8,
    x     REAL NOT NULL DEFAULT 80,
    y     REAL NOT NULL DEFAULT 80
  );

  CREATE TABLE IF NOT EXISTS guests (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    group_id  INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    table_id  INTEGER REFERENCES tables(id) ON DELETE SET NULL,
    seat_index INTEGER
  );
`);

// Seed defaults on first run
const seeded = db.prepare(`SELECT value FROM settings WHERE key = 'seeded'`).get();
if (!seeded) {
  const insertGroup = db.prepare(`INSERT INTO groups (name, color) VALUES (?, ?)`);
  insertGroup.run('Famille mariée', '#e9a23b');
  insertGroup.run('Famille marié', '#7c9cbf');
  insertGroup.run('Amis', '#9d7cbf');
  insertGroup.run('Collègues', '#6fae8f');

  const setSetting = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  setSetting.run('event_title', 'Notre mariage');
  setSetting.run('event_date', '');
  setSetting.run('seeded', '1');
}

export default db;
