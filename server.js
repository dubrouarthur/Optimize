import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ---------- Helpers ----------
const getSettings = () => {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
};

// ---------- Full state ----------
app.get('/api/state', (req, res) => {
  res.json({
    settings: getSettings(),
    groups: db.prepare(`SELECT * FROM groups ORDER BY id`).all(),
    tables: db.prepare(`SELECT * FROM tables ORDER BY id`).all(),
    guests: db.prepare(`SELECT * FROM guests ORDER BY name COLLATE NOCASE`).all(),
  });
});

// ---------- Settings ----------
app.patch('/api/settings', (req, res) => {
  const stmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  for (const [k, v] of Object.entries(req.body || {})) stmt.run(k, String(v ?? ''));
  res.json(getSettings());
});

// ---------- Groups ----------
app.post('/api/groups', (req, res) => {
  const { name, color } = req.body;
  const info = db.prepare(`INSERT INTO groups (name, color) VALUES (?, ?)`)
    .run((name || 'Groupe').trim(), color || '#bbbbbb');
  res.json(db.prepare(`SELECT * FROM groups WHERE id = ?`).get(info.lastInsertRowid));
});

app.patch('/api/groups/:id', (req, res) => {
  const { name, color } = req.body;
  const cur = db.prepare(`SELECT * FROM groups WHERE id = ?`).get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'introuvable' });
  db.prepare(`UPDATE groups SET name = ?, color = ? WHERE id = ?`)
    .run(name ?? cur.name, color ?? cur.color, req.params.id);
  res.json(db.prepare(`SELECT * FROM groups WHERE id = ?`).get(req.params.id));
});

app.delete('/api/groups/:id', (req, res) => {
  db.prepare(`DELETE FROM groups WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---------- Tables ----------
app.post('/api/tables', (req, res) => {
  const { name, shape, seats, x, y } = req.body;
  const count = db.prepare(`SELECT COUNT(*) c FROM tables`).get().c;
  const info = db.prepare(
    `INSERT INTO tables (name, shape, seats, x, y) VALUES (?, ?, ?, ?, ?)`
  ).run(
    (name || `Table ${count + 1}`).trim(),
    shape === 'rect' ? 'rect' : 'round',
    Math.max(1, Math.min(20, parseInt(seats) || 8)),
    x ?? 60 + (count % 4) * 250,
    y ?? 60 + Math.floor(count / 4) * 260
  );
  res.json(db.prepare(`SELECT * FROM tables WHERE id = ?`).get(info.lastInsertRowid));
});

app.patch('/api/tables/:id', (req, res) => {
  const cur = db.prepare(`SELECT * FROM tables WHERE id = ?`).get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'introuvable' });
  const { name, shape, seats, x, y } = req.body;
  const newSeats = seats != null ? Math.max(1, Math.min(20, parseInt(seats))) : cur.seats;
  // If shrinking, unseat guests sitting beyond the new seat count
  if (newSeats < cur.seats) {
    db.prepare(
      `UPDATE guests SET table_id = NULL, seat_index = NULL
       WHERE table_id = ? AND seat_index >= ?`
    ).run(req.params.id, newSeats);
  }
  db.prepare(`UPDATE tables SET name = ?, shape = ?, seats = ?, x = ?, y = ? WHERE id = ?`)
    .run(
      name ?? cur.name,
      shape ?? cur.shape,
      newSeats,
      x ?? cur.x,
      y ?? cur.y,
      req.params.id
    );
  res.json(db.prepare(`SELECT * FROM tables WHERE id = ?`).get(req.params.id));
});

app.delete('/api/tables/:id', (req, res) => {
  db.prepare(`UPDATE guests SET table_id = NULL, seat_index = NULL WHERE table_id = ?`)
    .run(req.params.id);
  db.prepare(`DELETE FROM tables WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---------- Guests ----------
app.post('/api/guests', (req, res) => {
  const { name, group_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'nom requis' });
  const info = db.prepare(`INSERT INTO guests (name, group_id) VALUES (?, ?)`)
    .run(name.trim(), group_id || null);
  res.json(db.prepare(`SELECT * FROM guests WHERE id = ?`).get(info.lastInsertRowid));
});

app.patch('/api/guests/:id', (req, res) => {
  const cur = db.prepare(`SELECT * FROM guests WHERE id = ?`).get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'introuvable' });
  const { name, group_id, table_id, seat_index } = req.body;

  // Seat assignment with swap handling
  if (table_id !== undefined) {
    const tId = table_id === null ? null : parseInt(table_id);
    const sIdx = seat_index === null || seat_index === undefined ? null : parseInt(seat_index);
    if (tId !== null && sIdx !== null) {
      const occupant = db.prepare(
        `SELECT * FROM guests WHERE table_id = ? AND seat_index = ? AND id != ?`
      ).get(tId, sIdx, cur.id);
      if (occupant) {
        // swap: move the occupant to the mover's previous seat (or unseat)
        db.prepare(`UPDATE guests SET table_id = ?, seat_index = ? WHERE id = ?`)
          .run(cur.table_id, cur.seat_index, occupant.id);
      }
    }
    db.prepare(`UPDATE guests SET table_id = ?, seat_index = ? WHERE id = ?`)
      .run(tId, sIdx, cur.id);
  }

  if (name !== undefined || group_id !== undefined) {
    db.prepare(`UPDATE guests SET name = ?, group_id = ? WHERE id = ?`)
      .run(
        name !== undefined ? name.trim() : cur.name,
        group_id !== undefined ? (group_id || null) : cur.group_id,
        cur.id
      );
  }
  res.json(db.prepare(`SELECT * FROM guests WHERE id = ?`).get(cur.id));
});

app.delete('/api/guests/:id', (req, res) => {
  db.prepare(`DELETE FROM guests WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---------- Auto-arrange ----------
// Fills empty seats with unplaced guests, keeping groups together when possible.
app.post('/api/auto-arrange', (req, res) => {
  const tables = db.prepare(`SELECT * FROM tables ORDER BY id`).all();
  const unplaced = db.prepare(
    `SELECT * FROM guests WHERE table_id IS NULL
     ORDER BY group_id IS NULL, group_id, name COLLATE NOCASE`
  ).all();

  // Build map of free seats per table
  const freeSeats = [];
  for (const t of tables) {
    const taken = new Set(
      db.prepare(`SELECT seat_index FROM guests WHERE table_id = ?`).all(t.id).map(r => r.seat_index)
    );
    for (let i = 0; i < t.seats; i++) {
      if (!taken.has(i)) freeSeats.push({ table_id: t.id, seat_index: i });
    }
  }

  const assign = db.prepare(`UPDATE guests SET table_id = ?, seat_index = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    let s = 0;
    for (const g of unplaced) {
      if (s >= freeSeats.length) break;
      const seat = freeSeats[s++];
      assign.run(seat.table_id, seat.seat_index, g.id);
    }
  });
  tx();

  res.json({
    placed: Math.min(unplaced.length, freeSeats.length),
    remaining: Math.max(0, unplaced.length - freeSeats.length),
  });
});

// ---------- Reset all seating ----------
app.post('/api/unseat-all', (req, res) => {
  db.prepare(`UPDATE guests SET table_id = NULL, seat_index = NULL`).run();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  💍  Plan de table  →  http://localhost:${PORT}\n`);
});
