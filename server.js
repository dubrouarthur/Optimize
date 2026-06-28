import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ---------- Live sync (Server-Sent Events) ----------
// Every connected browser keeps an open SSE stream. After any successful write,
// we broadcast a "changed" signal so all clients refresh and stay in sync.
const clients = new Set();
let revision = 0;

function broadcast() {
  revision++;
  const payload = `event: changed\ndata: ${revision}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { /* dropped on next close */ }
  }
}

// Broadcast automatically after any successful mutating /api request.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.on('finish', () => { if (res.statusCode < 400) broadcast(); });
  }
  next();
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n`);
  res.write(`event: hello\ndata: ${revision}\n\n`);
  clients.add(res);
  req.on('close', () => { clients.delete(res); });
});

// Keep SSE connections alive through proxies/load balancers.
setInterval(() => {
  for (const res of clients) { try { res.write(`: ping\n\n`); } catch { /* noop */ } }
}, 25000).unref();

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

const MAX_SEATS = 100;
const clampSeats = (v, fallback) => {
  const n = parseInt(v);
  return isNaN(n) ? fallback : Math.max(1, Math.min(MAX_SEATS, n));
};

// ---------- Tables ----------
app.post('/api/tables', (req, res) => {
  const { name, shape, seats, x, y, color } = req.body;
  const count = db.prepare(`SELECT COUNT(*) c FROM tables`).get().c;
  const info = db.prepare(
    `INSERT INTO tables (name, shape, seats, x, y, color) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    (name || `Table ${count + 1}`).trim(),
    shape === 'rect' ? 'rect' : 'round',
    clampSeats(seats, 8),
    x ?? 60 + (count % 4) * 250,
    y ?? 60 + Math.floor(count / 4) * 260,
    color || null
  );
  res.json(db.prepare(`SELECT * FROM tables WHERE id = ?`).get(info.lastInsertRowid));
});

app.patch('/api/tables/:id', (req, res) => {
  const cur = db.prepare(`SELECT * FROM tables WHERE id = ?`).get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'introuvable' });
  const { name, shape, seats, x, y, color } = req.body;
  const newSeats = seats != null ? clampSeats(seats, cur.seats) : cur.seats;
  // If shrinking, unseat guests sitting beyond the new seat count
  if (newSeats < cur.seats) {
    db.prepare(
      `UPDATE guests SET table_id = NULL, seat_index = NULL
       WHERE table_id = ? AND seat_index >= ?`
    ).run(req.params.id, newSeats);
  }
  db.prepare(`UPDATE tables SET name = ?, shape = ?, seats = ?, x = ?, y = ?, color = ? WHERE id = ?`)
    .run(
      name ?? cur.name,
      shape ?? cur.shape,
      newSeats,
      x ?? cur.x,
      y ?? cur.y,
      color !== undefined ? (color || null) : cur.color,
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
  const { name, group_id, table_id, seat_index } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'nom requis' });
  // Optionally seat the guest immediately (e.g. created by clicking an empty chair)
  let tId = null, sIdx = null;
  if (table_id != null && seat_index != null) {
    tId = parseInt(table_id);
    sIdx = parseInt(seat_index);
    // free the chair first if somehow occupied
    db.prepare(`UPDATE guests SET table_id = NULL, seat_index = NULL WHERE table_id = ? AND seat_index = ?`)
      .run(tId, sIdx);
  }
  const info = db.prepare(
    `INSERT INTO guests (name, group_id, table_id, seat_index) VALUES (?, ?, ?, ?)`
  ).run(name.trim(), group_id || null, tId, sIdx);
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

// ---------- Bulk add guests ----------
app.post('/api/guests/bulk', (req, res) => {
  const { names, group_id } = req.body;
  if (!Array.isArray(names)) return res.status(400).json({ error: 'names requis' });
  const insert = db.prepare(`INSERT INTO guests (name, group_id) VALUES (?, ?)`);
  let added = 0;
  const tx = db.transaction(() => {
    for (const raw of names) {
      const name = String(raw || '').trim();
      if (name) { insert.run(name, group_id || null); added++; }
    }
  });
  tx();
  res.json({ added, guests: db.prepare(`SELECT * FROM guests ORDER BY name COLLATE NOCASE`).all() });
});

// ---------- Auto-arrange ----------
// Fills empty seats with unplaced guests, keeping each group together at one
// table whenever a table has enough free seats for the whole group.
app.post('/api/auto-arrange', (req, res) => {
  const tables = db.prepare(`SELECT * FROM tables ORDER BY id`).all();
  const unplaced = db.prepare(
    `SELECT * FROM guests WHERE table_id IS NULL
     ORDER BY name COLLATE NOCASE`
  ).all();

  // Free seats grouped per table (list of seat indexes still available)
  const tableSeats = tables.map(t => {
    const taken = new Set(
      db.prepare(`SELECT seat_index FROM guests WHERE table_id = ?`).all(t.id).map(r => r.seat_index)
    );
    const free = [];
    for (let i = 0; i < t.seats; i++) if (!taken.has(i)) free.push(i);
    return { id: t.id, free };
  });

  // Bucket unplaced guests by group (null group => one bucket of singletons)
  const buckets = new Map();
  for (const g of unplaced) {
    const key = g.group_id == null ? `solo-${g.id}` : `grp-${g.group_id}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(g);
  }
  // Larger groups first so they claim contiguous tables before the leftovers
  const orderedBuckets = [...buckets.values()].sort((a, b) => b.length - a.length);

  const assign = db.prepare(`UPDATE guests SET table_id = ?, seat_index = ? WHERE id = ?`);
  let placed = 0;

  const seatGuest = (g) => {
    // Prefer a table that already hosts this guest's group, then any table with room
    let target = tableSeats.find(ts => ts.free.length > 0);
    if (!target) return false;
    const seat = target.free.shift();
    assign.run(target.id, seat, g.id);
    placed++;
    return true;
  };

  const tx = db.transaction(() => {
    for (const members of orderedBuckets) {
      // Try to seat the whole group at a single table that can fit it
      let table = tableSeats.find(ts => ts.free.length >= members.length);
      if (table) {
        for (const g of members) {
          const seat = table.free.shift();
          assign.run(table.id, seat, g.id);
          placed++;
        }
      } else {
        // Not enough room anywhere for the whole group — split across tables
        for (const g of members) { if (!seatGuest(g)) break; }
      }
    }
  });
  tx();

  res.json({ placed, remaining: unplaced.length - placed });
});

// ---------- Export plan (CSV) ----------
app.get('/api/export.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT g.name AS guest, gr.name AS grp, t.name AS tbl, g.seat_index AS seat
    FROM guests g
    LEFT JOIN groups gr ON gr.id = g.group_id
    LEFT JOIN tables t  ON t.id = g.table_id
    ORDER BY t.name COLLATE NOCASE, g.seat_index, g.name COLLATE NOCASE
  `).all();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['Invité,Groupe,Table,Place'];
  for (const r of rows) {
    lines.push([r.guest, r.grp || '', r.tbl || 'Non placé', r.seat != null ? r.seat + 1 : '']
      .map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="plan-de-table.csv"');
  res.send('﻿' + lines.join('\n'));
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
