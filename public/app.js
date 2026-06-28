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
  const diet = g.diet
    ? `<span class="diet-badge" title="Régime / allergies : ${esc(g.diet)}">🍽️</span>` : '';
  return `<div class="chip${sel}" draggable="true" data-id="${g.id}" title="Cliquer puis cliquer une chaise pour placer">
      <span class="dot" style="background:${color}"></span>
      <span class="name">${esc(g.name)}</span>
      ${diet}
      <span class="edit" data-edit="${g.id}" title="Modifier">✎</span>
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
    if (e.target.closest('.del') || e.target.closest('.edit')) return;
    selectGuest(id === selectedGuestId ? null : id);
  });
  const edit = el.querySelector('.edit');
  if (edit) edit.addEventListener('click', (e) => {
    e.stopPropagation();
    openGuestEditor(id);
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
const isMobile = () => window.matchMedia('(max-width: 860px)').matches;

function selectGuest(id) {
  selectedGuestId = id;
  document.body.classList.toggle('placing', id != null);
  renderPool();
  // On mobile, jump to the plan so the user can tap a chair right away
  if (id != null && isMobile()) setTab('plan');
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
  const filled = seated.length;
  const geo = tableGeometry(t);
  const S = geo.seatSize;

  // Size the stage so the disc + all seats fit, then centre everything in it.
  let ex = geo.w / 2, ey = geo.h / 2;
  for (let i = 0; i < t.seats; i++) {
    const p = geo.seatPos(i);
    ex = Math.max(ex, Math.abs(p.x) + S / 2);
    ey = Math.max(ey, Math.abs(p.y) + S / 2);
  }
  const stageW = Math.ceil(ex * 2) + 6;
  const stageH = Math.ceil(ey * 2) + 6;
  const cx = stageW / 2, cy = stageH / 2;

  const card = document.createElement('div');
  card.className = 'table-card' + (t.id === selectedTableId ? ' selected' : '');
  card.title = 'Cliquer pour modifier la table';
  card.addEventListener('mousedown', e => {
    if (e.target.closest('.seat')) return;
    selectTable(t.id);
  });

  const stage = document.createElement('div');
  stage.className = 'table-stage';
  stage.style.width = stageW + 'px';
  stage.style.height = stageH + 'px';

  const disc = document.createElement('div');
  disc.className = `table-disc ${t.shape}`;
  disc.style.width = geo.w + 'px';
  disc.style.height = geo.h + 'px';
  disc.style.left = (cx - geo.w / 2) + 'px';
  disc.style.top = (cy - geo.h / 2) + 'px';
  if (t.color) {
    disc.style.background = `linear-gradient(160deg, #ffffff, ${t.color})`;
    disc.style.borderColor = shade(t.color, -18);
  }
  disc.innerHTML = `<div>
      <div class="table-label">${esc(t.name)}</div>
      <div class="table-sub">${filled}/${t.seats}</div>
    </div>`;
  stage.appendChild(disc);

  for (let i = 0; i < t.seats; i++) {
    const pos = geo.seatPos(i);
    const occupant = seated.find(g => g.seat_index === i);
    const seat = document.createElement('div');
    seat.className = 'seat ' + (occupant ? 'filled' : 'empty');
    seat.dataset.table = t.id;
    seat.dataset.seat = i;
    seat.style.left = (cx + pos.x) + 'px';
    seat.style.top = (cy + pos.y) + 'px';
    seat.style.width = seat.style.height = S + 'px';
    seat.style.marginLeft = seat.style.marginTop = (-S / 2) + 'px';
    if (S < 38) seat.style.fontSize = '8px';
    if (occupant) {
      const grp = groupById(occupant.group_id);
      seat.style.background = grp ? hexToTint(grp.color) : '#fff';
      seat.style.borderColor = grp ? grp.color : 'var(--line)';
      seat.innerHTML = `<span class="seat-name">${esc(firstName(occupant.name))}</span>`;
      seat.draggable = true;
      if (occupant.diet) seat.classList.add('has-diet');
      seat.title = occupant.name
        + (occupant.diet ? ` — 🍽️ ${occupant.diet}` : '')
        + ' — clic pour modifier · × pour retirer de la table';
      seat.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', occupant.id));
      // Click the person to edit them; the × button removes them from the table
      seat.addEventListener('click', e => {
        if (e.target.closest('.seat-x')) return;
        openGuestEditor(occupant.id);
      });
      const xBtn = document.createElement('button');
      xBtn.className = 'seat-x';
      xBtn.type = 'button';
      xBtn.textContent = '×';
      xBtn.title = 'Retirer de la table (renvoyer dans « À placer »)';
      xBtn.draggable = false;
      xBtn.addEventListener('click', e => { e.stopPropagation(); unseat(occupant.id); });
      xBtn.addEventListener('mousedown', e => e.stopPropagation());
      seat.appendChild(xBtn);
    } else {
      seat.innerHTML = `<span class="seat-name">${i + 1}</span>`;
      seat.title = 'Cliquer pour saisir un nom ici';
      seat.addEventListener('click', () => {
        if (selectedGuestId != null) placeSelectedOn(t.id, i);
        else openSeatInput(seat, t.id, i);
      });
    }
    bindSeatDrop(seat, t.id, i);
    stage.appendChild(seat);
  }

  card.appendChild(stage);
  return card;
}

// Geometry: disc size, seat size and seat positions. Seats shrink and the table
// grows as the seat count rises, so even large tables (up to 100) stay tidy and
// never overlap.
function tableGeometry(t) {
  const n = Math.max(1, t.seats);
  const seatSize = Math.round(Math.max(24, Math.min(46, 46 - (n - 8) * 0.5)));
  const gap = 6;

  if (t.shape === 'rect') {
    const perSide = Math.ceil(n / 2);
    const w = Math.max(140, perSide * (seatSize + 10) + 24);
    const h = Math.max(70, seatSize + 44);
    return {
      w, h, seatSize,
      seatPos(i) {
        const top = i < perSide;
        const idx = top ? i : i - perSide;
        const countThisSide = top ? perSide : n - perSide;
        const span = w / (countThisSide + 1);
        const x = -w / 2 + span * (idx + 1);
        const y = top ? -(h / 2 + seatSize / 2 + 6) : (h / 2 + seatSize / 2 + 6);
        return { x, y };
      },
    };
  }

  // round: ring radius large enough that all seats fit without overlap
  const ringR = Math.max(70, (n * (seatSize + gap)) / (2 * Math.PI));
  const d = Math.max(90, 2 * (ringR - seatSize / 2 - 10));
  return {
    w: d, h: d, seatSize,
    seatPos(i) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      return { x: Math.cos(a) * ringR, y: Math.sin(a) * ringR };
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

// ---------- Table inspector ----------
const TABLE_BG = [
  null,        // défaut (crème)
  '#f3d9d6',   // rose poudré
  '#f6e7c4',   // sable doré
  '#d9e7e2',   // eucalyptus
  '#dfe3ef',   // bleu nuage
  '#e7dcef',   // lavande
  '#e3ead4',   // sauge
  '#f6dcc0',   // terracotta
];

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

  const sw = $('#insColor');
  sw.innerHTML = TABLE_BG.map(c => {
    const active = (c || null) === (t.color || null) ? ' active' : '';
    const cls = c ? '' : ' none';
    const style = c ? ` style="background:${c}"` : '';
    return `<button type="button" class="swatch${cls}${active}" data-color="${c || ''}"
              title="${c ? 'Fond coloré' : 'Défaut'}"${style}></button>`;
  }).join('');
  sw.querySelectorAll('.swatch').forEach(b =>
    b.addEventListener('click', () => {
      const t2 = state.tables.find(x => x.id === selectedTableId);
      if (!t2) return;
      updateTable(t2.id, { color: b.dataset.color || null });
    }));
}

// Wire inspector controls once
function setupInspector() {
  const sel = () => state.tables.find(x => x.id === selectedTableId);
  const seatsInput = $('#insSeats');
  const commitSeats = (v) => {
    const t = sel(); if (!t) return;
    const n = Math.max(1, Math.min(100, parseInt(v) || t.seats));
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

  // Per-table guest lists (with régime / allergies when present)
  let tablesHtml = '';
  for (const t of state.tables) {
    const seated = guestsOfTable(t.id).sort((a, b) => a.seat_index - b.seat_index);
    const items = seated.length
      ? seated.map(g => {
          const grp = groupById(g.group_id);
          const diet = g.diet ? ` <span class="pd-diet">🍽️ ${esc(g.diet)}</span>` : '';
          return `<li><span class="pd-seat">${g.seat_index + 1}</span> ${esc(g.name)}${grp ? ` <span class="pd-grp">· ${esc(grp.name)}</span>` : ''}${diet}</li>`;
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

  // Dietary summary (helpful for the caterer)
  const diets = state.guests.filter(g => g.diet);
  const dietHtml = diets.length
    ? `<section class="pd-section pd-break">
         <h2>Régimes &amp; allergies</h2>
         <ul class="pd-index">${diets
           .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }))
           .map(g => `<li>${esc(g.name)} <span class="pd-dots"></span> <b>${esc(g.diet)}</b></li>`).join('')}
         </ul>
       </section>`
    : '';

  $('#printDoc').innerHTML = `
    <section class="pd-cover">
      <div class="pd-ring">💍</div>
      <h1>${esc(title)}</h1>
      ${date ? `<p class="pd-date">${esc(date)}</p>` : ''}
      <p class="pd-sub">Plan de table · ${placed} invité${placed > 1 ? 's' : ''} placé${placed > 1 ? 's' : ''} · ${state.tables.length} table${state.tables.length > 1 ? 's' : ''}</p>
    </section>
    <section class="pd-section">
      <h2>Plan visuel</h2>
      <div class="pd-visual" id="pdVisual"></div>
    </section>
    <section class="pd-section pd-break">
      <h2>Répartition par table</h2>
      <div class="pd-grid">${tablesHtml || '<p>Aucune table.</p>'}</div>
    </section>
    <section class="pd-section pd-break">
      <h2>Index des invités</h2>
      <ul class="pd-index">${index || '<li>Aucun invité.</li>'}</ul>
    </section>
    ${dietHtml}`;

  // Render the real table visuals into the print document
  const vis = $('#pdVisual');
  for (const t of state.tables) vis.appendChild(buildTable(t));
}

// ---------- Import modal ----------
const modal = $('#importModal');
const guestModal = $('#guestModal');

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]); // strip data: prefix
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsText(file);
  });
}

$('#importBtn').addEventListener('click', () => {
  $('#importText').value = '';
  $('#impFile').value = '';
  $('#impMap').hidden = true;
  parsed = null;
  modal.hidden = false;
});
[modal, guestModal].forEach(m => m.addEventListener('click', e => {
  if (e.target === m || e.target.hasAttribute('data-close')) m.hidden = true;
}));

// Paste-a-list flow
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

// ---------- Excel / CSV file import with column mapping ----------
let parsed = null; // { headers, rows }

const MAP_FIELDS = [
  { key: 'name',  label: 'Nom *',             hints: ['nom', 'name', 'invit', 'prénom', 'prenom'] },
  { key: 'group', label: 'Groupe / Table',    hints: ['groupe', 'group', 'table', 'catégorie', 'categorie'] },
  { key: 'diet',  label: 'Régime / Allergies', hints: ['régime', 'regime', 'allerg', 'diet', 'menu'] },
  { key: 'notes', label: 'Notes',             hints: ['note', 'remarque', 'comment', 'observ'] },
];

$('#impFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const dataBase64 = await readFileBase64(file);
    const r = await fetch('/api/import/parse', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataBase64 }),
    });
    parsed = await r.json();
    if (!r.ok) { toast(parsed.error || 'Fichier illisible'); return; }
    if (!parsed.headers || !parsed.headers.length) { toast('Fichier vide'); return; }
    renderMapping();
    $('#impMap').hidden = false;
  } catch (err) { toast('Lecture du fichier impossible'); }
});

$('#impHeader').addEventListener('change', renderMapping);

function colLabels() {
  const useHeader = $('#impHeader').checked;
  return parsed.headers.map((h, i) =>
    useHeader && h ? h : `Colonne ${i + 1}`);
}

function renderMapping() {
  const labels = colLabels();
  const useHeader = $('#impHeader').checked;
  const guess = (hints) => {
    if (!useHeader) return -1;
    for (let i = 0; i < parsed.headers.length; i++) {
      const h = parsed.headers[i].toLowerCase();
      if (hints.some(x => h.includes(x))) return i;
    }
    return -1;
  };
  $('#mapGrid').innerHTML = MAP_FIELDS.map(f => {
    const sel = f.key === 'name' && guess(f.hints) < 0 ? 0 : guess(f.hints);
    const opts = [`<option value="-1">— ignorer —</option>`]
      .concat(labels.map((l, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(l)}</option>`))
      .join('');
    return `<label>${f.label}</label><select data-field="${f.key}">${opts}</select>`;
  }).join('');
  $('#mapGrid').querySelectorAll('select').forEach(s => s.addEventListener('change', renderPreview));
  renderPreview();
}

function currentMap() {
  const map = {};
  $('#mapGrid').querySelectorAll('select').forEach(s => { map[s.dataset.field] = parseInt(s.value); });
  return map;
}
function dataRows() {
  return $('#impHeader').checked ? parsed.rows : [parsed.headers, ...parsed.rows];
}

function renderPreview() {
  const map = currentMap();
  const rows = dataRows();
  const cell = (row, idx) => (idx >= 0 ? esc(row[idx] ?? '') : '<span style="color:#bbb">—</span>');
  const head = MAP_FIELDS.map(f => `<th>${f.label.replace(' *', '')}</th>`).join('');
  const body = rows.slice(0, 3).map(row =>
    `<tr>${MAP_FIELDS.map(f => `<td>${cell(row, map[f.key])}</td>`).join('')}</tr>`).join('');
  const n = rows.filter(r => map.name >= 0 && String(r[map.name] ?? '').trim()).length;
  $('#impPreview').innerHTML = rows.length
    ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    : '';
  $('#impCommit').textContent = `Importer ${n} invité${n > 1 ? 's' : ''}`;
}

$('#impCommit').addEventListener('click', async () => {
  const map = currentMap();
  if (map.name == null || map.name < 0) { toast('Choisissez la colonne « Nom »'); return; }
  const r = await api.send('POST', '/api/import/commit', { rows: dataRows(), map });
  modal.hidden = true;
  await load();
  toast(`${r.added} invité(s) importé(s)`);
});

// ---------- Backup : save / restore ----------
$('#saveBtn').addEventListener('click', () => { window.location.href = '/api/export.json'; });

$('#restoreLink').addEventListener('click', () => $('#restoreFile').click());
$('#restoreFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm('Restaurer cette sauvegarde remplacera TOUT le plan actuel. Continuer ?')) {
    e.target.value = ''; return;
  }
  try {
    const data = JSON.parse(await readFileText(file));
    const r = await fetch('/api/import.json', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const res = await r.json();
    if (!r.ok) { toast(res.error || 'Sauvegarde invalide'); return; }
    modal.hidden = true;
    await load();
    toast('Plan restauré ✓');
  } catch (err) { toast('Fichier de sauvegarde illisible'); }
  finally { e.target.value = ''; }
});

// ---------- Reset everything (double check) ----------
const resetModal = $('#resetModal');
$('#resetBtn').addEventListener('click', () => {
  $('#resetAck').checked = false;
  $('#resetConfirm').disabled = true;
  resetModal.hidden = false;
});
resetModal.addEventListener('click', e => {
  if (e.target === resetModal || e.target.hasAttribute('data-close')) resetModal.hidden = true;
});
$('#resetAck').addEventListener('change', e => { $('#resetConfirm').disabled = !e.target.checked; });
$('#resetConfirm').addEventListener('click', async () => {
  if (!$('#resetAck').checked) return;
  // Second verification
  if (!confirm('Dernière confirmation : supprimer définitivement TOUT le plan ?')) return;
  await api.send('POST', '/api/reset');
  resetModal.hidden = true;
  selectedTableId = null; selectedGuestId = null;
  await load();
  toast('Plan réinitialisé');
});

// ---------- Guest editor ----------
let editingGuestId = null;
function openGuestEditor(id) {
  const g = state.guests.find(x => x.id === id);
  if (!g) return;
  editingGuestId = id;
  $('#geName').value = g.name;
  $('#geGroup').innerHTML = '<option value="">Sans groupe</option>' +
    state.groups.map(gr => `<option value="${gr.id}"${gr.id === g.group_id ? ' selected' : ''}>${esc(gr.name)}</option>`).join('');
  $('#geDiet').value = g.diet || '';
  $('#geNotes').value = g.notes || '';
  guestModal.hidden = false;
  $('#geName').focus();
}
$('#geSave').addEventListener('click', async () => {
  if (editingGuestId == null) return;
  await api.send('PATCH', `/api/guests/${editingGuestId}`, {
    name: $('#geName').value, group_id: $('#geGroup').value || null,
    diet: $('#geDiet').value, notes: $('#geNotes').value,
  });
  guestModal.hidden = true;
  await load();
});
$('#geDelete').addEventListener('click', async () => {
  if (editingGuestId == null) return;
  if (!confirm('Supprimer cet invité ?')) return;
  await api.send('DELETE', `/api/guests/${editingGuestId}`);
  guestModal.hidden = true;
  await load();
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!modal.hidden) modal.hidden = true;
  if (!guestModal.hidden) guestModal.hidden = true;
  if (!resetModal.hidden) resetModal.hidden = true;
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
function shade(hex, pct) {
  const c = hex.replace('#', '');
  const f = (i) => {
    const v = Math.round(parseInt(c.substr(i, 2), 16) * (100 + pct) / 100);
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(2)}${f(4)}`;
}
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- Mobile tabs (Invités / Plan) ----------
function setTab(tab) {
  document.body.classList.remove('tab-guests', 'tab-plan');
  document.body.classList.add('tab-' + tab);
  $('#tabbar').querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
}
$('#tabbar').querySelectorAll('button').forEach(b =>
  b.addEventListener('click', () => setTab(b.dataset.tab)));
setTab('guests');

// ---------- Live sync (Server-Sent Events) ----------
// Receives a "changed" signal whenever anyone modifies the plan, then refreshes.
// Refresh is deferred while the local user is typing or dragging, so a remote
// update never steals focus or interrupts an in-progress edit.
let pendingRemote = false;

function isBusyEditing() {
  // Only defer for edits that a re-render would actually disrupt. Static fields
  // (add-guest, search, event title) survive load() untouched, so they don't block.
  if (!modal.hidden) return true;
  const ae = document.activeElement;
  if (!ae) return false;
  if (ae.classList.contains('seat-input') || ae.classList.contains('gname')) return true;
  if (ae.closest && ae.closest('#tableInspector')) return true;
  return false;
}

const applyRemote = debounce(async () => {
  if (!pendingRemote) return;
  if (isBusyEditing()) { setTimeout(applyRemote, 700); return; }
  pendingRemote = false;
  await load();
}, 250);

function setLive(on) {
  const dot = $('#liveDot');
  dot.classList.toggle('on', on);
  dot.title = on ? 'Synchronisé en direct avec les autres participants' : 'Reconnexion…';
}

function connectLive() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', () => setLive(true));
  es.addEventListener('changed', () => { pendingRemote = true; applyRemote(); });
  es.onopen = () => setLive(true);
  es.onerror = () => setLive(false); // EventSource auto-reconnects
}

load().then(connectLive);
