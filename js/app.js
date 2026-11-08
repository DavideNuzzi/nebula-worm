// The page: loads the model, runs the simulation in a worker and draws the worm, the decoded behavior, the decoded
// activity and the latent trajectory at the display time `tau` (seconds of worm time).
const $ = (q) => document.querySelector(q);
const FPS = 32;              // body frames per second
const KEEP = 130;            // seconds of history kept
const TRAIL = 60;            // seconds of head path drawn
const INK = '#e9ecef', INK2 = '#b4bbc4', INK3 = '#7c8591', LINE = '#2a2f37', SIL = '#e08a4f';

const S = {
  meta: null, worker: null, fpsL: 2.9046,
  playing: true, speed: 1, win: 60, loop: false, blocks: new Set(), singles: new Set(),
  epoch: 0, tau: 0, frames: [], f0: 0, steps: [], start: null,
  cam: { x: 0, y: 0, init: false }, zoom: 3.2, rot: { az: 160, el: 30 }, rate: 1, last: 0,
};

// ------------------------------------------------------------------------------------------------- loading
async function load() {
  status('Loading the model (5 MB)…');
  const get = (f) => fetch(`data/${f}`).then((r) => { if (!r.ok) throw new Error(`${f}: ${r.status}`); return r; });
  const [meta, body, manifest, buffer] = await Promise.all([
    get('meta.json').then((r) => r.json()), get('body.json').then((r) => r.json()),
    get('model.json').then((r) => r.json()), get('model.bin').then((r) => r.arrayBuffer())]);
  S.meta = meta; S.fpsL = meta.fps_labels;
  prepareStatic();
  S.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  S.worker.onmessage = onWorker;
  S.worker.onerror = (e) => status(`<span class="warn">The simulation stopped: ${e.message}</span>`);
  await new Promise((res) => {
    S.worker.addEventListener('message', function once(e) { if (e.data.type === 'ready') { S.worker.removeEventListener('message', once); res(); } });
    S.worker.postMessage({ type: 'init', manifest, buffer, meta, body }, [buffer]);
  });
  buildControls();
  restart();
  requestAnimationFrame(tick);
}

function onWorker(e) {
  const m = e.data;
  if (m.type !== 'frames' || m.epoch !== S.epoch) return;
  m.labels.forEach((label, k) => S.frames.push({ x: m.tips.subarray(k * 52, k * 52 + 26), y: m.tips.subarray(k * 52 + 26, k * 52 + 52), label }));
  for (const st of m.steps) S.steps.push(st);
  const drop = Math.floor((S.tau - KEEP) * FPS) - S.f0;
  if (drop > 256) { S.frames.splice(0, drop); S.f0 += drop; }
  const dropS = S.steps.length ? Math.floor((S.tau - KEEP) * S.fpsL) - S.steps[0].i : 0;
  if (dropS > 32) S.steps.splice(0, dropS);
}

const frameAt = (j) => S.frames[j - S.f0];
const stepAt = (i) => (S.steps.length && i >= S.steps[0].i ? S.steps[i - S.steps[0].i] : undefined);
const stepNow = () => stepAt(Math.floor(Math.floor(S.tau * FPS) * S.fpsL / FPS + 1e-9));
const silenced = () => [...new Set([...[...S.blocks].flatMap((b) => S.meta.blocks[b]), ...S.singles])].sort((a, b) => a - b);

function restart() {
  S.epoch++; S.tau = 0; S.frames = []; S.f0 = 0; S.steps = []; S.cam.init = false; S.rate = 1;
  const start = Math.floor(Math.random() * S.meta.starts.length);
  S.start = S.meta.starts[start];
  S.worker.postMessage({ type: 'reset', epoch: S.epoch, start, seed: (Math.random() * 2 ** 32) >>> 0, loop: S.loop, silenced: silenced() });
}

// ------------------------------------------------------------------------------------------------- controls
function pressed(group, btn) { group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn))); }

function setPlaying(p) {
  S.playing = p;
  const b = $('#play');
  b.setAttribute('aria-pressed', String(p));
  b.querySelector('.ico').textContent = p ? '❚❚' : '▶';
  b.querySelector('.lab').textContent = p ? 'Pause' : 'Play';
}

function setMode(loop) {
  S.loop = loop;
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.mode === 'loop') === loop)));
  S.worker.postMessage({ type: 'mode', loop });
  $('#sil-note').hidden = loop;
  document.querySelectorAll('#blocks .chip, #singles .chip').forEach((c) => { c.disabled = !loop; });
  $('#more').disabled = !loop;
}

function sendSilence() { S.worker.postMessage({ type: 'silence', indices: silenced() }); }

function chip(label, count, on, onClick) {
  const c = document.createElement('button');
  c.className = 'chip'; c.type = 'button';
  c.setAttribute('aria-pressed', String(on));
  c.innerHTML = count == null ? label : `${label}<span class="n">${count}</span>`;
  c.addEventListener('click', () => { onClick(c); });
  return c;
}

function renderSingles() {
  const box = $('#singles'), names = S.meta.neuron_names;
  box.innerHTML = '';
  const extra = [...S.singles].filter((i) => !S.meta.core.includes(i));
  for (const i of [...S.meta.core, ...extra]) {
    box.appendChild(chip(names[i], null, S.singles.has(i), () => {
      S.singles.has(i) ? S.singles.delete(i) : S.singles.add(i);
      renderSingles(); sendSilence();
    }));
  }
  box.querySelectorAll('.chip').forEach((c) => { c.disabled = !S.loop; });
}

function buildControls() {
  $('#play').addEventListener('click', () => setPlaying(!S.playing));
  $('#restart').addEventListener('click', restart);
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode === 'loop')));
  $('#to-loop').addEventListener('click', () => setMode(true));
  document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => { S.speed = +b.dataset.speed; pressed(b.parentNode, b); }));
  document.querySelectorAll('[data-window]').forEach((b) => b.addEventListener('click', () => { S.win = +b.dataset.window; pressed(b.parentNode, b); }));
  $('#zoom-in').addEventListener('click', () => { S.zoom = Math.max(1.2, S.zoom / 1.3); });
  $('#zoom-out').addEventListener('click', () => { S.zoom = Math.min(16, S.zoom * 1.3); });
  $('#arena').addEventListener('wheel', (e) => { e.preventDefault(); S.zoom = Math.min(16, Math.max(1.2, S.zoom * Math.exp(e.deltaY * 0.0015))); }, { passive: false });

  const blocks = $('#blocks');
  for (const [b, idx] of Object.entries(S.meta.blocks)) {
    blocks.appendChild(chip(b, idx.length, false, (c) => {
      S.blocks.has(b) ? S.blocks.delete(b) : S.blocks.add(b);
      c.setAttribute('aria-pressed', String(S.blocks.has(b))); sendSilence();
    }));
  }
  renderSingles();
  const names = S.meta.neuron_names, more = $('#more');
  const order = names.map((n, i) => i).filter((i) => !S.meta.core.includes(i))
    .sort((a, b) => (names[a].startsWith('#') - names[b].startsWith('#')) || (names[a].startsWith('#') ? a - b : names[a].localeCompare(names[b])));
  for (const i of order) more.add(new Option(names[i], i));
  more.addEventListener('change', () => { if (more.value !== '') { S.singles.add(+more.value); more.value = ''; renderSingles(); sendSilence(); } });
  $('#clear').addEventListener('click', () => {
    S.blocks.clear(); S.singles.clear();
    blocks.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', 'false'));
    renderSingles(); sendSilence();
  });
  setMode(false);

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('select, input, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!S.playing); }
    if (e.key === 'n' || e.key === 'N') restart();
  });

  const lat = $('#latent');
  let drag = null;
  lat.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, az: S.rot.az, el: S.rot.el }; lat.setPointerCapture(e.pointerId); });
  lat.addEventListener('pointermove', (e) => {
    if (!drag) return;
    S.rot.az = drag.az - (e.clientX - drag.x) * 0.5;
    S.rot.el = Math.max(-89, Math.min(89, drag.el + (e.clientY - drag.y) * 0.5));
    LAT.key = '';
  });
  lat.addEventListener('pointerup', () => { drag = null; });

  const legend = $('#legend');
  S.meta.behavior_names.forEach((n, k) => {
    legend.insertAdjacentHTML('beforeend', `<span><i class="swatch" style="background:${S.meta.behavior_colors[k]}"></i>${n}</span>`);
  });
  legend.insertAdjacentHTML('beforeend', `<span><i class="swatch" style="background:${INK3};height:3px"></i>closed loop</span>`);
  legend.insertAdjacentHTML('beforeend', `<span><i class="swatch" style="background:${SIL};height:6px"></i>silencing</span>`);

  const probs = $('#probs');
  S.meta.behavior_names.forEach((n, k) => {
    probs.insertAdjacentHTML('beforeend', `<span class="nm">${n}</span><span class="bar"><i style="background:${S.meta.behavior_colors[k]}"></i></span><span class="pc">0%</span>`);
  });
}

// ------------------------------------------------------------------------------------------------- static data
let ROWS = null, LUT = null;
function prepareStatic() {
  const m = S.meta, inBlock = new Set();
  ROWS = [];
  for (const [b, label] of [['reversal', 'reversal'], ['forward', 'forward'], ['ventral turn', 'ventral turn'], ['dorsal turn', 'dorsal turn']]) {
    const idx = m.blocks[b].filter((i) => !inBlock.has(i));
    idx.forEach((i) => inBlock.add(i));
    ROWS.push({ label, idx });
  }
  ROWS.push({ label: 'other', idx: m.neuron_names.map((_, i) => i).filter((i) => !inBlock.has(i)) });
  // diverging colormap for z-scores: blue - dark neutral - orange
  const neg = [91, 155, 213], mid = [28, 31, 36], pos = [242, 162, 92];
  LUT = Array.from({ length: 256 }, (_, k) => {
    const t = k / 255 * 2 - 1, a = Math.abs(t), c = t < 0 ? neg : pos;
    return mid.map((v, j) => Math.round(v + (c[j] - v) * a));
  });
}
const zscore = (i, v) => (v - S.meta.mean[i]) / S.meta.std[i];

// ------------------------------------------------------------------------------------------------- drawing utils
function fit(canvas) {
  const r = canvas.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(d, 0, 0, d, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

function timeAxis(ctx, x0, x1, y, win) {
  const step = [5, 10, 20, 30, 60].find((v) => (x1 - x0) * v / win >= 80) || win;   // labels at least 80 px apart
  ctx.fillStyle = INK3; ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'top';
  for (let s = 0; s <= win; s += step) {
    const x = x1 - (s / win) * (x1 - x0);
    ctx.textAlign = s === 0 ? 'right' : s === win ? 'left' : 'center';
    ctx.fillText(s === 0 ? 'now' : `−${s} s`, x, y);
    ctx.fillRect(x - 0.5, y - 4, 1, 3);
  }
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const lerp = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------------------------------------- arena
function drawArena(dt) {
  const { ctx, w, h } = fit($('#arena'));
  ctx.fillStyle = '#121418'; ctx.fillRect(0, 0, w, h);
  const j = Math.floor(S.tau * FPS), a = S.tau * FPS - j, f = frameAt(j);
  if (!f) { ctx.fillStyle = INK3; ctx.font = '14px system-ui'; ctx.textAlign = 'center'; ctx.fillText('Starting…', w / 2, h / 2); return; }
  const g = frameAt(j + 1) || f;
  const X = Array.from(f.x, (v, k) => lerp(v, g.x[k], a)), Y = Array.from(f.y, (v, k) => lerp(v, g.y[k], a));
  const cx = X.reduce((p, q) => p + q) / 26, cy = Y.reduce((p, q) => p + q) / 26;
  if (!S.cam.init) { S.cam.x = cx; S.cam.y = cy; S.cam.init = true; } else {
    const k = 1 - Math.exp(-dt * 2.2);
    S.cam.x += (cx - S.cam.x) * k; S.cam.y += (cy - S.cam.y) * k;
  }
  const sc = w / S.zoom, ox = w / 2 - S.cam.x * sc, oy = h / 2 + S.cam.y * sc;
  const sx = (x) => ox + x * sc, sy = (y) => oy - y * sc;

  // agar grid: 0.25 mm and 1 mm
  for (const [step, col] of [[0.25, '#181b20'], [1, '#22262d']]) {
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath();
    const xa = Math.floor((S.cam.x - w / sc / 2) / step) * step, ya = Math.floor((S.cam.y - h / sc / 2) / step) * step;
    for (let x = xa; x < S.cam.x + w / sc / 2 + step; x += step) { ctx.moveTo(Math.round(sx(x)) + 0.5, 0); ctx.lineTo(Math.round(sx(x)) + 0.5, h); }
    for (let y = ya; y < S.cam.y + h / sc / 2 + step; y += step) { ctx.moveTo(0, Math.round(sy(y)) + 0.5); ctx.lineTo(w, Math.round(sy(y)) + 0.5); }
    ctx.stroke();
  }

  // head path, colored by behavior, fading with age
  const cols = S.meta.behavior_colors, first = Math.max(S.f0, j - TRAIL * FPS);
  ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  let path = null;
  for (let k = first; k < j; k++) {
    const p = frameAt(k), q = frameAt(k + 1);
    if (!p || !q) continue;
    const key = `${p.label}|${Math.floor(((k - first) / (j - first + 1)) * 8)}`;
    if (!path || path.key !== key) {
      if (path) ctx.stroke();
      ctx.strokeStyle = cols[p.label]; ctx.globalAlpha = 0.15 + 0.75 * ((k - first) / (j - first + 1));
      ctx.beginPath(); ctx.moveTo(sx(p.x[0]), sy(p.y[0]));
      path = { key };
    }
    ctx.lineTo(sx(q.x[0]), sy(q.y[0]));
  }
  if (path) ctx.stroke();
  ctx.globalAlpha = 1;

  drawWorm(ctx, X, Y, sx, sy, sc);

  // direct label of the current behavior next to the head
  const st = stepNow();
  if (st) {
    const top = Math.min(...Y.map(sy)), xs = X.map(sx);                     // above the body, centred on it
    const hy = top - 22, hx = (Math.min(...xs) + Math.max(...xs)) / 2;
    ctx.font = '600 13px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const name = S.meta.behavior_names[f.label];
    const tw = ctx.measureText(name).width;
    const lx = hx - (tw + 24) / 2;
    ctx.fillStyle = 'rgba(14,16,19,0.75)'; ctx.fillRect(lx, hy - 10, tw + 24, 20);
    ctx.fillStyle = cols[f.label]; ctx.fillRect(lx + 5, hy - 4, 8, 8);
    ctx.fillStyle = INK; ctx.fillText(name, lx + 18, hy + 0.5);
  }

  // scale bar, clock
  const bar = S.zoom > 6 ? 2 : S.zoom > 2.4 ? 1 : 0.5;
  ctx.fillStyle = INK2; ctx.fillRect(16, h - 22, bar * sc, 3);
  ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText(`${bar} mm`, 16, h - 28);
  ctx.textBaseline = 'top'; ctx.fillStyle = INK2; ctx.font = '600 13px system-ui, sans-serif';
  ctx.fillText(fmt(S.tau), 16, 14);
  const sil = silenced().length;
  ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = INK3;
  ctx.fillText(S.loop ? (sil ? `closed loop · ${sil} neuron${sil > 1 ? 's' : ''} silenced` : 'closed loop') : 'generative', 16, 32);
}

// the body: centreline (head = point 0) resampled with Catmull-Rom, a tapered outline, a darker pharynx
function drawWorm(ctx, X, Y, sx, sy, sc) {
  const P = [];
  for (let i = 0; i < 25; i++) {
    const p0 = Math.max(0, i - 1), p3 = Math.min(25, i + 2);
    for (let s = 0; s < 4; s++) {
      const t = s / 4, t2 = t * t, t3 = t2 * t;
      const cr = (a0, a1, a2, a3) => 0.5 * (2 * a1 + (-a0 + a2) * t + (2 * a0 - 5 * a1 + 4 * a2 - a3) * t2 + (-a0 + 3 * a1 - 3 * a2 + a3) * t3);
      P.push([cr(X[p0], X[i], X[i + 1], X[p3]), cr(Y[p0], Y[i], Y[i + 1], Y[p3])]);
    }
  }
  P.push([X[25], Y[25]]);
  const n = P.length, half = 0.034;
  const prof = (u) => (u < 0.08 ? 0.5 + 0.5 * Math.sqrt(u / 0.08) : u < 0.6 ? 1 : 1 - 0.85 * ((u - 0.6) / 0.4) ** 1.5);
  const L = [], R = [];
  for (let k = 0; k < n; k++) {
    const a = P[Math.max(0, k - 1)], b = P[Math.min(n - 1, k + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const nn = Math.hypot(tx, ty) || 1; tx /= nn; ty /= nn;
    const r = half * prof(k / (n - 1));
    L.push([P[k][0] - ty * r, P[k][1] + tx * r]); R.push([P[k][0] + ty * r, P[k][1] - tx * r]);
  }
  const hx = P[0][0] - P[1][0], hy = P[0][1] - P[1][1], hn = Math.hypot(hx, hy) || 1;
  const nose = [P[0][0] + hx / hn * half * 0.9, P[0][1] + hy / hn * half * 0.9];
  ctx.beginPath();
  ctx.moveTo(sx(L[0][0]), sy(L[0][1]));
  for (let k = 1; k < n; k++) ctx.lineTo(sx(L[k][0]), sy(L[k][1]));
  for (let k = n - 1; k >= 0; k--) ctx.lineTo(sx(R[k][0]), sy(R[k][1]));
  ctx.quadraticCurveTo(sx(nose[0] + (R[0][0] - P[0][0])), sy(nose[1] + (R[0][1] - P[0][1])), sx(nose[0]), sy(nose[1]));
  ctx.quadraticCurveTo(sx(nose[0] + (L[0][0] - P[0][0])), sy(nose[1] + (L[0][1] - P[0][1])), sx(L[0][0]), sy(L[0][1]));
  ctx.closePath();
  ctx.fillStyle = '#d9cfbd'; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = '#8c8170'; ctx.stroke();
  const ph = P[Math.round(0.08 * (n - 1))];
  ctx.beginPath(); ctx.arc(sx(ph[0]), sy(ph[1]), Math.max(1.5, half * 0.42 * sc), 0, 2 * Math.PI);
  ctx.fillStyle = '#a99b84'; ctx.fill();
}

// ------------------------------------------------------------------------------------------------- side card
let lastCard = -1;
function drawBehaviorCard() {
  const st = stepNow();
  if (!st || st.i === lastCard) return;
  lastCard = st.i;
  const m = S.meta;
  $('#now-swatch').style.background = m.behavior_colors[st.label];
  $('#now-name').textContent = m.behavior_names[st.label];
  let i = st.i;
  while (stepAt(i - 1) && stepAt(i - 1).label === st.label) i--;
  $('#now-dwell').textContent = `for ${((st.i - i + 1) / S.fpsL).toFixed(1)} s${stepAt(i - 1) ? '' : ' (at least)'}`;
  const bars = $('#probs').querySelectorAll('.bar i'), pcs = $('#probs').querySelectorAll('.pc');
  st.p.forEach((p, k) => { bars[k].style.width = `${(p * 100).toFixed(1)}%`; pcs[k].textContent = `${Math.round(p * 100)}%`; });
}

// visible steps: [i0, i1] and the x position of time t (seconds) in [x0, x1]
function view(x0, x1) {
  const W = S.win, i1 = Math.floor(S.tau * S.fpsL), i0 = Math.max(S.steps.length ? S.steps[0].i : 0, Math.floor((S.tau - W) * S.fpsL) - 1);
  return { i0, i1, x: (t) => x1 - ((S.tau - t) / W) * (x1 - x0) };
}

// ------------------------------------------------------------------------------------------------- ethogram
function drawEthogram() {
  const { ctx, w, h } = fit($('#ethogram'));
  ctx.clearRect(0, 0, w, h);
  const x0 = 0, x1 = w, { i0, i1, x } = view(x0, x1), cols = S.meta.behavior_colors;
  for (let i = i0; i <= i1; i++) {
    const st = stepAt(i);
    if (!st) continue;
    const a = Math.max(x0, x(i / S.fpsL)), b = Math.min(x1, x(Math.min(S.tau, (i + 1) / S.fpsL)));
    if (b <= a) continue;
    ctx.fillStyle = cols[st.label]; ctx.fillRect(a, 14, b - a + 0.6, 28);
    if (st.loop) { ctx.fillStyle = INK3; ctx.fillRect(a, 8, b - a + 0.6, 2); }
    if (st.silenced.length) { ctx.fillStyle = SIL; ctx.fillRect(a, 2, b - a + 0.6, 5); }
  }
  timeAxis(ctx, x0, x1, 48, S.win);
}

// ------------------------------------------------------------------------------------------------- traces
function drawTraces() {
  const { ctx, w, h } = fit($('#traces'));
  ctx.clearRect(0, 0, w, h);
  const m = S.meta, extra = [...S.singles].filter((i) => !m.core.includes(i));
  const rows = [...m.core, ...extra], gut = 54, top = 4, bottom = 22;
  const rh = (h - top - bottom) / rows.length, { i0, i1, x } = view(gut, w - 4);
  // behavior bands
  for (let i = i0; i <= i1; i++) {
    const st = stepAt(i);
    if (!st) continue;
    const a = Math.max(gut, x(i / S.fpsL)), b = Math.min(w - 4, x(Math.min(S.tau, (i + 1) / S.fpsL)));
    if (b > a) { ctx.fillStyle = m.behavior_colors[st.label]; ctx.globalAlpha = 0.14; ctx.fillRect(a, top, b - a + 0.6, h - top - bottom); }
  }
  ctx.globalAlpha = 1;
  ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
  rows.forEach((n, r) => {
    const yc = top + rh * (r + 0.5), amp = rh * 0.42;
    const isSil = silenced().includes(n) && S.loop;
    ctx.fillStyle = isSil ? SIL : INK2; ctx.fillText(m.neuron_names[n], gut - 8, yc);
    ctx.lineWidth = 1.3; ctx.lineJoin = 'round';
    let prev = null;
    for (let i = i0; i <= i1; i++) {
      const st = stepAt(i);
      if (!st) { prev = null; continue; }
      const px = x(i / S.fpsL), py = yc - Math.max(-2.5, Math.min(2.5, zscore(n, st.x[n]))) * amp;
      if (prev) {
        ctx.strokeStyle = st.silenced.includes(n) ? SIL : '#d3d9e0';
        ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(px, py); ctx.stroke();
      }
      prev = [px, py];
    }
  });
  timeAxis(ctx, gut, w - 4, h - bottom + 6, S.win);
}

// ------------------------------------------------------------------------------------------------- heat map
const HM = { img: null, key: '' };
function drawHeatmap() {
  const { ctx, w, h } = fit($('#heatmap'));
  ctx.clearRect(0, 0, w, h);
  const gut = 118, right = 70, top = 2, bottom = 22, n = S.meta.n_neurons;
  const { i0, i1, x } = view(gut, w - right);
  const order = ROWS.flatMap((r) => r.idx), cols = i1 - i0 + 1;
  if (cols <= 0) return;
  const key = `${i0}|${i1}|${S.steps.length ? S.steps[0].i : 0}`;
  if (HM.key !== key) {
    HM.key = key;
    if (!HM.img || HM.img.width !== cols) { HM.img = document.createElement('canvas'); HM.img.width = cols; HM.img.height = n; }
    const c = HM.img.getContext('2d'), im = c.createImageData(cols, n);
    for (let k = 0; k < cols; k++) {
      const st = stepAt(i0 + k);
      order.forEach((neuron, r) => {
        const o = (r * cols + k) * 4;
        if (!st) { im.data[o + 3] = 0; return; }
        const z = Math.max(-2.5, Math.min(2.5, zscore(neuron, st.x[neuron])));
        const rgb = LUT[Math.round((z / 2.5 + 1) / 2 * 255)];
        im.data[o] = rgb[0]; im.data[o + 1] = rgb[1]; im.data[o + 2] = rgb[2]; im.data[o + 3] = 255;
      });
    }
    c.putImageData(im, 0, 0);
  }
  const H = h - top - bottom, a = x(i0 / S.fpsL), b = x((i1 + 1) / S.fpsL);
  ctx.save(); ctx.beginPath(); ctx.rect(gut, top, w - right - gut, H); ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(HM.img, a, top, b - a, H);
  ctx.restore();
  // groups
  ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  let r0 = 0;
  for (const g of ROWS) {
    const ya = top + (r0 / n) * H, yb = top + ((r0 + g.idx.length) / n) * H;
    ctx.fillStyle = INK2; ctx.fillText(`${g.label} (${g.idx.length})`, gut - 10, (ya + yb) / 2);
    ctx.fillStyle = INK3; ctx.fillRect(gut - 5, ya + 1, 2, yb - ya - 2);
    if (r0) { ctx.fillStyle = '#0e1013'; ctx.fillRect(gut, ya - 0.5, w - right - gut, 1); }
    r0 += g.idx.length;
  }
  // color scale
  const lx = w - right + 14, lh = Math.min(120, H - 20), ly = top + (H - lh) / 2;
  for (let k = 0; k < lh; k++) { const rgb = LUT[Math.round((1 - k / lh) * 255)]; ctx.fillStyle = `rgb(${rgb})`; ctx.fillRect(lx, ly + k, 10, 1.2); }
  ctx.fillStyle = INK3; ctx.textAlign = 'left';
  ctx.fillText('+2.5', lx + 14, ly + 4); ctx.fillText('0', lx + 14, ly + lh / 2); ctx.fillText('−2.5', lx + 14, ly + lh - 4);
  timeAxis(ctx, gut, w - right, h - bottom + 6, S.win);
}

// ------------------------------------------------------------------------------------------------- latent
const LAT = { bg: null, key: '' };
function projector(w, h) {
  const mu = S.meta.manifold.mu;
  if (!LAT.c) {
    const c = [0, 0, 0];
    mu.forEach((p) => { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; });
    LAT.c = c.map((v) => v / mu.length);
    const d = mu.map((p) => Math.hypot(p[0] - LAT.c[0], p[1] - LAT.c[1], p[2] - LAT.c[2])).sort((a, b) => a - b);
    LAT.r = d[Math.floor(0.98 * (d.length - 1))];
  }
  const az = S.rot.az * Math.PI / 180, el = S.rot.el * Math.PI / 180, s = 0.62 * Math.min(w, h) / LAT.r;
  return (p) => {
    const X = p[0] - LAT.c[0], Y = p[1] - LAT.c[1], Z = p[2] - LAT.c[2];
    const u = -Math.sin(az) * X + Math.cos(az) * Y;
    const v = -Math.sin(el) * (Math.cos(az) * X + Math.sin(az) * Y) + Math.cos(el) * Z;
    return [w / 2 + u * s, h / 2 - v * s];
  };
}

function drawLatent() {
  const cv = $('#latent'), { ctx, w, h } = fit(cv), pr = projector(w, h), m = S.meta;
  const key = `${w}|${h}|${S.rot.az}|${S.rot.el}`;
  if (LAT.key !== key) {
    LAT.key = key;
    const d = window.devicePixelRatio || 1;
    LAT.bg = document.createElement('canvas'); LAT.bg.width = cv.width; LAT.bg.height = cv.height;
    const b = LAT.bg.getContext('2d');
    b.setTransform(d, 0, 0, d, 0, 0); b.globalAlpha = 0.3;
    m.manifold.mu.forEach((p, k) => { const [x, y] = pr(p); b.fillStyle = m.behavior_colors[m.manifold.label[k]]; b.fillRect(x - 1, y - 1, 2, 2); });
  }
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(LAT.bg, 0, 0, w, h);
  const { i0, i1 } = view(0, w);
  ctx.lineWidth = 2; ctx.lineCap = 'round';
  let prev = null;
  for (let i = i0; i <= i1; i++) {
    const st = stepAt(i);
    if (!st) { prev = null; continue; }
    const q = pr(st.z);
    if (prev) {
      ctx.globalAlpha = 0.25 + 0.75 * (i - i0) / Math.max(1, i1 - i0);
      ctx.strokeStyle = m.behavior_colors[st.label];
      ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
    }
    prev = q;
  }
  ctx.globalAlpha = 1;
  const st = stepAt(i1);
  if (st) {
    const [x, y] = pr(st.z);
    ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 2 * Math.PI);
    ctx.fillStyle = m.behavior_colors[st.label]; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = INK; ctx.stroke();
  }
}

// ------------------------------------------------------------------------------------------------- main loop
function status(html) { $('#status').innerHTML = html; }

function tick(now) {
  const dt = S.last ? Math.min(0.1, (now - S.last) / 1000) : 0;
  S.last = now;
  if (S.playing && S.frames.length) {
    const want = dt * S.speed, maxT = (S.f0 + S.frames.length - 1) / FPS, got = Math.max(0, Math.min(S.tau + want, maxT) - S.tau);
    S.tau += got;
    if (want > 0) S.rate = 0.97 * S.rate + 0.03 * (got / want);
  }
  S.worker.postMessage({ type: 'clock', t: S.tau });
  drawArena(dt);
  drawBehaviorCard();
  drawEthogram();
  drawTraces();
  drawHeatmap();
  drawLatent();
  if (S.start && Math.floor(now / 250) !== S.lastStatus) {
    S.lastStatus = Math.floor(now / 250);
    const slow = S.playing && S.rate < 0.9 ? ` · <span class="warn">running at ${(S.rate * S.speed).toFixed(1)}× real time: this device cannot keep up</span>` : '';
    status(`Worm time <b>${fmt(S.tau)}</b> · started from the recording at ${fmt(S.start.frame / S.fpsL)} ` +
           `(${S.meta.behavior_names[S.start.label]}) · ${S.loop ? 'closed loop' : 'generative'}${slow}`);
  }
  requestAnimationFrame(tick);
}

load().catch((e) => status(`<span class="warn">Could not start: ${e.message}</span>`));
