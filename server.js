import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '15mb' }));
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
    decor: db.prepare(`SELECT * FROM decor ORDER BY id`).all(),
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
  const { name, shape, seats, x, y, color, rotation } = req.body;
  const count = db.prepare(`SELECT COUNT(*) c FROM tables`).get().c;
  const info = db.prepare(
    `INSERT INTO tables (name, shape, seats, x, y, color, rotation) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    (name || `Table ${count + 1}`).trim(),
    shape === 'rect' ? 'rect' : 'round',
    clampSeats(seats, 8),
    x ?? 60 + (count % 4) * 250,
    y ?? 60 + Math.floor(count / 4) * 260,
    color || null,
    Number(rotation) || 0
  );
  res.json(db.prepare(`SELECT * FROM tables WHERE id = ?`).get(info.lastInsertRowid));
});

app.patch('/api/tables/:id', (req, res) => {
  const cur = db.prepare(`SELECT * FROM tables WHERE id = ?`).get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'introuvable' });
  const { name, shape, seats, x, y, color, rotation } = req.body;
  const newSeats = seats != null ? clampSeats(seats, cur.seats) : cur.seats;
  // If shrinking, unseat guests sitting beyond the new seat count
  if (newSeats < cur.seats) {
    db.prepare(
      `UPDATE guests SET table_id = NULL, seat_index = NULL
       WHERE table_id = ? AND seat_index >= ?`
    ).run(req.params.id, newSeats);
  }
  db.prepare(`UPDATE tables SET name = ?, shape = ?, seats = ?, x = ?, y = ?, color = ?, rotation = ? WHERE id = ?`)
    .run(
      name ?? cur.name,
      shape ?? cur.shape,
      newSeats,
      x ?? cur.x,
      y ?? cur.y,
      color !== undefined ? (color || null) : cur.color,
      rotation != null ? Number(rotation) || 0 : cur.rotation,
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

// Remove every guest from a table (send them back to "À placer")
app.post('/api/tables/:id/clear', (req, res) => {
  const info = db.prepare(
    `UPDATE guests SET table_id = NULL, seat_index = NULL WHERE table_id = ?`
  ).run(req.params.id);
  res.json({ cleared: info.changes });
});

// Move every guest of one table onto another (swapping/appending by free seat)
app.post('/api/tables/:id/move-to/:target', (req, res) => {
  const from = parseInt(req.params.id), to = parseInt(req.params.target);
  const target = db.prepare(`SELECT * FROM tables WHERE id = ?`).get(to);
  if (!target) return res.status(404).json({ error: 'table cible introuvable' });
  const movers = db.prepare(`SELECT * FROM guests WHERE table_id = ? ORDER BY seat_index`).all(from);
  const taken = new Set(
    db.prepare(`SELECT seat_index FROM guests WHERE table_id = ?`).all(to).map(r => r.seat_index)
  );
  const free = [];
  for (let i = 0; i < target.seats; i++) if (!taken.has(i)) free.push(i);
  const assign = db.prepare(`UPDATE guests SET table_id = ?, seat_index = ? WHERE id = ?`);
  let moved = 0;
  db.transaction(() => {
    for (const g of movers) {
      if (!free.length) break;
      assign.run(to, free.shift(), g.id); moved++;
    }
  })();
  res.json({ moved, remaining: movers.length - moved });
});

// ---------- Decor (decorative elements on the floor plan) ----------
app.post('/api/decor', (req, res) => {
  const { kind, x, y, size, label } = req.body;
  const info = db.prepare(
    `INSERT INTO decor (kind, x, y, size, label) VALUES (?, ?, ?, ?, ?)`
  ).run(String(kind || 'plante'), x ?? 80, y ?? 80, size ?? 1, label || null);
  res.json(db.prepare(`SELECT * FROM decor WHERE id = ?`).get(info.lastInsertRowid));
});

app.patch('/api/decor/:id', (req, res) => {
  const cur = db.prepare(`SELECT * FROM decor WHERE id = ?`).get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'introuvable' });
  const { x, y, size, label } = req.body;
  db.prepare(`UPDATE decor SET x = ?, y = ?, size = ?, label = ? WHERE id = ?`).run(
    x ?? cur.x, y ?? cur.y,
    size != null ? Math.max(0.4, Math.min(4, size)) : cur.size,
    label !== undefined ? (label || null) : cur.label,
    req.params.id
  );
  res.json(db.prepare(`SELECT * FROM decor WHERE id = ?`).get(req.params.id));
});

app.delete('/api/decor/:id', (req, res) => {
  db.prepare(`DELETE FROM decor WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---------- Guests ----------
app.post('/api/guests', (req, res) => {
  const { name, group_id, table_id, seat_index, diet, notes } = req.body;
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
    `INSERT INTO guests (name, group_id, table_id, seat_index, diet, notes) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(name.trim(), group_id || null, tId, sIdx, diet || null, notes || null);
  res.json(db.prepare(`SELECT * FROM guests WHERE id = ?`).get(info.lastInsertRowid));
});

app.patch('/api/guests/:id', (req, res) => {
  const cur = db.prepare(`SELECT * FROM guests WHERE id = ?`).get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'introuvable' });
  const { name, group_id, table_id, seat_index, diet, notes } = req.body;

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

  if (name !== undefined || group_id !== undefined || diet !== undefined || notes !== undefined) {
    db.prepare(`UPDATE guests SET name = ?, group_id = ?, diet = ?, notes = ? WHERE id = ?`)
      .run(
        name !== undefined ? name.trim() : cur.name,
        group_id !== undefined ? (group_id || null) : cur.group_id,
        diet !== undefined ? (diet || null) : cur.diet,
        notes !== undefined ? (notes || null) : cur.notes,
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

// ---------- Parse an uploaded Excel/CSV file (returns headers + rows) ----------
app.post('/api/import/parse', async (req, res) => {
  const { dataBase64 } = req.body;
  if (!dataBase64) return res.status(400).json({ error: 'fichier manquant' });
  try {
    // Loaded lazily so a problem with the Excel library never breaks the rest of the app.
    const XLSX = await import('xlsx');
    const buf = Buffer.from(dataBase64, 'base64');
    // XLSX files are ZIP archives (start with "PK"). Anything else is treated as
    // text (CSV/TSV) and decoded as UTF-8 so accented characters survive.
    const isZip = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;
    const wb = isZip
      ? XLSX.read(buf, { type: 'buffer' })
      : XLSX.read(buf.toString('utf8'), { type: 'string' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    // Array-of-arrays, keeping empty cells so column indexes stay aligned
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
    if (!rows.length) return res.json({ headers: [], rows: [] });
    const width = Math.max(...rows.map(r => r.length));
    const norm = rows.map(r => {
      const a = r.map(c => (c == null ? '' : String(c).trim()));
      while (a.length < width) a.push('');
      return a;
    });
    res.json({
      headers: norm[0],
      rows: norm.slice(1, 1001),           // cap to 1000 data rows
      totalRows: norm.length - 1,
    });
  } catch (e) {
    res.status(400).json({ error: 'fichier illisible (' + e.message + ')' });
  }
});

// ---------- Commit a mapped import (creates groups as needed) ----------
app.post('/api/import/commit', (req, res) => {
  const { rows, map } = req.body; // map: { name, group, diet, notes } => column index or -1
  if (!Array.isArray(rows) || !map || map.name == null || map.name < 0) {
    return res.status(400).json({ error: 'colonne Nom requise' });
  }
  const groupByName = new Map(
    db.prepare(`SELECT id, name FROM groups`).all().map(g => [g.name.toLowerCase(), g.id])
  );
  const palette = ['#e9a23b', '#7c9cbf', '#9d7cbf', '#6fae8f', '#d98484', '#c69749', '#8c9b6e'];
  const insGroup = db.prepare(`INSERT INTO groups (name, color) VALUES (?, ?)`);
  const insGuest = db.prepare(`INSERT INTO guests (name, group_id, diet, notes) VALUES (?, ?, ?, ?)`);
  const cell = (row, idx) => (idx != null && idx >= 0 ? String(row[idx] ?? '').trim() : '');

  let added = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const name = cell(row, map.name);
      if (!name) continue;
      let groupId = null;
      const gName = cell(row, map.group);
      if (gName) {
        const key = gName.toLowerCase();
        if (groupByName.has(key)) groupId = groupByName.get(key);
        else {
          const color = palette[groupByName.size % palette.length];
          groupId = insGroup.run(gName, color).lastInsertRowid;
          groupByName.set(key, groupId);
        }
      }
      insGuest.run(name, groupId, cell(row, map.diet) || null, cell(row, map.notes) || null);
      added++;
    }
  });
  tx();
  res.json({ added });
});

// ---------- Full backup (export / restore the whole plan) ----------
app.get('/api/export.json', (req, res) => {
  const dump = {
    app: 'plan-de-table', version: 1, exportedAt: new Date().toISOString(),
    settings: getSettings(),
    groups: db.prepare(`SELECT * FROM groups ORDER BY id`).all(),
    tables: db.prepare(`SELECT * FROM tables ORDER BY id`).all(),
    guests: db.prepare(`SELECT * FROM guests ORDER BY id`).all(),
    decor: db.prepare(`SELECT * FROM decor ORDER BY id`).all(),
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="plan-de-table-sauvegarde.json"');
  res.send(JSON.stringify(dump, null, 2));
});

app.post('/api/import.json', (req, res) => {
  const d = req.body;
  if (!d || !Array.isArray(d.guests) || !Array.isArray(d.tables)) {
    return res.status(400).json({ error: 'sauvegarde invalide' });
  }
  const tx = db.transaction(() => {
    db.exec(`DELETE FROM guests; DELETE FROM tables; DELETE FROM groups; DELETE FROM decor;`);
    const insG = db.prepare(`INSERT INTO groups (id, name, color) VALUES (?, ?, ?)`);
    for (const g of d.groups || []) insG.run(g.id, g.name, g.color);
    const insT = db.prepare(
      `INSERT INTO tables (id, name, shape, seats, x, y, color, rotation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const t of d.tables) insT.run(t.id, t.name, t.shape, t.seats, t.x ?? 0, t.y ?? 0, t.color ?? null, t.rotation ?? 0);
    const insGu = db.prepare(
      `INSERT INTO guests (id, name, group_id, table_id, seat_index, diet, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const g of d.guests)
      insGu.run(g.id, g.name, g.group_id ?? null, g.table_id ?? null, g.seat_index ?? null,
        g.diet ?? null, g.notes ?? null);
    const insD = db.prepare(`INSERT INTO decor (id, kind, x, y, size, label) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const e of d.decor || []) insD.run(e.id, e.kind, e.x ?? 0, e.y ?? 0, e.size ?? 1, e.label ?? null);
    if (d.settings) {
      const setS = db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      );
      for (const [k, v] of Object.entries(d.settings)) setS.run(k, String(v ?? ''));
    }
  });
  tx();
  res.json({ ok: true });
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
    SELECT g.name AS guest, gr.name AS grp, t.name AS tbl, g.seat_index AS seat,
           g.diet AS diet, g.notes AS notes
    FROM guests g
    LEFT JOIN groups gr ON gr.id = g.group_id
    LEFT JOIN tables t  ON t.id = g.table_id
    ORDER BY t.name COLLATE NOCASE, g.seat_index, g.name COLLATE NOCASE
  `).all();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['Invité,Groupe,Table,Place,Régime / Allergies,Notes'];
  for (const r of rows) {
    lines.push([
      r.guest, r.grp || '', r.tbl || 'Non placé', r.seat != null ? r.seat + 1 : '',
      r.diet || '', r.notes || '',
    ].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="plan-de-table.csv"');
  res.send('﻿' + lines.join('\n'));
});

// ---------- Export plan (visual Excel .xlsx) ----------
const hasDiet = (d) => { const s = (d || '').trim(); return s !== '' && s.toUpperCase() !== 'NA'; };
app.get('/api/export.xlsx', async (req, res) => {
  try {
    const ExcelJS = (await import('exceljs')).default;
    const settings = getSettings();
    const tables = db.prepare(`SELECT * FROM tables ORDER BY id`).all();
    const guestsOf = (tid) => db.prepare(`SELECT * FROM guests WHERE table_id = ? ORDER BY seat_index`).all(tid);

    // ---- palette / style helpers ----
    const GOLD = 'FFC69749', GOLD_SOFT = 'FFF3E7CF', INK = 'FF2C2A26';
    const RED_FILL = 'FFF8D7DA', RED_TX = 'FFB02A1F';
    const GREEN_FILL = 'FFE3F1E6', GREEN_TX = 'FF4E8060';
    const border = { top: { style: 'thin', color: { argb: 'FFE7E0D4' } }, bottom: { style: 'thin', color: { argb: 'FFE7E0D4' } }, left: { style: 'thin', color: { argb: 'FFE7E0D4' } }, right: { style: 'thin', color: { argb: 'FFE7E0D4' } } };
    const fillOf = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Plan de table';

    // ===== Sheet 1: visual seating plan =====
    const ws = wb.addWorksheet('Plan de table', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Table', key: 'tbl', width: 16 },
      { header: 'Place', key: 'seat', width: 7 },
      { header: 'Invité', key: 'name', width: 30 },
      { header: 'Allergie / Régime', key: 'diet', width: 26 },
      { header: 'En face de', key: 'face', width: 28 },
    ];
    const head = ws.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
    head.alignment = { vertical: 'middle', horizontal: 'center' };
    head.height = 22;
    head.eachCell(c => { c.fill = fillOf(GOLD); c.border = border; });

    for (const t of tables) {
      const seated = guestsOf(t.id);
      // table title band
      const titleRow = ws.addRow([`${t.name}  —  ${seated.length}/${t.seats} placés`]);
      ws.mergeCells(`A${titleRow.number}:E${titleRow.number}`);
      const tc = titleRow.getCell(1);
      tc.fill = fillOf(GOLD_SOFT);
      tc.font = { bold: true, size: 12, color: { argb: INK } };
      tc.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      titleRow.height = 20;
      titleRow.eachCell(c => { c.border = border; });

      const perSide = Math.ceil(t.seats / 2);
      const bySeat = new Map(seated.map(g => [g.seat_index, g]));
      const facingSeat = (i) => (i < perSide ? i + perSide : i - perSide);
      for (let i = 0; i < t.seats; i++) {
        const g = bySeat.get(i);
        const faceG = bySeat.get(facingSeat(i));
        const row = ws.addRow({
          tbl: '', seat: i + 1,
          name: g ? g.name : '(libre)',
          diet: g ? (hasDiet(g.diet) ? g.diet : 'RAS') : '',
          face: faceG ? faceG.name : (i < t.seats ? '—' : ''),
        });
        row.eachCell(c => { c.border = border; c.alignment = { vertical: 'middle' }; });
        row.getCell('seat').alignment = { horizontal: 'center', vertical: 'middle' };
        if (!g) row.getCell('name').font = { italic: true, color: { argb: 'FF9A8E74' } };
        // colour the allergy cell: red if real restriction, green otherwise
        if (g) {
          const dc = row.getCell('diet');
          if (hasDiet(g.diet)) { dc.fill = fillOf(RED_FILL); dc.font = { bold: true, color: { argb: RED_TX } }; }
          else { dc.fill = fillOf(GREEN_FILL); dc.font = { color: { argb: GREEN_TX } }; }
        }
      }
      ws.addRow([]); // spacer between tables
    }

    // ===== Sheet 2: allergies only (for the caterer) =====
    const wa = wb.addWorksheet('Allergies', { views: [{ state: 'frozen', ySplit: 1 }] });
    wa.columns = [
      { header: 'Table', key: 'tbl', width: 16 },
      { header: 'Invité', key: 'name', width: 30 },
      { header: 'Allergie / Régime', key: 'diet', width: 34 },
    ];
    const ah = wa.getRow(1);
    ah.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
    ah.alignment = { vertical: 'middle', horizontal: 'center' };
    ah.height = 22;
    ah.eachCell(c => { c.fill = fillOf('FFB02A1F'); c.border = border; });
    let any = false;
    for (const t of tables) {
      for (const g of guestsOf(t.id)) {
        if (!hasDiet(g.diet)) continue;
        any = true;
        const row = wa.addRow({ tbl: t.name, name: g.name, diet: g.diet });
        row.eachCell(c => { c.border = border; c.alignment = { vertical: 'middle' }; });
        row.getCell('diet').fill = fillOf(RED_FILL);
        row.getCell('diet').font = { bold: true, color: { argb: RED_TX } };
      }
    }
    if (!any) wa.addRow({ tbl: '', name: 'Aucune allergie ni régime particulier', diet: '' });

    const title = (settings.event_title || 'plan-de-table').replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'plan-de-table';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${title}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: 'export Excel impossible (' + e.message + ')' });
  }
});

// ---------- Reset all seating ----------
app.post('/api/unseat-all', (req, res) => {
  db.prepare(`UPDATE guests SET table_id = NULL, seat_index = NULL`).run();
  res.json({ ok: true });
});

// ---------- Reset everything (wipe and restore default groups) ----------
app.post('/api/reset', (req, res) => {
  const palette = ['#e9a23b', '#7c9cbf', '#9d7cbf', '#6fae8f'];
  const defaults = ['Famille mariée', 'Famille marié', 'Amis', 'Collègues'];
  const tx = db.transaction(() => {
    db.exec(`DELETE FROM guests; DELETE FROM tables; DELETE FROM groups; DELETE FROM decor;
             DELETE FROM sqlite_sequence WHERE name IN ('guests','tables','groups','decor');`);
    const insG = db.prepare(`INSERT INTO groups (name, color) VALUES (?, ?)`);
    defaults.forEach((n, i) => insG.run(n, palette[i]));
    const setS = db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    setS.run('event_title', 'Notre mariage');
    setS.run('event_date', '');
  });
  tx();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  💍  Plan de table  →  http://localhost:${PORT}\n`);
});
