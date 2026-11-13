// Seat View 3D overlay.
// Finds the seat map on the current page, rebuilds the hall from where the seats
// are drawn, and shows a floating 3D "view from this seat" panel. Everything runs
// locally in this browser; nothing on the website itself is changed or sent.

import { SeatView3D } from './lib/seatView3d.js';
import { HALL, buildSeats, finishHall, seatMetrics } from './lib/hall.js';

const TARGET_HOSTS = /(^|\.)(cineplexx\.gr|villagecinemas\.gr)$/i;
const SEAT_SEL = [
  '[class*="seat" i]', '[id*="seat" i]', '[data-seat]', '[data-seat-id]', '[data-seatid]',
  '[aria-label*="seat" i]', '[aria-label*="θέση" i]', '[aria-label*="θεση" i]',
  '[title*="seat" i]', '[title*="θέση" i]',
].join(',');
const TAKEN_RE = /(occupied|taken|sold|unavailable|reserved|booked|disabled|blocked|κατειλ|κρατημ|μη διαθ)/i;
const SKIP_RE = /(legend|summary|basket|cart|tooltip|selected-seats|seat-list)/i;
const SEAT_WIDTH = 0.55; // metres between seat centres

const isTop = window.top === window;
let settings = loadSettings();
let layout = null;      // { seats, hall, els: Map<Element, seat>, taken: Set, signature }
let viewer = null;
let pinned = null;      // seat chosen by click
let current = null;
let ui = null;

export function start() {
  scan();
  const mo = new MutationObserver(debounce(scan, 700));
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'aria-disabled', 'disabled'] });
  document.addEventListener('pointerover', onPointer, true);
  document.addEventListener('click', onClick, true);
  window.addEventListener('resize', debounce(scan, 400));
}

// ---------------- detection ----------------

function scan() {
  const found = detectSeats();
  if (!found) {
    // keep the launcher on the target sites so the demo can still be opened
    if (isTop && TARGET_HOSTS.test(location.hostname)) ensureUI();
    if (layout) { layout = null; rebuildViewer(); }
    return;
  }
  ensureUI();
  if (!layout || layout.signature !== found.signature) {
    layout = found;
    rebuildViewer();
  } else {
    // same map, maybe new occupancy
    layout.taken = found.taken; layout.els = found.els;
    viewer?.setOccupied(layout.taken);
  }
}

function detectSeats() {
  let els;
  try { els = [...document.querySelectorAll(SEAT_SEL)]; } catch { return null; }
  const cands = [];
  for (const el of els) {
    if (ui && ui.host.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 5 || r.height < 5 || r.width > 90 || r.height > 90) continue;
    if (r.width / r.height > 3 || r.height / r.width > 3) continue;
    if (hasSkipAncestor(el)) continue;
    cands.push({ el, cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height });
  }
  // a seat is often a wrapper with inner icon/number elements: keep the outermost one
  const candEls = new Set(cands.map((c) => c.el));
  for (let i = cands.length - 1; i >= 0; i--) {
    let p = cands[i].el.parentElement;
    for (let k = 0; k < 3 && p; k++, p = p.parentElement) if (candEls.has(p)) { cands.splice(i, 1); break; }
  }
  // dedupe elements drawn on the same spot
  const seen = new Set();
  const items = cands.filter((c) => { const k = `${Math.round(c.cx / 3)}:${Math.round(c.cy / 3)}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (items.length < 12) return null;

  // group into rows by vertical position
  const medH = median(items.map((i) => i.h));
  items.sort((a, b) => a.cy - b.cy);
  const rows = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && it.cy - row.cy < medH * 0.6) { row.items.push(it); row.cy = mean(row.items.map((i) => i.cy)); }
    else rows.push({ cy: it.cy, items: [it] });
  }
  const good = rows.filter((r) => r.items.length >= 3);
  if (good.length < 2) return null;
  good.forEach((r) => r.items.sort((a, b) => a.cx - b.cx));

  const screenBelow = settings.flip ?? guessScreenBelow(good);
  if (screenBelow) good.reverse();             // row 0 = nearest the screen

  const gaps = [];
  good.forEach((r) => r.items.forEach((it, i) => { if (i) gaps.push(it.cx - r.items[i - 1].cx); }));
  const pitch = median(gaps.filter((g) => g > 0 && g < median(gaps) * 1.6));
  const mPerPx = SEAT_WIDTH / pitch;
  const rowGap = median(good.slice(1).map((r, i) => Math.abs(r.cy - good[i].cy)));
  const allX = good.flatMap((r) => r.items.map((i) => i.cx));
  const centerX = (Math.min(...allX) + Math.max(...allX)) / 2 + (settings.shiftPx || 0);
  const widest = Math.max(...good.map((r) => (r.items[r.items.length - 1].cx - r.items[0].cx) * mPerPx + SEAT_WIDTH));

  const hall = finishHall({
    screen: { width: settings.screenWidth || clamp(Math.round(widest * 0.85), 9, 24), aspect: settings.aspect || 2.39, bottom: 1.3 },
    firstRowDist: settings.firstRow || 4.5,
    rowDepth: 1.0, rise: settings.flat ? 0.0 : 0.34, seatWidth: SEAT_WIDTH, eyeHeight: 1.15,
  });

  const seats = [], map = new Map(), taken = new Set();
  const frontY = good[0].cy;
  good.forEach((row, r) => {
    const rowLabel = rowLabelFor(row) || String(r + 1);
    row.items.forEach((it, i) => {
      const info = labelFor(it.el);
      const number = info.seat || String(i + 1);
      const rowName = info.row || rowLabel;
      const id = `${rowName}-${number}-${r}-${i}`;
      const seat = {
        id, row: rowName, number, rowIndex: r, index: i, label: `Σειρά ${rowName} · Θέση ${number}`,
        x: (it.cx - centerX) * mPerPx * (screenBelow ? -1 : 1),
        z: hall.firstRowDist + (Math.abs(it.cy - frontY) / (rowGap || 1)) * hall.rowDepth,
        floorY: r * hall.rise, facing: 0, type: 'standard',
      };
      seats.push(seat); map.set(it.el, seat);
      if (isTaken(it.el)) taken.add(id);
    });
  });
  const signature = `${seats.length}|${good.length}|${Math.round(pitch)}|${JSON.stringify(settings)}`;
  return { seats, hall, els: map, taken, signature };
}

function hasSkipAncestor(el) {
  let n = el;
  for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
    const c = n.getAttribute?.('class') || '';
    if (SKIP_RE.test(c) || SKIP_RE.test(n.id || '')) return true;
  }
  return false;
}

function isTaken(el) {
  for (const n of [el, ...el.querySelectorAll('*')].slice(0, 6)) {
    const c = (n.getAttribute('class') || '') + ' ' + (n.dataset?.status || '') + ' ' + (n.getAttribute('aria-label') || '');
    if (TAKEN_RE.test(c) || n.getAttribute('aria-disabled') === 'true' || n.hasAttribute('disabled')) return true;
  }
  return false;
}

function labelFor(el) {
  const text = [el.getAttribute('aria-label'), el.getAttribute('title'), el.dataset?.row && `row ${el.dataset.row}`,
    el.dataset?.seat && `seat ${el.dataset.seat}`, el.dataset?.number && `seat ${el.dataset.number}`].filter(Boolean).join(' ');
  const row = text.match(/(?:σειρ[άα]|row)\s*[:#]?\s*([A-Za-zΑ-Ωα-ω]{1,2}|\d{1,2})/i)?.[1];
  let seat = text.match(/(?:θ[έε]ση|seat|no\.?)\s*[:#]?\s*(\d{1,3})/i)?.[1];
  if (!seat) { const t = (el.textContent || '').trim(); if (/^\d{1,3}$/.test(t)) seat = t; }
  return { row: row?.toUpperCase(), seat };
}

/** A single letter or number printed next to the row (common on seat maps). */
function rowLabelFor(row) {
  const { cy } = row;
  const left = row.items[0], right = row.items[row.items.length - 1];
  for (const x of [left.cx - left.w * 1.5, right.cx + right.w * 1.5]) {
    const el = document.elementFromPoint(x, cy);
    const t = el && !layoutHasEl(el) ? (el.textContent || '').trim() : '';
    if (/^[A-Za-zΑ-Ωα-ω]$|^\d{1,2}$/.test(t)) return t.toUpperCase();
  }
  return null;
}
function layoutHasEl(el) { return !!el.closest?.(SEAT_SEL); }

function guessScreenBelow(rows) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const midY = (rows[0].cy + rows[rows.length - 1].cy) / 2;
  let n;
  while ((n = walker.nextNode())) {
    if (/^\s*(screen|οθ[όο]νη|leinwand)\s*$/i.test(n.nodeValue)) {
      const r = n.parentElement.getBoundingClientRect();
      if (r.width) return r.top > midY;
    }
  }
  const screenEl = document.querySelector('[class*="screen" i]:not(body):not(html)');
  const r = screenEl?.getBoundingClientRect();
  if (r && r.width > 50 && r.height < 120) return r.top > midY;
  return false;
}

// ---------------- interaction ----------------

function seatFromEvent(e) {
  if (!layout) return null;
  let n = e.target;
  for (let i = 0; i < 5 && n; i++, n = n.parentElement) {
    const s = layout.els.get(n);
    if (s) return { seat: s, el: n };
  }
  return null;
}

function onPointer(e) {
  const hit = seatFromEvent(e);
  if (hit) show(hit.seat, hit.el);
}
function onClick(e) {
  const hit = seatFromEvent(e);
  if (hit) { pinned = hit; show(hit.seat, hit.el); }
}

let lastOutlined = null;
function show(seat, el, { open = true } = {}) {
  current = seat;
  if (open && ui.state === 'closed') openPanel();
  if (lastOutlined && lastOutlined !== el) lastOutlined.style.outline = lastOutlined.dataset.sv3dOutline || '';
  if (el) { el.dataset.sv3dOutline = el.style.outline; el.style.outline = '2px solid #f5b301'; lastOutlined = el; }
  viewer?.setSeat(seat);
  const m = seatMetrics(seat, layout ? layout.hall : HALL);
  ui.seatLabel.textContent = seat.label || `Σειρά ${seat.row} · Θέση ${seat.number}`;
  ui.score.className = `score ${m.tone}`;
  ui.score.textContent = `${m.label} · ${m.score}/100`;
  ui.metrics.innerHTML = `<span><b>${m.distance.toFixed(1)} m</b> απόσταση</span><span><b>${m.hAngle.toFixed(0)}°</b> γωνία θέασης</span><span><b>${m.offAxis.toFixed(0)}°</b> πλάγια</span>`;
}

// ---------------- viewer ----------------

async function rebuildViewer() {
  if (!ui) return;
  viewer?.dispose(); viewer = null;
  const demo = !layout;
  ui.empty.hidden = !demo || ui.demoOn;
  ui.demoBar.hidden = !(demo && ui.demoOn);
  if (demo && !ui.demoOn) return;
  const seats = demo ? demoSeats() : layout.seats;
  const hall = demo ? HALL : layout.hall;
  try {
    viewer = new SeatView3D(ui.viewport, seats, hall);
  } catch (err) {
    ui.empty.hidden = false;
    ui.empty.textContent = 'Το 3D δεν ξεκίνησε: ' + (err?.message || err);
    return;
  }
  viewer.setTitle(document.title.split(/[|–-]/)[0].trim().slice(0, 40));
  viewer.setOccupied(demo ? new Set() : layout.taken);
  const keep = current && seats.find((s) => s.id === current.id);
  const start = keep || seats.slice().sort((a, b) => seatMetrics(b, hall).score - seatMetrics(a, hall).score)[0];
  viewer.setSeat(start, { animate: false });
  show(start, null, { open: false });
  ui.info.textContent = demo
    ? 'Demo αίθουσα (δεν βρέθηκε χάρτης θέσεων σε αυτή τη σελίδα)'
    : `Βρέθηκαν ${seats.length} θέσεις σε ${new Set(seats.map((s) => s.rowIndex)).size} σειρές`;
}

let demoCache;
function demoSeats() { return (demoCache ||= buildSeats(HALL).map((s) => ({ ...s, label: `Σειρά ${s.row} · Θέση ${s.number}` }))); }

// ---------------- UI (Shadow DOM so the site's CSS can't touch it) ----------------

function ensureUI() {
  if (ui) return;
  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .launch { background: #f5b301; color: #1a1400; border: 0; border-radius: 999px; padding: 10px 16px; font-weight: 700; font-size: 14px; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.35); }
      .panel { width: min(460px, calc(100vw - 32px)); background: #12151c; color: #eef1f7; border: 1px solid #2a3040; border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.5); overflow: hidden; font-size: 13px; }
      .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #2a3040; }
      .head strong { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .icon { background: none; border: 0; color: #9aa3b5; font-size: 16px; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
      .icon:hover { color: #fff; background: #1e2330; }
      .score { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
      .good { background: rgba(60,207,122,.15); color: #3ccf7a; } .ok { background: rgba(245,179,1,.15); color: #f5b301; } .bad { background: rgba(240,106,90,.15); color: #f06a5a; }
      .vp { position: relative; aspect-ratio: 16/10; background: #000; touch-action: none; cursor: grab; }
      .vp canvas { display: block; width: 100%; height: 100%; }
      .empty { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; padding: 16px; color: #9aa3b5; gap: 10px; align-content: center; }
      .metrics { display: flex; gap: 12px; padding: 8px 10px; color: #9aa3b5; flex-wrap: wrap; }
      .metrics b { color: #eef1f7; }
      .foot { padding: 0 10px 8px; color: #6f788a; font-size: 11px; }
      .settings { padding: 8px 10px; border-top: 1px solid #2a3040; display: grid; gap: 8px; }
      .settings label { display: grid; grid-template-columns: 150px 1fr 48px; align-items: center; gap: 8px; color: #9aa3b5; }
      .settings .row { display: flex; gap: 14px; flex-wrap: wrap; color: #9aa3b5; }
      .btn { background: #f5b301; color: #1a1400; border: 0; border-radius: 8px; padding: 6px 12px; font-weight: 700; cursor: pointer; }
      .demo { display: flex; gap: 8px; align-items: center; padding: 8px 10px; border-top: 1px solid #2a3040; color: #9aa3b5; }
      select { background: #1e2330; color: #eef1f7; border: 1px solid #2a3040; border-radius: 6px; padding: 3px 6px; }
      [hidden] { display: none !important; }
    </style>
    <button class="launch" part="launch">🎬 3D θέα θέσης</button>
    <div class="panel" hidden>
      <div class="head">
        <strong class="seat">—</strong>
        <span class="score"></span>
        <button class="icon reset" title="Κοίτα την οθόνη">⟲</button>
        <button class="icon gear" title="Ρυθμίσεις αίθουσας">⚙</button>
        <button class="icon close" title="Κλείσιμο">✕</button>
      </div>
      <div class="vp">
        <div class="empty" hidden>
          <div>Δεν βρέθηκε χάρτης θέσεων σε αυτή τη σελίδα.<br>Άνοιξε την επιλογή θέσεων μιας προβολής.</div>
          <button class="btn demo-btn">Δείξε demo αίθουσα</button>
        </div>
      </div>
      <div class="demo" hidden>Σειρά <select class="d-row"></select> Θέση <select class="d-seat"></select></div>
      <div class="metrics"></div>
      <div class="settings" hidden>
        <label>Πλάτος οθόνης <input type="range" class="s-width" min="8" max="26" step="0.5"><span class="v-width"></span></label>
        <label>Απόσταση 1ης σειράς <input type="range" class="s-first" min="2.5" max="9" step="0.5"><span class="v-first"></span></label>
        <div class="row">
          <label style="display:flex;gap:6px"><input type="checkbox" class="s-flip"> Η οθόνη είναι κάτω στον χάρτη</label>
          <label style="display:flex;gap:6px"><input type="checkbox" class="s-flat"> Επίπεδη αίθουσα (χωρίς σκαλιά)</label>
          <label style="display:flex;gap:6px"><input type="checkbox" class="s-flatscreen"> Οθόνη 1.85:1</label>
        </div>
        <div><button class="icon s-auto">↺ Αυτόματες τιμές</button></div>
      </div>
      <div class="foot"><span class="info"></span> · Σύρε στο 3D για να κοιτάξεις γύρω</div>
    </div>`;
  document.documentElement.appendChild(host);
  const $ = (s) => root.querySelector(s);
  ui = {
    host, root, state: 'closed', demoOn: false,
    launch: $('.launch'), panel: $('.panel'), viewport: $('.vp'), empty: $('.empty'), seatLabel: $('.seat'),
    score: $('.score'), metrics: $('.metrics'), info: $('.info'), settings: $('.settings'), demoBar: $('.demo'),
  };
  ui.launch.onclick = openPanel;
  $('.close').onclick = () => { ui.state = 'closed'; ui.panel.hidden = true; ui.launch.hidden = false; };
  $('.reset').onclick = () => viewer?.resetLook();
  $('.gear').onclick = () => { ui.settings.hidden = !ui.settings.hidden; syncSettingsUI(); };
  $('.demo-btn').onclick = () => { ui.demoOn = true; fillDemoSelects(); rebuildViewer(); };

  const onSetting = () => {
    settings = {
      ...settings,
      screenWidth: +$('.s-width').value, firstRow: +$('.s-first').value,
      flip: $('.s-flip').checked, flat: $('.s-flat').checked, aspect: $('.s-flatscreen').checked ? 1.85 : 2.39,
    };
    saveSettings(); syncSettingsUI(); scan();
  };
  for (const s of ['.s-width', '.s-first']) $(s).addEventListener('change', onSetting);
  for (const s of ['.s-flip', '.s-flat', '.s-flatscreen']) $(s).addEventListener('change', onSetting);
  $('.s-auto').onclick = () => { settings = {}; saveSettings(); syncSettingsUI(); scan(); };

  $('.d-row').onchange = fillDemoSeats;
  $('.d-seat').onchange = () => { const s = demoSeats().find((x) => x.id === $('.d-seat').value); if (s) show(s, null); };
  ui.$ = $;

  if (TARGET_HOSTS.test(location.hostname) || layout) rebuildViewer();
}

function openPanel() {
  ui.state = 'open'; ui.panel.hidden = false; ui.launch.hidden = true;
  if (!viewer) rebuildViewer();
}

function syncSettingsUI() {
  const $ = ui.$, h = layout?.hall || HALL;
  $('.s-width').value = settings.screenWidth || h.screen.width;
  $('.s-first').value = settings.firstRow || h.firstRowDist;
  $('.s-flip').checked = !!settings.flip;
  $('.s-flat').checked = !!settings.flat;
  $('.s-flatscreen').checked = settings.aspect === 1.85;
  $('.v-width').textContent = `${$('.s-width').value} m`;
  $('.v-first').textContent = `${$('.s-first').value} m`;
}

function fillDemoSelects() {
  const sel = ui.$('.d-row');
  sel.innerHTML = HALL.rows.map((r) => `<option>${r.id}</option>`).join('');
  sel.value = 'F'; fillDemoSeats();
}
function fillDemoSeats() {
  const row = ui.$('.d-row').value;
  const seats = demoSeats().filter((s) => s.row === row);
  const sel = ui.$('.d-seat');
  sel.innerHTML = seats.map((s) => `<option value="${s.id}">${s.number}</option>`).join('');
  sel.value = seats[Math.floor(seats.length / 2)].id;
  show(seats[Math.floor(seats.length / 2)], null);
}

// ---------------- helpers ----------------

function loadSettings() { try { return JSON.parse(localStorage.getItem('sv3d:' + location.hostname)) || {}; } catch { return {}; } }
function saveSettings() { try { localStorage.setItem('sv3d:' + location.hostname, JSON.stringify(settings)); } catch { /* ignore */ } }
function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
