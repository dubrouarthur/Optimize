// ---------- API ----------
const api = {
  async get(url) { const r = await fetch(url); return r.json(); },
  async send(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  },
};

let state = { settings: {}, groups: [], tables: [], guests: [] };
let searchTerm = '';
let filterGroup = 'all';        // 'all' | 'none' | <group id>
let selectedGuestId = null;     // click-to-place selection
let selectedTableId = null;     // table being edited in the inspector

const $ = (s, el = document) => el.querySelector(s);
const groupById = (id) => state.groups.find(g => g.id === id);
const guestsOfTable = (tid) => state.guests.filter(g => g.table_id === tid);

// ---------- Toast ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- Load ----------
async function load() {
  state = await api.get('/api/state');
  $('#eventTitle').value = state.settings.event_title || '';
  $('#eventDate').value = state.settings.event_date || '';
  renderAll();
}

function renderAll() {
  renderGroupSelect();
  renderPoolFilter();
  renderPool();
  renderGroups();
  renderBoard();
  renderInspector();
  renderStats();
}

// ---------- Stats ----------
function renderStats() {
  const total = state.guests.length;
  const placed = state.guests.filter(g => g.table_id != null).length;
  const seats = state.tables.reduce((a, t) => a + t.seats, 0);
  const free = seats - placed;
  $('#stats').innerHTML = `
    <span class="stat"><b>${placed}</b>/${total} invités placés</span>
    <span class="stat"><b>${state.tables.length}</b> table${state.tables.length > 1 ? 's' : ''}</span>
    <span class="stat"><b>${Math.max(0, free)}</b> place${free > 1 ? 's' : ''} libre${free > 1 ? 's' : ''}</span>`;
}

// ---------- Group select ----------
function renderGroupSelect() {
  const opts = '<option value="">Sans groupe</option>' +
    state.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  for (const id of ['#guestGroup', '#importGroup']) {
    const sel = $(id);
    if (!sel) continue;
    const cur = sel.value;
    sel.innerHTML = opts;
    if (cur) sel.value = cur;
  }
}

// ---------- Pool filter chips ----------
function renderPoolFilter() {
  const el = $('#poolFilter');
  const chip = (key, label, color) =>
    `<button class="filter-chip ${filterGroup == key ? 'active' : ''}" data-f="${key}">
       ${color ? `<span class="dot" style="background:${color}"></span>` : ''}${esc(label)}
     </button>`;
  let html = chip('all', 'Tous');
  for (const g of state.groups) html += chip(String(g.id), g.name, g.color);
  html += chip('none', 'Sans groupe');
  el.innerHTML = html;
  el.querySelectorAll('.filter-chip').forEach(b =>
    b.addEventListener('click', () => { filterGroup = b.dataset.f; renderPoolFilter(); renderPool(); }));
}

// ---------- Pool (unplaced guests) ----------
function renderPool() {
  const pool = $('#pool');
  let list = state.guests.filter(g => g.table_id == null);
  const term = searchTerm.toLowerCase();
  if (term) list = list.filter(g => g.name.toLowerCase().includes(term));
  if (filterGroup === 'none') list = list.filter(g => g.group_id == null);
  else if (filterGroup !== 'all') list = list.filter(g => String(g.group_id) === filterGroup);

  $('#unplacedCount').textContent = state.guests.filter(g => g.table_id == null).length;

  if (!list.length) {
    pool.innerHTML = `<div class="empty-hint">${term || filterGroup !== 'all' ? 'Aucun invité ici.' : 'Tous les invités sont placés 🎉'}</div>`;
    return;
  }
  pool.innerHTML = list.map(g => chipHTML(g)).join('');
  pool.querySelectorAll('.chip').forEach(bindChip);
}

function chipHTML(g) {
  const grp = groupById(g.group_id);
  const color = grp ? grp.color : '#d9d2c5';
  const sel = g.id === selectedGuestId ? ' selected' : '';
  return `<div class="chip${sel}" draggable="true" data-id="${g.id}" title="Cliquer puis cliquer une chaise pour placer">
      <span class="dot" style="background:${color}"></span>
      <span class="name">${esc(g.name)}</span>
      <span class="del" data-del="${g.id}" title="Supprimer">×</span>
    </div>`;
}

function bindChip(el) {
  const id = +el.dataset.id;
  el.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', id);
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('click', e => {
    if (e.target.closest('.del')) return;
    selectGuest(id === selectedGuestId ? null : id);
  });
  const del = el.querySelector('.del');
  if (del) del.addEventListener('click', async (e) => {
    e.stopPropagation();
    await api.send('DELETE', `/api/guests/${id}`);
    state.guests = state.guests.filter(g => g.id !== id);
    if (selectedGuestId === id) selectedGuestId = null;
    renderAll();
  });
}

// ---------- Click-to-place ----------
function selectGuest(id) {
  selectedGuestId = id;
  document.body.classList.toggle('placing', id != null);
  renderPool();
}

// Pool as a drop target → unseat
const poolEl = $('#pool');
poolEl.addEventListener('dragover', e => { e.preventDefault(); poolEl.classList.add('dragover'); });
poolEl.addEventListener('dragleave', () => poolEl.classList.remove('dragover'));
poolEl.addEventListener('drop', async e => {
  e.preventDefault();
  poolEl.classList.remove('dragover');
  const id = +e.dataTransfer.getData('text/plain');
  await unseat(id);
});

async function unseat(id) {
  const g = state.guests.find(x => x.id === id);
  if (!g || g.table_id == null) return;
  await api.send('PATCH', `/api/guests/${id}`, { table_id: null, seat_index: null });
  g.table_id = null; g.seat_index = null;
  renderAll();
}

// ---------- Groups ----------
function renderGroups() {
  const el = $('#groupList');
  el.innerHTML = state.groups.map(g => {
    const count = state.guests.filter(x => x.group_id === g.id).length;
    return `<div class="group-row" data-id="${g.id}">
      <input type="color" value="${g.color}" data-color>
      <input class="gname" value="${esc(g.name)}" data-name>
      <span class="gcount">${count}</span>
      <span class="del" data-del title="Supprimer">×</span>
    </div>`;
  }).join('');

  el.querySelectorAll('.group-row').forEach(row => {
    const id = +row.dataset.id;
    const color = row.querySelector('[data-color]');
    const name = row.querySelector('[data-name]');
    const save = async () => {
      await api.send('PATCH', `/api/groups/${id}`, { name: name.value, color: color.value });
      const g = groupById(id); g.name = name.value; g.color = color.value;
      renderGroupSelect(); renderPool(); renderBoard();
    };
    color.addEventListener('change', save);
    name.addEventListener('change', save);
    row.querySelector('[data-del]').addEventListener('click', async () => {
      if (!confirm(`Supprimer le groupe « ${groupById(id).name} » ?`)) return;
      await api.send('DELETE', `/api/groups/${id}`);
      state.groups = state.groups.filter(x => x.id !== id);
      state.guests.forEach(x => { if (x.group_id === id) x.group_id = null; });
      renderAll();
    });
  });
}

$('#addGroup').addEventListener('click', async () => {
  const palette = ['#e9a23b', '#7c9cbf', '#9d7cbf', '#6fae8f', '#d98484', '#c69749', '#8c9b6e'];
  const color = palette[state.groups.length % palette.length];
  const g = await api.send('POST', '/api/groups', { name: 'Nouveau groupe', color });
  state.groups.push(g);
  renderAll();
});

// ---------- Board / Tables ----------
function renderBoard() {
  const board = $('#board');
  board.innerHTML = '';
  if (!state.tables.length) {
    board.innerHTML = `<div class="board-empty">
      <div class="board-empty-ring">◯</div>
      <p>Aucune table pour l'instant.<br>Ajoutez une table ronde ou rectangle ci-dessus pour commencer.</p>
    </div>`;
    return;
  }
  for (const t of state.tables) board.appendChild(buildTable(t));
}

function buildTable(t) {
  const seated = guestsOfTable(t.id);
  const wrap = document.createElement('div');
  wrap.className = 'table';
  wrap.style.left = t.x + 'px';
  wrap.style.top = t.y + 'px';

  const filled = seated.length;
  const geo = tableGeometry(t);

  const disc = document.createElement('div');
  disc.className = `table-disc ${t.shape}`;
  disc.style.width = geo.w + 'px';
  disc.style.height = geo.h + 'px';
  disc.innerHTML = `<div>
      <div class="table-label">${esc(t.name)}</div>
      <div class="table-sub">${filled}/${t.seats}</div>
    </div>`;

  // Seats
  for (let i = 0; i < t.seats; i++) {
    const pos = geo.seatPos(i);
    const occupant = seated.find(g => g.seat_index === i);
    const seat = document.createElement('div');
    seat.className = 'seat ' + (occupant ? 'filled' : 'empty');
    seat.dataset.table = t.id;
    seat.dataset.seat = i;
    seat.style.left = (geo.w / 2 + pos.x) + 'px';
    seat.style.top = (geo.h / 2 + pos.y) + 'px';
    if (occupant) {
      const grp = groupById(occupant.group_id);
      seat.style.background = grp ? hexToTint(grp.color) : '#fff';
      seat.style.borderColor = grp ? grp.color : 'var(--line)';
      seat.innerHTML = `<span class="seat-name">${esc(firstName(occupant.name))}</span>`;
      seat.draggable = true;
      seat.title = occupant.name + ' — glisser pour déplacer, clic pour libérer';
      seat.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', occupant.id));
      seat.addEventListener('click', () => unseat(occupant.id));
    } else {
      seat.innerHTML = `<span class="seat-name">${i + 1}</span>`;
      seat.title = 'Cliquer pour saisir un nom ici';
      seat.addEventListener('click', () => {
        if (selectedGuestId != null) placeSelectedOn(t.id, i);
        else openSeatInput(seat, t.id, i);
      });
    }
    bindSeatDrop(seat, t.id, i);
    wrap.appendChild(seat);
  }

  wrap.appendChild(disc);

  if (t.id === selectedTableId) wrap.classList.add('selected');
  disc.title = 'Cliquer pour modifier · glisser pour déplacer';

  // Drag to move; a click without movement opens the inspector
  enableTableDrag(wrap, disc, t, () => selectTable(t.id));
  return wrap;
}

// Geometry: returns disc size + seat positions relative to disc center
function tableGeometry(t) {
  if (t.shape === 'rect') {
    const perSide = Math.ceil(t.seats / 2);
    const w = Math.max(150, perSide * 56 + 28);
    const h = 96;
    return {
      w, h,
      seatPos(i) {
        const top = i < perSide;
        const idx = top ? i : i - perSide;
        const countThisSide = top ? perSide : t.seats - perSide;
        const gap = w / (countThisSide + 1);
        const x = -w / 2 + gap * (idx + 1);
        const y = top ? -(h / 2 + 30) : (h / 2 + 30);
        return { x, y };
      },
    };
  }
  // round
  const d = Math.max(118, Math.min(230, 70 + t.seats * 11));
  const r = d / 2 + 32;
  return {
    w: d, h: d,
    seatPos(i) {
      const a = (i / t.seats) * Math.PI * 2 - Math.PI / 2;
      return { x: Math.cos(a) * r, y: Math.sin(a) * r };
    },
  };
}

function bindSeatDrop(seat, tableId, seatIndex) {
  seat.addEventListener('dragover', e => { e.preventDefault(); seat.classList.add('dragover'); });
  seat.addEventListener('dragleave', () => seat.classList.remove('dragover'));
  seat.addEventListener('drop', async e => {
    e.preventDefault();
    seat.classList.remove('dragover');
    const id = +e.dataTransfer.getData('text/plain');
    if (!id) return;
    await api.send('PATCH', `/api/guests/${id}`, { table_id: tableId, seat_index: seatIndex });
    await load();
  });
}

// Type a guest's name directly on an empty chair. After Enter, jumps to the
// next empty chair of the same table so you can go around the table quickly.
function openSeatInput(seatEl, tableId, seatIndex) {
  if (seatEl.querySelector('input')) return;
  const prev = seatEl.innerHTML;
  seatEl.innerHTML = '';
  const input = document.createElement('input');
  input.className = 'seat-input';
  input.maxLength = 40;
  seatEl.appendChild(input);
  input.focus();

  let done = false;
  const cancel = () => { if (!done) { done = true; seatEl.innerHTML = prev; } };
  const commit = async (chain) => {
    if (done) return;
    const name = input.value.trim();
    if (!name) return cancel();
    done = true;
    const group_id = $('#guestGroup').value || null;
    await api.send('POST', '/api/guests', { name, group_id, table_id: tableId, seat_index: seatIndex });
    await load();
    if (chain) {
      const t = state.tables.find(x => x.id === tableId);
      const taken = new Set(guestsOfTable(tableId).map(g => g.seat_index));
      let next = -1;
      for (let k = seatIndex + 1; k < (t ? t.seats : 0); k++) { if (!taken.has(k)) { next = k; break; } }
      if (next >= 0) {
        const el = document.querySelector(`.seat[data-table="${tableId}"][data-seat="${next}"]`);
        if (el) openSeatInput(el, tableId, next);
      }
    }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', () => commit(false));
}

async function placeSelectedOn(tableId, seatIndex) {
  if (selectedGuestId == null) return;
  const id = selectedGuestId;
  selectGuest(null);
  await api.send('PATCH', `/api/guests/${id}`, { table_id: tableId, seat_index: seatIndex });
  await load();
}

async function updateTable(id, patch) {
  const t = await api.send('PATCH', `/api/tables/${id}`, patch);
  const idx = state.tables.findIndex(x => x.id === id);
  state.tables[idx] = t;
  await load(); // reload in case seats were unseated when shrinking
}

// Drag a table around the board; onClick fires on a press without movement.
function enableTableDrag(wrap, handle, t, onClick) {
  let startX, startY, origX, origY, moved = false;
  handle.addEventListener('mousedown', e => {
    if (e.target.closest('.seat')) return;
    e.preventDefault();
    moved = false;
    startX = e.clientX; startY = e.clientY;
    origX = t.x; origY = t.y;
    const onMove = ev => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      t.x = Math.max(0, origX + dx);
      t.y = Math.max(0, origY + dy);
      wrap.style.left = t.x + 'px';
      wrap.style.top = t.y + 'px';
    };
    const onUp = async () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (moved) await api.send('PATCH', `/api/tables/${t.id}`, { x: t.x, y: t.y });
      else if (onClick) onClick();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ---------- Table inspector ----------
function selectTable(id) {
  selectedTableId = id;
  renderBoard();
  renderInspector();
}

function renderInspector() {
  const box = $('#tableInspector');
  const t = state.tables.find(x => x.id === selectedTableId);
  if (!t) { box.hidden = true; return; }
  box.hidden = false;
  $('#insName').value = t.name;
  $('#insSeats').value = t.seats;
  $('#insShape').querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', b.dataset.shape === t.shape));
}

// Wire inspector controls once
function setupInspector() {
  const sel = () => state.tables.find(x => x.id === selectedTableId);
  const seatsInput = $('#insSeats');
  const commitSeats = (v) => {
    const t = sel(); if (!t) return;
    const n = Math.max(1, Math.min(30, parseInt(v) || t.seats));
    if (n !== t.seats) updateTable(t.id, { seats: n });
    else seatsInput.value = t.seats;
  };
  $('#insMinus').addEventListener('click', () => commitSeats((sel()?.seats || 1) - 1));
  $('#insPlus').addEventListener('click', () => commitSeats((sel()?.seats || 0) + 1));
  seatsInput.addEventListener('change', e => commitSeats(e.target.value));
  $('#insName').addEventListener('change', e => {
    const t = sel(); if (!t) return;
    updateTable(t.id, { name: e.target.value.trim() || t.name });
  });
  $('#insShape').querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => {
      const t = sel(); if (!t || t.shape === b.dataset.shape) return;
      updateTable(t.id, { shape: b.dataset.shape });
    }));
  $('#insDelete').addEventListener('click', async () => {
    const t = sel(); if (!t) return;
    if (!confirm(`Supprimer « ${t.name} » ?`)) return;
    await api.send('DELETE', `/api/tables/${t.id}`);
    selectedTableId = null;
    await load();
  });
  $('#insDone').addEventListener('click', () => selectTable(null));
}
setupInspector();

// Click empty board area to deselect the table
$('#board').addEventListener('mousedown', e => {
  if (e.target.id === 'board' && selectedTableId != null) selectTable(null);
});

// ---------- Add tables ----------
document.querySelectorAll('[data-add]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const board = $('#board');
    const t = await api.send('POST', '/api/tables', {
      shape: btn.dataset.add,
      seats: 8,
      x: board.scrollLeft + 70,
      y: board.scrollTop + 60,
    });
    state.tables.push(t);
    renderStats();
    selectTable(t.id);
  });
});

// ---------- Add guest ----------
$('#guestForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#guestName');
  const name = input.value.trim();
  if (!name) return;
  const group_id = $('#guestGroup').value || null;
  const g = await api.send('POST', '/api/guests', { name, group_id });
  state.guests.push(g);
  state.guests.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  input.value = '';
  input.focus();
  renderPool();
  renderStats();
  renderGroups();
});

// ---------- Search ----------
$('#search').addEventListener('input', e => { searchTerm = e.target.value; renderPool(); });

// ---------- Auto-arrange / unseat all ----------
$('#autoBtn').addEventListener('click', async () => {
  const r = await api.send('POST', '/api/auto-arrange');
  await load();
  toast(r.placed ? `${r.placed} invité(s) placé(s) automatiquement` +
    (r.remaining ? ` · ${r.remaining} sans place` : '') : 'Aucune place libre disponible');
});

$('#unseatAll').addEventListener('click', async () => {
  if (!confirm('Libérer tous les invités de leurs tables ?')) return;
  await api.send('POST', '/api/unseat-all');
  await load();
});

$('#pdfBtn').addEventListener('click', () => { buildPrintDoc(); window.print(); });
$('#exportBtn').addEventListener('click', () => { window.location.href = '/api/export.csv'; });

// ---------- Printable PDF document ----------
function buildPrintDoc() {
  const title = $('#eventTitle').value || 'Plan de table';
  const date = $('#eventDate').value || '';
  const placed = state.guests.filter(g => g.table_id != null).length;

  // Per-table guest lists
  let tablesHtml = '';
  for (const t of state.tables) {
    const seated = guestsOfTable(t.id).sort((a, b) => a.seat_index - b.seat_index);
    const items = seated.length
      ? seated.map(g => {
          const grp = groupById(g.group_id);
          return `<li><span class="pd-seat">${g.seat_index + 1}</span> ${esc(g.name)}${grp ? ` <span class="pd-grp">· ${esc(grp.name)}</span>` : ''}</li>`;
        }).join('')
      : '<li class="pd-empty">— aucune personne placée —</li>';
    tablesHtml += `<div class="pd-table">
      <h3>${esc(t.name)} <span class="pd-count">${seated.length}/${t.seats}</span></h3>
      <ol>${items}</ol>
    </div>`;
  }

  // Alphabetical guest index
  const tableName = id => (state.tables.find(t => t.id === id) || {}).name;
  const index = [...state.guests]
    .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }))
    .map(g => `<li>${esc(g.name)} <span class="pd-dots"></span> <b>${g.table_id ? esc(tableName(g.table_id)) : '—'}</b></li>`)
    .join('');

  $('#printDoc').innerHTML = `
    <section class="pd-cover">
      <div class="pd-ring">💍</div>
      <h1>${esc(title)}</h1>
      ${date ? `<p class="pd-date">${esc(date)}</p>` : ''}
      <p class="pd-sub">Plan de table · ${placed} invité${placed > 1 ? 's' : ''} placé${placed > 1 ? 's' : ''} · ${state.tables.length} table${state.tables.length > 1 ? 's' : ''}</p>
    </section>
    <section class="pd-section">
      <h2>Répartition par table</h2>
      <div class="pd-grid">${tablesHtml || '<p>Aucune table.</p>'}</div>
    </section>
    <section class="pd-section pd-break">
      <h2>Index des invités</h2>
      <ul class="pd-index">${index || '<li>Aucun invité.</li>'}</ul>
    </section>`;
}

// ---------- Import modal ----------
const modal = $('#importModal');
$('#importBtn').addEventListener('click', () => {
  $('#importText').value = '';
  modal.hidden = false;
  $('#importText').focus();
});
modal.addEventListener('click', e => {
  if (e.target === modal || e.target.hasAttribute('data-close')) modal.hidden = true;
});
$('#importConfirm').addEventListener('click', async () => {
  const names = $('#importText').value.split('\n').map(s => s.trim()).filter(Boolean);
  if (!names.length) { modal.hidden = true; return; }
  const group_id = $('#importGroup').value || null;
  const r = await api.send('POST', '/api/guests/bulk', { names, group_id });
  state.guests = r.guests;
  modal.hidden = true;
  renderAll();
  toast(`${r.added} invité(s) ajouté(s)`);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!modal.hidden) modal.hidden = true;
  if (selectedGuestId != null) selectGuest(null);
  if (selectedTableId != null) selectTable(null);
});

// ---------- Settings ----------
const saveSettings = debounce(async () => {
  await api.send('PATCH', '/api/settings', {
    event_title: $('#eventTitle').value,
    event_date: $('#eventDate').value,
  });
}, 600);
$('#eventTitle').addEventListener('input', saveSettings);
$('#eventDate').addEventListener('input', saveSettings);

// ---------- Utils ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function firstName(name) {
  // show first name + last initial to fit small seats
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return parts[0] + ' ' + parts[parts.length - 1][0] + '.';
}
function hexToTint(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
  return `rgba(${r},${g},${b},0.16)`;
}
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

load();
