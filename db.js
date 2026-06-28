import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join, isAbsolute } from 'path';
import { mkdirSync, accessSync, constants } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isWritableDir = (dir) => {
  try { mkdirSync(dir, { recursive: true }); accessSync(dir, constants.W_OK); return true; }
  catch { return false; }
};

// Where the SQLite file lives. To keep data PERSISTENT in production (where the
// container filesystem is wiped on each deploy), point it at a mounted volume.
// Resolution order:
//   1. SQLITE_PATH         — explicit file path
//   2. DATA_DIR            — directory to hold data.sqlite
//   3. /data (auto)        — used automatically if it's a writable mount
//                            (e.g. attach a Railway volume at /data → done, zero config)
//   4. ./data.sqlite       — local development fallback
function resolveDbPath() {
  if (process.env.SQLITE_PATH) {
    const p = process.env.SQLITE_PATH;
    return isAbsolute(p) ? p : join(__dirname, p);
  }
  let dir = process.env.DATA_DIR
    ? (isAbsolute(process.env.DATA_DIR) ? process.env.DATA_DIR : join(__dirname, process.env.DATA_DIR))
    : null;
  if (!dir && isWritableDir('/data')) dir = '/data';   // auto-detect a mounted volume
  if (!dir) dir = __dirname;
  mkdirSync(dir, { recursive: true });
  return join(dir, 'data.sqlite');
}

const dbPath = resolveDbPath();
const db = new Database(dbPath);
console.log(`  🗄️  Base de données : ${dbPath}`);

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
    y     REAL NOT NULL DEFAULT 80,
    color TEXT                             -- optional background tint (hex)
  );

  CREATE TABLE IF NOT EXISTS guests (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    group_id  INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    table_id  INTEGER REFERENCES tables(id) ON DELETE SET NULL,
    seat_index INTEGER,
    diet      TEXT,                          -- régime / allergies alimentaires
    notes     TEXT                           -- note libre
  );

  CREATE TABLE IF NOT EXISTS decor (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    kind  TEXT NOT NULL,                     -- 'plante' | 'lavande' | 'maison' | ...
    x     REAL NOT NULL DEFAULT 80,
    y     REAL NOT NULL DEFAULT 80,
    size  REAL NOT NULL DEFAULT 1,
    label TEXT
  );
`);

// Lightweight migrations for databases created by older versions
const tableCols = db.prepare(`PRAGMA table_info(tables)`).all().map(c => c.name);
if (!tableCols.includes('color')) {
  db.exec(`ALTER TABLE tables ADD COLUMN color TEXT`);
}
const guestCols = db.prepare(`PRAGMA table_info(guests)`).all().map(c => c.name);
if (!guestCols.includes('diet'))  db.exec(`ALTER TABLE guests ADD COLUMN diet TEXT`);
if (!guestCols.includes('notes')) db.exec(`ALTER TABLE guests ADD COLUMN notes TEXT`);

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
