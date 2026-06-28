// ---------- Offline-capable data layer ----------
// The app must keep working with no network: writes are applied locally and
// queued in a persistent outbox that drains (loops) automatically once the
// connection is back. Reads fall back to the last cached state.
const LS_OUTBOX = 'pdt_outbox', LS_CACHE = 'pdt_cache', LS_IDMAP = 'pdt_idmap';
let outbox = JSON.parse(localStorage.getItem(LS_OUTBOX) || '[]');
let idMap = JSON.parse(localStorage.getItem(LS_IDMAP) || '{}');   // tempId -> realId
let tmpSeq = 0;
let netOnline = navigator.onLine;
let flushing = false;

const saveOutbox = () => localStorage.setItem(LS_OUTBOX, JSON.stringify(outbox));
const saveIdMap = () => localStorage.setItem(LS_IDMAP, JSON.stringify(idMap));
const saveCache = () => { try { localStorage.setItem(LS_CACHE, JSON.stringify(state)); } catch {} };
// Negative numeric ids for entities created offline (so every === id comparison
// in the app still works); remapped to the real id once the create is flushed.
const tempId = () => -(Date.now() * 1000 + (++tmpSeq % 1000));

function remapValue(v) { return (v != null && idMap[v] != null) ? idMap[v] : v; }
function remapOp(op) {
  let url = op.url;
  for (const tid of Object.keys(idMap)) if (url.includes(tid)) url = url.split(tid).join(idMap[tid]);
  let body = op.body ? { ...op.body } : op.body;
  if (body) for (const k of ['table_id', 'group_id']) if (k in body) body[k] = remapValue(body[k]);
  return { url, method: op.method, body };
}

const api = {
  async get(url) { const r = await fetch(url, { cache: 'no-store' }); return r.json(); },
  // Returns the server response when online, or an optimistic stub when offline.
  // `stub` lets a POST return a locally-created entity (with a temp id).
  async send(method, url, body, stub) {
    if (netOnline) {
      try {
        const r = await fetch(url, {
          method, headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (r.ok) return r.json().catch(() => ({}));
        // HTTP error while online: surface it, don't queue (avoids infinite retry)
        return r.json().catch(() => ({}));
      } catch { setOnline(false); /* network dropped → fall through to queue */ }
    }
    // Offline: queue the op and return the optimistic stub
    outbox.push({ method, url, body, tempId: stub ? stub.id : undefined });
    saveOutbox();
    scheduleFlush();
    return stub || { ok: true, offline: true };
  },
};

async function flushOutbox() {
  if (flushing || !navigator.onLine || !outbox.length) return;
  flushing = true;
  try {
    while (outbox.length) {
      const op = outbox[0];
      const { url, method, body } = remapOp(op);
      const r = await fetch(url, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok && r.status >= 500) throw new Error('server ' + r.status);
      const data = await r.json().catch(() => ({}));
      if (op.tempId && data && data.id != null) { idMap[op.tempId] = data.id; saveIdMap(); }
      outbox.shift(); saveOutbox();
    }
    setOnline(true);
  } catch {
    setOnline(false);            // stay queued, retry on next trigger
  } finally {
    flushing = false;
  }
  updateSyncBadge();
}

let flushTimer = null;
function scheduleFlush() {
  updateSyncBadge();
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushOutbox();
    if (outbox.length && navigator.onLine) scheduleFlush();   // keep looping until drained
    else if (outbox.length) setTimeout(scheduleFlush, 5000);  // offline: retry later
  }, 600);
}

window.addEventListener('online', async () => { setOnline(true); await flushOutbox(); await load(); });
window.addEventListener('offline', () => setOnline(false));
// Periodic safety net: retry draining the outbox
setInterval(() => { if (outbox.length) scheduleFlush(); }, 15000);

let state = { settings: {}, groups: [], tables: [], guests: [], decor: [] };
let searchTerm = '';
let filterGroup = 'all';        // 'all' | 'none' | <group id>
let selectedGuestId = null;     // click-to-place selection
let selectedTableId = null;     // table being edited in the inspector
let selectedDecorId = null;     // decor element currently selected

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

// ---------- Load (resilient: never throws, uses cache offline) ----------
let hasLoadedReal = false;
async function load() {
  if (navigator.onLine) {
    try {
      await flushOutbox();                       // push pending writes first
      state = await api.get('/api/state');
      if (!state.decor) state.decor = [];
      hasLoadedReal = true;
      saveCache();
      setOnline(true);
    } catch {
      setOnline(false);
      if (!hasLoadedReal) loadFromCache();        // keep optimistic state once we have real data
    }
  } else {
    setOnline(false);
    if (!hasLoadedReal) loadFromCache();
  }
  $('#eventTitle').value = state.settings?.event_title || '';
  $('#eventDate').value = state.settings?.event_date || '';
  renderAll();
  updateSyncBadge();
}

function loadFromCache() {
  const c = localStorage.getItem(LS_CACHE);
  if (c) { try { state = JSON.parse(c); if (!state.decor) state.decor = []; hasLoadedReal = true; } catch {} }
}

// ---------- Online / sync indicator ----------
function setOnline(v) { netOnline = v; updateSyncBadge(); }
function updateSyncBadge() {
  const dot = $('#liveDot');
  if (!dot) return;
  if (!navigator.onLine || !netOnline) {
    dot.classList.remove('on'); dot.classList.add('offline');
    dot.textContent = outbox.length ? `Hors ligne · ${outbox.length} en attente` : 'Hors ligne';
    dot.title = 'Hors ligne — vos changements seront synchronisés au retour du réseau';
  } else if (outbox.length) {
    dot.classList.remove('offline'); dot.classList.add('on');
    dot.textContent = `Synchronisation… ${outbox.length}`;
  } else {
    dot.classList.remove('offline'); dot.classList.add('on');
    dot.textContent = 'En direct';
    dot.title = 'Synchronisé en direct';
  }
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
  renderBoard();          // refresh "armed" highlight on seats
  // On mobile, jump to the plan so the user can tap a chair right away
  if (id != null && isMobile()) setTab('plan');
}

// Arm a seated guest for a swap/move, then the next seat click moves/swaps them.
function armGuest(id) {
  selectGuest(id);
  if (id != null) {
    const g = state.guests.find(x => x.id === id);
    toast(`${g ? g.name : 'Invité'} sélectionné — cliquez une autre place pour échanger`);
    if (isMobile()) setTab('plan');
  }
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
  g.table_id = null; g.seat_index = null;
  api.send('PATCH', `/api/guests/${id}`, { table_id: null, seat_index: null });
  saveCache();
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
  const stub = { id: tempId(), name: 'Nouveau groupe', color };
  const g = await api.send('POST', '/api/groups', { name: 'Nouveau groupe', color }, stub);
  state.groups.push(g);
  saveCache();
  renderAll();
});

// ---------- Board / Tables ----------
function renderBoard() {
  const board = $('#board');
  board.innerHTML = '';
  const decor = state.decor || [];
  if (!state.tables.length && !decor.length) {
    board.innerHTML = `<div class="board-empty">
      <div class="board-empty-ring">◯</div>
      <p>Plan vide.<br>Ajoutez une table ou un élément de décor ci-dessus,<br>puis déplacez-les librement sur le plan.</p>
    </div>`;
    return;
  }
  // 2D canvas: tables and decor are freely positioned (x/y) and draggable
  const canvas = document.createElement('div');
  canvas.className = 'canvas';
  let maxX = 800, maxY = 560;
  for (const e of decor) { canvas.appendChild(buildDecor(e)); maxX = Math.max(maxX, e.x + 160); maxY = Math.max(maxY, e.y + 160); }
  for (const t of state.tables) {
    const el = buildTable(t);
    canvas.appendChild(el);
    maxX = Math.max(maxX, t.x + 320); maxY = Math.max(maxY, t.y + 320);
  }
  canvas.style.width = maxX + 'px';
  canvas.style.height = maxY + 'px';
  // Click on empty canvas deselects
  canvas.addEventListener('pointerdown', e => {
    if (e.target === canvas) { if (selectedTableId != null) selectTable(null); if (selectedDecorId != null) selectDecor(null); }
  });
  board.appendChild(canvas);
}

// Generic pointer-based drag (works for mouse and touch). onDrop receives final x,y.
function makeDraggable(el, item, applyXY, onDrop, onClick) {
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', e => {
    if (e.button != null && e.button !== 0) return;
    if (e.target.closest('.seat, button, .no-drag')) return;
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY, ox = item.x, oy = item.y;
    let moved = false;
    try { el.setPointerCapture(e.pointerId); } catch {}
    const move = ev => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) { moved = true; el.classList.add('dragging-item'); }
      item.x = Math.max(0, ox + dx); item.y = Math.max(0, oy + dy);
      applyXY(item.x, item.y);
    };
    const up = async () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.classList.remove('dragging-item');
      if (moved) await onDrop(item.x, item.y);
      else if (onClick) onClick();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}

// ---------- Decor elements ----------
const DECOR_KINDS = {
  plante: '🪴', lavande: '🪻', fleurs: '💐', arbre: '🌳', maison: '🏠',
  piste: '💃', buffet: '🍽️', gateau: '🎂', dj: '🎶', entree: '🚪',
  bougie: '🕯️', coeur: '❤️', arche: '💒', photo: '📸',
};

function buildDecor(e) {
  const el = document.createElement('div');
  el.className = 'decor-item' + (e.id === selectedDecorId ? ' selected' : '');
  el.style.left = e.x + 'px';
  el.style.top = e.y + 'px';
  el.style.fontSize = (38 * (e.size || 1)) + 'px';
  el.title = e.label || '';
  el.innerHTML = `<span class="decor-glyph">${DECOR_KINDS[e.kind] || '⭐'}</span>` +
    (e.label ? `<span class="decor-label">${esc(e.label)}</span>` : '');
  if (e.id === selectedDecorId) {
    const tools = document.createElement('div');
    tools.className = 'decor-tools no-drag';
    tools.innerHTML = `
      <button data-a="small" title="Réduire">−</button>
      <button data-a="big" title="Agrandir">+</button>
      <button data-a="label" title="Légende">✎</button>
      <button data-a="del" title="Supprimer">🗑️</button>`;
    tools.querySelector('[data-a=small]').onclick = () => updateDecor(e.id, { size: Math.max(0.4, (e.size || 1) - 0.2) });
    tools.querySelector('[data-a=big]').onclick = () => updateDecor(e.id, { size: Math.min(4, (e.size || 1) + 0.2) });
    tools.querySelector('[data-a=label]').onclick = () => {
      const label = prompt('Légende de l\'élément :', e.label || '');
      if (label != null) updateDecor(e.id, { label });
    };
    tools.querySelector('[data-a=del]').onclick = async () => {
      await api.send('DELETE', `/api/decor/${e.id}`);
      state.decor = state.decor.filter(d => d.id !== e.id);
      selectedDecorId = null; renderBoard();
    };
    el.appendChild(tools);
  }
  makeDraggable(el, e,
    (x, y) => { el.style.left = x + 'px'; el.style.top = y + 'px'; },
    async (x, y) => { await api.send('PATCH', `/api/decor/${e.id}`, { x, y }); const d = state.decor.find(d => d.id === e.id); if (d) { d.x = x; d.y = y; } },
    () => selectDecor(e.id));
  return el;
}

async function updateDecor(id, patch) {
  const d = await api.send('PATCH', `/api/decor/${id}`, patch);
  const i = state.decor.findIndex(x => x.id === id);
  if (i >= 0) state.decor[i] = d;
  renderBoard();
}
function selectDecor(id) {
  selectedDecorId = id;
  if (id != null) { selectedTableId = null; renderInspector(); }
  renderBoard();
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
  card.style.left = (t.x || 0) + 'px';
  card.style.top = (t.y || 0) + 'px';
  card.title = 'Glisser pour déplacer · cliquer pour modifier';
  makeDraggable(card, { x: t.x || 0, y: t.y || 0 },
    (x, y) => { card.style.left = x + 'px'; card.style.top = y + 'px'; },
    async (x, y) => { await api.send('PATCH', `/api/tables/${t.id}`, { x, y }); t.x = x; t.y = y; },
    () => selectTable(t.id));

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
      if (occupant.id === selectedGuestId) seat.classList.add('armed');
      seat.title = occupant.name
        + (occupant.diet ? ` — 🍽️ ${occupant.diet}` : '')
        + ' — clic pour modifier · ⇄ pour échanger · × pour retirer';
      seat.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', occupant.id));
      // If a guest is armed → clicking this seat swaps the two; otherwise edit
      seat.addEventListener('click', e => {
        if (e.target.closest('.seat-x') || e.target.closest('.swap-x')) return;
        if (selectedGuestId != null && selectedGuestId !== occupant.id) placeSelectedOn(t.id, i);
        else openGuestEditor(occupant.id);
      });
      // ⇄ : arm this guest, then click another place to swap/move
      const swapBtn = document.createElement('button');
      swapBtn.className = 'swap-x';
      swapBtn.type = 'button';
      swapBtn.textContent = '⇄';
      swapBtn.title = 'Échanger : armer cette personne puis cliquer une autre place';
      swapBtn.draggable = false;
      swapBtn.addEventListener('mousedown', e => e.stopPropagation());
      swapBtn.addEventListener('click', e => {
        e.stopPropagation();
        armGuest(occupant.id === selectedGuestId ? null : occupant.id);
      });
      seat.appendChild(swapBtn);
      // × : remove from the table
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
      seat.title = 'Cliquer pour choisir un invité à placer ici';
      seat.addEventListener('click', () => {
        if (selectedGuestId != null) placeSelectedOn(t.id, i);
        else openSeatPopup(t, i);
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

// Popup: choose which unplaced guest to seat on this chair (or create a new one).
let seatTarget = null; // { tableId, seatIndex }
function openSeatPopup(t, seatIndex) {
  seatTarget = { tableId: t.id, seatIndex };
  $('#seatModalTitle').textContent = `Qui placer à « ${t.name} » ?`;
  $('#seatSearch').value = '';
  $('#seatNewName').value = '';
  renderSeatList('');
  $('#seatModal').hidden = false;
  $('#seatSearch').focus();
}

function renderSeatList(term) {
  const list = $('#seatList');
  let unplaced = state.guests.filter(g => g.table_id == null);
  const q = (term || '').toLowerCase();
  if (q) unplaced = unplaced.filter(g => g.name.toLowerCase().includes(q));
  unplaced.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  if (!unplaced.length) {
    list.innerHTML = `<div class="empty-hint">${q ? 'Aucun invité non placé ne correspond.' : 'Tous les invités sont déjà placés. Créez-en un ci-dessous.'}</div>`;
    return;
  }
  list.innerHTML = unplaced.map(g => chipHTML(g)).join('');
  list.querySelectorAll('.chip').forEach(el => {
    el.querySelectorAll('.edit, .del').forEach(b => b.remove()); // simpler in the popup
    el.addEventListener('click', () => seatFromPopup(+el.dataset.id));
  });
}

// Optimistic local seat assignment, mirroring the server's swap behaviour
function applySeat(guestId, tableId, seatIndex) {
  const g = state.guests.find(x => x.id === guestId); if (!g) return;
  if (tableId != null && seatIndex != null) {
    const occ = state.guests.find(x => x.table_id === tableId && x.seat_index === seatIndex && x.id !== guestId);
    if (occ) { occ.table_id = g.table_id; occ.seat_index = g.seat_index; } // swap into mover's old seat
  }
  g.table_id = tableId; g.seat_index = seatIndex;
}

async function commitChange() {            // re-sync from server when online, else just re-render
  if (navigator.onLine) await load();
  else { renderAll(); updateSyncBadge(); }
}

// Some operations are computed on the server (auto-arrange, file import, restore…)
// and can't run offline — ask the user to reconnect rather than failing silently.
function requireOnline(actionName) {
  if (navigator.onLine) return true;
  toast(`« ${actionName} » nécessite une connexion internet`);
  return false;
}

async function seatFromPopup(guestId) {
  if (!seatTarget) return;
  const { tableId, seatIndex } = seatTarget;
  $('#seatModal').hidden = true;
  applySeat(guestId, tableId, seatIndex);
  api.send('PATCH', `/api/guests/${guestId}`, { table_id: tableId, seat_index: seatIndex });
  await commitChange();
}

async function placeSelectedOn(tableId, seatIndex) {
  if (selectedGuestId == null) return;
  const id = selectedGuestId;
  selectGuest(null);
  applySeat(id, tableId, seatIndex);
  api.send('PATCH', `/api/guests/${id}`, { table_id: tableId, seat_index: seatIndex });
  await commitChange();
}

async function updateTable(id, patch) {
  const t = state.tables.find(x => x.id === id); if (!t) return;
  const oldSeats = t.seats;
  Object.assign(t, patch);
  if (patch.seats != null && patch.seats < oldSeats) {  // mirror server: unseat overflow
    state.guests.forEach(g => { if (g.table_id === id && g.seat_index >= patch.seats) { g.table_id = null; g.seat_index = null; } });
  }
  api.send('PATCH', `/api/tables/${id}`, patch);
  await commitChange();
  renderInspector();
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
  if (id != null) selectedDecorId = null;
  renderBoard();
  renderInspector();
}

// A tidy non-overlapping default position for the n-th table (grid layout)
function defaultTablePos(n) {
  const COLS = 3, CW = 300, CH = 300;
  return { x: 40 + (n % COLS) * CW, y: 40 + Math.floor(n / COLS) * CH };
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

  // "Move all guests to…" target list (other tables only)
  const others = state.tables.filter(x => x.id !== t.id);
  $('#insMoveTo').innerHTML = '<option value="">Déplacer vers…</option>' +
    others.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  const seatedHere = guestsOfTable(t.id).length;
  $('#insClear').disabled = seatedHere === 0;
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
    state.tables = state.tables.filter(x => x.id !== t.id);
    state.guests.forEach(g => { if (g.table_id === t.id) { g.table_id = null; g.seat_index = null; } });
    api.send('DELETE', `/api/tables/${t.id}`);
    selectedTableId = null;
    await commitChange();
  });
  $('#insClear').addEventListener('click', async () => {
    const t = sel(); if (!t) return;
    if (!confirm(`Renvoyer tous les invités de « ${t.name} » vers « À placer » ?`)) return;
    state.guests.forEach(g => { if (g.table_id === t.id) { g.table_id = null; g.seat_index = null; } });
    api.send('POST', `/api/tables/${t.id}/clear`);
    await commitChange();
  });
  $('#insMoveTo').addEventListener('change', async e => {
    const t = sel(); const to = e.target.value;
    if (!t || !to) return;
    if (!requireOnline('Déplacer les invités')) { e.target.value = ''; return; }
    const r = await api.send('POST', `/api/tables/${t.id}/move-to/${to}`);
    await load();
    toast(r.remaining ? `${r.moved} déplacé(s), ${r.remaining} sans place` : `${r.moved} invité(s) déplacé(s)`);
  });
  $('#insDone').addEventListener('click', () => selectTable(null));
}
setupInspector();

// Click empty board area to deselect
$('#board').addEventListener('pointerdown', e => {
  if (e.target.id === 'board') { if (selectedTableId != null) selectTable(null); if (selectedDecorId != null) selectDecor(null); }
});

// ---------- Add tables ----------
document.querySelectorAll('[data-add]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const pos = defaultTablePos(state.tables.length);
    const shape = btn.dataset.add === 'rect' ? 'rect' : 'round';
    const stub = { id: tempId(), name: `Table ${state.tables.length + 1}`, shape, seats: 8, x: pos.x, y: pos.y, color: null };
    const t = await api.send('POST', '/api/tables', { shape, seats: 8, x: pos.x, y: pos.y }, stub);
    state.tables.push(t);
    saveCache();
    renderStats();
    selectTable(t.id);
  });
});

// ---------- Add decor ----------
document.querySelectorAll('[data-decor]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const board = $('#board');
    const x = (board.scrollLeft || 0) + Math.min(board.clientWidth, 400) / 2;
    const y = (board.scrollTop || 0) + 80;
    const stub = { id: tempId(), kind: btn.dataset.decor, x, y, size: 1, label: null };
    const e = await api.send('POST', '/api/decor', { kind: btn.dataset.decor, x, y }, stub);
    if (!state.decor) state.decor = [];
    state.decor.push(e);
    selectDecor(e.id);
  });
});

// ---------- Tidy up tables into a neat grid ----------
$('#tidyBtn')?.addEventListener('click', async () => {
  for (let i = 0; i < state.tables.length; i++) {
    const pos = defaultTablePos(i);
    state.tables[i].x = pos.x; state.tables[i].y = pos.y;
    await api.send('PATCH', `/api/tables/${state.tables[i].id}`, pos);
  }
  renderBoard();
  toast('Tables rangées');
});

// ---------- Add guest ----------
$('#guestForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#guestName');
  const name = input.value.trim();
  if (!name) return;
  const group_id = $('#guestGroup').value ? +$('#guestGroup').value : null;
  const stub = { id: tempId(), name, group_id, table_id: null, seat_index: null, diet: null, notes: null };
  const g = await api.send('POST', '/api/guests', { name, group_id }, stub);
  state.guests.push(g);
  state.guests.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  input.value = '';
  input.focus();
  saveCache();
  renderPool();
  renderStats();
  renderGroups();
});

// ---------- Search ----------
$('#search').addEventListener('input', e => { searchTerm = e.target.value; renderPool(); });

// ---------- Auto-arrange / unseat all ----------
$('#autoBtn').addEventListener('click', async () => {
  if (!requireOnline('Placer auto')) return;
  const r = await api.send('POST', '/api/auto-arrange');
  await load();
  toast(r.placed ? `${r.placed} invité(s) placé(s) automatiquement` +
    (r.remaining ? ` · ${r.remaining} sans place` : '') : 'Aucune place libre disponible');
});

$('#unseatAll').addEventListener('click', async () => {
  if (!confirm('Libérer tous les invités de leurs tables ?')) return;
  state.guests.forEach(g => { g.table_id = null; g.seat_index = null; });
  api.send('POST', '/api/unseat-all');
  await commitChange();
});

function printAs(mode, build) {
  build();
  document.body.classList.add('print-' + mode);
  const cleanup = () => { document.body.classList.remove('print-' + mode); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  window.print();
  setTimeout(cleanup, 1500); // fallback if afterprint doesn't fire
}
$('#pdfBtn').addEventListener('click', () => printAs('pdf', buildPrintDoc));
$('#posterBtn').addEventListener('click', () => printAs('poster', buildPoster));

// ---------- Beautiful poster (names only, by table, wedding script) ----------
function buildPoster() {
  const title = $('#eventTitle').value || 'Notre mariage';
  const date = $('#eventDate').value || '';
  const tablesHtml = state.tables.map(t => {
    const names = guestsOfTable(t.id)
      .sort((a, b) => a.seat_index - b.seat_index)
      .map(g => `<li>${esc(g.name)}</li>`).join('');
    return `<div class="po-table">
      <h2 class="po-tname">${esc(t.name)}</h2>
      <span class="po-rule"></span>
      <ul class="po-names">${names || '<li class="po-empty">—</li>'}</ul>
    </div>`;
  }).join('');
  $('#posterDoc').innerHTML = `
    <div class="po-frame">
      <header class="po-head">
        <div class="po-flourish">&#10086;</div>
        <h1 class="po-couple">${esc(title)}</h1>
        ${date ? `<div class="po-date">${esc(date)}</div>` : ''}
        <div class="po-sub">~ Plan de table ~</div>
      </header>
      <div class="po-grid">${tablesHtml || '<p style="text-align:center">Aucune table.</p>'}</div>
    </div>`;
}
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
  if (!requireOnline('Importer')) return;
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
  if (!requireOnline('Import de fichier')) { e.target.value = ''; return; }
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
  if (!requireOnline('Importer')) return;
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
  if (!requireOnline('Restaurer')) { e.target.value = ''; return; }
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

// ---------- Seat assignment popup ----------
const seatModal = $('#seatModal');
seatModal.addEventListener('click', e => {
  if (e.target === seatModal || e.target.hasAttribute('data-close')) seatModal.hidden = true;
});
$('#seatSearch').addEventListener('input', e => renderSeatList(e.target.value));
const seatAddNew = async () => {
  const name = $('#seatNewName').value.trim();
  if (!name || !seatTarget) return;
  const { tableId, seatIndex } = seatTarget;
  const group_id = $('#guestGroup').value ? +$('#guestGroup').value : null;
  seatModal.hidden = true;
  const stub = { id: tempId(), name, group_id, table_id: tableId, seat_index: seatIndex, diet: null, notes: null };
  state.guests.push(stub);
  api.send('POST', '/api/guests', { name, group_id, table_id: tableId, seat_index: seatIndex }, stub);
  await commitChange();
};
$('#seatNewAdd').addEventListener('click', seatAddNew);
$('#seatNewName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); seatAddNew(); } });

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
  if (!requireOnline('Réinitialiser')) return;
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
  const patch = {
    name: $('#geName').value.trim(), group_id: $('#geGroup').value ? +$('#geGroup').value : null,
    diet: $('#geDiet').value, notes: $('#geNotes').value,
  };
  const g = state.guests.find(x => x.id === editingGuestId);
  if (g) { g.name = patch.name || g.name; g.group_id = patch.group_id; g.diet = patch.diet || null; g.notes = patch.notes || null; }
  api.send('PATCH', `/api/guests/${editingGuestId}`, patch);
  guestModal.hidden = true;
  await commitChange();
});
$('#geDelete').addEventListener('click', async () => {
  if (editingGuestId == null) return;
  if (!confirm('Supprimer cet invité ?')) return;
  state.guests = state.guests.filter(x => x.id !== editingGuestId);
  api.send('DELETE', `/api/guests/${editingGuestId}`);
  guestModal.hidden = true;
  await commitChange();
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!modal.hidden) modal.hidden = true;
  if (!guestModal.hidden) guestModal.hidden = true;
  if (!resetModal.hidden) resetModal.hidden = true;
  if (!seatModal.hidden) seatModal.hidden = true;
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

function connectLive() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', () => setOnline(true));
  es.addEventListener('changed', () => { pendingRemote = true; applyRemote(); });
  es.onopen = () => { setOnline(true); flushOutbox(); };
  es.onerror = () => updateSyncBadge();   // EventSource auto-reconnects; keep status accurate
}

// Register the service worker so the app shell loads even with no network
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

load().then(connectLive);
