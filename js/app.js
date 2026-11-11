import { HALL, PRICES, buildSeats, seatMetrics } from './hall.js';

// ---------- demo data (fictional films) ----------
const MOVIES = [
  { id: 'm1', title: 'Η Τελευταία Παλίρροια', genre: 'Δράμα · Περιπέτεια', mins: 128, rating: 'K-12', colors: ['#0f3d5e', '#f28f3b'], times: ['17:10', '20:00', '22:45'] },
  { id: 'm2', title: 'Νεφελώματα', genre: 'Επιστ. Φαντασίας', mins: 146, rating: 'K-12', colors: ['#1a0b3b', '#7b5cff'], times: ['18:00', '21:15'] },
  { id: 'm3', title: 'Ο Κλέφτης των Φαναριών', genre: 'Κινούμενα σχέδια · Μεταγλ.', mins: 96, rating: 'K', colors: ['#2a5d34', '#f6d55c'], times: ['11:30', '14:00', '16:20'] },
  { id: 'm4', title: 'Σιωπηλή Μάρτυρας', genre: 'Θρίλερ', mins: 112, rating: 'K-15', colors: ['#2b0f12', '#c0392b'], times: ['19:30', '22:00', '23:50'] },
  { id: 'm5', title: 'Καλοκαίρι στο Πήλιο', genre: 'Κωμωδία', mins: 104, rating: 'K', colors: ['#0e6e7a', '#ffd3a5'], times: ['17:45', '20:30'] },
  { id: 'm6', title: 'Σιδερένιο Στέμμα', genre: 'Δράση · Fantasy', mins: 158, rating: 'K-15', colors: ['#3a2a12', '#d4a017'], times: ['16:00', '19:45', '23:00'] },
];
const HALL_FORMATS = ['Laser · Dolby Atmos', 'Laser', 'Dolby Atmos', 'Standard'];

const DAYS = ['Κυρ', 'Δευ', 'Τρί', 'Τετ', 'Πέμ', 'Παρ', 'Σάβ'];
const MONTHS = ['Ιαν', 'Φεβ', 'Μαρ', 'Απρ', 'Μαΐ', 'Ιουν', 'Ιουλ', 'Αυγ', 'Σεπ', 'Οκτ', 'Νοε', 'Δεκ'];

// ---------- state ----------
const seats = buildSeats(HALL);
const seatById = new Map(seats.map((s) => [s.id, s]));
const state = { dayOffset: 0, show: null, taken: new Set(), selected: [], preview: null };
let viewer = null;
let viewerPromise = null;

const $ = (sel) => document.querySelector(sel);
const fmtEuro = (v) => v.toFixed(2).replace('.', ',') + ' €';

// ---------- navigation ----------
function go(step) {
  $('#view-movies').hidden = step !== 1;
  $('#view-seats').hidden = step !== 2;
  $('#view-done').hidden = step !== 3;
  document.querySelectorAll('.step').forEach((el) => el.classList.toggle('active', +el.dataset.step === step));
  window.scrollTo({ top: 0 });
}

// ---------- step 1 ----------
function renderDates() {
  const wrap = $('#dates');
  wrap.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const b = document.createElement('button');
    b.className = 'date'; b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(i === state.dayOffset));
    b.innerHTML = `<span>${i === 0 ? 'Σήμερα' : DAYS[d.getDay()]}</span><b>${d.getDate()}</b><span>${MONTHS[d.getMonth()]}</span>`;
    b.onclick = () => { state.dayOffset = i; renderDates(); renderMovies(); };
    wrap.appendChild(b);
  }
}

function renderMovies() {
  const wrap = $('#movies');
  wrap.innerHTML = '';
  MOVIES.forEach((m, mi) => {
    const card = document.createElement('article');
    card.className = 'panel movie';
    card.innerHTML = `
      <div class="poster" style="background: linear-gradient(160deg, ${m.colors[0]}, ${m.colors[1]})">${m.title}</div>
      <div>
        <h3>${m.title}</h3>
        <div class="muted small">${m.genre}</div>
        <div class="tags"><span class="tag">${m.mins}′</span><span class="tag">${m.rating}</span><span class="tag">Υποτιτλ.</span></div>
        <div class="times"></div>
      </div>`;
    const times = card.querySelector('.times');
    m.times.forEach((t, ti) => {
      const hallNo = ((mi + ti) % 8) + 1;
      const b = document.createElement('button');
      b.className = 'time';
      b.innerHTML = `${t}<small>Αίθ. ${hallNo}</small>`;
      b.onclick = () => openShow({ movie: m, time: t, hallNo, format: HALL_FORMATS[(mi + ti) % HALL_FORMATS.length] });
      times.appendChild(b);
    });
    wrap.appendChild(card);
  });
}

// ---------- step 2 ----------
function openShow(show) {
  const d = new Date(); d.setDate(d.getDate() + state.dayOffset);
  show.date = d;
  show.key = `${show.movie.id}-${show.time}-${state.dayOffset}`;
  state.show = show;
  state.selected = [];
  state.taken = occupiedSeats(show.key);

  $('#show-title').textContent = show.movie.title;
  $('#show-meta').textContent = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} · ${show.time} · Αίθουσα ${show.hallNo} · ${show.format}`;
  go(2);
  renderSeatMap();
  renderCart();

  ensureViewer().then((v) => {
    if (!v) return;
    v.setTitle(show.movie.title);
    v.setOccupied(state.taken);
    // start at the best free seat so the viewer is never empty
    const best = seats.filter((s) => !state.taken.has(s.id)).sort((a, b) => seatMetrics(b).score - seatMetrics(a).score)[0];
    previewSeat(best, false);
  });
}

/** Deterministic pseudo-random occupancy per show. */
function occupiedSeats(key) {
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
  const taken = new Set();
  seats.forEach((s) => {
    const m = seatMetrics(s);
    // good seats sell first
    if (rnd() < 0.12 + (m.score / 100) * 0.45) taken.add(s.id);
  });
  return taken;
}

function renderSeatMap() {
  const map = $('#seatmap');
  map.innerHTML = '';
  const xs = seats.map((s) => s.x), zs = seats.map((s) => s.z);
  const minX = Math.min(...xs) - 0.9, maxX = Math.max(...xs) + 0.9;
  const minZ = Math.min(...zs) - 0.5, maxZ = Math.max(...zs) + 0.5;
  const spanX = maxX - minX, spanZ = maxZ - minZ;
  map.style.aspectRatio = `${spanX} / ${spanZ}`;
  const seatW = (HALL.seatWidth * 0.82 / spanX) * 100;
  const seatH = (HALL.rowDepth * 0.5 / spanZ) * 100;

  HALL.rows.forEach((row, r) => {
    const rowSeats = seats.filter((s) => s.rowIndex === r);
    const z = HALL.firstRowDist + r * HALL.rowDepth;
    for (const x of [minX + 0.35, maxX - 0.35]) {
      const l = document.createElement('span');
      l.className = 'rowlabel'; l.textContent = row.id;
      l.style.left = ((x - minX) / spanX) * 100 + '%';
      l.style.top = ((z - minZ) / spanZ) * 100 + '%';
      map.appendChild(l);
    }
    rowSeats.forEach((s) => {
      const b = document.createElement('button');
      b.className = `seat ${s.type === 'standard' ? '' : s.type}`;
      b.dataset.id = s.id;
      b.style.left = ((s.x - minX) / spanX) * 100 + '%';
      b.style.top = ((s.z - minZ) / spanZ) * 100 + '%';
      b.style.width = seatW + '%';
      b.style.height = seatH + '%';
      b.style.rotate = `${-s.facing}rad`;
      const taken = state.taken.has(s.id);
      if (taken) b.classList.add('taken');
      b.setAttribute('aria-label', `Σειρά ${s.row} θέση ${s.number}${taken ? ' (κατειλημμένη)' : ''}`);
      b.title = `${s.row}${s.number}`;
      b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') previewSeat(s); });
      b.addEventListener('click', () => {
        previewSeat(s);
        if (!taken) toggleSeat(s);
      });
      map.appendChild(b);
    });
  });
  // when the mouse leaves the map, go back to the last selected seat
  map.onpointerleave = (e) => {
    if (e.pointerType !== 'mouse') return;
    const last = state.selected[state.selected.length - 1];
    if (last) previewSeat(seatById.get(last));
  };
}

function toggleSeat(s) {
  const i = state.selected.indexOf(s.id);
  if (i >= 0) state.selected.splice(i, 1);
  else if (state.selected.length < 10) state.selected.push(s.id);
  document.querySelectorAll('.seat').forEach((el) => el.classList.toggle('sel', state.selected.includes(el.dataset.id)));
  renderCart();
}

function renderCart() {
  const wrap = $('#cart-seats');
  if (!state.selected.length) { wrap.textContent = 'Καμία ακόμη'; }
  else {
    wrap.innerHTML = '';
    state.selected.forEach((id) => {
      const s = seatById.get(id);
      const t = document.createElement('button');
      t.className = 'tag'; t.textContent = `${s.row}${s.number} · ${fmtEuro(PRICES[s.type])}`;
      t.title = 'Προβολή 3D'; t.style.border = '0';
      t.onclick = () => previewSeat(s);
      wrap.appendChild(t);
    });
  }
  const total = state.selected.reduce((sum, id) => sum + PRICES[seatById.get(id).type], 0);
  $('#cart-total').textContent = fmtEuro(total);
  $('#btn-continue').disabled = !state.selected.length;
}

function previewSeat(s, animate = true) {
  if (!s) return;
  state.preview = s;
  document.querySelectorAll('.seat.preview').forEach((el) => el.classList.remove('preview'));
  document.querySelector(`.seat[data-id="${s.id}"]`)?.classList.add('preview');

  const m = seatMetrics(s);
  const taken = state.taken.has(s.id);
  $('#pv-seat').textContent = `Σειρά ${s.row} · Θέση ${s.number}${s.type === 'vip' ? ' · VIP' : s.type === 'wheel' ? ' · ΑμεΑ' : ''}${taken ? ' (κατειλημμένη)' : ''}`;
  const score = $('#pv-score');
  score.className = `score ${m.tone}`;
  score.textContent = `${m.label} · ${m.score}/100`;
  $('#metrics').innerHTML = `
    <div><dt>Απόσταση</dt><dd>${m.distance.toFixed(1)} m<small>από το κέντρο της οθόνης</small></dd></div>
    <div><dt>Γωνία θέασης</dt><dd>${m.hAngle.toFixed(0)}°<small>ιδανικά 36–45°</small></dd></div>
    <div><dt>Πλάγια απόκλιση</dt><dd>${m.offAxis.toFixed(0)}°<small>${m.offAxis < 10 ? 'σχεδόν κεντρικά' : m.offAxis < 20 ? 'ελαφρώς πλάγια' : 'πλάγια'}</small></dd></div>
    <div><dt>Κλίση αυχένα</dt><dd>${Math.max(0, m.centerAngle).toFixed(0)}°<small>προς το κέντρο της οθόνης</small></dd></div>`;
  viewer?.setSeat(s, { animate });
}

/** Arrow keys walk through seats in the 3D view. */
function moveSeat(dx, dr) {
  const cur = state.preview;
  if (!cur) return;
  let target;
  if (dx) {
    target = seats.find((s) => s.rowIndex === cur.rowIndex && s.index === cur.index + dx);
  } else {
    const rowSeats = seats.filter((s) => s.rowIndex === cur.rowIndex + dr);
    target = rowSeats.sort((a, b) => Math.abs(a.x - cur.x) - Math.abs(b.x - cur.x))[0];
  }
  if (target) previewSeat(target);
}

function ensureViewer() {
  if (viewerPromise) return viewerPromise;
  const vp = $('#viewport');
  viewerPromise = import('./seatView3d.js')
    .then(({ SeatView3D }) => {
      viewer = new SeatView3D(vp, seats, HALL);
      return viewer;
    })
    .catch((err) => {
      console.error(err);
      const msg = document.createElement('div');
      msg.className = 'vp-empty';
      msg.textContent = 'Η 3D προβολή δεν είναι διαθέσιμη σε αυτή τη συσκευή.';
      vp.appendChild(msg);
      return null;
    });
  return viewerPromise;
}

// ---------- step 3 ----------
function confirmBooking() {
  const s = state.show;
  const total = state.selected.reduce((sum, id) => sum + PRICES[seatById.get(id).type], 0);
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  $('#done-text').innerHTML = `<b>${s.movie.title}</b><br>${DAYS[s.date.getDay()]} ${s.date.getDate()} ${MONTHS[s.date.getMonth()]} · ${s.time} · Αίθουσα ${s.hallNo}<br>Θέσεις: ${state.selected.join(', ')} · ${fmtEuro(total)}<br>Κωδικός κράτησης: <b>${code}</b>`;
  go(3);
}

// ---------- wiring ----------
$('#back-to-movies').onclick = () => go(1);
$('#btn-continue').onclick = confirmBooking;
$('#btn-again').onclick = () => go(1);
$('#btn-reset').onclick = () => viewer?.resetLook();
$('#btn-people').onclick = (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', String(on));
  viewer?.setPeopleVisible(on);
};
$('#btn-full').onclick = () => {
  const vp = $('#viewport');
  if (document.fullscreenElement) document.exitFullscreen();
  else vp.requestFullscreen?.();
};
document.addEventListener('keydown', (e) => {
  if ($('#view-seats').hidden) return;
  const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (map[e.key]) { e.preventDefault(); moveSeat(...map[e.key]); }
  if (e.key === 'Enter' && state.preview && !state.taken.has(state.preview.id)) toggleSeat(state.preview);
});

renderDates();
renderMovies();
go(1);
