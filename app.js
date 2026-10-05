'use strict';

/* =====================================================================
 * Drawer Insert Planner
 *
 * Model: a drawer (interior W x L x H, H overall) is filled by a tree of compartments.
 * The bottom panel is WALL thick, so dividers stand H - WALL tall.
 * A leaf is one compartment. A split node divides its rectangle into a grid
 * of columns x rows (colF / rowF are size fractions that each sum to 1) and
 * holds one child per cell, row-major. Vertical dividers of a split node span
 * that node's full height; horizontal ones span its full width.
 * All geometry is stored in inches.
 * ===================================================================== */

const MM_PER_IN = 25.4;           // only used to size the printed drawing in millimetres
const WALL = 0.17;                // sheet thickness: outer wall and divider thickness (in)
const MIN_CELL = 1;               // smallest compartment edge (in)
const SNAP = 1 / 16;              // drag snapping (in)
const EPS = 0.002;                // tolerance when matching positions (in)
const STORAGE_KEY = 'drawer-organizer-designer:v1';

// Placeholder pricing. Replace with your real numbers.
//   total = base + perSqIn x square inches of material (bottom panel + dividers)
//                + perDivider x number of dividers (assembly and gluing time)
// Same price as the store's order form: the shop's production cost (acrylic, laser, labour, packaging),
// grossed up so that advertising, card fees, customer service and the net profit target come out of each sale.
// Rebuilt from pricing/cost_model.py; keep the two in step (the tests compare them).
const PRICE = { k: 3.5087719, area: 0.037232142, cut: 0.011127944, top: 0.018389007, part: 1.1607143, pack: 0.014314236, fixed: 10.316667, minimum: 0 };

const FRACS = ['', '⅛', '¼', '⅜', '½', '⅝', '¾', '⅞'];

/* ---------- state ---------- */
let nextId = 1;
const state = {
  dims: null,                     // the insert: { w, l, h } in eighths of an inch (the drawer interior less the safety gap)
  drawer: null,                   // the drawer interior as measured: { w, l, h } in eighths
  gap: 0,                         // safety gap in eighths, off each side of the width and length and once off the height
  root: newLeaf(),
  eq: [],                         // locked equal sizes: [{ a: '<space id>:w', b: '<space id>:l' }, ...]
};
const hist = { stack: [], i: -1 };

function newLeaf() { return { id: nextId++ }; }

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const on = (s, ev, fn) => { const el = $(s); if (el) el.addEventListener(ev, fn); };
const eighthsToIn = n => n / 8;
const fmt2 = v => v.toFixed(2);
function fmtEighths(n) {
  const whole = Math.floor(n / 8), r = n % 8;
  return `${whole || ''}${r ? (whole ? ' ' : '') + FRACS[r] : ''}`;
}
const fmtMoney = v => '$' + v.toFixed(2);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};
function maxId(n) { return n.kids ? Math.max(n.id, ...n.kids.map(maxId)) : n.id; }
const isDefaultLayout = () => !state.root.kids;

/* ---------- layout ---------- */
// The customer measures the drawer's inside (state.drawer, in eighths of an inch) and chooses a safety gap
// (state.gap, eighths, taken off each side of the width and length and once off the height). Everything else in
// the planner (layout, price, exports) works on the resulting insert size, state.dims.
const GAPS = [0, 1, 2, 3, 4];                         // 0, 1/8, 1/4, 3/8, 1/2 inch
const DEFAULT_GAP = 1;
function drawerLimits(g = state.gap) {                // interior sizes that give an insert the store can make: 5-47 in wide and long, 1/2-15 in high
  return { w: [40 + 2 * g, 376 + 2 * g], l: [40 + 2 * g, 376 + 2 * g], h: [4 + g, 120 + g] };
}
function syncInsert() {
  const lim = drawerLimits(), clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
  state.drawer = { w: clamp(state.drawer.w, lim.w), l: clamp(state.drawer.l, lim.l), h: clamp(state.drawer.h, lim.h) };
  state.dims = { w: state.drawer.w - 2 * state.gap, l: state.drawer.l - 2 * state.gap, h: state.drawer.h - state.gap };
}
function drawerSize() {
  const { w, l, h } = state.dims;
  const H = eighthsToIn(h);
  return { W: eighthsToIn(w), L: eighthsToIn(l), H, partH: H - WALL };   // partH: height of dividers and walls
}

const sameFr = (x, y) => x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 1e-6);

// A split whose every child is split along the other axis into identical parts is a grid in
// disguise: its full-span divider can be rebuilt the other way round so each piece moves alone.
function transposable(n, axis) {
  if (!n.kids) return false;
  const k0 = n.kids[0];
  if (axis === 'v') return n.rowF.length === 1 && n.colF.length > 1 && n.kids.every(k => k.kids && k.colF.length === 1 && k.rowF.length > 1 && sameFr(k.rowF, k0.rowF));
  return n.colF.length === 1 && n.rowF.length > 1 && n.kids.every(k => k.kids && k.rowF.length === 1 && k.colF.length > 1 && sameFr(k.colF, k0.colF));
}

function transposeAt(n, axis) {
  if (axis === 'v') {
    const R = [...n.kids[0].rowF], C = [...n.colF], old = n.kids;
    n.colF = [1]; n.rowF = R;
    n.kids = R.map((_, r) => ({ id: nextId++, colF: [...C], rowF: [1], kids: C.map((_, c) => old[c].kids[r]) }));
  } else {
    const C = [...n.kids[0].colF], R = [...n.rowF], old = n.kids;
    n.rowF = [1]; n.colF = C;
    n.kids = C.map((_, c) => ({ id: nextId++, rowF: [...R], colF: [1], kids: R.map((_, r) => old[r].kids[c]) }));
  }
}

function layoutTree(root, W, L) {
  const cells = [], divs = [], regions = new Map();    // regions: every node's rectangle, for the constraint solver
  (function walk(n, x, y, w, h) {
    regions.set(n.id, { w, h });
    if (!n.kids) { cells.push({ n, x, y, w, h }); return; }
    const nc = n.colF.length, nr = n.rowF.length;
    const aw = w - (nc - 1) * WALL, ah = h - (nr - 1) * WALL;
    const cx = [], cw = [], ry = [], rh = [];
    let p = x;
    n.colF.forEach(f => { cx.push(p); cw.push(f * aw); p += f * aw + WALL; });
    p = y;
    n.rowF.forEach(f => { ry.push(p); rh.push(f * ah); p += f * ah + WALL; });
    const piecesV = transposable(n, 'v') ? (() => {
      const fr = n.kids[0].rowF, ah2 = h - (fr.length - 1) * WALL; let q = y;
      return fr.map(f => { const a = q; q += f * ah2 + WALL; return [a, a + f * ah2]; });
    })() : null;
    const piecesH = transposable(n, 'h') ? (() => {
      const fr = n.kids[0].colF, aw2 = w - (fr.length - 1) * WALL; let q = x;
      return fr.map(f => { const a = q; q += f * aw2 + WALL; return [a, a + f * aw2]; });
    })() : null;
    for (let i = 0; i < nc - 1; i++) divs.push({ n, axis: 'v', i, x: cx[i] + cw[i], y, w: WALL, h, avail: aw, pieces: piecesV, size: [cw[i], cw[i + 1]] });
    for (let j = 0; j < nr - 1; j++) divs.push({ n, axis: 'h', i: j, x, y: ry[j] + rh[j], w, h: WALL, avail: ah, pieces: piecesH, size: [rh[j], rh[j + 1]] });
    n.kids.forEach((k, idx) => walk(k, cx[idx % nc], ry[Math.floor(idx / nc)], cw[idx % nc], rh[Math.floor(idx / nc)]));
  })(root, WALL, WALL, W - 2 * WALL, L - 2 * WALL);
  return { cells, divs, regions };
}

function currentLayout() {
  const { W, L } = drawerSize();
  return layoutTree(state.root, W, L);
}

const dividerLength = d => (d.axis === 'v' ? d.h : d.w);

// Segments that sit on the same line and touch end to end (across a crossing divider)
// are one physical piece, however the layout was built. Used for price, cut list and export.
function physicalDividers(divs) {
    const out = [];
  for (const axis of ['v', 'h']) {
    const segs = divs.filter(d => d.axis === axis).map(d => axis === 'v'
      ? { axis, pos: d.x, start: d.y, end: d.y + d.h }
      : { axis, pos: d.y, start: d.x, end: d.x + d.w });
    segs.sort((a, b) => a.pos - b.pos || a.start - b.start);
    let cur = null;
    for (const s of segs) {
      if (cur && Math.abs(s.pos - cur.pos) < EPS && s.start <= cur.end + WALL + EPS) cur.end = Math.max(cur.end, s.end);
      else { if (cur) out.push(cur); cur = { ...s }; }
    }
    if (cur) out.push(cur);
  }
  return out.map(s => ({ axis: s.axis, pos: s.pos, start: s.start, length: s.end - s.start }));
}

function priceFor(W, L, H, N, DA) {
  const h = H - WALL, S = h > 0 ? DA / h : 0;
  const area = W * L + 2 * h * (L + W - 2 * WALL) + DA;                       // every part that gets cut
  const cut = 6 * (W + L) - 8 * WALL + 8 * h + 2 * S + 2 * N * h;              // laser cutting length
  const top = 2 * (L + W - 2 * WALL) + S;                                      // top edges to flame polish
  const cost = PRICE.area * area + PRICE.cut * cut + PRICE.top * top + PRICE.part * (4 + N) + PRICE.pack * (W + 2) * (L + 2) + PRICE.fixed;
  return Math.max(PRICE.minimum, PRICE.k * cost);
}
function priceBreakdown() {
  const zero = { drawer: 0, dividerCost: 0, dividers: 0, dividerArea: 0, total: 0 };
  if (!state.dims) return zero;
  const { W, L, H, partH } = drawerSize();
  const divs = physicalDividers(currentLayout().divs);
  const dividerArea = Math.round(divs.reduce((s, d) => s + d.length * partH, 0) * 100) / 100;   // the value the order form receives
  const total = priceFor(W, L, H, divs.length, dividerArea);
  const drawer = Math.min(total, priceFor(W, L, H, 0, 0));                    // the empty insert; the dividers account for the rest
  return { drawer, dividerCost: total - drawer, dividers: divs.length, dividerArea, total };
}
const estimatePrice = () => priceBreakdown().total;

/* ---------- history / persistence ---------- */
const snapshot = () => JSON.stringify({ root: state.root, eq: state.eq });
function loadSnapshot(text) {
  const s = JSON.parse(text);
  state.root = s.root;
  state.eq = s.eq || [];
}
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ dims: state.dims, drawer: state.drawer, gap: state.gap, root: state.root, eq: state.eq })); } catch (e) { /* storage unavailable */ }
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && saved.dims && saved.root) {
      state.dims = saved.dims;
      state.gap = Number.isInteger(saved.gap) && GAPS.includes(saved.gap) ? saved.gap : 0;       // older saves were sizes of the insert itself: no gap
      state.drawer = saved.drawer || { w: saved.dims.w + 2 * state.gap, l: saved.dims.l + 2 * state.gap, h: saved.dims.h + state.gap };
      state.root = saved.root;
      state.eq = Array.isArray(saved.eq) ? saved.eq : [];
      nextId = maxId(state.root) + 1;
      return true;
    }
  } catch (e) { /* ignore corrupt data */ }
  return false;
}
function resetHistory() {
  hist.stack = [snapshot()];
  hist.i = 0;
}
function commit() {
  hist.stack = hist.stack.slice(0, hist.i + 1);
  hist.stack.push(snapshot());
  hist.i++;
  persist();
  refresh();
}
function undo() {
  if (hist.i <= 0) return;
  hist.i--;
  loadSnapshot(hist.stack[hist.i]);
  pendingNum = null;
  reconcileLinks(true);
  closePopover(); persist(); refresh();
}
function redo() {
  if (hist.i >= hist.stack.length - 1) return;
  hist.i++;
  loadSnapshot(hist.stack[hist.i]);
  pendingNum = null;
  reconcileLinks(true);
  closePopover(); persist(); refresh();
}

/* ---------- equal-size links ----------
 * Two numbers in different spaces can be linked so they stay equal. Every space (and every region
 * a split creates) has a width and a length; the layout adds sum equations (a row of spaces plus the
 * dividers between them add up to the region they sit in) and each link adds "this = that".
 * The solver finds the sizes that satisfy all of them while changing the current sizes as little as
 * possible (changes are proportional to size, which matches how an unlinked layout scales). */
const numKey = (id, dim) => `${id}:${dim}`;
const numId = key => +key.split(':')[0];
const numDim = key => key.split(':')[1];
let pendingNum = null;             // the first number picked while linking

function eqGroups(eq = state.eq) {
  const parent = new Map();
  const find = k => { while (parent.get(k) !== k) k = parent.get(k); return k; };
  for (const { a, b } of eq) { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); parent.set(find(a), find(b)); }
  const roots = [], members = new Map(), groupOf = new Map();
  for (const k of parent.keys()) {
    const r = find(k);
    if (!members.has(r)) { members.set(r, []); roots.push(r); }
    members.get(r).push(k);
  }
  roots.forEach((r, gi) => members.get(r).forEach(k => groupOf.set(k, gi)));
  return { groupOf, groups: roots.map(r => members.get(r)) };
}

function dropLinksFor(ids) {
  const gone = new Set(ids);
  state.eq = state.eq.filter(({ a, b }) => !gone.has(numId(a)) && !gone.has(numId(b)));
}

function buildProblem(root, regions) {
  const ids = [];
  (function walk(n) { ids.push(n.id); if (n.kids) n.kids.forEach(walk); })(root);
  const index = new Map(ids.map((id, k) => [id, k]));
  const Wv = id => 2 * index.get(id), Lv = id => 2 * index.get(id) + 1;
  const x0 = new Array(ids.length * 2);
  ids.forEach(id => { x0[Wv(id)] = regions.get(id).w; x0[Lv(id)] = regions.get(id).h; });
  const rows = [
    { t: [[Wv(root.id), 1]], b: x0[Wv(root.id)] },       // the outer region is fixed by the drawer
    { t: [[Lv(root.id), 1]], b: x0[Lv(root.id)] },
  ];
  (function walk(n) {
    if (!n.kids) return;
    const nc = n.colF.length, nr = n.rowF.length, kid = (r, c) => n.kids[r * nc + c];
    for (let c = 0; c < nc; c++) for (let r = 1; r < nr; r++) rows.push({ t: [[Wv(kid(r, c).id), 1], [Wv(kid(0, c).id), -1]], b: 0 });
    for (let r = 0; r < nr; r++) for (let c = 1; c < nc; c++) rows.push({ t: [[Lv(kid(r, c).id), 1], [Lv(kid(r, 0).id), -1]], b: 0 });
    rows.push({ t: [...Array.from({ length: nc }, (_, c) => [Wv(kid(0, c).id), 1]), [Wv(n.id), -1]], b: -(nc - 1) * WALL });
    rows.push({ t: [...Array.from({ length: nr }, (_, r) => [Lv(kid(r, 0).id), 1]), [Lv(n.id), -1]], b: -(nr - 1) * WALL });
    n.kids.forEach(walk);
  })(root);
  return { ids, index, Wv, Lv, x0, rows };
}

const varOf = (prob, key) => (prob.index.has(numId(key)) ? (numDim(key) === 'w' ? prob.Wv(numId(key)) : prob.Lv(numId(key))) : -1);

// Weighted least-change solution of A x = b. `heavy` variables resist change (1e6 times as strongly).
function projectConstraints(prob, extra, heavy) {
  const rows = prob.rows.concat(extra), n = prob.x0.length, m = rows.length;
  const winv = prob.x0.map((v, i) => (heavy && heavy.has(i) ? 1e-6 : 1) * Math.max(v, 0.01));
  const r = rows.map(row => row.b - row.t.reduce((s, [i, c]) => s + c * prob.x0[i], 0));
  const byVar = Array.from({ length: n }, () => []);
  rows.forEach((row, ri) => row.t.forEach(([i, c]) => byVar[i].push([ri, c])));
  const M = Array.from({ length: m }, () => new Float64Array(m + 1));
  byVar.forEach((list, i) => { for (const [a, ca] of list) for (const [b, cb] of list) M[a][b] += ca * cb * winv[i]; });
  for (let k = 0; k < m; k++) M[k][m] = r[k];
  let maxDiag = 0;
  for (let k = 0; k < m; k++) maxDiag = Math.max(maxDiag, M[k][k]);
  // Gauss-Jordan with partial pivoting; dependent (redundant) equations are skipped
  const pivotCol = [];
  let rank = 0;
  for (let col = 0; col < m && rank < m; col++) {
    let best = rank;
    for (let k = rank + 1; k < m; k++) if (Math.abs(M[k][col]) > Math.abs(M[best][col])) best = k;
    if (Math.abs(M[best][col]) <= 1e-13 * Math.max(1, maxDiag)) continue;
    [M[rank], M[best]] = [M[best], M[rank]];
    const pv = M[rank][col];
    for (let c = col; c <= m; c++) M[rank][c] /= pv;
    for (let k = 0; k < m; k++) {
      if (k === rank) continue;
      const f = M[k][col];
      if (f !== 0) for (let c = col; c <= m; c++) M[k][c] -= f * M[rank][c];
    }
    pivotCol.push(col);
    rank++;
  }
  const lambda = new Float64Array(m);
  pivotCol.forEach((col, k) => { lambda[col] = M[k][m]; });
  const x = prob.x0.slice();
  byVar.forEach((list, i) => { let d = 0; for (const [ri, c] of list) d += c * lambda[ri]; x[i] += winv[i] * d; });
  const residual = rows.reduce((mx, row) => Math.max(mx, Math.abs(row.t.reduce((s, [i, c]) => s + c * x[i], 0) - row.b)), 0);
  const smallest = Math.min(...x);
  return { ok: residual < 1e-6 && smallest >= MIN_CELL - 1e-6, x, residual };
}

function linkRows(prob, eq) {
  const rows = [];
  for (const { a, b } of eq) {
    const ia = varOf(prob, a), ib = varOf(prob, b);
    if (ia >= 0 && ib >= 0 && ia !== ib) rows.push({ t: [[ia, 1], [ib, -1]], b: 0 });
  }
  return rows;
}

// Write solved sizes back as fractions.
function applySolution(prob, x) {
  (function walk(n) {
    if (!n.kids) return;
    const nc = n.colF.length, nr = n.rowF.length, kid = (r, c) => n.kids[r * nc + c];
    const cols = Array.from({ length: nc }, (_, c) => x[prob.Wv(kid(0, c).id)]);
    const rowsz = Array.from({ length: nr }, (_, r) => x[prob.Lv(kid(r, 0).id)]);
    const sc = cols.reduce((s, v) => s + v, 0), sr = rowsz.reduce((s, v) => s + v, 0);
    n.colF = cols.map(v => v / sc);
    n.rowF = rowsz.map(v => v / sr);
    n.kids.forEach(walk);
  })(state.root);
}

// Variables of a space and everything inside it (they scale together with it).
function subtreeVars(prob, nodeId) {
  const set = new Set();
  const add = nd => { set.add(prob.Wv(nd.id)); set.add(prob.Lv(nd.id)); if (nd.kids) nd.kids.forEach(add); };
  const root = findNode(state.root, nodeId);
  if (root) add(root);
  return set;
}

// Solve the current layout against a set of links (and optionally one pinned size, for dragging).
function solveLinks(eq, { pin = null, freeVars = null } = {}) {
  const { W, L } = drawerSize();
  const { regions } = layoutTree(state.root, W, L);
  const prob = buildProblem(state.root, regions);
  const extra = linkRows(prob, eq);
  if (pin) extra.push({ t: [[pin.v(prob), 1]], b: pin.value });
  const heavy = freeVars ? new Set(Array.from({ length: prob.x0.length }, (_, i) => i).filter(i => !freeVars(prob).has(i))) : null;
  return { prob, ...projectConstraints(prob, extra, heavy) };
}

/* ---------- rendering ---------- */
const PAD = { top: 58, right: 30, bottom: 54, left: 66 };

function renderDrawer(svg, { interactive }) {
  if (!state.dims) { svg.replaceChildren(); return; }
  const box = svg.getBoundingClientRect();
  const bw = Math.max(box.width, 50), bh = Math.max(box.height, 50);
  svg.setAttribute('viewBox', `0 0 ${bw} ${bh}`);
  svg.classList.toggle('is-static', !interactive);

  const { W, L } = drawerSize();
  const pad = interactive ? PAD : { top: 44, right: 16, bottom: 44, left: 44 };
  const s = Math.max(0.01, Math.min((bw - pad.left - pad.right) / W, (bh - pad.top - pad.bottom) / L));
  const dw = W * s, dl = L * s;
  const ox = pad.left + (bw - pad.left - pad.right - dw) / 2;
  const oy = pad.top + (bh - pad.top - pad.bottom - dl) / 2;
  svg._view = { ox, oy, s };

  const { cells, divs } = layoutTree(state.root, W, L);
  const out = [];
  const line = (x1, y1, x2, y2) => `<line class="dimline" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  const slash = (x, y) => line(x - 4, y + 4, x + 4, y - 4);          // architectural end mark

  // overall dimensions: extension lines, dimension line with slash ends, figure in mono type
  const ay = oy - 22, ax = ox - 24;
  out.push(line(ox, oy - 4, ox, ay - 5), line(ox + dw, oy - 4, ox + dw, ay - 5), line(ox, ay, ox + dw, ay), slash(ox, ay), slash(ox + dw, ay));
  out.push(`<text class="dim-text" x="${ox + dw / 2}" y="${ay - 8}" text-anchor="middle">${fmtEighths(state.dims.w)}″</text>`);
  out.push(line(ox - 4, oy, ax - 5, oy), line(ox - 4, oy + dl, ax - 5, oy + dl), line(ax, oy, ax, oy + dl), slash(ax, oy), slash(ax, oy + dl));
  out.push(`<text class="dim-text" transform="translate(${ax - 9} ${oy + dl / 2}) rotate(-90)" text-anchor="middle">${fmtEighths(state.dims.l)}″</text>`);

  // sheet stock: walls and dividers show as the gaps between the open spaces
  out.push(`<rect class="wall" x="${ox}" y="${oy}" width="${dw}" height="${dl}"/>`);
  for (const c of cells) {
    out.push(`<rect class="cell" data-cell="${c.n.id}" x="${ox + c.x * s}" y="${oy + c.y * s}" width="${c.w * s}" height="${c.h * s}"/>`);
  }
  out.push(`<rect class="outline" x="${ox}" y="${oy}" width="${dw}" height="${dl}"/>`);

  // size of each space. Each number is its own target: select one, then another, to link them as equal.
  const { groupOf } = eqGroups();
  const numEl = (key, text, x, y, anchor, size) => {
    const tw = text.length * 0.6 * size, x0 = anchor === 'middle' ? x - tw / 2 : x, pad = Math.max(3, size * 0.3);
    const gi = groupOf.get(key), chosen = pendingNum === key;
    let chip = '';
    if (gi !== undefined) {
      chip = `<rect class="num-chip g${gi % 4}" x="${x0 - pad}" y="${y - size * 0.7 - pad / 2}" width="${tw + 2 * pad}" height="${size * 1.4 + pad}" rx="3" pointer-events="none"/>`
        + `<g class="num-lock g${gi % 4}" pointer-events="none"><rect x="${x0 + tw + pad - 9}" y="${y - size * 0.7 - pad / 2 - 4}" width="11" height="9" rx="1.6"/><path d="M${x0 + tw + pad - 6.5} ${y - size * 0.7 - pad / 2 - 4}v-2.6a3 3 0 0 1 6 0v2.6"/></g>`;
    }
    const tip = gi !== undefined ? 'Linked: stays equal to its partner. Select to unlock.' : (pendingNum ? 'Select to make this equal to the number you picked.' : 'Select, then pick a number in another space to make them equal.');
    return `${chip}<rect class="num-hit${chosen ? ' sel' : ''}" data-num="${key}" x="${x0 - pad}" y="${y - size * 0.7 - pad / 2}" width="${tw + 2 * pad}" height="${size * 1.4 + pad}" rx="3"><title>${tip}</title></rect>`
      + `<text class="cell-label" x="${x0}" y="${y}" font-size="${size}" dominant-baseline="central">${text}</text>`;
  };
  for (const c of cells) {
    const wpx = c.w * s, hpx = c.h * s;
    const a = fmt2(c.w) + '″', b = fmt2(c.h) + '″';
    const cx = ox + (c.x + c.w / 2) * s, cy = oy + (c.y + c.h / 2) * s;
    const kw = numKey(c.n.id, 'w'), kl = numKey(c.n.id, 'l');
    let fs = Math.min(16, (wpx - 12) / 8.6);
    if (fs >= 10.5 && hpx > 24) {
      const cw = 0.6 * fs, wW = a.length * cw, wL = b.length * cw, gap = fs * 0.85, x0 = cx - (wW + 2 * gap + wL) / 2;
      out.push(numEl(kw, a, x0, cy, 'start', fs));
      out.push(`<text class="cell-label" x="${x0 + wW + gap}" y="${cy}" font-size="${fs}" text-anchor="middle" dominant-baseline="central">×</text>`);
      out.push(numEl(kl, b, x0 + wW + 2 * gap, cy, 'start', fs));
    } else {
      fs = Math.min(14, (wpx - 6) / 3.4, (hpx - 6) / 3.2);
      if (fs >= 5.5) {
        out.push(numEl(kw, a, cx, cy - fs * 0.75, 'middle', fs));
        out.push(numEl(kl, b, cx, cy + fs * 0.75, 'middle', fs));
      }
    }
  }

  if (interactive) {
    // grab areas for dividers (one per piece when the line sits on a grid)
    for (const d of divs) {
      const thick = Math.max(WALL * s, 14);
      const spans = d.pieces || [d.axis === 'v' ? [d.y, d.y + d.h] : [d.x, d.x + d.w]];
      spans.forEach((sp, pi) => {
        let x, y, w, h;
        if (d.axis === 'v') { x = ox + (d.x + WALL / 2) * s - thick / 2; w = thick; y = oy + sp[0] * s; h = (sp[1] - sp[0]) * s; }
        else { y = oy + (d.y + WALL / 2) * s - thick / 2; h = thick; x = ox + sp[0] * s; w = (sp[1] - sp[0]) * s; }
        const piece = d.pieces ? ` data-piece="${pi}"` : '';
        const key = `${d.n.id}:${d.axis}:${d.i}${d.pieces ? ':' + pi : ''}`;
        const active = drag && drag.key === key ? ' active' : '';
        out.push(`<rect class="hit${active}" data-hit="1" data-key="${key}" data-node="${d.n.id}" data-axis="${d.axis}" data-i="${d.i}"${piece} x="${x}" y="${y}" width="${w}" height="${h}" rx="2"><title>Drag to move. Select to see its sizes or delete it.</title></rect>`);
      });
    }
    // front edge: a bracket under the drawer with its name in the middle
    const fy = oy + dl + 20, fx = ox + dw / 2;
    out.push(line(ox, fy, fx - 96, fy), line(fx + 96, fy, ox + dw, fy), line(ox, fy - 6, ox, fy + 6), line(ox + dw, fy - 6, ox + dw, fy + 6));
    out.push(`<text class="front-text" x="${fx}" y="${fy + 4}" text-anchor="middle">Front of drawer</text>`);
  }

  // empty drawer: invite the first division
  if (interactive && !state.root.kids && cells[0]) {
    const c = cells[0];
    const cx = ox + (c.x + c.w / 2) * s, cy = oy + (c.y + c.h / 2) * s;
    const hy = cy + 52;                                        // below the size label
    out.push(`<circle class="hint-ring" cx="${cx}" cy="${hy}" r="18"/>`);
    out.push(`<path class="hint-plus" d="M${cx - 7} ${hy}h14M${cx} ${hy - 7}v14"/>`);
    out.push(`<text class="hint-text" x="${cx}" y="${hy + 42}" text-anchor="middle">Select this space to divide it</text>`);
  }

  svg.innerHTML = out.join('');
}

/* ---------- editor interactions ---------- */
const canvas = $('#canvas');
let drag = null;       // active divider drag
let press = null;      // pending cell click
let popoverCell = null;

function findNode(n, id) {
  if (n.id === id) return n;
  if (n.kids) for (const k of n.kids) { const r = findNode(k, id); if (r) return r; }
  return null;
}

let numPress = null;      // a pending click on a number

canvas.addEventListener('pointerdown', e => {
  const num = e.target.closest('[data-num]');
  if (num) {
    closePopover();
    numPress = { key: num.dataset.num, x: e.clientX, y: e.clientY };
    press = null;
    return;
  }
  const hit = e.target.closest('[data-hit]');
  if (hit) {
    closePopover();
    const before = snapshot();
    let n = findNode(state.root, +hit.dataset.node);
    const axis = hit.dataset.axis, i = +hit.dataset.i;
    const piece = hit.dataset.piece === undefined ? null : +hit.dataset.piece;
    const nodeId = n.id;
    let key = hit.dataset.key;
    if (piece !== null) {                       // grab one piece of a grid line: rebuild the grid so that piece is independent
      transposeAt(n, axis);
      n = n.kids[piece];
      key = `${n.id}:${axis}:${i}`;
    }
    const f = axis === 'v' ? n.colF : n.rowF;
    const { divs } = currentLayout();
    const d = divs.find(x => x.n === n && x.axis === axis && x.i === i);
    // positions of other segments on the same axis that touch this one, for snap-to-align
    const span = axis === 'v' ? [d.y, d.y + d.h] : [d.x, d.x + d.w];
    const cands = divs.filter(o => o !== d && o.axis === axis).filter(o => {
      const os = axis === 'v' ? [o.y, o.y + o.h] : [o.x, o.x + o.w];
      return os[0] <= span[1] + WALL + EPS && os[1] >= span[0] - WALL - EPS;
    }).map(o => (axis === 'v' ? o.x : o.y));
    drag = {
      key, n, axis, i, f, avail: d.avail, pos0: axis === 'v' ? d.x : d.y, cands,
      start: axis === 'v' ? e.clientX : e.clientY,
      f0: f[i], pair: f[i] + f[i + 1], before, moved: false,
      info: { nodeId, axis, i, piece, size: d.size },
    };
    canvas.setPointerCapture(e.pointerId);
    renderDrawer(canvas, { interactive: true });
    e.preventDefault();
    return;
  }
  const cell = e.target.closest('[data-cell]');
  press = cell ? { id: +cell.dataset.cell, x: e.clientX, y: e.clientY } : null;
  if (!cell) { closePopover(); if (pendingNum) { pendingNum = null; refresh(); } }
});

// Move the dragged divider to `target` (the size of the space before it) while every equal-size link holds.
// If the links make that impossible the divider stops at the nearest position that works.
function dragWithLinks(target) {
  const n = drag.n, axis = drag.axis, i = drag.i;
  const nc = n.colF.length, nr = n.rowF.length;
  const head = axis === 'v' ? n.kids[i] : n.kids[i * nc];
  const pin = { v: prob => (axis === 'v' ? prob.Wv(head.id) : prob.Lv(head.id)), value: 0 };
  const freeVars = prob => {                    // the two spaces beside the divider (and anything inside them) may change
    const set = new Set();
    const add = nd => { set.add(prob.Wv(nd.id)); set.add(prob.Lv(nd.id)); if (nd.kids) nd.kids.forEach(add); };
    const lines = axis === 'v' ? [i, i + 1] : [i, i + 1];
    for (const line of lines) for (let k = 0; k < (axis === 'v' ? nr : nc); k++) add(axis === 'v' ? n.kids[k * nc + line] : n.kids[line * nc + k]);
    return set;
  };
  const attempt = value => solveLinks(state.eq, { pin: { v: pin.v, value }, freeVars });
  const current = drag.f[i] * drag.avail;
  let res = attempt(target);
  if (!res.ok) {                                // find the furthest position that still works
    let good = current, bad = target, best = null;
    for (let k = 0; k < 14; k++) {
      const mid = (good + bad) / 2, r = attempt(mid);
      if (r.ok) { good = mid; best = r; } else bad = mid;
    }
    res = best;
  }
  if (res) { applySolution(res.prob, res.x); drag.moved = true; }
}

canvas.addEventListener('pointermove', e => {
  if (!drag) return;
  const { s } = canvas._view;
  const cur = drag.axis === 'v' ? e.clientX : e.clientY;
  const deltaIn = (cur - drag.start) / s;
  const pairIn = drag.pair * drag.avail;
  const base = drag.f0 * drag.avail;
  let a = Math.round((base + deltaIn) / SNAP) * SNAP;
  const near = drag.cands.map(c => c - drag.pos0).reduce((best, t) => (Math.abs(base + t - a) < Math.abs(best - a) ? base + t : best), Infinity);
  if (Math.abs(near - a) < 8 / s) a = near;
  if (pairIn < 2 * MIN_CELL) return;
  a = clamp(a, MIN_CELL, pairIn - MIN_CELL);
  if (state.eq.length) dragWithLinks(a);
  else {
    drag.moved = true;
    drag.f[drag.i] = a / drag.avail;
    drag.f[drag.i + 1] = (pairIn - a) / drag.avail;
  }
  renderDrawer(canvas, { interactive: true });
});

function endDrag(e) {
  if (!drag) return;
  const d = drag;
  const changed = d.moved && snapshot() !== d.before;
  if (!changed) loadSnapshot(d.before);              // a plain click leaves the layout untouched
  drag = null;
  if (changed) commit();
  else {
    refresh();
    if (!d.moved && e) openDividerPopover(d.info, e.clientX, e.clientY);   // a click on a divider: its sizes, and delete
  }
}
canvas.addEventListener('pointerup', e => {
  if (numPress) {
    const np = numPress; numPress = null;
    if (Math.hypot(e.clientX - np.x, e.clientY - np.y) < 6) onNumberClick(np.key, e.clientX, e.clientY);
    return;
  }
  if (drag) { endDrag(e); return; }
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) openPopover(press.id, e.clientX, e.clientY);
  press = null;
});
canvas.addEventListener('pointercancel', () => { numPress = null; if (drag) { endDrag(); } press = null; });

/* ---------- notes shown over the plan ---------- */
let transientNote = null, noteTimer = null;
function showNote(text, kind = 'warn', ms = 4500) {
  transientNote = { text, kind };
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { transientNote = null; updateNote(); }, ms);
  updateNote();
}
function updateNote() {
  const el = $('#note-bar');
  const msg = transientNote || (pendingNum ? { text: 'Now select the number it should match. Esc cancels.', kind: 'pending' } : null);
  el.hidden = !msg;
  if (msg) { el.textContent = msg.text; el.className = 'note-bar ' + msg.kind; }
}

/* ---------- linking two numbers ---------- */
function onNumberClick(key, px, py) {
  const { groupOf } = eqGroups();
  if (pendingNum) {
    if (pendingNum === key) { pendingNum = null; refresh(); return; }
    if (numId(pendingNum) === numId(key)) { showNote('Pick a number in a different space.'); return; }
    if (groupOf.has(key) && groupOf.get(key) === groupOf.get(pendingNum)) { pendingNum = null; showNote('Those two are already linked.'); refresh(); return; }
    const trial = [...state.eq, { a: pendingNum, b: key }];
    // only the two spaces being linked are meant to change; other spaces move only if the sums force them to
    const res = solveLinks(trial, { freeVars: prob => new Set([...subtreeVars(prob, numId(pendingNum)), ...subtreeVars(prob, numId(key))]) });
    pendingNum = null;
    if (!res.ok) { showNote("Those can't be made equal with the layout as it is. Move or unlock something first.", 'warn', 6000); refresh(); return; }
    applySolution(res.prob, res.x);
    state.eq = trial;
    transientNote = null; updateNote();
    commit();
    return;
  }
  if (groupOf.has(key)) { openNumberPopover(key, px, py); return; }
  pendingNum = key;
  refresh();
}

let numberKey = null;
function openNumberPopover(key, px, py) {
  $('#popover').hidden = true; $('#divpop').hidden = true; popoverCell = null; dividerInfo = null;
  numberKey = key;
  const { groups, groupOf } = eqGroups();
  const others = groups[groupOf.get(key)].length - 1;
  $('#numpop-note').textContent = `This number stays equal to ${others} other ${others === 1 ? 'number' : 'numbers'}.`;
  placePopover($('#numpop'), px, py);
}
$('#numpop-link').addEventListener('click', () => { const k = numberKey; closePopover(); pendingNum = k; refresh(); });
$('#numpop-unlock').addEventListener('click', () => {
  const key = numberKey;
  const { groups, groupOf } = eqGroups();
  const group = groups[groupOf.get(key)];
  const rest = group.filter(k => k !== key);
  state.eq = state.eq.filter(({ a, b }) => !group.includes(a) && !group.includes(b));
  for (let k = 0; k + 1 < rest.length; k++) state.eq.push({ a: rest[k], b: rest[k + 1] });     // the others stay linked together
  closePopover();
  commit();
});
$('#numpop-close').addEventListener('click', () => closePopover());

// After undo, redo or a change of drawer size, make sure the links still hold (or release them).
function reconcileLinks(announce) {
  if (!state.eq.length) return;
  const res = solveLinks(state.eq);
  if (res.ok) applySolution(res.prob, res.x);
  else { state.eq = []; if (announce) showNote('The equal-size links could not be kept at this size, so they were released.', 'warn', 6000); }
}

/* ---------- delete a divider ---------- */
// The two spaces either side of divider i. A divider can span several rows (or columns), so there is one pair per row.
function pairsAcross(n, axis, i) {
  const nc = n.colF.length, nr = n.rowF.length;
  return axis === 'v'
    ? Array.from({ length: nr }, (_, r) => [r * nc + i, r * nc + i + 1])
    : Array.from({ length: nc }, (_, c) => [i * nc + c, (i + 1) * nc + c]);
}

// Why a divider cannot be deleted, or null when it can. Only undivided spaces can be merged.
function deleteBlocker(info) {
  const n = findNode(state.root, info.nodeId);
  if (!n) return 'This divider is no longer there.';
  const pairs = info.piece !== null
    ? [[n.kids[info.i].kids && n.kids[info.i].kids[info.piece], n.kids[info.i + 1].kids && n.kids[info.i + 1].kids[info.piece]]]
    : pairsAcross(n, info.axis, info.i).map(([a, b]) => [n.kids[a], n.kids[b]]);
  const open = pairs.every(([a, b]) => a && b && !a.kids && !b.kids);
  return open ? null : 'Both spaces beside it must be undivided. Delete the dividers inside them first.';
}

// Merge the spaces either side of divider i. Every other space keeps its size; the merged space also takes
// the width of the divider that was removed.
function mergeAcross(n, axis, i) {
  const pairs = pairsAcross(n, axis, i);
  if (!pairs.every(([a, b]) => !n.kids[a].kids && !n.kids[b].kids)) return false;
  const d = currentLayout().divs.find(x => x.n === n && x.axis === axis && x.i === i);
  const F = axis === 'v' ? n.colF : n.rowF;
  const sizes = F.map(f => f * d.avail);
  const merged = [...sizes.slice(0, i), sizes[i] + sizes[i + 1] + WALL, ...sizes.slice(i + 2)];
  const avail = d.avail + WALL;
  dropLinksFor(pairs.flatMap(([a, b]) => [n.kids[a].id, n.kids[b].id]));       // the merged space is a new size: release its links
  const drop = new Set(pairs.map(([, b]) => b));
  n.kids = n.kids.filter((_, idx) => !drop.has(idx));
  const frac = merged.map(s => s / avail);
  if (axis === 'v') n.colF = frac; else n.rowF = frac;
  if (n.colF.length === 1 && n.rowF.length === 1) {       // nothing left to divide: this is a single space again
    delete n.kids; delete n.colF; delete n.rowF;
  }
  return true;
}

function deleteDivider(info) {
  let n = findNode(state.root, info.nodeId);
  if (!n || deleteBlocker(info)) return;
  if (info.piece !== null) { transposeAt(n, info.axis); n = n.kids[info.piece]; }
  if (!mergeAcross(n, info.axis, info.i)) return;
  closePopover();
  commit();
}

/* ---------- divider panel ---------- */
let dividerInfo = null;

function placePopover(pop, px, py) {
  pop.hidden = false;
  const box = $('#stage').getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = clamp(px - box.left - w / 2, 8, box.width - w - 8) + 'px';
  pop.style.top = clamp(py - box.top + 12, 8, box.height - h - 8) + 'px';
}

function openDividerPopover(info, px, py) {
  $('#popover').hidden = true; $('#numpop').hidden = true; popoverCell = null; numberKey = null;
  dividerInfo = info;
  const wide = info.axis === 'v';
  const [s1, s2] = info.size;
  $('#divpop-sizes').textContent = `${wide ? 'Left' : 'Back'} ${fmt2(s1)}″ · ${wide ? 'Right' : 'Front'} ${fmt2(s2)}″`;
  const blocker = deleteBlocker(info);
  $('#divpop-delete').disabled = !!blocker;
  $('#divpop-delnote').textContent = blocker || 'Deleting merges the two spaces into one.';
  placePopover($('#divpop'), px, py);
}
$('#divpop-delete').addEventListener('click', () => { if (dividerInfo) deleteDivider(dividerInfo); });
$('#divpop-close').addEventListener('click', () => closePopover());

/* ---------- split popover ---------- */
const SPLITS = [
  { nc: 2, nr: 1, label: '2 columns', icon: '<line x1="17" y1="2" x2="17" y2="22"/>' },
  { nc: 3, nr: 1, label: '3 columns', icon: '<line x1="11.5" y1="2" x2="11.5" y2="22"/><line x1="22.5" y1="2" x2="22.5" y2="22"/>' },
  { nc: 1, nr: 2, label: '2 rows', icon: '<line x1="2" y1="12" x2="32" y2="12"/>' },
  { nc: 1, nr: 3, label: '3 rows', icon: '<line x1="2" y1="9" x2="32" y2="9"/><line x1="2" y1="15" x2="32" y2="15"/>' },
];

function openPopover(cellId, px, py) {
  const { cells } = currentLayout();
  const cell = cells.find(c => c.n.id === cellId);
  if (!cell) return;
  $('#divpop').hidden = true; $('#numpop').hidden = true; dividerInfo = null; numberKey = null;
  popoverCell = cell.n;
  const grid = $('#pop-grid');
  grid.innerHTML = '';
  for (const sp of SPLITS) {
    const ok = (cell.w - (sp.nc - 1) * WALL) / sp.nc >= MIN_CELL && (cell.h - (sp.nr - 1) * WALL) / sp.nr >= MIN_CELL;
    const b = document.createElement('button');
    b.type = 'button';
    b.disabled = !ok;
    b.title = ok ? `Divide into ${sp.label}` : 'This space is too small to divide that way';
    b.setAttribute('aria-label', sp.label);
    b.innerHTML = `<svg viewBox="0 0 34 24" aria-hidden="true"><rect x="2" y="2" width="30" height="20"/>${sp.icon}</svg><span>${sp.label}</span>`;
    b.addEventListener('click', () => applySplit(sp));
    grid.appendChild(b);
  }
  const pop = $('#popover');
  pop.hidden = false;
  const lab = $('#stage').getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = clamp(px - lab.left - w / 2, 8, lab.width - w - 8) + 'px';
  pop.style.top = clamp(py - lab.top + 12, 8, lab.height - h - 8) + 'px';
}
function closePopover() { $('#popover').hidden = true; $('#divpop').hidden = true; $('#numpop').hidden = true; popoverCell = null; dividerInfo = null; numberKey = null; }

function applySplit(sp) {
  const n = popoverCell;
  if (!n) return;
  n.colF = Array(sp.nc).fill(1 / sp.nc);
  n.rowF = Array(sp.nr).fill(1 / sp.nr);
  const hadLinks = state.eq.some(({ a, b }) => numId(a) === n.id || numId(b) === n.id);
  dropLinksFor([n.id]);
  n.kids = Array.from({ length: sp.nc * sp.nr }, newLeaf);
  closePopover();
  commit();
  if (hadLinks) showNote('Dividing this space released its equal-size links.', 'info');
}
$('#pop-cancel').addEventListener('click', closePopover);

/* ---------- UI wiring ---------- */
function refresh() {
  const pb = priceBreakdown();
  const { cells } = currentLayout();
  const { partH } = drawerSize();
  const divided = pb.dividers > 0;
  $('#undo').disabled = hist.i <= 0;
  $('#redo').disabled = hist.i >= hist.stack.length - 1;
  $('#clear').disabled = isDefaultLayout();
  $('#price-total').textContent = fmtMoney(pb.total);
  $('#price-base').textContent = fmtMoney(pb.drawer);
  $('#price-material').textContent = fmtMoney(pb.dividerCost);
  $('#price-dividers-label').textContent = divided ? `Dividers (${pb.dividers})` : 'Dividers';
  $('#plan-price').textContent = fmtMoney(pb.total);
  $('#fb-price').textContent = fmtMoney(pb.total);
  $('#est-note').textContent = divided ? 'Updates as you divide and resize.' : 'Divide the drawer to add dividers, or use it as an empty tray.';
  $('#open-review').disabled = false;                 // an empty tray is a valid design
  $('#stock-thickness').textContent = `${WALL.toFixed(2)}″`;
  $('#stock-height').textContent = `${partH.toFixed(2)}″`;
  $('#stock-spaces').textContent = String(cells.length);
  $('#stock-dividers').textContent = String(pb.dividers);
  $('#plan-status').textContent = `${fmtEighths(state.dims.w)}″ × ${fmtEighths(state.dims.l)}″ × ${fmtEighths(state.dims.h)}″ · ${cells.length} ${cells.length === 1 ? 'space' : 'spaces'}`;
  renderDrawer(canvas, { interactive: true });
  updateNote();
}

function fillSelect(sel, from, to, value) {          // from, to, value in eighths of an inch
  sel.innerHTML = '';
  for (let n = from; n <= to; n++) {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = `${fmtEighths(n)}″`;
    sel.appendChild(o);
  }
  sel.value = value;
}
function showSizes() {                                // the three drawer boxes, the gap, and the resulting insert size
  const lim = drawerLimits();
  fillSelect($('#dim-w'), lim.w[0], lim.w[1], state.drawer.w);
  fillSelect($('#dim-l'), lim.l[0], lim.l[1], state.drawer.l);
  fillSelect($('#dim-h'), lim.h[0], lim.h[1], state.drawer.h);
  const gap = $('#dim-gap');
  if (!gap.options.length) for (const g of GAPS) gap.add(new Option(g ? `${fmtEighths(g)}″` : 'None', g));
  gap.value = state.gap;
  const d = state.dims;
  $('#insert-size').textContent = `${fmtEighths(d.w)}″ × ${fmtEighths(d.l)}″ × ${fmtEighths(d.h)}″`;
}
function sizesChanged() {
  pendingNum = null;
  syncInsert();
  showSizes();
  reconcileLinks(true);                              // resizing the insert re-solves the equal-size links
  closePopover();
  persist();
  refresh();
}
// Dividers are stored as fractions of the insert, so resizing scales the whole layout.
for (const id of ['#dim-w', '#dim-l', '#dim-h']) {
  $(id).addEventListener('change', () => {
    state.drawer = { w: +$('#dim-w').value, l: +$('#dim-l').value, h: +$('#dim-h').value };
    sizesChanged();
  });
}
$('#dim-gap').addEventListener('change', () => { state.gap = +$('#dim-gap').value; sizesChanged(); });

$('#undo').addEventListener('click', undo);
$('#redo').addEventListener('click', redo);
$('#clear').addEventListener('click', () => {
  if (isDefaultLayout()) return;
  state.root = newLeaf();
  state.eq = [];
  pendingNum = null;
  closePopover();
  commit();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!$('#review').hidden) $('#review').hidden = true;
    else if (pendingNum || transientNote) { pendingNum = null; transientNote = null; clearTimeout(noteTimer); refresh(); }
    else if (!$('#popover').hidden || !$('#divpop').hidden || !$('#numpop').hidden) closePopover();
    else if (document.body.classList.contains('editor-full')) setExpanded(false);
    else closePopover();
    return;
  }
  if (e.target && /^(SELECT|INPUT|TEXTAREA)$/.test(e.target.tagName)) return;      // leave form fields to the browser
  if (e.key === 'Delete' && dividerInfo && !$('#divpop-delete').disabled) { e.preventDefault(); deleteDivider(dividerInfo); return; }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
});

new ResizeObserver(() => renderDrawer(canvas, { interactive: true })).observe(canvas);

// The layout editor can fill the whole window for detailed work on a complicated layout.
function setExpanded(on) {
  document.body.classList.toggle('editor-full', on);
  const btn = $('#expand');
  btn.setAttribute('aria-pressed', String(on));
  btn.querySelector('span').textContent = on ? 'Exit full screen' : 'Expand editor';
  closePopover();
  if (typeof EMBED !== 'undefined' && EMBED) window.parent.postMessage({ type: 'drawer-insert-fullscreen', on }, '*');   // the store's pop-up grows too
  refresh();
}
$('#expand').addEventListener('click', () => setExpanded(!document.body.classList.contains('editor-full')));

/* ---------- review / export ---------- */
function labelFor(i) {
  let s = '';
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

const sortCells = cells => [...cells].sort((a, b) => (Math.abs(a.y - b.y) > 0.5 ? a.y - b.y : a.x - b.x));

/* ---------- to-scale drawing ---------- */
// Plan view built in paper millimetres: 1 unit = 1 mm on paper when printed at 100%.
// The SVG carries a physical width/height, so any viewer that honours it shows true scale.
function drawing() {
  const { W, L } = drawerSize();
  const { cells, divs } = currentLayout();
  const physical = physicalDividers(divs);
  const ratios = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 48];
  const M = { l: 26, r: 16, t: 24 };
  const ratio = ratios.find(r => (W * MM_PER_IN) / r + M.l + M.r <= 190.5 && (L * MM_PER_IN) / r + M.t <= 165) || ratios[ratios.length - 1];
  const k = MM_PER_IN / ratio;          // paper millimetres per inch of drawer
  const planW = W * k, planL = L * k;
  const pageW = Math.max(M.l + planW + M.r, 140);
  const ox = (pageW - planW) / 2 + (M.l - M.r) / 2, oy = M.t;
  const titleTop = oy + planL + 18, titleH = 44;
  const pageH = titleTop + titleH + 4;

  // The drawing is a list of simple shapes in paper millimetres, drawn as SVG and as PDF.
  const scene = [];
  const R = (x, y, w, h, o = {}) => scene.push({ k: 'rect', x, y, w, h, fill: o.fill || null, stroke: o.stroke || null, sw: o.sw || 0, rx: o.rx || 0 });
  const Ln = (x1, y1, x2, y2, sw = 0.25) => scene.push({ k: 'line', x1, y1, x2, y2, stroke: '#111', sw });
  const T = (x, y, s, size, o = {}) => scene.push({ k: 'text', x, y, s, size, anchor: o.anchor || 'start', bold: !!o.bold, fill: o.fill || '#000', rot: o.rot || 0, ls: o.ls || 0 });

  R(0, 0, pageW, pageH, { fill: '#fff' });
  R(ox, oy, planW, planL, { fill: '#c9c9c9', stroke: '#111', sw: 0.5 });
  const sorted = sortCells(cells);
  sorted.forEach((c, i) => {
    const x = ox + c.x * k, y = oy + c.y * k, w = c.w * k, h = c.h * k;
    R(x, y, w, h, { fill: '#fff', stroke: '#111', sw: 0.25 });
    const cx = x + w / 2, cy = y + h / 2;
    if (w >= 21 && h >= 12) {
      T(cx, cy - 0.6, labelFor(i), 4.6, { bold: true, anchor: 'middle' });
      T(cx, cy + 4.2, `${fmt2(c.w)} × ${fmt2(c.h)}`, 2.8, { anchor: 'middle', fill: '#333' });
    } else if (w >= 6 && h >= 6) {
      T(cx, cy + 1.5, labelFor(i), Math.min(4.6, w * 0.6, h * 0.6), { bold: true, anchor: 'middle' });
    }
  });

  // overall dimension lines (extension lines, dimension line, end ticks)
  const dimH = (x1, x2, y, label) => {
    Ln(x1, y - 1, x1, oy - 1); Ln(x2, y - 1, x2, oy - 1);
    Ln(x1, y, x2, y); Ln(x1 - 1, y + 1, x1 + 1, y - 1); Ln(x2 - 1, y + 1, x2 + 1, y - 1);
    T((x1 + x2) / 2, y - 2, label, 3.2, { anchor: 'middle' });
  };
  const dimV = (y1, y2, x, label) => {
    Ln(x - 1, y1, ox - 1, y1); Ln(x - 1, y2, ox - 1, y2);
    Ln(x, y1, x, y2); Ln(x - 1, y1 + 1, x + 1, y1 - 1); Ln(x - 1, y2 + 1, x + 1, y2 - 1);
    T(x - 2.4, (y1 + y2) / 2, label, 3.2, { anchor: 'middle', rot: -90 });
  };
  dimH(ox, ox + planW, oy - 9, `${fmtEighths(state.dims.w)} in`);
  dimV(oy, oy + planL, ox - 9, `${fmtEighths(state.dims.l)} in`);

  // front marker
  R(ox + planW / 2 - 8, oy + planL + 3, 16, 2, { fill: '#555', rx: 1 });
  T(ox + planW / 2, oy + planL + 10, 'FRONT', 2.8, { anchor: 'middle', bold: true, fill: '#444', ls: 0.4 });

  // title block
  R(2, titleTop, pageW - 4, titleH, { stroke: '#111', sw: 0.4 });
  T(6, titleTop + 8, 'Drawer insert plan, seen from above', 4.2, { bold: true });
  T(6, titleTop + 15, `Insert ${fmtEighths(state.dims.w)} × ${fmtEighths(state.dims.l)} × ${fmtEighths(state.dims.h)} in (width, length, height), for a drawer ${fmtEighths(state.drawer.w)} × ${fmtEighths(state.drawer.l)} × ${fmtEighths(state.drawer.h)} in inside`, 2.9);
  T(6, titleTop + 20.5, `${sorted.length} ${sorted.length === 1 ? 'space' : 'spaces'}, ${physical.length} ${physical.length === 1 ? 'divider' : 'dividers'}, sheet ${WALL.toFixed(2)} in, dividers ${drawerSize().partH.toFixed(2)} in tall`, 2.9);
  T(6, titleTop + 26, 'Each space shows width × length in inches.', 2.9, { fill: '#444' });
  T(6, titleTop + 38, `Scale 1:${ratio}. Print at 100%, not fit-to-page.`, 3.2, { bold: true });

  // scale bar
  const barIn = [1, 2, 3, 6, 12, 24, 48].filter(v => v * k <= 62).pop() || 1;
  const bw = barIn * k, bx = pageW - 8 - bw, by = titleTop + 24;
  for (let i = 0; i < barIn; i++) R(bx + i * k, by, k, 2.2, { fill: i % 2 ? '#fff' : '#111', stroke: '#111', sw: 0.25 });
  T(bx, by + 6.5, '0', 2.6, { anchor: 'middle' });
  T(bx + bw, by + 6.5, `${barIn} in`, 2.6, { anchor: 'middle' });
  T(bx + bw / 2, by - 2.5, 'Scale', 2.6, { anchor: 'middle', fill: '#444' });

  return { svg: sceneToSVG(scene, pageW, pageH), scene, w: pageW, h: pageH, ratio };
}

function sceneToSVG(scene, pageW, pageH) {
  const n = v => Math.round(v * 1000) / 1000;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = scene.map(o => {
    if (o.k === 'rect') return `<rect x="${n(o.x)}" y="${n(o.y)}" width="${n(o.w)}" height="${n(o.h)}"${o.rx ? ` rx="${o.rx}"` : ''} fill="${o.fill || 'none'}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw}"` : ''}/>`;
    if (o.k === 'line') return `<line x1="${n(o.x1)}" y1="${n(o.y1)}" x2="${n(o.x2)}" y2="${n(o.y2)}" stroke="${o.stroke}" stroke-width="${o.sw}"/>`;
    const attrs = `x="${n(o.x)}" y="${n(o.y)}" font-size="${o.size}"${o.bold ? ' font-weight="700"' : ''}${o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : ''}${o.fill !== '#000' ? ` fill="${o.fill}"` : ''}${o.ls ? ` letter-spacing="${o.ls}"` : ''}${o.rot ? ` transform="rotate(${o.rot} ${n(o.x)} ${n(o.y)})"` : ''}`;
    return `<text ${attrs}>${esc(o.s)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(pageW)}mm" height="${n(pageH)}mm" viewBox="0 0 ${n(pageW)} ${n(pageH)}" font-family="Helvetica, Arial, sans-serif">${body}</svg>`;
}

async function drawingPNG() {
  const { svg, w, h } = drawing();
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
  const px = 300 / MM_PER_IN;                                  // 300 dpi at 100% size
  const c = document.createElement('canvas');
  c.width = Math.round(w * px); c.height = Math.round(h * px);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('png'))), 'image/png'));
}

function designData() {
  const { W, L, H, partH } = drawerSize();
  const { cells, divs } = currentLayout();
  const sorted = sortCells(cells);
  const r = v => Math.round(v * 10000) / 10000;
  return {
    metadata: { version: '2.0', units: 'inches', drawer_interior_in: { width: eighthsToIn(state.drawer.w), length: eighthsToIn(state.drawer.l), height: eighthsToIn(state.drawer.h) }, safety_gap_in: eighthsToIn(state.gap) },   // drawer.* below is the insert itself
    drawer: { width_in: r(W), length_in: r(L), height_in: r(H), thickness_in: WALL, part_height_in: r(partH) },   // height_in is overall
    dividers: physicalDividers(divs).map((d, i) => ({
      id: `divider-${i}`, orientation: d.axis === 'v' ? 'vertical' : 'horizontal',
      x_in: r(d.axis === 'v' ? d.pos : d.start), y_in: r(d.axis === 'v' ? d.start : d.pos), length_in: r(d.length),
    })),
    compartments: sorted.map((c, i) => ({
      label: labelFor(i), x_in: r(c.x), y_in: r(c.y), width_in: r(c.w), length_in: r(c.h),
    })),
    price_estimate: {
      drawer: r(priceBreakdown().drawer), dividers: r(priceBreakdown().dividerCost), total: r(priceBreakdown().total),
    },
    order_fields: { divider_count: priceBreakdown().dividers, divider_area_sq_in: priceBreakdown().dividerArea },
  };
}

function cutList() {
  const { W, L, partH } = drawerSize();
  const divs = physicalDividers(currentLayout().divs);
  const rows = [{ qty: 1, part: 'Bottom panel', a: W, b: L }];
  const groups = new Map();
  for (const d of divs) {
    const key = Math.round(d.length * 1000) / 1000;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  [...groups].sort((a, b) => b[0] - a[0]).forEach(([len, qty]) => rows.push({ qty, part: 'Divider', a: len, b: partH }));
  return rows;
}

// The plan sheet's tables, shared by the on-screen sheet and the PDF.
function sheetData() {
  const data = designData();
  const { W, L, H, partH } = drawerSize();
  const cuts = cutList();
  const pb = priceBreakdown();
  const inch = v => v.toFixed(2) + '"';
  return {
    sections: [
      { title: 'Sizes', right: [1], rows: [
        ['Drawer interior, as measured', `${inch(eighthsToIn(state.drawer.w))} × ${inch(eighthsToIn(state.drawer.l))} × ${inch(eighthsToIn(state.drawer.h))}`],
        ['Safety gap (each side of the width and length, once off the height)', `${eighthsToIn(state.gap).toFixed(3)}"`],
        ['Insert size (width × length × height)', `${inch(W)} × ${inch(L)} × ${inch(H)}`],
        ['Divider height (insert height less one sheet)', inch(partH)],
        ['Sheet thickness', inch(WALL)],
        ['Open spaces', String(data.compartments.length)],
      ] },
      { title: 'Cost estimate', right: [1], total: true, rows: [
        ['Insert (bottom and outer walls)', fmtMoney(pb.drawer)],
        [`Dividers (${pb.dividers}, ${pb.dividerArea.toFixed(1)} sq in)`, fmtMoney(pb.dividerCost)],
        ['Estimated total', fmtMoney(pb.total)],
      ] },
      { title: 'Parts to cut', head: ['Qty', 'Part', 'Size'], right: [2], rows: cuts.map(c => [String(c.qty), c.part, `${inch(c.a)} × ${inch(c.b)}`]) },
      { title: 'Spaces', head: ['Label', 'Width', 'Length'], right: [1, 2], rows: data.compartments.map(c => [c.label, inch(c.width_in), inch(c.length_in)]) },
    ],
  };
}

function sectionHTML(s) {
  const head = s.head ? `<thead><tr>${s.head.map(h => `<th>${h}</th>`).join('')}</tr></thead>` : '';
  const rows = s.rows.map((r, i) => `<tr${s.total && i === s.rows.length - 1 ? ' class="total"' : ''}>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<h3>${s.title}</h3><table>${head}<tbody>${rows}</tbody></table>`;
}

function openReview() {
  const dr = drawing();
  const sections = sheetData().sections.map(sectionHTML);
  $('#rev-body').innerHTML = `
    <h3>Plan drawing</h3>
    <div class="drawing">${dr.svg}</div>
    <p class="hint">Drawn at 1:${dr.ratio}. Print the SVG or PNG, or save the PDF, at 100% to keep that scale.</p>
    ${sections.join('\n')}`;
  $('#review').hidden = false;
}

/* ---------- PDF (no libraries): page 1 is the to-scale drawing, then the tables ---------- */
const PDF_W = 612, PDF_H = 792, PDF_MARGIN = 36;                 // US Letter in points, half-inch margins
// Helvetica advance widths (1/1000 em) for ASCII 32..126, regular and bold
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELV_B = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

const pdfCode = ch => {
  const c = ch.codePointAt(0);
  if (ch === '″') return 34;                       // inch mark
  if (ch === '′') return 39;
  if (c === 0x2013 || c === 0x2014) return 45;
  if (c === 0xD7 || c === 0xB7) return c;          // × and · exist in WinAnsi
  return c >= 32 && c <= 126 ? c : 63;
};
// The PDF's built-in font has no fraction characters: write them out ("5 1/2") instead of printing "?".
const PDF_FRACTIONS = { '⅛': '1/8', '¼': '1/4', '⅜': '3/8', '½': '1/2', '⅝': '5/8', '¾': '3/4', '⅞': '7/8' };
const pdfText = s => String(s).replace(/[⅛¼⅜½⅝¾⅞]/g, f => PDF_FRACTIONS[f]);
const pdfStr = s => [...pdfText(s)].map(ch => {
  const c = pdfCode(ch);
  if (c === 40 || c === 41 || c === 92) return '\\' + String.fromCharCode(c);
  return c > 126 ? '\\' + c.toString(8).padStart(3, '0') : String.fromCharCode(c);
}).join('');
const pdfWidth = (s, size, bold) => [...pdfText(s)].reduce((sum, ch) => {
  const c = pdfCode(ch);
  return sum + (c === 0xD7 ? 584 : c === 0xB7 ? 278 : (bold ? HELV_B : HELV)[c - 32]);
}, 0) * size / 1000;
const pdfRGB = hex => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map(c => c + c).join('');
  const v = parseInt(h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map(x => +(x / 255).toFixed(3)).join(' ');
};
const pdfNum = v => String(Math.round(v * 1000) / 1000);

// Draw a scene (paper millimetres) with its top-left corner at (left, top) points from the page's top-left.
function pdfDrawScene(scene, pt, left, top) {
  const X = x => left + x * pt, Y = y => PDF_H - (top + y * pt);
  const ops = [];
  for (const o of scene) {
    if (o.k === 'rect') {
      const paint = o.fill && o.stroke ? 'B' : o.fill ? 'f' : o.stroke ? 'S' : 'n';
      if (o.fill) ops.push(`${pdfRGB(o.fill)} rg`);
      if (o.stroke) ops.push(`${pdfRGB(o.stroke)} RG ${pdfNum(o.sw * pt)} w`);
      ops.push(`${pdfNum(X(o.x))} ${pdfNum(Y(o.y + o.h))} ${pdfNum(o.w * pt)} ${pdfNum(o.h * pt)} re ${paint}`);
    } else if (o.k === 'line') {
      ops.push(`${pdfRGB(o.stroke)} RG ${pdfNum(o.sw * pt)} w ${pdfNum(X(o.x1))} ${pdfNum(Y(o.y1))} m ${pdfNum(X(o.x2))} ${pdfNum(Y(o.y2))} l S`);
    } else {
      const size = o.size * pt, w = pdfWidth(o.s, size, o.bold);
      const shift = o.anchor === 'middle' ? -w / 2 : 0;
      const x = X(o.x), y = Y(o.y);
      // rotate -90 in the drawing reads upward; in PDF space that is a +90 degree turn
      const tm = o.rot ? `0 1 -1 0 ${pdfNum(x)} ${pdfNum(y + shift)}` : `1 0 0 1 ${pdfNum(x + shift)} ${pdfNum(y)}`;
      ops.push(`BT /${o.bold ? 'F2' : 'F1'} ${pdfNum(size)} Tf ${pdfNum((o.ls || 0) * pt)} Tc ${pdfRGB(o.fill)} rg ${tm} Tm (${pdfStr(o.s)}) Tj ET`);
    }
  }
  return ops.join('\n');
}

// Text tables, flowing onto more pages when needed. Returns one operator string per page.
function pdfSheetPages(sections, subtitle) {
  const pages = [];
  let ops = [], y = 0;
  const text = (x, baseline, s, size, o = {}) => {
    const w = pdfWidth(s, size, o.bold);
    const px = o.right ? x - w : x;
    ops.push(`BT /${o.bold ? 'F2' : 'F1'} ${size} Tf ${pdfRGB(o.fill || '#000')} rg 1 0 0 1 ${pdfNum(px)} ${pdfNum(PDF_H - baseline)} Tm (${pdfStr(s)}) Tj ET`);
  };
  const rule = (yy, gray = '#d4d4d4') => ops.push(`${pdfRGB(gray)} RG 0.5 w ${PDF_MARGIN} ${pdfNum(PDF_H - yy)} m ${PDF_W - PDF_MARGIN} ${pdfNum(PDF_H - yy)} l S`);
  const startPage = first => {
    if (ops.length) pages.push(ops.join('\n'));
    ops = [];
    text(PDF_MARGIN, PDF_MARGIN + 16, first ? 'Drawer insert plan' : 'Drawer insert plan (continued)', first ? 18 : 12, { bold: true });
    y = PDF_MARGIN + 16;
    if (first) { text(PDF_MARGIN, y + 16, subtitle, 10, { fill: '#555' }); y += 16; }
    y += 26;
  };
  const colWidths = n => (n === 2 ? [0.7, 0.3] : [0.18, 0.5, 0.32]).map(f => f * (PDF_W - 2 * PDF_MARGIN));
  const ROW = 19, LIMIT = PDF_H - 56;
  startPage(true);
  for (const s of sections) {
    const need = 22 + (s.head ? ROW : 0) + ROW * Math.min(s.rows.length, 3);
    if (y + need > LIMIT) startPage(false);
    text(PDF_MARGIN, y + 8, s.title.toUpperCase(), 9, { bold: true, fill: '#555' });
    y += 16;
    const cols = colWidths(s.rows[0].length);
    const colX = cols.map((_, i) => PDF_MARGIN + cols.slice(0, i).reduce((a, b) => a + b, 0));
    const place = (cells, i, baseline, size, o) => text(s.right.includes(i) ? colX[i] + cols[i] - 4 : colX[i] + 4, baseline, cells[i], size, { ...o, right: s.right.includes(i) });
    if (s.head) {
      s.head.forEach((_, i) => place(s.head, i, y + 13, 8.5, { fill: '#555' }));
      y += ROW; rule(y - 3, '#9a9a9a');
    }
    s.rows.forEach((r, ri) => {
      if (y + ROW > LIMIT) { startPage(false); y += 0; }
      const total = s.total && ri === s.rows.length - 1;
      r.forEach((_, i) => place(r, i, y + 13, 10, { bold: total }));
      y += ROW; rule(y - 3);
    });
    y += 12;
  }
  pages.push(ops.join('\n'));
  return pages;
}

// Assemble the PDF file: pages are operator strings; returns bytes.
function pdfFile(pages, title) {
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  let next = 5;
  const kids = [];
  for (const content of pages) {
    const pageId = next++, contentId = next++;
    kids.push(`${pageId} 0 R`);
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_W} ${PDF_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    objs[contentId] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  }
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  const infoId = next++;
  objs[infoId] = `<< /Title (${pdfStr(title)}) /Producer (Drawer Insert Planner) >>`;
  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets = [];
  for (let id = 1; id < next; id++) { offsets[id] = out.length; out += `${id} 0 obj\n${objs[id]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${next}\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${next} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, ch => ch.charCodeAt(0) & 255);
}

function makePlanPdf() {
  const dr = drawing();
  const pt = 72 / MM_PER_IN;                           // points per paper millimetre: the drawing prints at 100%
  const subtitle = `Insert ${fmtEighths(state.dims.w)} x ${fmtEighths(state.dims.l)} x ${fmtEighths(state.dims.h)} in   |   drawing at 1:${dr.ratio}`;
  const drawingPage = pdfDrawScene(dr.scene, pt, (PDF_W - dr.w * pt) / 2, PDF_MARGIN);
  const pages = [drawingPage, ...pdfSheetPages(sheetData().sections, subtitle)];
  const today = new Date().toISOString().slice(0, 10);
  const footer = (i, n) => {
    const label = `Drawer Insert Planner   ${today}`, right = `Page ${i} of ${n}`;
    const y = PDF_H - 22;
    return `BT /F1 8 Tf ${pdfRGB('#777')} rg 1 0 0 1 ${PDF_MARGIN} ${y} Tm (${pdfStr(label)}) Tj ET\nBT /F1 8 Tf ${pdfRGB('#777')} rg 1 0 0 1 ${pdfNum(PDF_W - PDF_MARGIN - pdfWidth(right, 8, false))} ${y} Tm (${pdfStr(right)}) Tj ET`;
  };
  return pdfFile(pages.map((ops, i) => ops + '\n' + footer(i + 1, pages.length)), 'Drawer insert plan');
}

let downloadsCap;
async function getDownloads() {
  if (downloadsCap === undefined) {
    try { downloadsCap = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch (e) { downloadsCap = null; }
  }
  return downloadsCap;
}
const MIME = { svg: 'image/svg+xml', png: 'image/png', json: 'application/json', csv: 'text/csv', pdf: 'application/pdf' };

// Uses the host's save prompt when the page runs as a claude.ai artifact, a normal download otherwise.
async function saveFile(name, data, btn) {
  const label = btn && (btn.dataset.label || (btn.dataset.label = btn.textContent));
  const note = t => { if (btn) { btn.textContent = t; setTimeout(() => { btn.textContent = label; }, 1800); } };
  try {
    const dl = await getDownloads();
    if (dl) { await dl.save({ filename: name, data }); return; }
    const blob = data instanceof Blob ? data : new Blob([data], { type: MIME[name.split('.').pop()] });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    if (!err || err.code !== 'declined') note('Could not save');
  }
}

$('#open-review').addEventListener('click', openReview);
$('#rev-close').addEventListener('click', () => { $('#review').hidden = true; });
$('#review').addEventListener('pointerdown', e => { if (e.target.id === 'review') $('#review').hidden = true; });
const csvText = () => ['qty,part,dim_a_in,dim_b_in', ...cutList().map(c => `${c.qty},${c.part},${c.a.toFixed(3)},${c.b.toFixed(3)}`)].join('\n') + '\n';
const jsonText = () => JSON.stringify(designData(), null, 2);

function copyText(text, btn) {
  const done = ok => {
    const old = btn.dataset.label || btn.textContent;
    btn.dataset.label = old;
    btn.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { btn.textContent = old; }, 1500);
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove(); done(ok);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => done(true), fallback);
  else fallback();
}

on('#rev-json', 'click', e => saveFile('insert-plan.json', jsonText(), e.currentTarget));
on('#rev-csv', 'click', e => saveFile('insert-parts.csv', csvText(), e.currentTarget));
on('#rev-pdf', 'click', e => saveFile('insert-plan.pdf', makePlanPdf(), e.currentTarget));
on('#rev-svg', 'click', e => saveFile('insert-drawing.svg', drawing().svg, e.currentTarget));
on('#rev-png', 'click', async e => { const b = e.currentTarget; try { await saveFile('insert-drawing.png', await drawingPNG(), b); } catch (err) { /* handled in saveFile */ } });
on('#rev-print', 'click', () => window.print());
on('#rev-copy-json', 'click', e => copyText(jsonText(), e.currentTarget));
on('#rev-copy-csv', 'click', e => copyText(csvText(), e.currentTarget));

/* ---------- init ---------- */
if (!restore()) {                                                  // opens ready to work: an 18 x 22 x 3 in drawer
  state.gap = DEFAULT_GAP;
  state.drawer = { w: 144, l: 176, h: 24 };
  syncInsert();
}
resetHistory();
showSizes();
refresh();

/* ---------- embedded mode ----------
   The store's order form shows this page inside a pop-up (?embed=1). It asks the form for the drawer size,
   and "Use this design" sends the form the plan files and the two values its price formula needs. */
const EMBED = new URLSearchParams(location.search).has('embed') && window.parent !== window;
if (EMBED) {
  document.body.classList.add('embed');
  window.addEventListener('message', e => {
    const m = e.data;
    if (!m || m.type !== 'drawer-insert-init' || !m.dims) return;
    const eighths = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(+v * 8)));
    const w = eighths(m.dims.width, 40, 376), l = eighths(m.dims.length, 40, 376), h = eighths(m.dims.height, 4, 120);
    if (![w, l, h].every(Number.isFinite)) return;
    state.drawer = { w: w + 2 * state.gap, l: l + 2 * state.gap, h: h + state.gap };
    sizesChanged();
  });
  function sendPlan() {
    const pb = priceBreakdown();
    const { W, L, H } = drawerSize();
    const pdf = makePlanPdf();
    const buf = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength);
    window.parent.postMessage({
      type: 'drawer-insert-plan', version: 1,
      dims: { width: W, length: L, height: H },
      dividerCount: pb.dividers, dividerArea: pb.dividerArea, total: Math.round(pb.total * 100) / 100,
      json: jsonText(), pdf: buf,
    }, '*', [buf]);
    showUpload('progress', 0);
  }
  // A layout with no dividers is allowed (an empty tray), but the customer is asked to confirm it.
  const ask = document.createElement('div');
  ask.id = 'confirm-overlay'; ask.hidden = true;
  ask.innerHTML = '<div class="ov-card" role="alertdialog" aria-labelledby="ask-title"><div class="ov-title" id="ask-title">This layout is empty</div><div class="ov-sub">It has no dividers, so it will be built as a plain tray: a bottom and four walls. Use it anyway?</div><div class="ask-buttons"><button type="button" class="btn" id="ask-back">Keep designing</button><button type="button" class="btn primary" id="ask-yes">Yes, use an empty tray</button></div></div>';
  document.body.appendChild(ask);
  on('#finish', 'click', () => {
    if (priceBreakdown().dividers) sendPlan(); else { ask.hidden = false; $('#ask-back').focus(); }
  });
  on('#ask-back', 'click', () => { ask.hidden = true; });
  on('#ask-yes', 'click', () => { ask.hidden = true; sendPlan(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !ask.hidden) { ask.hidden = true; e.stopImmediatePropagation(); } }, true);
  // The order form reports its upload progress back; the pop-up closes itself once the files are up.
  const ov = document.createElement('div');
  ov.id = 'upload-overlay'; ov.hidden = true;
  ov.innerHTML = '<div class="ov-card" role="status"><div class="ov-title"></div><div class="ov-bar"><i></i></div><div class="ov-sub"></div><button type="button" class="btn primary ov-retry" hidden>Try again</button></div>';
  document.body.appendChild(ov);
  const ovQ = s => ov.querySelector(s);
  let doneTimer = 0;
  function showUpload(state, percent, text) {
    clearTimeout(doneTimer);
    ov.hidden = false;
    ov.dataset.state = state;
    ovQ('.ov-bar i').style.width = Math.max(4, Math.min(100, percent || 0)) + '%';
    ovQ('.ov-title').textContent = state === 'done' ? 'Plan saved' : state === 'failed' ? 'Upload failed' : 'Saving your plan…';
    ovQ('.ov-sub').textContent = text || (state === 'done' ? 'Closing…' : state === 'failed' ? '' : `Uploading your plan files${percent ? ` · ${Math.round(percent)}%` : ''}`);
    ovQ('.ov-retry').hidden = state !== 'failed';
    if (state === 'done') doneTimer = setTimeout(() => { ov.hidden = true; }, 1500);      // the pop-up closes itself; never leave this card behind
  }
  ovQ('.ov-retry').addEventListener('click', () => { ov.hidden = true; });
  ov.addEventListener('click', () => { if (ov.dataset.state === 'done') ov.hidden = true; });
  window.addEventListener('message', e => {
    const m = e.data;
    if (m && m.type === 'drawer-insert-collapse') {            // the pop-up was closed: start tidy next time it opens
      clearTimeout(doneTimer); ov.hidden = true; ask.hidden = true;
      if (document.body.classList.contains('editor-full')) setExpanded(false);
      return;
    }
    if (!m || m.type !== 'drawer-insert-upload') return;
    if (m.state === 'slow') showUpload('progress', +ovQ('.ov-bar i').style.width.replace('%', ''), 'Still uploading. This can take a little longer on a slow connection.');
    else showUpload(m.state, m.percent, m.text);
    if (m.state === 'done' && document.body.classList.contains('editor-full')) setExpanded(false);
  });
  window.parent.postMessage({ type: 'drawer-insert-ready' }, '*');
}
