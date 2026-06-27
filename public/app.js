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
  renderPool();
  renderGroups();
  renderBoard();
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
  const sel = $('#guestGroup');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Sans groupe</option>' +
    state.groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  if (cur) sel.value = cur;
}

// ---------- Pool (unplaced guests) ----------
function renderPool() {
  const pool = $('#pool');
  let list = state.guests.filter(g => g.table_id == null);
  const term = searchTerm.toLowerCase();
  if (term) list = list.filter(g => g.name.toLowerCase().includes(term));

  $('#unplacedCount').textContent = state.guests.filter(g => g.table_id == null).length;

  if (!list.length) {
    pool.innerHTML = `<div class="empty-hint">${term ? 'Aucun résultat.' : 'Tous les invités sont placés 🎉'}</div>`;
    return;
  }
  pool.innerHTML = list.map(g => chipHTML(g)).join('');
  pool.querySelectorAll('.chip').forEach(bindChip);
}

function chipHTML(g) {
  const grp = groupById(g.group_id);
  const color = grp ? grp.color : '#d9d2c5';
  return `<div class="chip" draggable="true" data-id="${g.id}">
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
  const del = el.querySelector('.del');
  if (del) del.addEventListener('click', async (e) => {
    e.stopPropagation();
    await api.send('DELETE', `/api/guests/${id}`);
    state.guests = state.guests.filter(g => g.id !== id);
    renderAll();
  });
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
    }
    bindSeatDrop(seat, t.id, i);
    wrap.appendChild(seat);
  }

  wrap.appendChild(disc);

  // Tools
  const tools = document.createElement('div');
  tools.className = 'table-tools';
  tools.innerHTML = `
    <button data-act="rename" title="Renommer">✏️</button>
    <button data-act="minus" title="Retirer une place">−</button>
    <span class="seatnum">${t.seats}</span>
    <button data-act="plus" title="Ajouter une place">+</button>
    <button data-act="shape" title="Changer la forme">${t.shape === 'round' ? '▭' : '◯'}</button>
    <button data-act="del" title="Supprimer la table">🗑️</button>`;
  tools.querySelector('[data-act=rename]').onclick = () => renameTable(t);
  tools.querySelector('[data-act=minus]').onclick = () => updateTable(t.id, { seats: t.seats - 1 });
  tools.querySelector('[data-act=plus]').onclick = () => updateTable(t.id, { seats: t.seats + 1 });
  tools.querySelector('[data-act=shape]').onclick = () =>
    updateTable(t.id, { shape: t.shape === 'round' ? 'rect' : 'round' });
  tools.querySelector('[data-act=del]').onclick = async () => {
    if (!confirm(`Supprimer « ${t.name} » ?`)) return;
    await api.send('DELETE', `/api/tables/${t.id}`);
    state.tables = state.tables.filter(x => x.id !== t.id);
    state.guests.forEach(g => { if (g.table_id === t.id) { g.table_id = null; g.seat_index = null; } });
    renderAll();
  };
  wrap.appendChild(tools);

  enableTableDrag(wrap, disc, t);
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

async function updateTable(id, patch) {
  const t = await api.send('PATCH', `/api/tables/${id}`, patch);
  const idx = state.tables.findIndex(x => x.id === id);
  state.tables[idx] = t;
  await load(); // reload in case seats were unseated when shrinking
}

async function renameTable(t) {
  const name = prompt('Nom de la table :', t.name);
  if (name == null) return;
  await updateTable(t.id, { name: name.trim() || t.name });
}

// Drag a table around the board
function enableTableDrag(wrap, handle, t) {
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
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

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
    renderBoard();
    renderStats();
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

$('#printBtn').addEventListener('click', () => window.print());

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
