'use strict';

/* =====================================================================
 * Drawer Insert Planner
 *
 * Model: a drawer (interior W x L x H, H overall) holds dividers, and nothing else: the
 * layout is the set of dividers (see "the layout: a set of dividers"), and the spaces,
 * their sizes and the L-shapes are all worked out from where the dividers are, so a
 * layout behaves the same however it was built.
 * The bottom panel is WALL thick, so dividers stand H - WALL tall.
 * All geometry is stored in inches.
 * ===================================================================== */

const MM_PER_IN = 25.4;           // only used to size the printed drawing in millimetres
const WALL = 0.17;                // sheet thickness: outer wall and divider thickness (in)
const MIN_CELL = 1 / 16;          // smallest compartment edge (in): no real limit, just enough that two dividers never sit on top of each other
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

const FRACS = ['', '1/8', '1/4', '3/8', '1/2', '5/8', '3/4', '7/8'];       // written out: the one-character fractions are too small to read in the drop-down lists

/* ---------- state ---------- */
let nextId = 1;
const state = {
  dims: null,                     // the insert: { w, l, h } in ten-thousandths of an inch (the drawer interior less the safety gap)
  drawer: null,                   // the drawer interior as measured: { w, l, h } in ten-thousandths of an inch
  label: '',                      // the customer's drawer label (a few words, printed at the top of the PDF)
  gap: 0,                         // safety gap (same unit), off each side of the width and length and once off the height
  decimal: false,                 // sizes are typed as decimals instead of picked from fraction lists
  segs: [],                       // the dividers (see the layout section)
  eq: [],                         // linked equal sizes: [{ a: size, b: size }, ...] (see the links section)
  fix: [],                        // sizes set to a number: [{ ...size, value }, ...]
  names: [],                      // names of spaces: [{ name, key, f }] (see the names section)
  suggested: false,               // the layout was suggested from a photo
  photo: false,                   // the layout was suggested from a photo and the drawer size has not been confirmed as measured
};
const hist = { stack: [], i: -1 };

// The drawer label: a few words in plain printable characters (the PDF's built-in font has no others).
const LABEL_MAX = 30;
function cleanLabel(v) {
  return String(v == null ? '' : v).replace(/[‘’′]/g, "'").replace(/[“”″]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').slice(0, LABEL_MAX);
}
const drawerLabel = () => cleanLabel(state.label).trim();
const NAME_MAX = 28;
const cleanName = v => cleanLabel(v).replace(/[<>"]/g, '').slice(0, NAME_MAX);      // a space's name: plain printable characters, as the PDF's built-in font has no others

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const on = (s, ev, fn) => { const el = $(s); if (el) el.addEventListener(ev, fn); };
// Sizes are whole numbers of ten-thousandths of an inch (the finest the planner takes), so decimal input is exact and
// the fraction lists (steps of 1/8 in) are just every 1250th value.
const IN = 10000, EIGHTH = IN / 8;
const unitsToIn = n => n / IN;
const snapEighth = n => Math.round(n / EIGHTH) * EIGHTH;
const fmt2 = v => (Math.round(v * 1e4) / 1e4).toFixed(2);             // rounded first, so two equal sizes always read alike
const fmtDecimal = n => String(+(n / IN).toFixed(4));                     // 12.1875, 12.5, 12
function fmtIn(n) {                                                      // a size as fractions (12 1/8) or, in decimal mode, decimals (12.125)
  if (state.decimal || n % EIGHTH !== 0) return fmtDecimal(n);
  const e = n / EIGHTH, whole = Math.floor(e / 8), r = e % 8;
  return `${whole || ''}${r ? (whole ? ' ' : '') + FRACS[r] : ''}`;
}
const fmtMoney = v => '$' + v.toFixed(2);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const svgEl = (tag, attrs = {}) => {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};

/* ---------- layout ---------- */
// The customer measures the drawer's inside (state.drawer) and chooses a safety gap (state.gap, taken off each side
// of the width and length and once off the height). Everything else in the planner (layout, price, exports) works on
// the resulting insert size, state.dims.
const GAPS = [0, 1, 2, 3, 4].map(g => g * EIGHTH);    // the list: none, 1/8, 1/4, 3/8, 1/2 inch
const GAP_MAX = 4 * EIGHTH;                           // decimal input takes any gap from 0 to 1/2 inch
const DEFAULT_GAP = EIGHTH;
function drawerLimits(g = state.gap) {                // interior sizes that give an insert the store can make: 5-47 in wide and long, 1/2-15 in high
  return { w: [5 * IN + 2 * g, 47 * IN + 2 * g], l: [5 * IN + 2 * g, 47 * IN + 2 * g], h: [IN / 2 + g, 15 * IN + g] };
}
function syncInsert() {
  const lim = drawerLimits(), clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
  state.drawer = { w: clamp(state.drawer.w, lim.w), l: clamp(state.drawer.l, lim.l), h: clamp(state.drawer.h, lim.h) };
  state.dims = { w: state.drawer.w - 2 * state.gap, l: state.drawer.l - 2 * state.gap, h: state.drawer.h - state.gap };
}
function drawerSize() {
  const { w, l, h } = state.dims;
  const H = unitsToIn(h);
  return { W: unitsToIn(w), L: unitsToIn(l), H, partH: H - WALL };   // partH: height of dividers and walls
}

const isDefaultLayout = () => !state.segs.length;


// The spaces left when the dividers (and the pocket) are taken out of a region: connected areas of free floor. Each is a
// rectangle { x, y, w, h } or has a rectilinear outline `poly`. `rects` are the rectangles it is dealt with as: extend a
// line through every inside corner, and what is left in each piece (an L is three: its two ends and the elbow).
function regionFaces(x, y, w, h, blockers) {
  const uniq = arr => { const out = []; for (const v of [...arr].sort((p, q) => p - q)) if (!out.length || v - out[out.length - 1] > EPS) out.push(v); return out; };
  const xs = uniq([x, x + w, ...blockers.flatMap(r => [r.x, r.x + r.w])].filter(v => v >= x - EPS && v <= x + w + EPS));
  const ys = uniq([y, y + h, ...blockers.flatMap(r => [r.y, r.y + r.h])].filter(v => v >= y - EPS && v <= y + h + EPS));
  const nx = xs.length - 1, ny = ys.length - 1, comp = new Array(nx * ny).fill(-2);
  const inside = (r, px, py) => px > r.x && px < r.x + r.w && py > r.y && py < r.y + r.h;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const px = (xs[i] + xs[i + 1]) / 2, py = (ys[j] + ys[j + 1]) / 2;
    comp[j * nx + i] = blockers.some(r => inside(r, px, py)) ? -1 : -2;      // -1 a divider or the pocket, -2 free
  }
  let count = 0;
  const cellsOf = [];
  for (let start = 0; start < comp.length; start++) {
    if (comp[start] !== -2) continue;
    const id = count++, stack = [start], list = [];
    comp[start] = id;
    while (stack.length) {
      const c = stack.pop(), i = c % nx, j = (c - i) / nx;
      list.push([i, j]);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny || comp[nj * nx + ni] !== -2) continue;
        comp[nj * nx + ni] = id; stack.push(nj * nx + ni);
      }
    }
    cellsOf.push(list);
  }
  const at = (arr, v) => { let lo = 0, hi = arr.length - 2; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (arr[m] <= v) lo = m; else hi = m - 1; } return lo; };
  const faces = cellsOf.map((list, id) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, i0 = Infinity, i1 = -1, j0 = Infinity, j1 = -1;
    for (const [i, j] of list) { x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i + 1]); y0 = Math.min(y0, ys[j]); y1 = Math.max(y1, ys[j + 1]); i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); }
    const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    if (list.length === (i1 - i0 + 1) * (j1 - j0 + 1)) return box;      // every cell of its bounding grid: a plain rectangle
    // outline: the edges of the cells that border something else, chained into a loop (clockwise on screen)
    const next = new Map(), key = (i, j) => i * (ny + 1) + j, owner = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny ? -3 : comp[j * nx + i]);
    for (const [i, j] of list) {
      if (owner(i, j - 1) !== id) next.set(key(i, j), [i + 1, j]);
      if (owner(i + 1, j) !== id) next.set(key(i + 1, j), [i + 1, j + 1]);
      if (owner(i, j + 1) !== id) next.set(key(i + 1, j + 1), [i, j + 1]);
      if (owner(i - 1, j) !== id) next.set(key(i, j + 1), [i, j]);
    }
    const first = [...next.keys()][0];
    let pts = [], k = first, guard = 0;
    do { const i = Math.floor(k / (ny + 1)), j = k % (ny + 1); pts.push([xs[i], ys[j]]); const nxt = next.get(k); k = key(nxt[0], nxt[1]); } while (k !== first && ++guard < 10000);
    pts = pts.filter((q, m) => { const a0 = pts[(m + pts.length - 1) % pts.length], c0 = pts[(m + 1) % pts.length]; return Math.abs((q[0] - a0[0]) * (c0[1] - q[1]) - (q[1] - a0[1]) * (c0[0] - q[0])) > EPS * EPS; });
    if (pts.length <= 4) return box;
    const reflex = pts.filter((q, m) => { const a0 = pts[(m + pts.length - 1) % pts.length], c0 = pts[(m + 1) % pts.length]; return (q[0] - a0[0]) * (c0[1] - q[1]) - (q[1] - a0[1]) * (c0[0] - q[0]) < 0; });
    const cx = uniq([x0, x1, ...reflex.map(q => q[0])]), cy = uniq([y0, y1, ...reflex.map(q => q[1])]), rects = [];
    for (let j = 0; j < cy.length - 1; j++) for (let i = 0; i < cx.length - 1; i++) {
      const px = (cx[i] + cx[i + 1]) / 2, py = (cy[j] + cy[j + 1]) / 2;
      if (comp[at(ys, py) * nx + at(xs, px)] === id) rects.push({ x: cx[i], y: cy[j], w: cx[i + 1] - cx[i], h: cy[j + 1] - cy[j] });
    }
    const face = { ...box, poly: pts, rects };
    if (pts.length === 6) {                                  // an L: the corner of its bounding box that is missing, as a rectangle
      const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], miss = corners.find(c => !pts.some(q => Math.abs(q[0] - c[0]) < EPS && Math.abs(q[1] - c[1]) < EPS)), rv = reflex[0];
      if (miss && rv) face.cut = { x: Math.min(miss[0], rv[0]), y: Math.min(miss[1], rv[1]), w: Math.abs(miss[0] - rv[0]), h: Math.abs(miss[1] - rv[1]) };
    }
    return face;
  });
  return faces.sort((p, q) => (Math.abs(p.y - q.y) > EPS ? p.y - q.y : p.x - q.x));
}

/* ---------- the layout: a set of dividers ----------
 * A layout is nothing but its dividers, so it works the same however it was built. Each divider (a "seg") is a straight
 * run of sheet with an axis, a position u (a fraction of the floor less one sheet, so the whole layout scales with the
 * drawer) and what each of its two ends rests on: a wall, or the near (e = 0) or far (e = 1) face of another divider
 * (r = that divider's id). Where a divider ends on another one the two stay joined when either is moved.
 * seg = { id, axis: 'v' | 'h', u, a: { r, e }, b: { r, e } }   (a = the start end, b = the finish end; r null = a wall)
 * Everything else (spaces, their sizes, L-shapes, parts of a divider) is worked out from where the dividers are. */
function segGeom(segs, R) {
  const byId = new Map(segs.map(g => [g.id, g]));
  const lo = g => (g.axis === 'v' ? R.x : R.y), span = g => (g.axis === 'v' ? R.w : R.h) - WALL;
  const pos = g => lo(g) + g.u * span(g);
  const end = (spec, wall) => { const q = spec.r == null ? null : byId.get(spec.r); return q ? pos(q) + spec.e * WALL : wall; };
  return segs.map(g => {
    const [w0, w1] = g.axis === 'v' ? [R.y, R.y + R.h] : [R.x, R.x + R.w];
    return { id: g.id, axis: g.axis, pos: pos(g), s: end(g.a, w0), e: end(g.b, w1) };
  });
}
const lineRect = l => (l.axis === 'v' ? { x: l.pos, y: l.s, w: WALL, h: l.e - l.s } : { x: l.s, y: l.pos, w: l.e - l.s, h: WALL });

// Seg records for divider lines { id, axis, pos, s, e } (ids already given); null if an end rests on nothing.
function segsFromLines(R, lines) {
  const segs = [];
  for (const l of lines) {
    const [w0, w1] = l.axis === 'v' ? [R.y, R.y + R.h] : [R.x, R.x + R.w];
    const attach = (val, wall) => {
      if (Math.abs(val - wall) < EPS) return { r: null, e: 0 };
      let best = null;
      for (const q of lines) {
        if (q === l || q.axis === l.axis) continue;
        if (q.s > l.pos + WALL + EPS || q.e < l.pos - EPS) continue;                            // it must reach this divider
        for (const e of [0, 1]) { const d = Math.abs(val - (q.pos + e * WALL)); if (d < EPS && (!best || d < best.d - 1e-9)) best = { r: q.id, e, d }; }
      }
      return best ? { r: best.r, e: best.e } : null;
    };
    const a = attach(l.s, w0), b = attach(l.e, w1);
    if (!a || !b) return null;
    segs.push({ id: l.id, axis: l.axis, u: (l.pos - (l.axis === 'v' ? R.x : R.y)) / ((l.axis === 'v' ? R.w : R.h) - WALL), a, b });
  }
  return segs;
}

// Dividers (absolute lines) are clear of the walls and of each other: MIN_CELL to the next divider running alongside that faces it
function linesValid(R, lines) {
  for (const l of lines) {
    const lo = l.axis === 'v' ? l.pos - R.x : l.pos - R.y, tot = l.axis === 'v' ? R.w : R.h;
    if (lo < MIN_CELL - EPS || tot - lo - WALL < MIN_CELL - EPS || l.e - l.s < EPS) return false;
  }
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const p = lines[i], q = lines[j];
    if (p.axis !== q.axis || Math.min(p.e, q.e) - Math.max(p.s, q.s) <= EPS) continue;
    if (Math.abs(p.pos - q.pos) - WALL < MIN_CELL - EPS) return false;
  }
  return true;
}
// Every divider end must still rest on the divider it was attached to, and the lines must be clear of each other
function segsValid(segs, R) {
  const lines = segGeom(segs, R), byId = new Map(lines.map(g => [g.id, g]));
  if (!linesValid(R, lines)) return false;
  return segs.every(g => {
    const me = byId.get(g.id);
    return [g.a, g.b].every(sp => { const q = sp.r == null ? null : byId.get(sp.r); return sp.r == null || (q && q.s <= me.pos + WALL + EPS && q.e >= me.pos - EPS); });
  });
}

// The thinnest piece of any space (the narrowest part of an L, say)
function minFace(lines, R) {
  let m = Infinity;
  for (const f of regionFaces(R.x, R.y, R.w, R.h, lines.map(lineRect))) for (const r of f.rects || [f]) m = Math.min(m, r.w, r.h);
  return m;
}

function layoutOf(segs, W, L) {
  const R = { x: WALL, y: WALL, w: W - 2 * WALL, h: L - 2 * WALL };
  const lines = segGeom(segs, R);
  const divs = lines.map(g => ({ sid: g.id, axis: g.axis, x: g.axis === 'v' ? g.pos : g.s, y: g.axis === 'v' ? g.s : g.pos, w: g.axis === 'v' ? WALL : g.e - g.s, h: g.axis === 'v' ? g.e - g.s : WALL }));
  const cells = regionFaces(R.x, R.y, R.w, R.h, lines.map(lineRect)).map((f, k) => ({ ...f, id: k + 1 }));
  return { cells, divs, lines, R };
}
function currentLayout() {
  const { W, L } = drawerSize();
  return layoutOf(state.segs, W, L);
}
const wholeRect = () => { const { W, L } = drawerSize(); return { x: WALL, y: WALL, w: W - 2 * WALL, h: L - 2 * WALL }; };
const divSeg = d => (d.axis === 'v' ? { axis: 'v', pos: d.x, s: d.y, e: d.y + d.h } : { axis: 'h', pos: d.y, s: d.x, e: d.x + d.w });
const layoutLines = () => currentLayout().lines.map(({ axis, pos, s, e }) => ({ axis, pos, s, e }));

/* ---------- putting a set of dividers together ---------- */
// Segments that sit on the same line and touch end to end (across a crossing divider) are one divider, whatever order they were added in.
function mergeLines(segs) {
  const out = [];
  for (const axis of ['v', 'h']) {
    const list = segs.filter(x => x.axis === axis).sort((a, b) => a.pos - b.pos);
    const groups = [];                                                // dividers on the same line (positions within EPS of the first)
    for (const x of list) { const g = groups[groups.length - 1]; if (g && x.pos - g[0].pos < EPS) g.push(x); else groups.push([x]); }
    for (const g of groups) {
      g.sort((a, b) => a.s - b.s);
      let cur = null;
      for (const x of g) {
        if (cur && x.s <= cur.e + WALL + EPS) { cur.e = Math.max(cur.e, x.e); cur.ext = cur.ext || x.ext; }
        else { if (cur) out.push(cur); cur = { ...x, pos: g[0].pos }; }
      }
      if (cur) out.push(cur);
    }
  }
  return out;
}

// Two parallel dividers that run side by side with less than NARROW between them are one divider: the one that was
// extended moves onto the other (two extended ones join on the longer). Dividers that ended on the moved one follow it.
const NARROW = 0.2;
function joinNarrow(lines) {
  for (let pass = 0; pass < 100; pass++) {
    let pair = null;
    for (const a of lines) {
      for (const b of lines) {
        if (a === b || a.axis !== b.axis || !(a.ext || b.ext)) continue;
        const d = Math.abs(a.pos - b.pos);
        if (d > EPS && d < WALL + NARROW - EPS && Math.min(a.e, b.e) - Math.max(a.s, b.s) > EPS) { pair = [a, b]; break; }
      }
      if (pair) break;
    }
    if (!pair) return lines;
    const [a, b] = pair;
    const keep = a.ext !== b.ext ? (a.ext ? b : a) : (a.e - a.s >= b.e - b.s ? a : b);
    const move = keep === a ? b : a, old = move.pos;
    move.pos = keep.pos;
    for (const x of lines) {
      if (x.axis === move.axis || x.pos + WALL <= move.s + EPS || x.pos >= move.e - EPS) continue;
      if (Math.abs(x.e - old) < EPS) x.e = keep.pos;
      else if (Math.abs(x.s - (old + WALL)) < EPS) x.s = keep.pos + WALL;
    }
    lines = mergeLines(lines.filter(x => x.e - x.s > EPS));
  }
  return lines;
}

// A divider end that rests on nothing is carried on until it meets a wall or a divider that runs across its whole width.
// An end rests when it is on a divider (or at a wall) that crosses the line.
function extendHanging(R, lines) {
  const touches = (g, q) => q.s <= g.pos + WALL + EPS && q.e >= g.pos - EPS;
  const covers = (g, q) => q.s <= g.pos + EPS && q.e >= g.pos + WALL - EPS;
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const g of lines) {
      const [w0, w1] = g.axis === 'v' ? [R.y, R.y + R.h] : [R.x, R.x + R.w];
      const perp = lines.filter(q => q.axis !== g.axis), on = (q, v) => v >= q.pos - EPS && v <= q.pos + WALL + EPS;
      if (g.e < w1 - EPS && !perp.some(q => touches(g, q) && on(q, g.e))) {
        g.e = Math.min(w1, ...perp.filter(q => covers(g, q) && q.pos >= g.e - EPS).map(q => q.pos)); g.ext = true; changed = true;
      }
      if (g.s > w0 + EPS && !perp.some(q => touches(g, q) && on(q, g.s))) {
        g.s = Math.max(w0, ...perp.filter(q => covers(g, q) && q.pos + WALL <= g.s + EPS).map(q => q.pos + WALL)); g.ext = true; changed = true;
      }
    }
    if (!changed) break;
  }
}

/* Dividers keep their ids through an edit where they are still in the same place, so links and the like hold. `lineage` says
 * which new dividers an old one became (a divider cut in two becomes two). */
function assignIds(oldLines, lines) {
  const used = new Set(), pairs = [];
  for (const n of lines) for (const o of oldLines) {
    if (o.axis !== n.axis || Math.abs(o.pos - n.pos) > EPS) continue;
    const ov = Math.min(o.e, n.e) - Math.max(o.s, n.s);
    if (ov > EPS) pairs.push({ n, o, ov });
  }
  pairs.sort((p, q) => q.ov - p.ov);
  for (const { n, o } of pairs) if (n.id == null && !used.has(o.id)) { n.id = o.id; used.add(o.id); }
  for (const n of lines) if (n.id == null) n.id = nextId++;
  const lineage = new Map();
  for (const { n, o } of pairs) { if (!lineage.has(o.id)) lineage.set(o.id, []); lineage.get(o.id).push(n.id); }
  return lineage;
}

/* The plan for a set of divider lines: { segs, lineage }, or null when the result is not a layout (a space thinner than MIN_CELL
 * that was not there before, or an end resting on nothing). Merging, ids and what each end rests on all come from the lines alone. */
function finishLines(R, lines, cells, oldLines = currentLayout().lines, loose = false) {
  lines = joinNarrow(mergeLines(lines)).map(l => ({ axis: l.axis, pos: l.pos, s: l.s, e: l.e }));
  if (!loose) {
    const same = (a, b) => ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) < EPS);
    const small = r => (r.w < MIN_CELL - EPS || r.h < MIN_CELL - EPS) && !cells.some(c => same(c, r));
    if (!linesValid(R, lines)) return null;
    if (regionFaces(R.x, R.y, R.w, R.h, lines.map(lineRect)).some(f => (f.rects || [f]).some(small))) return null;
  }
  const lineage = assignIds(oldLines, lines);
  const segs = segsFromLines(R, lines);
  return segs ? { segs, lineage } : null;
}
// The plan that the layout becomes with the divider lines `segs` left in it (hanging ends carried on), or null
function rebuildWithout(segs) {
  const R = wholeRect(), lines = mergeLines(segs);
  extendHanging(R, lines);
  return finishLines(R, lines, currentLayout().cells);
}

/* ---------- old saves: a tree of grids and L-shapes, turned into dividers ---------- */
function legacyFractions(e, key) { return Array.isArray(e[key]) ? e[key] : []; }
function legacyEllGeom(e, x, y, w, h) {
  const pw = e.fx * (w - WALL), ph = e.fy * (h - WALL), left = e.corner[1] === 'l', top = e.corner[0] === 't';
  const vx = left ? x + pw : x + w - pw - WALL, hy = top ? y + ph : y + h - ph - WALL;
  const vy0 = top ? y : hy, vy1 = top ? hy + WALL : y + h;
  const hx0 = left ? x : vx + WALL, hx1 = left ? vx : x + w;
  const cut = { x: left ? x : x + w - pw - WALL, y: top ? y : y + h - ph - WALL, w: pw + WALL, h: ph + WALL };
  const items = [];
  legacyFractions(e, 'cx').forEach((f, i) => items.push({ kind: 'x', a: x + f * (w - WALL), anchor: y + (Number.isFinite((e.ax || [])[i]) ? e.ax[i] : 0.5) * h, n: Number.isFinite((e.ox || [])[i]) ? e.ox[i] : 0 }));
  legacyFractions(e, 'cy').forEach((f, i) => items.push({ kind: 'y', a: y + f * (h - WALL), anchor: x + (Number.isFinite((e.ay || [])[i]) ? e.ay[i] : 0.5) * w, n: Number.isFinite((e.oy || [])[i]) ? e.oy[i] : 0 }));
  const made = [];
  for (const it of [...items].sort((p, q) => p.n - q.n)) {
    let c;
    if (it.kind === 'x') {
      const inPocket = left ? it.a + WALL <= cut.x + cut.w + EPS : it.a >= cut.x - EPS;
      let [c0, c1] = inPocket ? (top ? [cut.y + cut.h, y + h] : [y, cut.y]) : [y, y + h];
      for (const p of made) {
        if (p.kind !== 'y' || p.n >= it.n || it.a + WALL <= p.x + EPS || it.a >= p.x + p.w - EPS || p.y + WALL <= c0 + EPS || p.y >= c1 - EPS) continue;
        if (it.anchor >= p.y + WALL / 2) c0 = Math.max(c0, p.y + WALL); else c1 = Math.min(c1, p.y);
      }
      c = { ...it, axis: 'v', x: it.a, y: c0, w: WALL, h: c1 - c0 };
    } else {
      const inPocket = top ? it.a + WALL <= cut.y + cut.h + EPS : it.a >= cut.y - EPS;
      let [c0, c1] = inPocket ? (left ? [cut.x + cut.w, x + w] : [x, cut.x]) : [x, x + w];
      for (const p of made) {
        if (p.kind !== 'x' || p.n >= it.n || it.a + WALL <= p.y + EPS || it.a >= p.y + p.h - EPS || p.x + WALL <= c0 + EPS || p.x >= c1 - EPS) continue;
        if (it.anchor >= p.x + WALL / 2) c0 = Math.max(c0, p.x + WALL); else c1 = Math.min(c1, p.x);
      }
      c = { ...it, axis: 'h', x: c0, y: it.a, w: c1 - c0, h: WALL };
    }
    made.push(c);
  }
  return { pocket: { x: left ? x : x + w - pw, y: top ? y : y + h - ph, w: pw, h: ph }, chords: made, v: { x: vx, y: vy0, w: WALL, h: vy1 - vy0 }, hz: { x: hx0, y: hy, w: hx1 - hx0, h: WALL } };
}
// The dividers of an old tree (as lines), and the rectangle of every undivided space in it (for the equal-size links)
function legacyLines(root, W, L) {
  const out = [], leaves = new Map();
  const R = { x: WALL, y: WALL, w: W - 2 * WALL, h: L - 2 * WALL };
  (function walk(n, x, y, w, h) {
    if (!n.kids) { leaves.set(n.id, { x, y, w, h }); return; }
    if (n.ell) {
      const g = legacyEllGeom(n.ell, x, y, w, h);
      out.push({ axis: 'v', pos: g.v.x, s: g.v.y, e: g.v.y + g.v.h }, { axis: 'h', pos: g.hz.y, s: g.hz.x, e: g.hz.x + g.hz.w });
      for (const c of g.chords) out.push(c.axis === 'v' ? { axis: 'v', pos: c.x, s: c.y, e: c.y + c.h } : { axis: 'h', pos: c.y, s: c.x, e: c.x + c.w });
      walk(n.kids[0], g.pocket.x, g.pocket.y, g.pocket.w, g.pocket.h);
      return;
    }
    const nc = n.colF.length, nr = n.rowF.length, aw = w - (nc - 1) * WALL, ah = h - (nr - 1) * WALL;
    const cx = [], cw = [], ry = [], rh = [];
    let p = x;
    n.colF.forEach(f => { cx.push(p); cw.push(f * aw); p += f * aw + WALL; });
    p = y;
    n.rowF.forEach(f => { ry.push(p); rh.push(f * ah); p += f * ah + WALL; });
    for (let i = 0; i < nc - 1; i++) out.push({ axis: 'v', pos: cx[i] + cw[i], s: y, e: y + h });
    for (let j = 0; j < nr - 1; j++) out.push({ axis: 'h', pos: ry[j] + rh[j], s: x, e: x + w });
    n.kids.forEach((k, idx) => walk(k, cx[idx % nc], ry[Math.floor(idx / nc)], cw[idx % nc], rh[Math.floor(idx / nc)]));
  })(root, R.x, R.y, R.w, R.h);
  return { lines: out, leaves, R };
}
// Segs (and the links that can be kept) for a saved tree at drawer size W x L
function migrateTree(root, eq, W, L) {
  const { lines, leaves, R } = legacyLines(root, W, L);
  const plan = finishLines(R, lines, [], [], true);
  if (!plan) return { segs: [], eq: [] };
  const lay = layoutOf(plan.segs, W, L), ms = allMeasures(lay);
  const mapKey = key => {
    const [id, dim] = String(key).split(':'), r = leaves.get(+id);
    if (!r) return null;
    const m = measureAt(lay.lines, lay.R, dim === 'w' ? 'x' : 'y', r.x + r.w / 2, r.y + r.h / 2);
    return ms.some(q => mkey(q) === mkey(m)) ? { ax: m.ax, lo: m.lo, hi: m.hi, at: m.at } : null;
  };
  const links = [];
  for (const { a, b } of eq || []) { const ea = mapKey(a), eb = mapKey(b); if (ea && eb && mkey(ea) !== mkey(eb)) links.push({ a: ea, b: eb }); }
  return { segs: plan.segs, eq: links };
}

/* ---------- the sizes shown in the spaces ----------
 * A size is the gap between the two nearest dividers (or walls) either side of a point, measured one way. It is named by
 * what is on either side, { ax: 'x' (across) | 'y' (along), lo, hi } (a divider's id, or 'W' for a wall), so it means the same
 * thing wherever it is shown. A rectangle shows its width and length; an L-shaped space shows how wide its upright leg is
 * and how deep its flat leg is; other shapes show none. Any size can be set equal to any other. */
const mkey = m => `${m.ax}:${m.lo}:${m.hi}`;
function measureAt(lines, R, ax, x, y) {
  const across = ax === 'x', p = across ? x : y, t = across ? y : x;
  let lo = { id: 'W', c: across ? R.x : R.y }, hi = { id: 'W', c: across ? R.x + R.w : R.y + R.h };
  for (const g of lines) {
    if (g.axis !== (across ? 'v' : 'h') || g.s > t + EPS || g.e < t - EPS) continue;
    const a = g.pos, b = g.pos + WALL;
    if (b <= p + EPS && b > lo.c) lo = { id: g.id, c: b };
    if (a >= p - EPS && a < hi.c) hi = { id: g.id, c: a };
  }
  return { ax, lo: lo.id, hi: hi.id, value: hi.c - lo.c, at: [x, y] };
}
function faceMeasures(c, lines, R) {
  const m = (ax, x, y, extra) => ({ ...measureAt(lines, R, ax, x, y), cell: c.id, ...extra });
  if (!c.poly) return [m('x', c.x + c.w / 2, c.y + c.h / 2, { kind: 'w' }), m('y', c.x + c.w / 2, c.y + c.h / 2, { kind: 'l' })];
  if (c.poly.length === 6 && c.cut) {
    const cut = c.cut, left = cut.x <= c.x + EPS, top = cut.y <= c.y + EPS;
    const vx0 = left ? cut.x + cut.w : c.x, vw = c.w - cut.w, hy0 = top ? cut.y + cut.h : c.y, hh = c.h - cut.h;
    const ay = cut.y + cut.h / 2, ax = cut.x + cut.w / 2;
    return [m('x', vx0 + vw / 2, ay, { kind: 'legx', arrow: { x0: vx0, x1: vx0 + vw, y: ay } }), m('y', ax, hy0 + hh / 2, { kind: 'legy', arrow: { y0: hy0, y1: hy0 + hh, x: ax } })];
  }
  return [];
}
const allMeasures = lay => lay.cells.flatMap(c => faceMeasures(c, lay.lines, lay.R));

/* ---------- names of spaces ----------
 * A space can be given a name. A name belongs to the space it was given to, which is found again after any edit: by the four
 * dividers (or walls) around it (they keep their ids while they are only moved), and otherwise by where it was (the new space
 * that overlaps it most, so when a space is divided its name stays with the larger part). Two names that end up on one space
 * (a divider between them was deleted) keep the first. */
const faceKey = (c, lay) => faceMeasures(c, lay.lines, lay.R).map(mkey).join('|');
const largestRect = c => faceRects(c).reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
const fracOf = (r, R) => [(r.x - R.x) / R.w, (r.y - R.y) / R.h, r.w / R.w, r.h / R.h];
function nameEntryFor(c, lay) { const keys = faceKey(c, lay); return { key: keys, f: fracOf(largestRect(c), lay.R) }; }
function findName(c, lay, byKey) {
  const k = faceKey(c, lay);
  if (k && byKey.has(k)) return byKey.get(k);
  if (k) return null;
  let best = null, bs = 0;                                         // a space of an odd shape has no key: the name whose place overlaps it most
  for (const n of state.names) {
    if (n.key) continue;
    const o = { x: lay.R.x + n.f[0] * lay.R.w, y: lay.R.y + n.f[1] * lay.R.h, w: n.f[2] * lay.R.w, h: n.f[3] * lay.R.h };
    const sc = faceRects(c).reduce((s, r) => s + Math.max(0, Math.min(o.x + o.w, r.x + r.w) - Math.max(o.x, r.x)) * Math.max(0, Math.min(o.y + o.h, r.y + r.h) - Math.max(o.y, r.y)), 0) / (o.w * o.h);
    if (sc > bs) { bs = sc; best = n; }
  }
  return bs >= 0.35 ? best : null;
}
const nameLookup = () => new Map(state.names.filter(n => n.key).map(n => [n.key, n]));
function remapNames() {
  if (!state.names.length) return;
  const lay = currentLayout(), faces = lay.cells.map(c => ({ c, key: faceKey(c, lay), rects: faceRects(c) })), taken = new Set(), out = [];
  for (const n of state.names) {
    let f = n.key ? faces.find(q => q.key === n.key && !taken.has(q.c.id)) : null;
    if (!f) {
      const o = { x: lay.R.x + n.f[0] * lay.R.w, y: lay.R.y + n.f[1] * lay.R.h, w: n.f[2] * lay.R.w, h: n.f[3] * lay.R.h };
      let bs = 0;
      for (const q of faces) {
        if (taken.has(q.c.id)) continue;
        const sc = q.rects.reduce((s, r) => s + Math.max(0, Math.min(o.x + o.w, r.x + r.w) - Math.max(o.x, r.x)) * Math.max(0, Math.min(o.y + o.h, r.y + r.h) - Math.max(o.y, r.y)), 0) / (o.w * o.h);
        if (sc > bs) { bs = sc; f = q; }
      }
      if (bs < 0.35) f = null;
    }
    if (!f) continue;
    taken.add(f.c.id);
    out.push({ name: n.name, ...nameEntryFor(f.c, lay) });
  }
  state.names = out;
}
// Give the space (a cell of the current layout) a name; an empty name takes it away
function setName(cell, text) {
  const lay = currentLayout(), c = lay.cells.find(q => q.id === cell.id);
  if (!c) return;
  const key = faceKey(c, lay), old = findName(c, lay, nameLookup());
  state.names = state.names.filter(n => n !== old);
  const name = cleanName(text).trim();
  if (name) state.names.push({ name, ...nameEntryFor(c, lay) });
}
const nameOf = (c, lay, byKey) => { const n = findName(c, lay, byKey || nameLookup()); return n ? n.name : ''; };

// Gaps either side of a divider at one point along it: the space before it and after it
function gapsAround(lines, R, g, t) {
  let before = g.axis === 'v' ? g.pos - R.x : g.pos - R.y, after = (g.axis === 'v' ? R.x + R.w : R.y + R.h) - g.pos - WALL;
  for (const q of lines) {
    if (q === g || q.axis !== g.axis || q.s > t + EPS || q.e < t - EPS) continue;
    if (q.pos + WALL <= g.pos + EPS) before = Math.min(before, g.pos - q.pos - WALL); else if (q.pos >= g.pos + WALL - EPS) after = Math.min(after, q.pos - g.pos - WALL);
  }
  return [before, after];
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
    segs.sort((a, b) => Math.round(a.pos / EPS) - Math.round(b.pos / EPS) || a.start - b.start);     // positions that differ by float noise are the same line
    let cur = null;
    for (const s of segs) {
      if (cur && Math.abs(s.pos - cur.pos) < EPS && s.start <= cur.end + WALL + EPS) cur.end = Math.max(cur.end, s.end);
      else { if (cur) out.push(cur); cur = { ...s }; }
    }
    if (cur) out.push(cur);
  }
  return out.map(s => ({ axis: s.axis, pos: s.pos, start: s.start, length: s.end - s.start }));
}

// Shipping weight the way UPS bills it (pounds): the acrylic parts plus the honeycomb box, with a 10% margin, against
// the box's dimensional weight (each box side is the insert plus 2 in, each rounded to a whole inch, divided by 139).
// Mirrors pricing/weight_model.py.
const SHIP = { acrylic: 1.18 * 16.387064 / 453.59237, honeycomb: 6 / (48 * 96), allowance: 2, safety: 1.10, divisor: 139 };
function shippingFor(W, L, H, N, DA) {
  const h = H - WALL;
  const area = W * L + 2 * h * (L + W - 2 * WALL) + DA;                       // every part that gets cut
  const acrylic = area * WALL * SHIP.acrylic;
  const a = W + SHIP.allowance, b = L + SHIP.allowance, c = H + SHIP.allowance;
  const box = 2 * (a * b + a * c + b * c) * SHIP.honeycomb;
  const actual = (acrylic + box) * SHIP.safety;
  const round = v => Math.floor(v + 0.5);                                      // UPS: nearest whole inch, halves up
  const dimensional = round(a) * round(b) * round(c) / SHIP.divisor;
  return { acrylic, box, actual, dimensional, boxDims: [round(a), round(b), round(c)], billable: Math.max(1, Math.ceil(Math.max(actual, dimensional) - 1e-9)) };
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
  const zero = { drawer: 0, dividerCost: 0, dividers: 0, dividerArea: 0, total: 0, shipping: { billable: 0 } };
  if (!state.dims) return zero;
  const { W, L, H, partH } = drawerSize();
  const divs = physicalDividers(currentLayout().divs);
  const dividerArea = Math.round(divs.reduce((s, d) => s + d.length * partH, 0) * 100) / 100;   // the value the order form receives
  const total = priceFor(W, L, H, divs.length, dividerArea);
  const drawer = Math.min(total, priceFor(W, L, H, 0, 0));                    // the empty insert; the dividers account for the rest
  return { drawer, dividerCost: total - drawer, dividers: divs.length, dividerArea, total, shipping: shippingFor(W, L, H, divs.length, dividerArea) };
}
const estimatePrice = () => priceBreakdown().total;

/* ---------- history / persistence ---------- */
const snapshot = () => JSON.stringify({ segs: state.segs, eq: state.eq, fix: state.fix, names: state.names });
function loadSnapshot(text) {
  const s = JSON.parse(text);
  state.segs = s.segs;
  state.eq = s.eq || [];
  state.fix = s.fix || [];
  state.names = s.names || [];
}
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ u: IN, decimal: state.decimal, dims: state.dims, drawer: state.drawer, gap: state.gap, label: state.label, segs: state.segs, eq: state.eq, fix: state.fix, names: state.names, photo: state.photo, suggested: state.suggested })); } catch (e) { /* storage unavailable */ }
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && saved.dims && (saved.segs || saved.root)) {
      const k = saved.u === IN ? 1 : EIGHTH;                       // saves made before decimal input counted eighths of an inch
      const scale = o => o && { w: Math.round(o.w * k), l: Math.round(o.l * k), h: Math.round(o.h * k) };
      state.dims = scale(saved.dims);
      state.gap = Number.isFinite(saved.gap) && saved.gap * k >= 0 && saved.gap * k <= GAP_MAX ? Math.round(saved.gap * k) : 0;       // older saves were sizes of the insert itself: no gap
      state.drawer = scale(saved.drawer) || { w: state.dims.w + 2 * state.gap, l: state.dims.l + 2 * state.gap, h: state.dims.h + state.gap };
      state.decimal = !!saved.decimal || [state.drawer.w, state.drawer.l, state.drawer.h, state.gap].some(v => v % EIGHTH !== 0);
      state.label = cleanLabel(saved.label);
      const { W, L } = drawerSize();
      state.fix = []; state.names = []; state.photo = !!saved.photo; state.suggested = !!saved.suggested;
      if (Array.isArray(saved.segs)) { state.segs = saved.segs; state.eq = Array.isArray(saved.eq) ? saved.eq : []; state.fix = Array.isArray(saved.fix) ? saved.fix : []; state.names = Array.isArray(saved.names) ? saved.names.filter(n => n && typeof n.name === 'string').map(n => ({ ...n, name: cleanName(n.name) })) : []; }
      else if (saved.root && saved.root.free && Array.isArray(saved.root.free.segs)) { state.segs = saved.root.free.segs; state.eq = []; }
      else { const m = migrateTree(saved.root, saved.eq, W, L); state.segs = m.segs; state.eq = m.eq; }      // a layout saved as a tree of grids and L-shapes: now just its dividers
      if (!segsValid(state.segs, wholeRect())) { state.segs = []; state.eq = []; state.fix = []; state.names = []; }        // a layout that cannot be made at this size: start empty
      nextId = state.segs.reduce((m, g) => Math.max(m, g.id), 0) + 1;
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
 * Two sizes (see the sizes shown in the spaces) can be linked so they stay equal. A size is the gap between two dividers (or
 * walls), so a link is a sum equation on where those dividers are. The solver finds the positions that satisfy every link while
 * moving the dividers as little as possible (a divider with more room either side gives way more, which matches how an
 * unlinked layout scales). A link is kept through any edit that leaves the size meaning the same thing, and released otherwise. */
let pendingNum = null;             // the first size picked while linking: { ax, lo, hi, at }

function eqGroups(eq = state.eq) {
  const parent = new Map();
  const find = k => { while (parent.get(k) !== k) k = parent.get(k); return k; };
  for (const { a, b } of eq) { const ka = mkey(a), kb = mkey(b); if (!parent.has(ka)) parent.set(ka, ka); if (!parent.has(kb)) parent.set(kb, kb); parent.set(find(ka), find(kb)); }
  const roots = [], members = new Map(), groupOf = new Map();
  for (const k of parent.keys()) {
    const r = find(k);
    if (!members.has(r)) { members.set(r, []); roots.push(r); }
    members.get(r).push(k);
  }
  roots.forEach((r, gi) => members.get(r).forEach(k => groupOf.set(k, gi)));
  return { groupOf, groups: roots.map(r => members.get(r)) };
}

// Carry links (and sizes set to a number) through an edit: an end follows its size if the two dividers (or what they became) still have it between them
function sizeMapper(lineage, lay) {
  const ms = allMeasures(lay);
  const near = (cands, at) => cands.reduce((best, m) => (!best || Math.hypot(m.at[0] - at[0], m.at[1] - at[1]) < Math.hypot(best.at[0] - at[0], best.at[1] - at[1]) ? m : best), null);
  return e => {
    let cands = ms.filter(m => m.ax === e.ax && m.lo === e.lo && m.hi === e.hi);
    if (!cands.length && lineage) {
      const los = e.lo === 'W' ? ['W'] : lineage.get(e.lo) || [], his = e.hi === 'W' ? ['W'] : lineage.get(e.hi) || [];
      cands = ms.filter(m => m.ax === e.ax && los.includes(m.lo) && his.includes(m.hi));
    }
    const m = near(cands, e.at);
    return m ? { ax: m.ax, lo: m.lo, hi: m.hi, at: m.at } : null;
  };
}
function remapLinks(eq, lineage, lay) {
  const mapEnd = sizeMapper(lineage, lay), out = [];
  for (const { a, b } of eq) { const ea = mapEnd(a), eb = mapEnd(b); if (ea && eb && mkey(ea) !== mkey(eb)) out.push({ a: ea, b: eb }); }
  return { eq: out, dropped: eq.length - out.length };
}
function remapFixed(fix, lineage, lay) {
  const mapEnd = sizeMapper(lineage, lay), out = [];
  for (const f of fix) { const e = mapEnd(f); if (e && !out.some(o => mkey(o) === mkey(e))) out.push({ ...e, value: f.value }); }
  return { fix: out, dropped: fix.length - out.length };
}
const hasConstraints = () => state.eq.length > 0 || state.fix.length > 0;

function buildProblem(lines, R) {
  const index = new Map(lines.map((g, i) => [g.id, i]));
  const w = lines.map(g => {
    const [before, after] = gapsAround(lines, R, g, (g.s + g.e) / 2);
    return Math.max((before + after) / 2, 0.01);
  });
  return { index, x0: lines.map(g => g.pos), w, rows: [], lines, R };
}
// a size as a sum of divider positions: { t: [[variable, coefficient]], c }, or null if one of its dividers is gone
function sizeRow(prob, m) {
  const { R } = prob, across = m.ax === 'x';
  const t = []; let c = 0;
  if (m.hi === 'W') c += across ? R.x + R.w : R.y + R.h; else { const i = prob.index.get(m.hi); if (i === undefined) return null; t.push([i, 1]); }
  if (m.lo === 'W') c -= across ? R.x : R.y; else { const i = prob.index.get(m.lo); if (i === undefined) return null; t.push([i, -1]); c -= WALL; }
  return { t, c };
}
function linkRows(prob, eq, fix = []) {
  const rows = [];
  for (const { a, b } of eq) {
    const ra = sizeRow(prob, a), rb = sizeRow(prob, b);
    if (ra && rb) rows.push({ t: [...ra.t, ...rb.t.map(([i, k]) => [i, -k])], b: rb.c - ra.c });
  }
  for (const f of fix) { const r = sizeRow(prob, f); if (r) rows.push({ t: r.t, b: f.value - r.c }); }       // a size set to a number
  return rows;
}

// Weighted least-change solution of A x = b.
function projectConstraints(prob, extra) {
  const rows = prob.rows.concat(extra), n = prob.x0.length, m = rows.length;
  const winv = prob.w;
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
  return { x, residual };
}

const segU = (g, R, pos) => (pos - (g.axis === 'v' ? R.x : R.y)) / ((g.axis === 'v' ? R.w : R.h) - WALL);
// Solve the current layout against a set of links (and optionally some dividers held at given positions, for dragging).
// { ok, prob, x }: ok when every link holds and the dividers are still clear of each other.
function solveLinks(eq, { pins = [], noThin = true, fix = state.fix, hold = [] } = {}) {
  const R = wholeRect(), lines = currentLayout().lines, prob = buildProblem(lines, R);
  for (const id of hold) if (prob.index.has(id)) prob.w[prob.index.get(id)] = 1e-9;                  // dividers asked to stay put
  const extra = linkRows(prob, eq, fix);
  for (const p of pins) extra.push({ t: [[prob.index.get(p.id), 1]], b: p.value });
  const { x, residual } = projectConstraints(prob, extra);
  const trial = state.segs.map(g => ({ ...g, u: segU(g, R, x[prob.index.get(g.id)]) }));
  // the dividers must stay clear of each other, and no space may end up thinner than it is now (or than MIN_CELL)
  const ok = residual < 1e-6 && segsValid(trial, R) && (!noThin || minFace(segGeom(trial, R), R) >= Math.min(MIN_CELL, minFace(lines, R)) - 1e-9);
  return { prob, x, ok };
}
// Write solved positions back
function applySolution(prob, x) {
  for (const g of state.segs) g.u = segU(g, prob.R, x[prob.index.get(g.id)]);
}

// After undo, redo or a change of drawer size, make sure the links and set sizes still hold (or release them).
function reconcileLinks(announce) {
  if (!hasConstraints()) return;
  const res = solveLinks(state.eq, { noThin: false });
  if (res.ok) { applySolution(res.prob, res.x); tidyLayout(); reanchorLinks(); }
  else {
    state.eq = []; state.fix = [];
    if (announce) showNote('The equal-size links and set sizes could not be kept at this size, so they were released.', 'warn', 6000);
  }
}
// Put each link's anchor back on its size (the spaces move when dividers do)
function reanchorLinks() {
  const lay = currentLayout();
  if (state.eq.length) state.eq = remapLinks(state.eq, null, lay).eq;
  if (state.fix.length) state.fix = remapFixed(state.fix, null, lay).fix;
}
// Does every link and set size hold in the layout as it is?
function constraintsHold() {
  const ms = allMeasures(currentLayout());
  const val = e => { const m = ms.find(q => mkey(q) === mkey(e)); return m ? m.value : null; };
  return state.eq.every(({ a, b }) => { const x = val(a), y = val(b); return x !== null && y !== null && Math.abs(x - y) < 1e-4; })
    && state.fix.every(f => { const x = val(f); return x !== null && Math.abs(x - f.value) < 1e-4; });
}

// Make the plan the layout. Links and set sizes follow their sizes through the edit; the ones that no longer mean anything are released.
function applyPlan(plan, quiet) {
  if (!plan) return false;
  const had = state.eq.length + state.fix.length;
  state.segs = plan.segs;
  remapNames();
  if (had) {
    const lay = currentLayout(), r = remapLinks(state.eq, plan.lineage, lay), f = remapFixed(state.fix, plan.lineage, lay);
    state.eq = r.eq; state.fix = f.fix;
    let dropped = r.dropped + f.dropped;
    if (!constraintsHold()) {                                      // dividers that were joined or extended may have moved: put the sizes back, or release what cannot be
      const res = solveLinks(state.eq, { noThin: false });
      if (res.ok) applySolution(res.prob, res.x);
      else { dropped += state.eq.length + state.fix.length; state.eq = []; state.fix = []; }
    }
    if (dropped && !quiet) showNote(dropped === 1 ? 'That edit released one equal-size link or set size.' : `That edit released ${dropped} equal-size links or set sizes.`, 'info', 5000);
  }
  return true;
}
// Dividers that now line up (after a drag) are one divider again, and everything is put in its canonical form
function tidyLayout() {
  const R = wholeRect(), lay = currentLayout();
  const plan = finishLines(R, lay.lines.map(({ axis, pos, s, e }) => ({ axis, pos, s, e })), lay.cells);
  if (!plan) return;
  applyPlan(plan, true);
  if (hasConstraints()) { const res = solveLinks(state.eq, { noThin: false }); if (res.ok) applySolution(res.prob, res.x); }      // lines that were merged may have moved a hair: put the links back exactly
}

/* ---------- zoom and pan ---------- */
// view.z multiplies the scale that fits the drawer in the window; (view.u, view.v) is the point of the drawer (inches)
// shown at the middle of the editor. At z = 1 the whole drawer is shown, centred.
const ZMAX = 20;
const view = { z: 1, u: null, v: null };
const pointers = new Map();        // fingers and mouse buttons currently down on the plan
let pinch = null, pan = null;

// Set the zoom so that the drawer point (ix, iy) sits under the screen point (px, py), both relative to the plan.
function applyView(z, ix, iy, px, py) {
  const vw = canvas._view;
  if (!vw) return;
  z = clamp(z, 1, ZMAX);
  if (z === 1) { view.z = 1; view.u = view.v = null; }
  else {
    const s = vw.fit * z;
    view.z = z; view.u = (vw.rcx - (px - ix * s)) / s; view.v = (vw.rcy - (py - iy * s)) / s;
  }
  closePopover();
  renderDrawer(canvas, { interactive: true });
}
function setZoom(z, cx, cy) {                   // cx, cy: the screen point to keep still (client pixels); default the middle
  const vw = canvas._view, r = canvas.getBoundingClientRect();
  if (!vw) return;
  const px = (cx === undefined ? vw.rcx + r.left : cx) - r.left, py = (cy === undefined ? vw.rcy + r.top : cy) - r.top;
  applyView(z, (px - vw.ox) / vw.s, (py - vw.oy) / vw.s, px, py);
}
function panBy(dx, dy) {
  const vw = canvas._view;
  if (!vw || view.z <= 1) return;
  view.u = (vw.rcx - (vw.ox + dx)) / vw.s; view.v = (vw.rcy - (vw.oy + dy)) / vw.s;
  closePopover();
  renderDrawer(canvas, { interactive: true });
}
function updateZoomUI() {
  const pct = $('#zoom-pct');
  if (!pct) return;
  pct.textContent = Math.round(view.z * 100) + '%';
  $('#zoom-out').disabled = view.z <= 1;
  $('#zoom-in').disabled = view.z >= ZMAX;
  $('#zoom-fit').disabled = view.z <= 1;
  $('#stage').classList.toggle('zoomed', view.z > 1);
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
  const fit = Math.max(0.01, Math.min((bw - pad.left - pad.right) / W, (bh - pad.top - pad.bottom) / L));
  const z = interactive ? view.z : 1;
  const s = fit * z;
  const dw = W * s, dl = L * s;
  const rcx = pad.left + (bw - pad.left - pad.right) / 2, rcy = pad.top + (bh - pad.top - pad.bottom) / 2;     // the middle of the area the drawer is fitted to
  const u = z > 1 ? clamp(view.u === null ? W / 2 : view.u, 0, W) : W / 2, v = z > 1 ? clamp(view.v === null ? L / 2 : view.v, 0, L) : L / 2;   // the point of the drawer shown there
  const ox = rcx - u * s, oy = rcy - v * s;
  svg._view = { ox, oy, s, fit, rcx, rcy, W, L };
  if (interactive) updateZoomUI();

  const lay = layoutOf(state.segs, W, L), { cells, lines, R } = lay, namesByKey = nameLookup();
  const out = [`<defs><marker id="leg-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke="#0e7c72" stroke-width="1.4"/></marker></defs>`];
  const line = (x1, y1, x2, y2) => `<line class="dimline" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  const slash = (x, y) => line(x - 4, y + 4, x + 4, y - 4);          // architectural end mark

  // overall dimensions: extension lines, dimension line with slash ends, figure in mono type
  const ay = oy - 22, ax = ox - 24;
  out.push(line(ox, oy - 4, ox, ay - 5), line(ox + dw, oy - 4, ox + dw, ay - 5), line(ox, ay, ox + dw, ay), slash(ox, ay), slash(ox + dw, ay));
  out.push(`<text class="dim-text" x="${ox + dw / 2}" y="${ay - 8}" text-anchor="middle">${fmtIn(state.dims.w)}″</text>`);
  out.push(line(ox - 4, oy, ax - 5, oy), line(ox - 4, oy + dl, ax - 5, oy + dl), line(ax, oy, ax, oy + dl), slash(ax, oy), slash(ax, oy + dl));
  out.push(`<text class="dim-text" transform="translate(${ax - 9} ${oy + dl / 2}) rotate(-90)" text-anchor="middle">${fmtIn(state.dims.l)}″</text>`);

  // sheet stock: walls and dividers show as the gaps between the open spaces
  out.push(`<rect class="wall" x="${ox}" y="${oy}" width="${dw}" height="${dl}"/>`);
  for (const c of cells) {
    if (c.poly) out.push(`<path class="cell lface" data-cell="${c.id}" d="M${c.poly.map(([qx, qy]) => `${ox + qx * s} ${oy + qy * s}`).join('L')}Z"/>`);
    else out.push(`<rect class="cell" data-cell="${c.id}" x="${ox + c.x * s}" y="${oy + c.y * s}" width="${c.w * s}" height="${c.h * s}"/>`);
  }
  out.push(`<g id="hover-layer" pointer-events="none">${hoverMarkup(ox, oy, s)}</g>`);
  if (interactive) svg._cells = cells;
  out.push(`<rect class="outline" x="${ox}" y="${oy}" width="${dw}" height="${dl}"/>`);

  // size of each space. Each number is its own target: select one, then another, to link them as equal.
  const { groupOf } = eqGroups();
  const fixedKeys = new Map(state.fix.map(f => [mkey(f), f.value]));
  const nums = new Map(), chosenKey = pendingNum ? mkey(pendingNum) : null;
  const numEl = (m, text, x, y, anchor, size, boxed) => {
    const key = mkey(m);
    nums.set(key, m);
    const tw = text.length * 0.6 * size, x0 = anchor === 'middle' ? x - tw / 2 : x, pad = Math.max(3, size * 0.3);
    const gi = groupOf.get(key), chosen = chosenKey === key, fixed = fixedKeys.has(key), cls = gi !== undefined ? `g${gi % 4}` : 'fx';
    let chip = '';
    if (gi !== undefined || fixed) {
      chip = `<rect class="num-chip ${cls}" x="${x0 - pad}" y="${y - size * 0.7 - pad / 2}" width="${tw + 2 * pad}" height="${size * 1.4 + pad}" rx="3" pointer-events="none"/>`
        + `<g class="num-lock ${cls}" pointer-events="none"><rect x="${x0 + tw + pad - 9}" y="${y - size * 0.7 - pad / 2 - 4}" width="11" height="9" rx="1.6"/><path d="M${x0 + tw + pad - 6.5} ${y - size * 0.7 - pad / 2 - 4}v-2.6a3 3 0 0 1 6 0v2.6"/></g>`;
    } else if (boxed) chip = `<rect class="num-box" x="${x0 - pad}" y="${y - size * 0.7 - pad / 2}" width="${tw + 2 * pad}" height="${size * 1.4 + pad}" rx="3" pointer-events="none"/>`;
    const tip = fixed ? `Set to ${fmt2(fixedKeys.get(key))}″. Select to change or unlock it.` : gi !== undefined ? 'Linked: stays equal to its partner. Select to unlock.' : (pendingNum ? 'Select to make this equal to the number you picked.' : 'Select, then pick a number in another space to make them equal.');
    return `${chip}<rect class="num-hit${chosen ? ' sel' : ''}" data-num="${key}" data-ncell="${m.cell}" x="${x0 - pad}" y="${y - size * 0.7 - pad / 2}" width="${tw + 2 * pad}" height="${size * 1.4 + pad}" rx="3"><title>${tip}</title></rect>`
      + `<text class="cell-label" x="${x0}" y="${y}" font-size="${size}" dominant-baseline="central">${text}</text>`;
  };
  for (const c of cells) {
    const ms = faceMeasures(c, lines, R), nm = nameOf(c, lay, namesByKey);
    const fit = (t, px, size) => (t.length * size * 0.62 <= px ? t : t.slice(0, Math.max(1, Math.floor(px / (size * 0.62)) - 1)) + '…');      // a name cut to the room there is
    if (!ms.length) {                                     // a space that is neither a rectangle nor an L: just a name, in its largest part
      const lg = c.rects.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
      const lx0 = Math.max(ox + lg.x * s, 0), lx1 = Math.min(ox + (lg.x + lg.w) * s, bw), ly0 = Math.max(oy + lg.y * s, 0), ly1 = Math.min(oy + (lg.y + lg.h) * s, bh);
      const fs = Math.min(14, (lx1 - lx0 - 6) / 5.2, (ly1 - ly0 - 6) / 1.4);
      if (fs >= 6) out.push(`<text class="cell-label" x="${(lx0 + lx1) / 2}" y="${(ly0 + ly1) / 2}" font-size="${fs}" text-anchor="middle" dominant-baseline="central">${esc(nm ? fit(nm, lx1 - lx0 - 6, fs) : 'Odd shape')}</text>`);
      continue;
    }
    if (c.poly) {                                         // an L: a number across each of its two legs, with an arrow showing what is measured
      if (nm) {                                           // its name goes in the largest part, clear of the two arrows
        const lg = largestRect(c), spots = ms.map(m => [ox + (m.arrow.x0 !== undefined ? (m.arrow.x0 + m.arrow.x1) / 2 : m.arrow.x) * s, oy + (m.arrow.y0 !== undefined ? (m.arrow.y0 + m.arrow.y1) / 2 : m.arrow.y) * s]);
        let bx = 0, by = 0, bd = -1;
        for (const fx of [0.25, 0.5, 0.75]) for (const fy of [0.25, 0.5, 0.75]) {
          const px = ox + (lg.x + lg.w * fx) * s, py = oy + (lg.y + lg.h * fy) * s, d = Math.min(...spots.map(([sx, sy]) => Math.hypot(px - sx, (py - sy) * 1.3)));
          if (d > bd) { bd = d; bx = px; by = py; }
        }
        if (bx > 0 && by > 0 && bx < bw && by < bh) out.push(`<text class="cell-label name-label" x="${bx}" y="${by}" font-size="14" text-anchor="middle" dominant-baseline="central">${esc(fit(nm, lg.w * s - 8, 14))}</text>`);
      }
      for (const m of ms) {
        const across = m.kind === 'legx', a = m.arrow, text = fmt2(m.value) + '″';
        const [p0, p1] = across ? [ox + a.x0 * s, ox + a.x1 * s] : [oy + a.y0 * s, oy + a.y1 * s], at = across ? oy + a.y * s : ox + a.x * s;
        const [lo, hi] = across ? [20, bw - 20] : [20, bh - 20], v0 = Math.max(p0, lo), v1 = Math.min(p1, hi);       // zoomed in, only part of the arrow shows: put the number in that part
        if (at < 0 || at > (across ? bh : bw) || v1 - v0 < 10) continue;
        const mid = p0 + (p1 - p0) / 2 >= v0 && p0 + (p1 - p0) / 2 <= v1 ? (p0 + p1) / 2 : (v0 + v1) / 2;
        const [cx, cy] = across ? [mid, at] : [at, mid];
        const fs = 14, room = p1 - p0, chipW = text.length * 0.6 * fs + 16;
        if (room >= chipW + 28) {
          out.push(across ? `<line class="leg-line" x1="${p0 + 3}" y1="${at}" x2="${p1 - 3}" y2="${at}" marker-start="url(#leg-arrow)" marker-end="url(#leg-arrow)"/>` : `<line class="leg-line" x1="${at}" y1="${p0 + 3}" x2="${at}" y2="${p1 - 3}" marker-start="url(#leg-arrow)" marker-end="url(#leg-arrow)"/>`);
          out.push(numEl(m, text, cx, cy, 'middle', fs, true));
        } else if (across ? room >= text.length * 6 + 10 : true) {
          const sz = across ? Math.min(fs, (room - 10) / (text.length * 0.6)) : fs;       // too narrow for the arrow: just the number
          if (sz >= 8) out.push(numEl(m, text, cx, cy, 'middle', sz, true));
        }
      }
      continue;
    }
    // zoomed in, a space is mostly off screen: put its label in the part that is showing
    const px0 = Math.max(ox + c.x * s, 0), px1 = Math.min(ox + (c.x + c.w) * s, bw), py0 = Math.max(oy + c.y * s, 0), py1 = Math.min(oy + (c.y + c.h) * s, bh);
    if (px1 - px0 < 4 || py1 - py0 < 4) continue;
    const wpx = px1 - px0, hpx = py1 - py0;
    const a = fmt2(ms[0].value) + '″', b = fmt2(ms[1].value) + '″';
    const cx = (px0 + px1) / 2, cy = (py0 + py1) / 2;
    let fs = Math.min(16, (wpx - 12) / 8.6);
    if (nm && hpx > 52 && wpx > 50) out.push(`<text class="cell-label name-label" x="${cx}" y="${cy - Math.max(fs, 12) * 1.5}" font-size="${Math.max(11, Math.min(15, fs))}" text-anchor="middle" dominant-baseline="central">${esc(fit(nm, wpx - 10, Math.max(11, Math.min(15, fs))))}</text>`);
    if (fs >= 10.5 && hpx > 24) {
      const cw = 0.6 * fs, wW = a.length * cw, wL = b.length * cw, gap = fs * 0.85, x0 = cx - (wW + 2 * gap + wL) / 2;
      out.push(numEl(ms[0], a, x0, cy, 'start', fs));
      out.push(`<text class="cell-label" x="${x0 + wW + gap}" y="${cy}" font-size="${fs}" text-anchor="middle" dominant-baseline="central">×</text>`);
      out.push(numEl(ms[1], b, x0 + wW + 2 * gap, cy, 'start', fs));
    } else {
      fs = Math.min(14, (wpx - 6) / 3.4, (hpx - 6) / 3.2);
      if (fs >= 5.5) {
        out.push(numEl(ms[0], a, cx, cy - fs * 0.75, 'middle', fs));
        out.push(numEl(ms[1], b, cx, cy + fs * 0.75, 'middle', fs));
      }
    }
  }
  if (interactive) svg._nums = nums;

  if (interactive) {
    // grab areas for dividers: one per run between the dividers that cross it, so each can be moved on its own
    for (const g of lines) {
      const thick = Math.max(WALL * s, 14);
      dragParts(lines, g).forEach((sp, pi) => {
        let x, y, w, h;
        if (g.axis === 'v') { x = ox + (g.pos + WALL / 2) * s - thick / 2; w = thick; y = oy + sp[0] * s; h = (sp[1] - sp[0]) * s; }
        else { y = oy + (g.pos + WALL / 2) * s - thick / 2; h = thick; x = ox + sp[0] * s; w = (sp[1] - sp[0]) * s; }
        const active = lineDrag && lineDrag.items.some(it => it.id === g.id) ? ' active' : '';
        out.push(`<rect class="hit${active}" data-seg="${g.id}" data-part="${pi}" data-axis="${g.axis}" x="${x}" y="${y}" width="${w}" height="${h}" rx="2"><title>Drag to move. Select to see its sizes or delete it.</title></rect>`);
      });
    }
    // an L (two dividers that end on each other): the round handle at its corner moves both
    for (const j of ellJoints(state.segs)) {
      const v = lines.find(l => l.id === j.v), h = lines.find(l => l.id === j.h);
      if (v && h) out.push(`<circle class="ell-corner" data-joint="1" data-v="${j.v}" data-h="${j.h}" cx="${ox + (v.pos + WALL / 2) * s}" cy="${oy + (h.pos + WALL / 2) * s}" r="9"><title>Drag to move the corner of the L. Select it for options.</title></circle>`);
    }
    // front edge: a bracket under the drawer with its name in the middle
    const fy = oy + dl + 20, fx = ox + dw / 2;
    out.push(line(ox, fy, fx - 96, fy), line(fx + 96, fy, ox + dw, fy), line(ox, fy - 6, ox, fy + 6), line(ox + dw, fy - 6, ox + dw, fy + 6));
    out.push(`<text class="front-text" x="${fx}" y="${fy + 4}" text-anchor="middle">Front of drawer</text>`);
  }

  // empty drawer: invite the first division
  if (interactive && !state.segs.length && cells[0]) {
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
let lineDrag = null;   // active drag of a divider (two, by the corner of an L)
let press = null;      // pending click on a space
let popoverCell = null;
let numPress = null;   // a pending click on a number

canvas.addEventListener('pointerdown', e => {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {                      // a second finger: pinch to zoom, and drag to move, instead of anything else
    if (lineDrag) { loadSnapshot(lineDrag.before); lineDrag = null; refresh(); }
    numPress = null; press = null; pan = null;
    const [a, b] = [...pointers.values()], vw = canvas._view, r = canvas.getBoundingClientRect();
    const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
    pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: view.z, ix: (cx - vw.ox) / vw.s, iy: (cy - vw.oy) / vw.s };
    closePopover();
    return;
  }
  if (pointers.size > 2) return;
  const num = e.target.closest('[data-num]');
  if (num) {
    closePopover();
    numPress = { key: num.dataset.num, cell: +num.dataset.ncell, x: e.clientX, y: e.clientY };
    press = null;
    return;
  }
  const corner = e.target.closest('[data-joint]');
  if (corner) { closePopover(); startLineDrag([+corner.dataset.v, +corner.dataset.h], null, e, { joint: { v: +corner.dataset.v, h: +corner.dataset.h } }); return; }
  const hit = e.target.closest('[data-seg]');
  if (hit) { closePopover(); startLineDrag([+hit.dataset.seg], +hit.dataset.part, e, null); return; }
  const cell = e.target.closest('[data-cell]');
  press = cell ? { id: +cell.dataset.cell, x: e.clientX, y: e.clientY } : null;
  if (!cell) {
    closePopover(); if (pendingNum) { pendingNum = null; refresh(); }
    if (view.z > 1) { pan = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); }     // empty ground: drag to move the view
  }
});

// Zoomed in, dragging a space (rather than clicking it) moves the view too. Two fingers pinch.
canvas.addEventListener('pointermove', e => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (e.pointerType !== 'touch' && !lineDrag && !pinch && !pan) updateHover(e);
  if (lineDrag) { moveLines(e); return; }
  if (pinch) {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()], r = canvas.getBoundingClientRect();
    applyView(pinch.z0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0, pinch.ix, pinch.iy, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
    return;
  }
  if (!pan && press && view.z > 1 && Math.hypot(e.clientX - press.x, e.clientY - press.y) >= 6) {
    pan = { x: press.x, y: press.y }; press = null; canvas.setPointerCapture(e.pointerId);
  }
  if (pan) { panBy(e.clientX - pan.x, e.clientY - pan.y); pan = { x: e.clientX, y: e.clientY }; }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pinch && pointers.size < 2) pinch = null;
  pan = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', e => {
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(view.z * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.12 : 0.004)), e.clientX, e.clientY); }
  else if (view.z > 1) { e.preventDefault(); panBy(-(e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX), e.shiftKey && !e.deltaX ? 0 : -e.deltaY); }
}, { passive: false });
$('#zoom-in').addEventListener('click', () => setZoom(view.z * 1.5));
$('#zoom-out').addEventListener('click', () => setZoom(view.z / 1.5));
$('#zoom-fit').addEventListener('click', () => setZoom(1));
{
  const mq = window.matchMedia('(max-width: 600px)'), ctl = $('#zoom-ctl');
  const place = () => {
    ctl.classList.toggle('in-bar', mq.matches);
    if (mq.matches) $('.bar-end').insertBefore(ctl, $('#expand')); else $('#stage').insertBefore(ctl, canvas);
  };
  place();
  mq.addEventListener('change', place);
}

/* ---------- moving dividers ---------- */
// The runs of a divider between the dividers that cross it (both sides), each a [start, end]: each run can be moved on its own
function dragParts(lines, g) {
  const cuts = lines.filter(q => q.axis !== g.axis && q.s < g.pos - EPS && q.e > g.pos + WALL + EPS && q.pos >= g.s - EPS && q.pos + WALL <= g.e + EPS)
    .map(q => [q.pos, q.pos + WALL]).sort((a, b) => a[0] - b[0]);
  const parts = [];
  let from = g.s;
  for (const [a, b] of cuts) { if (a - from > EPS) parts.push([from, a]); from = Math.max(from, b); }
  if (g.e - from > EPS) parts.push([from, g.e]);
  return parts;
}
const sortLines = lines => lines.sort((p, q) => (p.axis === q.axis ? 0 : p.axis < q.axis ? 1 : -1) || Math.round(p.pos / EPS) - Math.round(q.pos / EPS) || p.s - q.s);
// A divider that crosses others is cut at them so that one run can be moved alone; the run asked for keeps the divider's id
function splitForDrag(gid, partIdx) {
  const lay = currentLayout(), g = lay.lines.find(l => l.id === gid);
  const parts = g ? dragParts(lay.lines, g) : [];
  if (parts.length <= 1) return gid;
  const lines = lay.lines.filter(l => l.id !== gid).map(({ id, axis, pos, s, e }) => ({ id, axis, pos, s, e }));
  const ids = parts.map((_, i) => (i === partIdx ? gid : nextId++));
  parts.forEach((p, i) => lines.push({ id: ids[i], axis: g.axis, pos: g.pos, s: p[0], e: p[1] }));
  const segs = segsFromLines(lay.R, sortLines(lines));
  if (!segs) return gid;
  const lineage = new Map(lay.lines.map(l => [l.id, [l.id]]));
  lineage.set(gid, ids);
  applyPlan({ segs, lineage }, true);
  return ids[partIdx];
}
// the gaps either side of a divider, against every divider that faces it
function facingGaps(lines, R, g) {
  let before = g.axis === 'v' ? g.pos - R.x : g.pos - R.y, after = (g.axis === 'v' ? R.x + R.w : R.y + R.h) - g.pos - WALL;
  for (const q of lines) {
    if (q === g || q.axis !== g.axis || Math.min(q.e, g.e) - Math.max(q.s, g.s) <= EPS) continue;
    if (q.pos + WALL <= g.pos + EPS) before = Math.min(before, g.pos - q.pos - WALL); else if (q.pos >= g.pos + WALL - EPS) after = Math.min(after, q.pos - g.pos - WALL);
  }
  return [before, after];
}
// The panel for a divider: what is either side of it, where it was clicked, and whether it is an arm of an L
function dividerInfoFor(sid, px, py) {
  const lay = currentLayout(), g = lay.lines.find(l => l.id === sid);
  if (!g) return null;
  const [ix, iy] = pointToDrawer(px, py), t = g.axis === 'v' ? iy : ix;
  return { sid, axis: g.axis, size: gapsAround(lay.lines, lay.R, g, clamp(t, g.s, g.e)), joint: jointOf(sid) };
}
// The two dividers that end on each other (a vertical and a horizontal one): an L
function ellJoints(segs) {
  const out = [];
  for (const v of segs) for (const h of segs) {
    if (v.axis !== 'v' || h.axis !== 'h') continue;
    if ([v.a, v.b].some(sp => sp.r === h.id) && [h.a, h.b].some(sp => sp.r === v.id)) out.push({ v: v.id, h: h.id });
  }
  return out;
}
const jointOf = sid => ellJoints(state.segs).find(j => j.v === sid || j.h === sid) || null;

function startLineDrag(ids, part, e, extra) {
  const before = snapshot();
  const info = !extra ? dividerInfoFor(ids[0], e.clientX, e.clientY) : null;
  if (part !== null) ids = [splitForDrag(ids[0], part)];
  const R = wholeRect(), lines = currentLayout().lines;
  const items = ids.map(id => {
    const g = lines.find(l => l.id === id), [b, a] = facingGaps(lines, R, g);
    const cands = lines.filter(o => o !== g && o.axis === g.axis && Math.min(o.e, g.e) - Math.max(o.s, g.s) > -WALL - EPS).map(o => o.pos);
    return { id, axis: g.axis, pos0: g.pos, lo: g.pos - b, hi: g.pos + a, cands, cur: g.pos };
  });
  lineDrag = { items, x0: e.clientX, y0: e.clientY, before, R, moved: false, info, joint: extra && extra.joint, thin: Math.min(MIN_CELL, minFace(lines, R)) };
  canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
}
// Put the dividers at `target` positions: all the way if that is allowed (clear of each other, links holding), otherwise as far as is
function placeLines(d, target) {
  const R = d.R, from = d.items.map(it => it.cur);
  const pinsAt = t => d.items.map((it, i) => ({ id: it.id, value: from[i] + (target[i] - from[i]) * t }));
  const roomy = trial => d.thin === undefined || minFace(segGeom(trial, R), R) >= d.thin - 1e-9;      // no space gets thinner than it was (or than MIN_CELL)
  const attempt = t => {
    const pins = pinsAt(t);
    if (hasConstraints()) {
      const res = solveLinks(state.eq, { pins });
      if (!res.ok || !roomy(state.segs.map(g => ({ ...g, u: segU(g, R, res.x[res.prob.index.get(g.id)]) })))) return null;
      return () => applySolution(res.prob, res.x);
    }
    const trial = state.segs.map(g => { const p = pins.find(q => q.id === g.id); return p ? { ...g, u: segU(g, R, p.value) } : g; });
    return segsValid(trial, R) && roomy(trial) ? () => { for (const p of pins) { const g = state.segs.find(q => q.id === p.id); g.u = segU(g, R, p.value); } } : null;
  };
  let best = attempt(1), reached = 1;
  if (!best) {
    let lo = 0, hi = 1;
    for (let k = 0; k < 14; k++) { const mid = (lo + hi) / 2, f = attempt(mid); if (f) { lo = mid; best = f; } else hi = mid; }
    reached = lo;
  }
  if (best) best();
  d.items.forEach((it, i) => { it.cur = from[i] + (target[i] - from[i]) * reached; });
}
function moveLines(e) {
  const d = lineDrag;
  if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
  d.moved = true;
  const { s } = canvas._view;
  const target = d.items.map(it => {
    const delta = (it.axis === 'v' ? e.clientX - d.x0 : e.clientY - d.y0) / s;
    let pos = it.lo + Math.round((it.pos0 + delta - it.lo) / SNAP) * SNAP;
    const near = it.cands.reduce((best, c) => (Math.abs(c - pos) < Math.abs(best - pos) ? c : best), Infinity);
    if (Math.abs(near - pos) < 8 / s) pos = near;
    return clamp(pos, it.lo + MIN_CELL, Math.max(it.lo + MIN_CELL, it.hi - MIN_CELL));
  });
  placeLines(d, target);
  renderDrawer(canvas, { interactive: true });
}
function endLineDrag(e) {
  const d = lineDrag;
  lineDrag = null;
  if (!d) return;
  if (d.moved && snapshot() !== d.before) { tidyLayout(); commit(); return; }
  loadSnapshot(d.before);                                        // a plain click leaves the layout untouched
  refresh();
  if (!d.moved && e) {
    if (d.joint) openEllPopover(d.joint, e.clientX, e.clientY);
    else if (d.info) openDividerPopover(d.info, e.clientX, e.clientY);
  }
}
canvas.addEventListener('pointerup', e => {
  if (lineDrag) { endLineDrag(e); return; }
  if (numPress) {
    const np = numPress; numPress = null;
    if (Math.hypot(e.clientX - np.x, e.clientY - np.y) < 6) onNumberClick(np.key, np.cell, e.clientX, e.clientY);
    return;
  }
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) openPopover(press.id, e.clientX, e.clientY);
  press = null;
});
canvas.addEventListener('pointercancel', () => { numPress = null; if (lineDrag) { loadSnapshot(lineDrag.before); lineDrag = null; refresh(); } press = null; });

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
  const msg = transientNote;
  el.hidden = !msg;
  if (msg) { el.textContent = msg.text; el.className = 'note-bar ' + msg.kind; }
  updateSetBar();
}

/* ---------- setting a size to a number ----------
 * Selecting a number (to link it) also offers "Set to a specific number" in a bar at the top of the editor. The size is then
 * held at that number until it is unlocked, like a link: dragging or resizing cannot change it. A number that cannot be had is
 * refused with the reason. */
let setOpen = false;                                  // the number picker in the bar is showing
const fmtSize = x => `${fmt2(x)}″`;
// Hold the size at v while every other link and set size still holds, or null. Tries moving either divider of the size, then both.
function trySetSize(m, v, geometryOnly) {
  const fix = [...(geometryOnly ? [] : state.fix.filter(f => mkey(f) !== mkey(m))), { ax: m.ax, lo: m.lo, hi: m.hi, at: m.at, value: v }], eq = geometryOnly ? [] : state.eq;
  for (const hold of [[], m.lo === 'W' ? [] : [m.lo], m.hi === 'W' ? [] : [m.hi]]) {
    const res = solveLinks(eq, { fix, hold });
    if (res.ok) return { res, fix };
  }
  return null;
}
// The smallest and largest this size can be (with the links and set sizes, or just the room there is)
function sizeRange(m, geometryOnly) {
  const R = wholeRect(), top = m.ax === 'x' ? R.w : R.h, ok = v => !!trySetSize(m, v, geometryOnly);
  const edge = (from, to) => { if (ok(to)) return to; let a = from, b = to; for (let k = 0; k < 22; k++) { const mid = (a + b) / 2; if (ok(mid)) a = mid; else b = mid; } return a; };
  return [edge(m.value, MIN_CELL), edge(m.value, top)];
}
// Why a size cannot be set to v
function explainSize(m, v) {
  const R = wholeRect(), which = m.ax === 'x' ? 'wide' : 'long', lo2 = x => fmtSize(Math.ceil(x * 100 - 1e-6) / 100), hi2 = x => fmtSize(Math.floor(x * 100 + 1e-6) / 100);
  if (m.lo === 'W' && m.hi === 'W') return `This space runs from wall to wall, so the drawer sets how ${which} it is (${fmtSize(m.value)}). Change the drawer size to change it.`;
  if (!(v >= MIN_CELL - 1e-9)) return `A space has to be at least 1/16″ ${which}, or the dividers around it would touch.`;
  const geo = sizeRange(m, true);
  if (v > geo[1] + 1e-6) return `That is too big. With the other dividers where they are (each kept at least 1/16″ clear of the next one), this space can be at most ${hi2(geo[1])} ${which}.`;
  if (v < geo[0] - 1e-6) return `That is too small. With the other dividers where they are, this space can be at least ${lo2(geo[0])} ${which}.`;
  const rng = sizeRange(m, false);
  if (rng[1] - rng[0] < 1e-3) return `This number can't change right now: the numbers that are linked or set to a size hold it at ${fmtSize(m.value)}. Unlock one of them first.`;
  return `That does not fit with the numbers that are linked or set to a size elsewhere: with them, this space can be between ${lo2(rng[0])} and ${hi2(rng[1])} ${which}. Unlock one of them, or choose a number in that range.`;
}
function setSizeFromBar() {
  const m = pendingNum, err = $('#set-error');
  let v;
  if (state.decimal) {
    v = parseDecimal($('#set-dec').value);
    if (v === null) { err.textContent = 'Enter a number, such as 6.25.'; err.hidden = false; return; }
    v /= IN;
  } else v = +$('#set-select').value * EIGHTH / IN;
  const hit = trySetSize(m, v, false);
  if (!hit) { err.textContent = explainSize(m, v); err.hidden = false; return; }
  applySolution(hit.res.prob, hit.res.x);
  state.fix = hit.fix;
  tidyLayout();
  reanchorLinks();
  pendingNum = null; setOpen = false;
  transientNote = null;
  commit();
}
function openSetForm() {
  const m = pendingNum;
  if (!m) return;
  const R = wholeRect(), top = m.ax === 'x' ? R.w : R.h;
  setOpen = true;
  const sel = $('#set-select');
  if (!sel.options.length || sel.dataset.top !== String(Math.floor(top * 8))) {            // every size in steps of 1/8″ that could fit between the walls
    sel.innerHTML = '';
    sel.dataset.top = String(Math.floor(top * 8));
    for (let n = 1; n <= Math.floor(top * 8); n++) sel.add(new Option(`${fmtIn(n * EIGHTH)}″`, n));
  }
  sel.value = String(Math.min(Math.max(1, Math.round(m.value * 8)), Math.floor(top * 8)));
  $('#set-dec').value = String(+m.value.toFixed(4));
  $('#set-error').hidden = true;
  updateSetBar();
  (state.decimal ? $('#set-dec') : sel).focus();
}
function updateSetBar() {
  const bar = $('#set-bar'), on = !!pendingNum;
  bar.hidden = !on;
  $('#stage').classList.toggle('has-setbar', on);
  if (!on) { setOpen = false; return; }
  $('#set-msg').textContent = setOpen ? `Set this number (now ${fmtSize(pendingNum.value)}) to:` : 'Now select the number it should match, or';
  $('#set-open').hidden = setOpen;
  $('#set-form').hidden = !setOpen;
  $('#set-select').hidden = state.decimal; $('#set-dec').hidden = !state.decimal;
}
on('#set-open', 'click', openSetForm);
on('#set-cancel', 'click', () => { pendingNum = null; setOpen = false; refresh(); });
on('#set-apply', 'click', setSizeFromBar);
on('#set-dec', 'input', e => { const t = cleanDecimalText(e.target.value); if (t !== e.target.value) e.target.value = t; $('#set-error').hidden = true; });
on('#set-select', 'change', () => { $('#set-error').hidden = true; });
on('#set-bar', 'keydown', e => { if (e.key === 'Enter' && setOpen) { e.preventDefault(); setSizeFromBar(); } else if (e.key === 'Escape') { e.stopPropagation(); pendingNum = null; setOpen = false; refresh(); } });

/* ---------- linking two numbers ---------- */
function onNumberClick(key, cellId, px, py) {
  const m = canvas._nums && canvas._nums.get(key);
  if (!m) return;
  const { groupOf } = eqGroups();
  if (pendingNum) {
    if (mkey(pendingNum) === key) {                              // the same number again: let go of it
      if (pendingNum.cell === cellId) { pendingNum = null; refresh(); return; }
      pendingNum = null; showNote('Those two are already the same size, because they sit between the same two dividers.', 'info'); refresh(); return;
    }
    if (pendingNum.cell === cellId) { showNote('Pick a number in a different space.'); return; }
    if (groupOf.has(key) && groupOf.get(key) === groupOf.get(mkey(pendingNum))) { pendingNum = null; showNote('Those two are already linked.'); refresh(); return; }
    const end = x => ({ ax: x.ax, lo: x.lo, hi: x.hi, at: x.at });
    const trial = [...state.eq, { a: end(pendingNum), b: end(m) }];
    const res = solveLinks(trial);
    pendingNum = null;
    if (!res.ok) { showNote("Those can't be made equal with the layout as it is. Move or unlock something first.", 'warn', 6000); refresh(); return; }
    applySolution(res.prob, res.x);
    state.eq = trial;
    tidyLayout();
    reanchorLinks();
    transientNote = null; updateNote();
    commit();
    return;
  }
  if (groupOf.has(key) || state.fix.some(f => mkey(f) === key)) { openNumberPopover(key, px, py); return; }
  pendingNum = { ...m, cell: cellId }; setOpen = false;
  refresh();
}

let numberKey = null;
function openNumberPopover(key, px, py) {
  $('#ellpop').hidden = true; $('#popover').hidden = true; $('#divpop').hidden = true; popoverCell = null; dividerInfo = null;
  numberKey = key;
  const { groups, groupOf } = eqGroups(), fixed = state.fix.find(f => mkey(f) === key);
  const others = groupOf.has(key) ? groups[groupOf.get(key)].length - 1 : 0;
  const bits = [];
  if (fixed) bits.push(`This number is set to ${fmtSize(fixed.value)} and stays that size.`);
  if (others) bits.push(`This number stays equal to ${others} other ${others === 1 ? 'number' : 'numbers'}.`);
  $('#numpop-note').textContent = bits.join(' ');
  $('#numpop-unlock').hidden = !others;
  $('#numpop-unfix').hidden = !fixed;
  $('#numpop-set').textContent = fixed ? 'Change the set number' : 'Set to a specific number';
  placePopover($('#numpop'), px, py);
}
$('#numpop-link').addEventListener('click', () => { const k = numberKey, m = canvas._nums && canvas._nums.get(k); closePopover(); if (m) { pendingNum = { ...m, cell: -1 }; setOpen = false; refresh(); } });
$('#numpop-set').addEventListener('click', () => { const k = numberKey, m = canvas._nums && canvas._nums.get(k); closePopover(); if (m) { pendingNum = { ...m, cell: -1 }; refresh(); openSetForm(); } });
$('#numpop-unfix').addEventListener('click', () => { state.fix = state.fix.filter(f => mkey(f) !== numberKey); closePopover(); commit(); });
$('#numpop-unlock').addEventListener('click', () => {
  const key = numberKey;
  const { groups, groupOf } = eqGroups();
  const group = groups[groupOf.get(key)];
  const rest = group.filter(k => k !== key);
  const ends = new Map();
  for (const { a, b } of state.eq) { ends.set(mkey(a), a); ends.set(mkey(b), b); }
  state.eq = state.eq.filter(({ a, b }) => !group.includes(mkey(a)) && !group.includes(mkey(b)));
  for (let k = 0; k + 1 < rest.length; k++) state.eq.push({ a: ends.get(rest[k]), b: ends.get(rest[k + 1]) });     // the others stay linked together
  closePopover();
  commit();
});
$('#numpop-close').addEventListener('click', () => closePopover());

/* ---------- delete a divider ---------- */
const stripLine = ({ axis, pos, s, e }) => ({ axis, pos, s, e });
function planWholeDelete(sid) { return rebuildWithout(currentLayout().lines.filter(l => l.id !== sid).map(stripLine)); }
// Deleting an L takes out only its own two dividers; whatever else is in the space stays, and dividers that were left hanging are carried on
function planEllDelete(j) { return rebuildWithout(currentLayout().lines.filter(l => l.id !== j.v && l.id !== j.h).map(stripLine)); }

/* Deleting a divider that other dividers end on: those dividers would be left hanging, so each one is extended until it reaches
 * a wall or another divider (two that end up closer than 0.2 in become one). */
/* Deleting just part of a divider: a divider is cut into parts by the dividers that meet it. The part between two of them (or
 * between one and a wall) can be removed on its own; what is left may make a new L (a divider that ran past another now stops
 * at it). The clicked part is found from the click, and the rest of the layout is rebuilt as when a whole divider is deleted. */
function dividerSegment(info, px, py) {
  const { lines } = currentLayout(), line = lines.find(l => l.id === info.sid);
  if (!line) return null;
  const [ix, iy] = pointToDrawer(px, py), along = line.axis === 'v' ? iy : ix;
  const bands = lines.filter(q => q.axis !== line.axis && q.s <= line.pos + WALL + EPS && q.e >= line.pos - EPS && q.pos > line.s + EPS && q.pos + WALL < line.e - EPS)       // dividers that meet it part way along (not the one it ends on)
    .map(q => [q.pos, q.pos + WALL]);
  if (bands.some(([a, b]) => along > a - EPS && along < b + EPS)) return null;           // on the joint itself
  const s = Math.max(line.s, ...bands.filter(([, b]) => b <= along).map(([, b]) => b)), e = Math.min(line.e, ...bands.filter(([a]) => a >= along).map(([a]) => a));
  if (e - s < EPS) return null;
  return { id: line.id, axis: line.axis, pos: line.pos, s, e, whole: Math.abs(s - line.s) < EPS && Math.abs(e - line.e) < EPS };
}
function planPartDelete(seg) {
  const segs = [];
  for (const l of currentLayout().lines) {
    const d = stripLine(l);
    if (l.id === seg.id) {
      if (seg.s - d.s > EPS) segs.push({ ...d, e: seg.s });
      if (d.e - seg.e > EPS) segs.push({ ...d, s: seg.e });
    } else segs.push(d);
  }
  return rebuildWithout(segs);
}

// Why a divider cannot be deleted, or null when it can
function deleteBlocker(info) {
  if (!currentLayout().lines.some(l => l.id === info.sid)) return 'This divider is no longer there.';
  return planWholeDelete(info.sid) ? null : 'Deleting this divider would leave a space too thin to make.';
}
function deleteDivider(info) {
  if (deleteBlocker(info) || !applyPlan(planWholeDelete(info.sid))) return;
  closePopover();
  commit();
}

/* ---------- divider panel ---------- */
let dividerInfo = null, partSeg = null;

function placePopover(pop, px, py) {
  pop.hidden = false;
  const box = $('#stage').getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = clamp(px - box.left - w / 2, 8, box.width - w - 8) + 'px';
  pop.style.top = clamp(py - box.top + 12, 8, box.height - h - 8) + 'px';
}

function openDividerPopover(info, px, py) {
  $('#ellpop').hidden = true; $('#popover').hidden = true; $('#numpop').hidden = true; popoverCell = null; numberKey = null;
  dividerInfo = info;
  const wide = info.axis === 'v';
  const [s1, s2] = info.size;
  $('#divpop-sizes').textContent = `${wide ? 'Left' : 'Back'} ${fmt2(s1)}″ · ${wide ? 'Right' : 'Front'} ${fmt2(s2)}″`;
  const blocker = deleteBlocker(info);
  // a divider that other dividers meet can also be deleted in part: just the part under the click, up to the next divider
  partSeg = null; setSegSel(null);
  const seg = dividerSegment(info, px, py), part = $('#divpop-part');
  part.hidden = !(seg && !seg.whole);
  if (seg && !seg.whole) {
    const plan = planPartDelete(seg);
    partSeg = plan ? seg : null;
    part.disabled = !plan;
    part.title = plan ? 'Remove only the highlighted part of this divider' : 'Removing just that part would leave a space too thin to make';
    setSegSel(seg);
  }
  const ell = $('#divpop-ell');
  ell.hidden = !info.joint;
  $('#divpop-delete').textContent = part.hidden ? 'Delete divider' : 'Delete the whole divider';
  $('#divpop-delete').disabled = !!blocker;
  $('#divpop-delnote').textContent = blocker || (!part.hidden ? (part.disabled ? 'Deleting just the highlighted part would leave a space too thin to make. You can delete the whole divider.' : 'The highlighted part goes up to the next divider and the rest stays, which can make a new L. Or delete the whole divider.')
    : info.joint ? 'This divider and the one it meets make an L. Delete just this divider, or the whole L. Dividers that ended on it are extended until they reach a wall or another divider.'
    : 'Deleting merges the two spaces. Dividers that ended on it are extended until they reach a wall or another divider (two that end up closer than 0.2″ become one).');
  const pop = $('#divpop');
  pop.hidden = false;                                  // beside the click, not over the divider and the part that is highlighted
  const box = $('#stage').getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  const rightRoom = box.right - (px + 18) - 8 >= w;
  pop.style.left = clamp(rightRoom ? px - box.left + 18 : px - box.left - 18 - w, 8, box.width - w - 8) + 'px';
  pop.style.top = clamp(py - box.top - h / 2, 8, box.height - h - 8) + 'px';
}
$('#divpop-delete').addEventListener('click', () => { if (dividerInfo) deleteDivider(dividerInfo); });
$('#divpop-part').addEventListener('click', () => { if (partSeg && applyPlan(planPartDelete(partSeg))) { closePopover(); commit(); } });
$('#divpop-ell').addEventListener('click', () => { if (dividerInfo && dividerInfo.joint) deleteEll(dividerInfo.joint); });
$('#divpop-close').addEventListener('click', () => closePopover());

/* ---------- L-shaped dividers ---------- */
// An L is two dividers that end on each other. Its corner has a handle that moves both; each divider can also be moved alone.
function openEllPopover(j, px, py) {
  closePopover();
  ellJoint = j;
  placePopover($('#ellpop'), px, py);
}
let ellJoint = null;
function deleteEll(j) {
  if (!applyPlan(planEllDelete(j))) { showNote('Deleting that L would leave a space too thin to make, so it was kept.'); return; }
  closePopover();
  commit();
}
$('#ellpop-delete').addEventListener('click', () => { if (ellJoint) deleteEll(ellJoint); });
$('#ellpop-close').addEventListener('click', () => closePopover());

/* ---------- split popover ---------- */
const SPLITS = [
  { nc: 2, nr: 1, label: '2 columns', icon: '<line x1="17" y1="2" x2="17" y2="22"/>' },
  { nc: 1, nr: 2, label: '2 rows', icon: '<line x1="2" y1="12" x2="32" y2="12"/>' },
];
const CORNERS = [['tl', 'top left'], ['tr', 'top right'], ['bl', 'bottom left'], ['br', 'bottom right']];

function openPopover(cellId, px, py) {
  const { cells } = currentLayout();
  const cell = cells.find(c => c.id === cellId);
  if (!cell) return;
  $('#ellpop').hidden = true; $('#divpop').hidden = true; $('#numpop').hidden = true; dividerInfo = null; numberKey = null;
  popoverCell = cell;
  popoverRect = rectAtPoint(cell, px, py) || faceRects(cell)[0];       // inside a space that is not a rectangle: the rectangle that was clicked
  setSelected(cell.poly ? popoverRect : null);
  $('#pop-namewrap').hidden = false; $('#pop-name').value = nameOf(cell, currentLayout());
  const grid = $('#pop-grid');
  grid.innerHTML = '';
  for (const sp of SPLITS) {
    const ok = !!freeSplit(popoverRect, sp);
    const b = document.createElement('button');
    b.type = 'button';
    b.disabled = !ok;
    b.title = ok ? `Divide into ${sp.label}` : 'This space is too small to divide that way';
    b.setAttribute('aria-label', sp.label);
    b.innerHTML = `<svg viewBox="0 0 34 24" aria-hidden="true"><rect x="2" y="2" width="30" height="20"/>${sp.icon}</svg><span>${sp.label}</span>`;
    b.addEventListener('click', () => applySplit(sp));
    grid.appendChild(b);
  }
  // the corners that make sense are those of the clicked rectangle that the space itself closes off
  const corners = CORNERS.filter(([c]) => faceEllPlan(cell, popoverRect, c));
  const bl = document.createElement('button');
  bl.type = 'button'; bl.className = 'span2'; bl.disabled = !corners.length;
  bl.title = corners.length ? 'Fence off a corner with an L-shaped divider' : (cell.poly ? 'No corner of this part of the space can be fenced off with an L' : 'This space is too small for an L-shape');
  bl.setAttribute('aria-label', 'L-shape');
  bl.innerHTML = '<svg viewBox="0 0 34 24" aria-hidden="true"><rect x="2" y="2" width="30" height="20"/><path d="M2 12h13v-10"/></svg><span>L-shape</span>';
  const rect = popoverRect;
  bl.addEventListener('click', () => {                                        // not added yet: first ask which corner the pocket goes in, unless only one makes sense
    if (corners.length === 1) applyEll(cell, rect, corners[0][0]);
    else chooseEllCorner(cell, px, py, corners);
  });
  grid.appendChild(bl);
  $('#pop-title').textContent = 'Divide this space';
  placeDividePopover(px, py);
}
function placeDividePopover(px, py) {
  const pop = $('#popover');
  pop.hidden = false;
  const lab = $('#stage').getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = clamp(px - lab.left - w / 2, 8, lab.width - w - 8) + 'px';
  pop.style.top = clamp(py - lab.top + 12, 8, lab.height - h - 8) + 'px';
}
// The same menu, now asking which corner the L's pocket goes in; the L is only added when a corner is picked
function chooseEllCorner(cell, px, py, list = CORNERS) {
  const grid = $('#pop-grid');
  grid.innerHTML = '';
  $('#pop-namewrap').hidden = true;
  const rect = popoverRect;
  for (const [c, name] of list) {
    const b = document.createElement('button');
    b.type = 'button'; b.title = `Pocket in the ${name} corner`; b.setAttribute('aria-label', `Pocket in the ${name} corner`);
    b.innerHTML = `<svg viewBox="0 0 34 24" aria-hidden="true"><rect x="2" y="2" width="30" height="20"/><rect class="pocket" x="${c[1] === 'l' ? 2 : 17}" y="${c[0] === 't' ? 2 : 12}" width="15" height="10"/></svg><span>${name[0].toUpperCase() + name.slice(1)}</span>`;
    b.addEventListener('click', () => applyEll(cell, rect, c));
    grid.appendChild(b);
  }
  const back = document.createElement('button');
  back.type = 'button'; back.className = 'span2'; back.innerHTML = '<span>← Back</span>';
  back.addEventListener('click', () => openPopover(cell.id, px, py));
  grid.appendChild(back);
  $('#pop-title').textContent = 'Pocket in which corner?';
  placeDividePopover(px, py);
}
function closePopover() { if (subSel) setSelected(null); if (segSel) setSegSel(null); $('#ellpop').hidden = true; ellJoint = null; $('#popover').hidden = true; $('#divpop').hidden = true; $('#numpop').hidden = true; popoverCell = null; dividerInfo = null; numberKey = null; }

/* An L-shaped space is dealt with as rectangles: for an L its two ends and the elbow where they meet. Only the one under the pointer
 * is highlighted, and a divider added from the menu goes through the middle of the one that was clicked. */
let popoverRect = null;
function faceRects(cell) {
  return cell.rects || [{ x: cell.x, y: cell.y, w: cell.w, h: cell.h }];
}
function pointToDrawer(px, py) {
  const vw = canvas._view, r = canvas.getBoundingClientRect();
  return [(px - r.left - vw.ox) / vw.s, (py - r.top - vw.oy) / vw.s];
}
function rectAtPoint(cell, px, py) {
  const [ix, iy] = pointToDrawer(px, py);
  const rs = faceRects(cell);
  return rs.find(r => ix >= r.x - EPS && ix <= r.x + r.w + EPS && iy >= r.y - EPS && iy <= r.y + r.h + EPS) || null;
}
let subHover = null, subSel = null, segSel = null;                      // the highlighted rectangle under the pointer, and the one a menu is open for
function hoverMarkup(ox, oy, s) {
  const one = (cls, r) => (r ? `<rect class="${cls}" x="${ox + r.x * s}" y="${oy + r.y * s}" width="${r.w * s}" height="${r.h * s}"/>` : '');
  return one('sub-hover', subHover && !(subSel && sameRect(subHover, subSel)) ? subHover : null) + one('sub-sel', subSel) + one('seg-sel', segSel);
}
const sameRect = (a, b) => !!a && !!b && ['x', 'y', 'w', 'h'].every(k => Math.abs(a[k] - b[k]) < EPS);
function paintHover() {
  const g = canvas.querySelector('#hover-layer'), vw = canvas._view;
  if (g && vw) g.innerHTML = hoverMarkup(vw.ox, vw.oy, vw.s);
}
function setSegSel(seg) {
  const next = seg ? (seg.axis === 'v' ? { x: seg.pos, y: seg.s, w: WALL, h: seg.e - seg.s } : { x: seg.s, y: seg.pos, w: seg.e - seg.s, h: WALL }) : null;
  if (sameRect(next, segSel) && !!next === !!segSel) return;
  segSel = next; canvas.classList.toggle('has-seg', !!next); paintHover();
}
function setSelected(r) { if (!sameRect(r, subSel) || (!r && subSel)) { subSel = r; paintHover(); } }
function updateHover(e) {
  const hit = e.target.closest && e.target.closest('[data-cell]');
  let next = null;
  if (hit && canvas._cells) {
    const c = canvas._cells.find(q => String(q.id) === hit.dataset.cell);
    if (c && c.poly) next = rectAtPoint(c, e.clientX, e.clientY);
  }
  if (!sameRect(next, subHover) || (!next && subHover)) { subHover = next; paintHover(); }
}
canvas.addEventListener('pointerleave', () => { if (subHover) { subHover = null; paintHover(); } });

/* Dividers added inside a space are drawn from the middle of the clicked rectangle outwards until they meet a wall or a divider;
 * the layout is then put together again from all the lines. So a divider added later stops against one added earlier. */
// Where a divider of this axis, at `pos`, starting from `from` and running in direction `dir` (-1 or 1), stops: the first divider across its path, or the wall
function reach(lines, R, axis, pos, from, dir) {
  const [w0, w1] = axis === 'v' ? [R.y, R.y + R.h] : [R.x, R.x + R.w];
  let best = dir < 0 ? w0 : w1;
  for (const q of lines) {
    if (q.axis === axis || q.s >= pos + WALL - EPS || q.e <= pos + EPS) continue;
    if (dir < 0 && q.pos + WALL <= from + EPS) best = Math.max(best, q.pos + WALL);
    if (dir > 0 && q.pos >= from - EPS) best = Math.min(best, q.pos);
  }
  return best;
}
function freeSplit(rect, sp) {                           // the plan for 2 columns or 2 rows through the middle of the rectangle, or null
  const R = wholeRect(), lines = layoutLines(), add = [];
  if (sp.nc > 1) { const x = rect.x + rect.w / 2 - WALL / 2, yc = rect.y + rect.h / 2; add.push({ axis: 'v', pos: x, s: reach(lines, R, 'v', x, yc, -1), e: reach(lines, R, 'v', x, yc, 1) }); }
  if (sp.nr > 1) { const y = rect.y + rect.h / 2 - WALL / 2, xc = rect.x + rect.w / 2; add.push({ axis: 'h', pos: y, s: reach(lines, R, 'h', y, xc, -1), e: reach(lines, R, 'h', y, xc, 1) }); }
  return finishLines(R, [...lines, ...add], currentLayout().cells);
}
// An L with its pocket in one corner of the clicked rectangle: the vertical divider takes the corner square and the horizontal one
// butts against it, each running out until it meets a wall or a divider. It only makes sense in a corner where that closes the pocket off
// as a rectangle inside the clicked rectangle (so not where the dividers would run on into the next rectangle).
function faceEllPlan(cell, rect, corner) {
  if (!rect) return null;
  const R = wholeRect(), lines = layoutLines(), left = corner[1] === 'l', top = corner[0] === 't';
  const jx = rect.x + rect.w / 2 - WALL / 2, jy = rect.y + rect.h / 2 - WALL / 2;
  const v = top ? { axis: 'v', pos: jx, s: reach(lines, R, 'v', jx, jy, -1), e: jy + WALL } : { axis: 'v', pos: jx, s: jy, e: reach(lines, R, 'v', jx, jy + WALL, 1) };
  const h = left ? { axis: 'h', pos: jy, s: reach(lines, R, 'h', jy, jx, -1), e: jx } : { axis: 'h', pos: jy, s: jx + WALL, e: reach(lines, R, 'h', jy, jx + WALL, 1) };
  const pocket = { x: left ? h.s : jx + WALL, y: top ? v.s : jy + WALL, w: left ? jx - h.s : h.e - jx - WALL, h: top ? jy - v.s : v.e - jy - WALL };
  if (pocket.x < rect.x - EPS || pocket.y < rect.y - EPS || pocket.x + pocket.w > rect.x + rect.w + EPS || pocket.y + pocket.h > rect.y + rect.h + EPS) return null;      // the pocket must stay in the rectangle
  const all = [...lines, v, h];
  const closed = regionFaces(R.x, R.y, R.w, R.h, all.map(lineRect)).some(f => !f.poly && sameRect(f, pocket));
  return closed ? finishLines(R, all, currentLayout().cells) : null;
}
function applyEll(cell, rect, corner) {
  if (!applyPlan(faceEllPlan(cell, rect, corner))) { showNote('There is no room for an L there.'); return; }
  closePopover();
  commit();
}
function applySplit(sp) {
  if (!popoverCell) return;
  if (!applyPlan(freeSplit(popoverRect, sp))) { showNote('There is no room to divide that space that way.'); return; }
  closePopover();
  commit();
}
$('#pop-cancel').addEventListener('click', closePopover);
$('#pop-name').addEventListener('input', e => { if (!popoverCell) return; setName(popoverCell, e.target.value); renderDrawer(canvas, { interactive: true }); });
$('#pop-name').addEventListener('change', () => { if (popoverCell) { const cell = popoverCell; commit(); popoverCell = cell; } });
$('#pop-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } e.stopPropagation(); });


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
  $('#plan-status').textContent = `${fmtIn(state.dims.w)}″ × ${fmtIn(state.dims.l)}″ × ${fmtIn(state.dims.h)}″ · ${cells.length} ${cells.length === 1 ? 'space' : 'spaces'}`;
  renderDrawer(canvas, { interactive: true });
  updateNote();
  updatePhotoBanner();
}

// The select lists count eighths of an inch (value 97 = 12 1/8 in); the planner itself works in ten-thousandths.
function fillSelect(sel, from, to, value) {
  sel.innerHTML = '';
  for (let n = from; n <= to; n += EIGHTH) {
    const o = document.createElement('option');
    o.value = n / EIGHTH;
    o.textContent = `${fmtIn(n)}″`;
    sel.appendChild(o);
  }
  sel.value = value / EIGHTH;
}
const SIZE_FIELDS = [['w', 'Width', '#dim-w'], ['l', 'Length', '#dim-l'], ['h', 'Height', '#dim-h']];
function showSizes() {                                // the three drawer boxes, the gap, and the resulting insert size
  const lim = drawerLimits();
  const dec = state.decimal;
  $('#unit-toggle').textContent = dec ? 'Switch to fractions' : 'Switch to decimals';
  $('#unit-toggle').setAttribute('aria-pressed', String(dec));
  $('#dec-help').hidden = !dec;
  for (const [k, , id] of SIZE_FIELDS) {
    $(id).hidden = dec; $(id + '-dec').hidden = !dec;
    if (dec) $(id + '-dec').value = fmtDecimal(state.drawer[k]);
    else fillSelect($(id), lim[k][0], lim[k][1], state.drawer[k]);
  }
  const gap = $('#dim-gap');
  if (!gap.options.length) for (const g of GAPS) gap.add(new Option(g ? `${fmtIn(g)}″` : 'None', g / EIGHTH));
  else for (const o of gap.options) o.textContent = +o.value ? `${fmtIn(o.value * EIGHTH)}″` : 'None';
  gap.hidden = dec; $('#dim-gap-dec').hidden = !dec;
  if (dec) $('#dim-gap-dec').value = fmtDecimal(state.gap); else gap.value = state.gap / EIGHTH;
  $('#drawer-label').value = state.label;
  const d = state.dims;
  $('#insert-size').textContent = `${fmtIn(d.w)}″ × ${fmtIn(d.l)}″ × ${fmtIn(d.h)}″`;
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
for (const [k, , id] of SIZE_FIELDS) {
  $(id).addEventListener('change', () => { state.drawer[k] = +$(id).value * EIGHTH; sizesChanged(); });
}
$('#drawer-label').addEventListener('input', e => {
  const v = cleanLabel(e.target.value);
  if (v !== e.target.value) e.target.value = v;
  state.label = v;
  persist();
});
$('#dim-gap').addEventListener('change', () => { state.gap = +$('#dim-gap').value * EIGHTH; sizesChanged(); });

// Decimal input: text boxes taking up to four decimal places, checked when the customer leaves the box or presses Enter.
function cleanDecimalText(t) {
  t = String(t).replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const i = t.indexOf('.');
  return i < 0 ? t.slice(0, 3) : t.slice(0, Math.min(i, 3)) + '.' + t.slice(i + 1).replace(/\./g, '').slice(0, 4);
}
function parseDecimal(t) {                           // ten-thousandths, or null when it is not a number
  t = cleanDecimalText(t);
  return t === '' || t === '.' ? null : Math.round(parseFloat(t) * IN);
}
for (const [id, name] of [...SIZE_FIELDS.map(([k, n, i]) => [i + '-dec', n]), ['#dim-gap-dec', 'Safety gap']]) {
  const box = $(id);
  box.addEventListener('input', () => { const t = cleanDecimalText(box.value); if (t !== box.value) box.value = t; });
  box.addEventListener('focus', () => box.select());
  box.addEventListener('change', () => {
    const v = parseDecimal(box.value), gapBox = id === '#dim-gap-dec';
    if (v === null) { showNote('Enter a number, such as 12.1875.'); showSizes(); return; }
    const k = SIZE_FIELDS.find(f => f[2] + '-dec' === id), lim = gapBox ? [0, GAP_MAX] : drawerLimits()[k[0]];
    const c = clamp(v, lim[0], lim[1]);
    if (c !== v) showNote(`${name} must be between ${fmtDecimal(lim[0])} and ${fmtDecimal(lim[1])} in.`);
    if (gapBox) state.gap = c; else state.drawer[k[0]] = c;
    sizesChanged();
  });
  box.addEventListener('keydown', e => { if (e.key === 'Enter') box.blur(); });
}
$('#unit-toggle').addEventListener('click', () => {
  if (state.decimal) {                               // back to fractions: round every size to the nearest 1/8 in
    const before = JSON.stringify([state.drawer, state.gap]);
    state.gap = clamp(snapEighth(state.gap), 0, GAP_MAX);
    for (const k of ['w', 'l', 'h']) state.drawer[k] = snapEighth(state.drawer[k]);
    state.decimal = false;
    syncInsert();                                    // the limits move with the gap: keep every size on the 1/8 in grid
    for (const k of ['w', 'l', 'h']) state.drawer[k] = snapEighth(state.drawer[k]);
    sizesChanged();
    if (JSON.stringify([state.drawer, state.gap]) !== before) showNote('Sizes were rounded to the nearest 1/8″ for the fraction lists.', 'warn', 6000);
  } else { state.decimal = true; sizesChanged(); }
});

$('#undo').addEventListener('click', undo);
$('#redo').addEventListener('click', redo);
$('#clear').addEventListener('click', () => {
  if (isDefaultLayout()) return;
  state.segs = [];
  state.eq = [];
  state.fix = [];
  state.names = [];
  state.photo = false; state.suggested = false;
  pendingNum = null;
  closePopover();
  commit();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!$('#photo-modal').hidden) closePhoto();
    else if (!$('#review').hidden) $('#review').hidden = true;
    else if (pendingNum || transientNote) { pendingNum = null; transientNote = null; clearTimeout(noteTimer); refresh(); }
    else if (!$('#popover').hidden || !$('#divpop').hidden || !$('#numpop').hidden) closePopover();
    else if (document.body.classList.contains('editor-full')) setExpanded(false);
    else closePopover();
    return;
  }
  if (e.target && /^(SELECT|INPUT|TEXTAREA)$/.test(e.target.tagName)) return;      // leave form fields to the browser
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(view.z * 1.5); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(view.z / 1.5); return; }
    if (e.key === '0') { e.preventDefault(); setZoom(1); return; }
  }
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
  const lay = currentLayout(), { cells, divs } = lay, byKey = nameLookup();
  const physical = physicalDividers(divs);
  const ratios = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 48];
  const label = drawerLabel();
  const M = { l: 26, r: 16, t: label ? 30 : 24 };            // room above the drawing for the drawer label
  const ratio = ratios.find(r => (W * MM_PER_IN) / r + M.l + M.r <= 190.5 && (L * MM_PER_IN) / r + M.t <= (label ? 172 : 165)) || ratios[ratios.length - 1];
  const k = MM_PER_IN / ratio;          // paper millimetres per inch of drawer
  const planW = W * k, planL = L * k;
  const pageW = Math.max(M.l + planW + M.r, 140);
  const ox = (pageW - planW) / 2 + (M.l - M.r) / 2, oy = M.t;
  const titleTop = oy + planL + 18, titleH = 44;
  const pageH = titleTop + titleH + 4;

  // The drawing is a list of simple shapes in paper millimetres, drawn as SVG and as PDF.
  const scene = [];
  const R = (x, y, w, h, o = {}) => scene.push({ k: 'rect', x, y, w, h, fill: o.fill || null, stroke: o.stroke || null, sw: o.sw || 0, rx: o.rx || 0 });
  const PG = (pts, o = {}) => scene.push({ k: 'poly', pts, fill: o.fill || null, stroke: o.stroke || null, sw: o.sw || 0 });
  const C = (x, y, r, o = {}) => scene.push({ k: 'circle', x, y, r, fill: o.fill || null, stroke: o.stroke || null, sw: o.sw || 0 });
  const Ln = (x1, y1, x2, y2, sw = 0.25) => scene.push({ k: 'line', x1, y1, x2, y2, stroke: '#111', sw });
  const T = (x, y, s, size, o = {}) => scene.push({ k: 'text', x, y, s, size, anchor: o.anchor || 'start', bold: !!o.bold, fill: o.fill || '#000', rot: o.rot || 0, ls: o.ls || 0 });

  R(0, 0, pageW, pageH, { fill: '#fff' });
  if (label) T(pageW / 2, 9, label, Math.min(6.5, (pageW - 14) / pdfWidth(label, 1, true)), { bold: true, anchor: 'middle' });
  R(ox, oy, planW, planL, { fill: '#c9c9c9', stroke: '#111', sw: 0.5 });
  const sorted = sortCells(cells);
  const callouts = [], labels = [];          // callouts: spaces too small for their letter, labelled in the margin instead
  sorted.forEach((c, i) => {
    const x = ox + c.x * k, y = oy + c.y * k, w = c.w * k, h = c.h * k;
    if (c.poly) PG(c.poly.map(([qx, qy]) => [ox + qx * k, oy + qy * k]), { fill: '#fff', stroke: '#111', sw: 0.25 });
    else R(x, y, w, h, { fill: '#fff', stroke: '#111', sw: 0.25 });
    let cx = x + w / 2, cy = y + h / 2;
    const nm = nameOf(c, lay, byKey), fitName = (px, size) => { let t = nm; while (t.length > 1 && pdfWidth(t, size, true) > px) t = t.slice(0, -1); return t === nm ? t : t.slice(0, -1) + '.'; };
    if (c.poly) {                                                // a space that is not a rectangle: its letter goes in its largest part
      const lg = c.rects.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
      const lw = lg.w * k, lh = lg.h * k;
      cx = ox + (lg.x + lg.w / 2) * k; cy = oy + (lg.y + lg.h / 2) * k;
      const legs = faceMeasures(c, lay.lines, lay.R);
      const spots = legs.filter(m => m.arrow).map(m => [ox + (m.arrow.x0 !== undefined ? (m.arrow.x0 + m.arrow.x1) / 2 : m.arrow.x) * k, oy + (m.arrow.y0 !== undefined ? (m.arrow.y0 + m.arrow.y1) / 2 : m.arrow.y) * k]);
      if (spots.length) {                                        // keep the letter clear of the leg sizes: the spot in the largest part furthest from them
        let best = -1;
        for (const fx of [0.25, 0.5, 0.75]) for (const fy of [0.25, 0.5, 0.75]) {
          const px = ox + (lg.x + lg.w * fx) * k, py = oy + (lg.y + lg.h * fy) * k, d = Math.min(...spots.map(([sx, sy]) => Math.hypot(px - sx, (py - sy) * 1.3)));
          if (d > best + 1e-6) { best = d; cx = px; cy = py; }
        }
      }
      if (lw >= 6 && lh >= 6) labels.push({ x: cx, y: cy + 1.5, s: labelFor(i), size: Math.min(4.6, lw * 0.6, lh * 0.6), bold: true });
      else callouts.push({ letter: labelFor(i), cx, cy });
      if (nm && lw >= 14 && lh >= 11) labels.push({ x: cx, y: cy + 5.3, s: fitName(lw - 3, 2.8), size: 2.8, bold: true, fill: '#333' });
      for (const m of legs) {         // an L: how wide its upright leg is and how deep its flat leg is, with an arrow across each
        const across = m.kind === 'legx', a = m.arrow, text = fmt2(m.value);
        const tw = pdfWidth(text, 2.8, false), th = 2.8;
        const [p0, p1] = across ? [ox + a.x0 * k, ox + a.x1 * k] : [oy + a.y0 * k, oy + a.y1 * k], at = across ? oy + a.y * k : ox + a.x * k, mid = (p0 + p1) / 2;
        const room = p1 - p0;
        if (room >= (across ? tw + 8 : th + 8)) {
          const hd = 1.1;
          if (across) { Ln(p0 + 0.3, at, p1 - 0.3, at, 0.2); for (const [x, d] of [[p0 + 0.3, 1], [p1 - 0.3, -1]]) { Ln(x, at, x + d * hd, at - 0.6, 0.2); Ln(x, at, x + d * hd, at + 0.6, 0.2); } }
          else { Ln(at, p0 + 0.3, at, p1 - 0.3, 0.2); for (const [y, d] of [[p0 + 0.3, 1], [p1 - 0.3, -1]]) { Ln(at, y, at - 0.6, y + d * hd, 0.2); Ln(at, y, at + 0.6, y + d * hd, 0.2); } }
          labels.push({ x: across ? mid : at, y: (across ? at : mid) + 1, s: text, size: 2.8, fill: '#333' });
        } else if (room >= (across ? tw + 1 : th + 1.5)) labels.push({ x: across ? mid : at, y: (across ? at : mid) + 1, s: text, size: 2.8, fill: '#333' });
      }
      return;
    }
    const dims = `${fmt2(c.w)} × ${fmt2(c.h)}`, fit = Math.min(2.8, (w - 1.6) / pdfWidth(dims, 1, false));       // the sizes go in the space whenever they are legible there
    if (nm && w >= 18 && h >= 17) {
      labels.push({ x: cx, y: cy - 3.6, s: labelFor(i), size: 4.6, bold: true }, { x: cx, y: cy + 0.9, s: fitName(w - 3, 3), size: 3, bold: true, fill: '#222' }, { x: cx, y: cy + 5, s: dims, size: Math.min(2.8, fit), fill: '#333' });
    } else if (w >= 21 && h >= 12) {
      labels.push({ x: cx, y: cy - 0.6, s: labelFor(i), size: 4.6, bold: true }, { x: cx, y: cy + 4.2, s: dims, size: 2.8, fill: '#333' });
    } else if (fit >= 2 && h >= 10) {
      labels.push({ x: cx, y: cy - 0.4, s: labelFor(i), size: Math.min(4.2, w * 0.6, h * 0.35), bold: true }, { x: cx, y: cy + 3.3, s: dims, size: fit, fill: '#333' });
    } else if (w >= 6 && h >= 6) {
      labels.push({ x: cx, y: cy + 1.5, s: labelFor(i), size: Math.min(4.6, w * 0.6, h * 0.6), bold: true });
    } else {
      callouts.push({ letter: labelFor(i), cx, cy });
    }
  });
  // Callouts: the letter sits in a circle beside the drawing, on a thin leader line to a dot in its space.
  // They are spread out down the right-hand margin so they never overlap.
  if (callouts.length) {
    const lx = ox + planW + 8.5, gap = 7.2, r = 2.8;
    callouts.sort((a, b) => a.cy - b.cy);
    let prev = -Infinity;
    for (const c of callouts) { c.ly = Math.max(c.cy, prev + gap); prev = c.ly; }
    const floor = oy + planL;
    if (prev > floor) { callouts[callouts.length - 1].ly = Math.max(floor, callouts[callouts.length - 1].ly - (prev - floor)); for (let j = callouts.length - 2; j >= 0; j--) callouts[j].ly = Math.min(callouts[j].ly, callouts[j + 1].ly - gap); }
    for (const c of callouts) {
      Ln(c.cx, c.cy, lx - r, c.ly, 0.2);
      C(c.cx, c.cy, 0.7, { fill: '#111' });
    }
    for (const c of callouts) {
      C(lx, c.ly, r, { fill: '#fff', stroke: '#111', sw: 0.3 });
      T(lx, c.ly + 1.5, c.letter, 4.2, { bold: true, anchor: 'middle' });
    }
  }
  // Letters and sizes inside the spaces go on top, on a white patch, so a leader line passing through never strikes them out.
  for (const l of labels) {
    const w = pdfWidth(l.s, l.size, l.bold) + 1.2;
    R(l.x - w / 2, l.y - l.size * 0.78, w, l.size * 1.02, { fill: '#fff' });
    T(l.x, l.y, l.s, l.size, { bold: !!l.bold, anchor: 'middle', fill: l.fill });
  }

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
  dimH(ox, ox + planW, oy - 9, `${fmtIn(state.dims.w)} in`);
  dimV(oy, oy + planL, ox - 9, `${fmtIn(state.dims.l)} in`);

  // front marker
  R(ox + planW / 2 - 8, oy + planL + 3, 16, 2, { fill: '#555', rx: 1 });
  T(ox + planW / 2, oy + planL + 10, 'FRONT', 2.8, { anchor: 'middle', bold: true, fill: '#444', ls: 0.4 });

  // title block
  R(2, titleTop, pageW - 4, titleH, { stroke: '#111', sw: 0.4 });
  T(6, titleTop + 8, 'Drawer insert plan, seen from above', 4.2, { bold: true });
  T(6, titleTop + 15, `Insert ${fmtIn(state.dims.w)} × ${fmtIn(state.dims.l)} × ${fmtIn(state.dims.h)} in (width, length, height), for a drawer ${fmtIn(state.drawer.w)} × ${fmtIn(state.drawer.l)} × ${fmtIn(state.drawer.h)} in inside`, 2.9);
  T(6, titleTop + 20.5, `${sorted.length} ${sorted.length === 1 ? 'space' : 'spaces'}, ${physical.length} ${physical.length === 1 ? 'divider' : 'dividers'}, sheet ${WALL.toFixed(2)} in, dividers ${drawerSize().partH.toFixed(2)} in tall`, 2.9);
  T(6, titleTop + 26, 'Spaces show width × length in inches; an L shows its two leg sizes.', 2.9, { fill: '#444' });
  if (callouts.length || labels.length < cells.length * 2) T(6, titleTop + 31.5, 'Sizes too small to print here, and small lettered spaces, are on page 2.', 2.9, { fill: '#444' });
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
    if (o.k === 'poly') return `<polygon points="${o.pts.map(q => `${n(q[0])},${n(q[1])}`).join(' ')}" fill="${o.fill || 'none'}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw}"` : ''}/>`;
    if (o.k === 'circle') return `<circle cx="${n(o.x)}" cy="${n(o.y)}" r="${n(o.r)}" fill="${o.fill || 'none'}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw}"` : ''}/>`;
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
  const lay = currentLayout(), { cells, divs } = lay, byKey = nameLookup();
  const sorted = sortCells(cells);
  const r = v => Math.round(v * 10000) / 10000;
  return {
    metadata: { version: '2.0', units: 'inches', drawer_interior_in: { width: unitsToIn(state.drawer.w), length: unitsToIn(state.drawer.l), height: unitsToIn(state.drawer.h) }, safety_gap_in: unitsToIn(state.gap), drawer_label: drawerLabel(), ...(state.photo || state.suggested ? { suggested_from_photo: true, drawer_size_confirmed_measured: !state.photo } : {}) },   // drawer.* below is the insert itself
    drawer: { width_in: r(W), length_in: r(L), height_in: r(H), thickness_in: WALL, part_height_in: r(partH) },   // height_in is overall
    dividers: physicalDividers(divs).map((d, i) => ({
      id: `divider-${i}`, orientation: d.axis === 'v' ? 'vertical' : 'horizontal',
      x_in: r(d.axis === 'v' ? d.pos : d.start), y_in: r(d.axis === 'v' ? d.start : d.pos), length_in: r(d.length),
    })),
    compartments: sorted.map((c, i) => ({
      label: labelFor(i), ...(nameOf(c, lay, byKey) ? { name: nameOf(c, lay, byKey) } : {}), x_in: r(c.x), y_in: r(c.y), width_in: r(c.w), length_in: r(c.h),
      ...(c.poly && !c.cut ? { shape: 'polygon', note: 'Not a rectangle: width and length are the overall size; outline_in is its outline, corner to corner', outline_in: c.poly.map(([qx, qy]) => [r(qx), r(qy)]) } : {}),
      ...(c.cut ? { shape: 'L', legs_in: (() => { const ms = faceMeasures(c, currentLayout().lines, currentLayout().R); return { upright_width: r(ms[0].value), flat_depth: r(ms[1].value) }; })(), note: 'L-shaped: width and length are the overall size; legs_in are how wide its upright leg is and how deep its flat leg is; the pocket cut out of it is cutout_in', cutout_in: { x: r(c.cut.x), y: r(c.cut.y), width: r(c.cut.w), length: r(c.cut.h) } } : {}),
    })),
    price_estimate: {
      drawer: r(priceBreakdown().drawer), dividers: r(priceBreakdown().dividerCost), total: r(priceBreakdown().total),
    },
    order_fields: { drawer_label: drawerLabel(), divider_count: priceBreakdown().dividers, divider_area_sq_in: priceBreakdown().dividerArea, shipping_weight_lb: priceBreakdown().shipping.billable },
    shipping: (() => { const s = priceBreakdown().shipping; return { box_in: s.boxDims, actual_weight_lb: r(s.actual), dimensional_weight_lb: r(s.dimensional), billable_weight_lb: s.billable }; })(),
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
// pdf: true is the PDF that goes to the shop: sizes and spaces only, with no pricing, shipping box or parts list
function sheetData({ pdf = false } = {}) {
  const data = designData();
  const { W, L, H, partH } = drawerSize();
  const cuts = cutList();
  const pb = priceBreakdown();
  const inch = v => v.toFixed(2) + '"';
  const exact = (v, min = 2) => { let t = String(+v.toFixed(4)); const d = (t.split('.')[1] || '').length; if (d < min) t = v.toFixed(min); return t + '"'; };      // up to four decimals, at least two
  return {
    sections: [
      { title: 'Sizes', right: [1], rows: [
        ...(drawerLabel() ? [['Drawer label', drawerLabel()]] : []),
        ['Drawer interior, as measured', `${exact(unitsToIn(state.drawer.w))} × ${exact(unitsToIn(state.drawer.l))} × ${exact(unitsToIn(state.drawer.h))}`],
        ['Safety gap (each side of the width and length, once off the height)', `${exact(unitsToIn(state.gap), 3)}`],
        ['Insert size (width × length × height)', `${exact(W)} × ${exact(L)} × ${exact(H)}`],
        ['Divider height (insert height less one sheet)', inch(partH)],
        ['Sheet thickness', inch(WALL)],
        ['Open spaces', String(data.compartments.length)],
      ] },
      ...(pdf ? [] : [{ title: 'Cost estimate', right: [1], total: true, rows: [
        ['Insert (bottom and outer walls)', fmtMoney(pb.drawer)],
        [`Dividers (${pb.dividers}, ${pb.dividerArea.toFixed(1)} sq in)`, fmtMoney(pb.dividerCost)],
        ['Estimated total', fmtMoney(pb.total)],
      ] }]),
      ...(pdf ? [] : [{ title: 'Shipping', right: [1], rows: [
        ['Box (each side is the insert plus 2 in)', `${pb.shipping.boxDims.join(' × ')} in`],
        ['Actual weight (acrylic and box, plus 10%)', `${pb.shipping.actual.toFixed(1)} lb`],
        ['Dimensional weight (UPS, divided by 139)', `${pb.shipping.dimensional.toFixed(1)} lb`],
        ['Billable weight (the greater, rounded up)', `${pb.shipping.billable} lb`],
      ] },
      { title: 'Parts to cut', head: ['Qty', 'Part', 'Size'], right: [2], rows: cuts.map(c => [String(c.qty), c.part, `${inch(c.a)} × ${inch(c.b)}`]) }]),
      { title: 'Spaces', ...(data.compartments.some(c => c.name)
        ? { head: ['Label', 'Name', 'Width', 'Length'], right: [2, 3], rows: data.compartments.flatMap(c => [[c.shape ? `${c.label} (${c.shape === 'L' ? 'L-shaped' : 'odd shape'}, overall)` : c.label, c.name || '', inch(c.width_in), inch(c.length_in)],
          ...(c.legs_in ? [[`${c.label} upright leg (how wide)`, '', inch(c.legs_in.upright_width), ''], [`${c.label} flat leg (how deep)`, '', '', inch(c.legs_in.flat_depth)]] : [])]) }
        : { head: ['Label', 'Width', 'Length'], right: [1, 2], rows: data.compartments.flatMap(c => [[c.shape ? `${c.label} (${c.shape === 'L' ? 'L-shaped' : 'odd shape'}, overall)` : c.label, inch(c.width_in), inch(c.length_in)],
          ...(c.legs_in ? [[`${c.label} upright leg (how wide)`, inch(c.legs_in.upright_width), ''], [`${c.label} flat leg (how deep)`, '', inch(c.legs_in.flat_depth)]] : [])]) }) },
    ],
  };
}

function sectionHTML(s) {
  const head = s.head ? `<thead><tr>${s.head.map(h => `<th>${h}</th>`).join('')}</tr></thead>` : '';
  const rows = s.rows.map((r, i) => `<tr${s.total && i === s.rows.length - 1 ? ' class="total"' : ''}>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
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
    } else if (o.k === 'poly') {
      const paint = o.fill && o.stroke ? 'B' : o.fill ? 'f' : o.stroke ? 'S' : 'n';
      if (o.fill) ops.push(`${pdfRGB(o.fill)} rg`);
      if (o.stroke) ops.push(`${pdfRGB(o.stroke)} RG ${pdfNum(o.sw * pt)} w`);
      ops.push(o.pts.map((q, qi) => `${pdfNum(X(q[0]))} ${pdfNum(Y(q[1]))} ${qi ? 'l' : 'm'}`).join(' ') + ` h ${paint}`);
    } else if (o.k === 'circle') {
      const paint = o.fill && o.stroke ? 'B' : o.fill ? 'f' : o.stroke ? 'S' : 'n';
      const cx = X(o.x), cy = Y(o.y), r = o.r * pt, q = 0.5523 * r;
      if (o.fill) ops.push(`${pdfRGB(o.fill)} rg`);
      if (o.stroke) ops.push(`${pdfRGB(o.stroke)} RG ${pdfNum(o.sw * pt)} w`);
      ops.push(`${pdfNum(cx + r)} ${pdfNum(cy)} m ${pdfNum(cx + r)} ${pdfNum(cy + q)} ${pdfNum(cx + q)} ${pdfNum(cy + r)} ${pdfNum(cx)} ${pdfNum(cy + r)} c ${pdfNum(cx - q)} ${pdfNum(cy + r)} ${pdfNum(cx - r)} ${pdfNum(cy + q)} ${pdfNum(cx - r)} ${pdfNum(cy)} c ${pdfNum(cx - r)} ${pdfNum(cy - q)} ${pdfNum(cx - q)} ${pdfNum(cy - r)} ${pdfNum(cx)} ${pdfNum(cy - r)} c ${pdfNum(cx + q)} ${pdfNum(cy - r)} ${pdfNum(cx + r)} ${pdfNum(cy - q)} ${pdfNum(cx + r)} ${pdfNum(cy)} c h ${paint}`);
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
  const colWidths = n => (n === 2 ? [0.7, 0.3] : n === 4 ? [0.2, 0.4, 0.2, 0.2] : [0.18, 0.5, 0.32]).map(f => f * (PDF_W - 2 * PDF_MARGIN));
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
  const subtitle = `Insert ${fmtIn(state.dims.w)} x ${fmtIn(state.dims.l)} x ${fmtIn(state.dims.h)} in   |   drawing at 1:${dr.ratio}`;
  const drawingPage = pdfDrawScene(dr.scene, pt, (PDF_W - dr.w * pt) / 2, PDF_MARGIN);
  const pages = [drawingPage, ...pdfSheetPages(sheetData({ pdf: true }).sections, subtitle)];
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

on('#rev-json', 'click', e => saveFile('data.json', jsonText(), e.currentTarget));
on('#rev-csv', 'click', e => saveFile('insert-parts.csv', csvText(), e.currentTarget));
on('#rev-pdf', 'click', e => saveFile('Layout_Drawing.pdf', makePlanPdf(), e.currentTarget));
on('#rev-svg', 'click', e => saveFile('insert-drawing.svg', drawing().svg, e.currentTarget));
on('#rev-png', 'click', async e => { const b = e.currentTarget; try { await saveFile('insert-drawing.png', await drawingPNG(), b); } catch (err) { /* handled in saveFile */ } });
on('#rev-print', 'click', () => window.print());
on('#rev-copy-json', 'click', e => copyText(jsonText(), e.currentTarget));
on('#rev-copy-csv', 'click', e => copyText(csvText(), e.currentTarget));

/* ---------- layout from a photo ----------
 * "Suggest Layout from Photo": the customer's photo is shrunk here and sent to a small service (worker/photo-reader.js) that
 * asks Claude what is in the drawer. What comes back is a drawer size estimate and groups of things (each group = one
 * compartment). Everything after that is plain code: the groups are given floor area in proportion to what they hold and cut
 * into dividers by the same layout engine as the rest of the planner, and each space is named after its group. */
const isEmbed = () => new URLSearchParams(location.search).has('embed') && window.parent !== window;       // inside the store's order form (see below)
const PHOTO_API_URL = '';                           // set to the address of the deployed photo-reader service; the button stays hidden while it is empty
function photoApi() {
  if (['localhost', '127.0.0.1'].includes(location.hostname)) { const q = new URLSearchParams(location.search).get('photoapi'); if (q) return q; }       // for testing against a local stand-in
  return PHOTO_API_URL;
}

// What each group needs: floor area (things stack and nest, so more of them need less than proportionally more) and its longest thing
function photoPrep(groups) {
  const gs = groups.filter(g => g.on !== false && g.items.length).map(g => ({
    name: g.name || 'Space', items: g.items,
    need: Math.max(9, g.items.reduce((s, i) => s + Math.pow(i.count, 0.75) * (i.length_in + 0.3) * (i.width_in + 0.2), 0)),
    minLong: Math.max(...g.items.map(i => i.length_in)) + 0.3,
  }));
  gs.sort((a, b) => b.need - a.need);
  while (gs.length > 8) {                                    // too many: the smallest ones share one space
    const b = gs.pop(), a = gs.pop();
    gs.push({ name: 'Small odds and ends', items: [...a.items, ...b.items], need: a.need + b.need, minLong: Math.max(a.minLong, b.minLong) });
    gs.sort((x, y) => y.need - x.need);
  }
  return gs;
}
function photoScore(g, w, h) {                               // how badly a space of this size suits its group (0 = fine)
  const long = Math.max(w, h), short = Math.min(w, h);
  let s = 0;
  if (long < g.minLong) s += (g.minLong - long) * 4;
  if (short < 1) s += (1 - short) * 4;
  const ratio = long / Math.max(short, 0.01); if (ratio > 5) s += (ratio - 5) * 0.3;
  const r = (w * h) / g.need; if (r < 1) s += (1 - r) * 2;
  return s;
}
// Cut the floor into one space per group by repeatedly dividing it in two where each side's area follows what the groups on it need
function photoTreemap(gs, x, y, w, h) {
  if (gs.length === 1) return { cells: [{ g: gs[0], x, y, w, h }], divs: [], score: photoScore(gs[0], w, h) };
  let best = null;
  for (let k = 1; k < gs.length; k++) {
    const A = gs.slice(0, k), B = gs.slice(k), a = A.reduce((s, g) => s + g.need, 0), b = B.reduce((s, g) => s + g.need, 0);
    for (const dir of ['v', 'h']) {
      const avail = (dir === 'v' ? w : h) - WALL, s1 = Math.round(avail * a / (a + b) * 16) / 16, s2 = avail - s1;
      if (s1 < 0.75 || s2 < 0.75) continue;
      const r1 = dir === 'v' ? photoTreemap(A, x, y, s1, h) : photoTreemap(A, x, y, w, s1);
      const r2 = dir === 'v' ? photoTreemap(B, x + s1 + WALL, y, s2, h) : photoTreemap(B, x, y + s1 + WALL, w, s2);
      const score = r1.score + r2.score;
      if (!best || score < best.score - 1e-9) best = { score, cells: [...r1.cells, ...r2.cells], divs: [...r1.divs, ...r2.divs, dir === 'v' ? { axis: 'v', pos: x + s1, s: y, e: y + h } : { axis: 'h', pos: y + s1, s: x, e: x + w }] };
    }
  }
  return best || { cells: gs.map((g, i) => ({ g, x, y: y + i * (h / gs.length), w, h: h / gs.length })), divs: [], score: 99 };
}
// Full-length strips side by side (two rows when there are many), the longest things first
function photoStrips(gs, W, H) {
  const rowsOf = gs.length <= 4 ? [gs] : (() => { const half = gs.reduce((s, g) => s + g.need, 0) / 2; let acc = 0; const top = [], rest = []; gs.forEach(g => { if (acc < half && top.length < 4) { top.push(g); acc += g.need; } else rest.push(g); }); return [top, rest]; })();
  const cells = [], divs = [], totals = rowsOf.map(r => r.reduce((s, g) => s + g.need, 0)), all = totals.reduce((s, v) => s + v, 0), availH = H - WALL * (rowsOf.length - 1);
  let y = 0;
  rowsOf.forEach((row, ri) => {
    const rh = ri === rowsOf.length - 1 ? H - y : Math.round(availH * totals[ri] / all * 16) / 16, ordered = [...row].sort((a, b) => b.minLong - a.minLong), availW = W - WALL * (ordered.length - 1);
    let x = 0;
    ordered.forEach((g, i) => {
      const cw = i === ordered.length - 1 ? W - x : Math.round(availW * g.need / totals[ri] * 16) / 16;
      cells.push({ g, x, y, w: cw, h: rh });
      if (i < ordered.length - 1) divs.push({ axis: 'v', pos: x + cw, s: y, e: y + rh });
      x += cw + WALL;
    });
    if (ri < rowsOf.length - 1) divs.push({ axis: 'h', pos: y + rh, s: 0, e: W });
    y += rh + WALL;
  });
  return { cells, divs };
}
// The dividers and names for the groups in the drawer's floor R: { plan, cells: [{ name, cx, cy }], variant, score } or null
function suggestLayout(groups, R) {
  let gs = photoPrep(groups);
  while (gs.length) {
    const tries = [{ variant: 'grid', r: photoTreemap(gs, 0, 0, R.w, R.h) }, { variant: 'strips', r: photoStrips(gs, R.w, R.h) }];
    for (const t of tries) t.score = t.r.cells.reduce((s, c) => s + photoScore(c.g, c.w, c.h), 0) + (t.r.cells.length < gs.length || t.r.divs.length < gs.length - 1 || t.r.cells.some(c => Math.min(c.w, c.h) < 0.75) ? 99 : 0);
    tries.sort((a, b) => a.score - b.score);
    for (const t of tries) {
      if (t.score >= 99 && gs.length > 1) continue;                       // too cramped to cut into that many spaces
      const lines = t.r.divs.map(d => (d.axis === 'v' ? { axis: 'v', pos: R.x + d.pos, s: R.y + d.s, e: R.y + d.e } : { axis: 'h', pos: R.y + d.pos, s: R.x + d.s, e: R.x + d.e }));
      const plan = finishLines(R, lines, [], []);
      if (plan) return { plan, cells: t.r.cells.map(c => ({ name: c.g.name, cx: R.x + c.x + c.w / 2, cy: R.y + c.y + c.h / 2 })), variant: t.variant, score: t.score };
    }
    if (gs.length === 1) return null;
    const b = gs.pop(), a = gs.pop();                                     // fewer, bigger spaces: the two smallest groups share one
    gs.push({ name: 'Small odds and ends', items: [...a.items, ...b.items], need: a.need + b.need, minLong: Math.max(a.minLong, b.minLong) });
    gs.sort((x, y) => y.need - x.need);
  }
  return null;
}
// Put the suggestion in the planner: the drawer size, the dividers and the names. False if no layout could be made.
function applySuggestion(groups, size) {       // size: the drawer size to use, or null to keep the one in the planner (the order form's)
  const lim = drawerLimits(), fit = (v, [lo, hi]) => clamp(snapEighth(Math.round(v * IN)), lo, hi);
  const before = { drawer: { ...state.drawer }, dims: { ...state.dims } };
  if (size) { state.drawer = { w: fit(size.w, lim.w), l: fit(size.l, lim.l), h: fit(size.h, lim.h) }; syncInsert(); }
  const res = suggestLayout(groups, wholeRect());
  if (!res) { state.drawer = before.drawer; syncInsert(); return false; }
  state.segs = res.plan.segs; state.eq = []; state.fix = []; state.names = [];
  const lay = currentLayout();
  for (const c of res.cells) {
    const face = lay.cells.find(f => faceRects(f).some(r => c.cx > r.x && c.cx < r.x + r.w && c.cy > r.y && c.cy < r.y + r.h));
    if (face) setName(face, c.name);
  }
  state.photo = !!size; state.suggested = true;                // a size taken from the photo has to be confirmed as measured; one the customer entered does not
  pendingNum = null; closePopover();
  showSizes();
  commit();
  return true;
}

/* ---- the window ---- */
const phs = { file: null, url: null, groups: [], size: { w: 18, l: 22, h: 3 }, meta: {}, ctl: null };
const phStage = n => { ['#ph-s1', '#ph-busy', '#ph-s2'].forEach((id, i) => { $(id).hidden = i !== n; }); };
function phError(msg) { const e = $('#ph-err'); e.textContent = msg || ''; e.hidden = !msg; }
function openPhoto() {
  phs.file = null; phs.groups = []; if (phs.url) { URL.revokeObjectURL(phs.url); phs.url = null; }
  $('#ph-preview').hidden = true; $('#ph-drop-hint').hidden = false; $('#ph-go').disabled = true; $('#ph-file').value = '';
  $('#ph-note1').textContent = isEmbed() ? 'Your photo is used only to read what is in your drawer and is not kept. The layout will be made for the drawer size you entered.' : 'Your photo is used only to read what is in your drawer and is not kept. The drawer size is estimated from the photo, so you will be asked to measure it before ordering.';
  phError(''); phStage(0); $('#photo-modal').hidden = false; $('#ph-close').focus();
}
function closePhoto() { if (phs.ctl) phs.ctl.abort(); $('#photo-modal').hidden = true; }
function phPick(file) {
  phError('');
  if (!file) return;
  if (!/^image\//.test(file.type) || /heic|heif/i.test(file.type)) { phError('Please use a JPEG or PNG photo. (If your phone saved it as HEIC, choose "Most Compatible" in its camera settings, or share the photo as a JPEG.)'); return; }
  phs.file = file; if (phs.url) URL.revokeObjectURL(phs.url); phs.url = URL.createObjectURL(file);
  $('#ph-preview').src = phs.url; $('#ph-preview').hidden = false; $('#ph-drop-hint').hidden = true; $('#ph-go').disabled = false;
}
// The photo as a JPEG no larger than 1568 px on its longest side (also strips location and other hidden data), as base64
async function phPrepare(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) { bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = phs.url; }); }
  const sw = bmp.width, sh = bmp.height, k = Math.min(1, 1568 / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) throw new Error('encode');
  return await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
}
function phClean(raw) {
  const d = (raw && raw.drawer) || {}, num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const groups = (Array.isArray(raw && raw.groups) ? raw.groups : []).slice(0, 10).map(g => ({
    name: cleanName(g.name || 'Space').trim() || 'Space', on: true,
    items: (Array.isArray(g.items) ? g.items : []).slice(0, 20).map(i => ({ name: cleanName(i.name || 'item').trim() || 'item', count: clamp(Math.round(num(i.count) || 1), 1, 99), length_in: clamp(num(i.length_in) || 3, 0.2, 40), width_in: clamp(num(i.width_in) || 1, 0.1, 30) })),
  })).filter(g => g.items.length);
  return { groups, size: { w: clamp(num(d.width_in) || 18, 5, 47), l: clamp(num(d.length_in) || 22, 5, 47), h: num(d.height_in) ? clamp(num(d.height_in), 0.5, 15) : 3 }, meta: { quality: raw && raw.photo_quality, tip: cleanLabel((raw && raw.photo_tip) || ''), basis: cleanLabel(d.basis || ''), conf: String(d.confidence || '') } };
}
const PH_ERRORS = { 413: 'That photo is too large. Try a smaller one.', 415: 'That kind of file cannot be used. Try a JPEG or PNG photo.', 429: 'Too many photos have been sent just now. Please wait a few minutes and try again.' };
async function phGo() {
  phError(''); phStage(1); $('#ph-go').disabled = true;
  let status = 'Usually about 30 seconds.'; const t0 = Date.now();
  const paint = () => { $('#ph-busy-sub').textContent = `${status} ${Math.round((Date.now() - t0) / 1000)} seconds so far.`; };
  paint(); const tick = setInterval(paint, 1000);
  phs.ctl = new AbortController();
  try {
    status = 'Preparing the photo.'; paint();
    const image = await phPrepare(phs.file);
    status = 'Reading the photo.'; paint();
    const res = await fetch(photoApi(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image, mime: 'image/jpeg' }), signal: phs.ctl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'failed'), { status: res.status });
    const r = phClean(data);
    if (!r.groups.length) { phStage(0); phError('No items could be made out in that photo. Try a brighter, closer shot from above, with things spread out.'); return; }
    phs.groups = r.groups; phs.size = r.size; phs.meta = r.meta;
    phRenderResults(); phStage(2);
  } catch (e) {
    phStage(0);
    if (e && e.name === 'AbortError') return;
    phError(PH_ERRORS[e && e.status] || (e && e.status >= 500 ? 'The photo reader is busy or unavailable. Please try again in a moment.' : 'The photo could not be read. Check your connection and try again, or use a different photo.'));
  } finally { clearInterval(tick); phs.ctl = null; $('#ph-go').disabled = !phs.file; }
}
function phRenderResults() {
  $('#ph-thumb').src = phs.url || '';
  $('#ph-quality').textContent = phs.meta.quality === 'good' ? 'The photo was clear enough to work from.' : 'The photo was not ideal. ' + (phs.meta.tip || 'A top-down shot with things spread out works best.');
  const embed = isEmbed();
  $('#ph-sizebox').hidden = embed; $('#ph-warn').hidden = embed; $('#ph-embed-size').hidden = !embed;
  if (embed) {                                                // the drawer size comes from the order form: the photo's estimate is only a cross-check
    $('#ph-embed-size').textContent = `Your drawer: ${fmtIn(state.dims.w)}″ × ${fmtIn(state.dims.l)}″ × ${fmtIn(state.dims.h)}″ (the size you entered).`
      + (Math.abs(phs.size.w / (state.dims.w / IN) - 1) > 0.2 || Math.abs(phs.size.l / (state.dims.l / IN) - 1) > 0.2 ? ` The photo looks like a drawer about ${fmt2(phs.size.w)}″ × ${fmt2(phs.size.l)}″, so please double-check your measurements.` : '');
  }
  for (const k of ['w', 'l', 'h']) $('#ph-' + k).value = phs.size[k];
  $('#ph-basis').textContent = `${phs.meta.conf ? 'Confidence: ' + phs.meta.conf + '. ' : ''}${phs.meta.basis}`;
  const box = $('#ph-groups'); box.innerHTML = '';
  phs.groups.forEach(g => {
    const card = document.createElement('div'); card.className = 'ph-group' + (g.on ? '' : ' off');
    card.innerHTML = `<div class="ph-ghead"><input type="checkbox" ${g.on ? 'checked' : ''} aria-label="Include ${esc(g.name)}"><input type="text" class="ph-name" value="${esc(g.name)}" maxlength="${NAME_MAX}" aria-label="Name of this space"></div><ul class="ph-items"></ul>`;
    const ul = card.querySelector('ul');
    g.items.forEach((it, ii) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${it.count} × ${esc(it.name)}</span><span class="ph-sz">${it.length_in} × ${it.width_in} in <button type="button" class="ph-x" aria-label="Remove ${esc(it.name)}">×</button></span>`;
      li.querySelector('.ph-x').addEventListener('click', () => { g.items.splice(ii, 1); if (!g.items.length) g.on = false; phRenderResults(); });
      ul.appendChild(li);
    });
    card.querySelector('input[type=checkbox]').addEventListener('change', e => { g.on = e.target.checked; card.classList.toggle('off', !g.on); });
    card.querySelector('input.ph-name').addEventListener('input', e => { g.name = cleanName(e.target.value); });
    box.appendChild(card);
  });
}
function phBuild() {
  if (isEmbed()) {
    if (!phs.groups.some(g => g.on && g.items.length)) { const e = $('#ph-build-err'); e.textContent = 'Switch on at least one space.'; e.hidden = false; return; }
    if (!applySuggestion(phs.groups, null)) { const e = $('#ph-build-err'); e.textContent = 'A layout could not be made for those items in a drawer that size. Try switching off some spaces.'; e.hidden = false; return; }
    closePhoto(); showNote('Suggested layout loaded. Undo goes back to what you had.', 'info', 7000); return;
  }
  const w = parseFloat($('#ph-w').value), l = parseFloat($('#ph-l').value), h = parseFloat($('#ph-h').value), lim = drawerLimits(), err = $('#ph-build-err');
  err.hidden = true;
  const bad = msg => { err.textContent = msg; err.hidden = false; };
  if (!(w >= lim.w[0] / IN && w <= lim.w[1] / IN && l >= lim.l[0] / IN && l <= lim.l[1] / IN)) return bad(`The drawer must be between ${lim.w[0] / IN} and ${lim.w[1] / IN} inches wide and long (the planner makes inserts in that range).`);
  if (!(h >= lim.h[0] / IN && h <= lim.h[1] / IN)) return bad(`The drawer height must be between ${lim.h[0] / IN} and ${lim.h[1] / IN} inches.`);
  if (!phs.groups.some(g => g.on && g.items.length)) return bad('Switch on at least one space.');
  if (!applySuggestion(phs.groups, { w, l, h })) return bad('A layout could not be made for those items in a drawer that size. Try switching off some spaces or check the size.');
  closePhoto();
  showNote('Suggested layout loaded. Undo goes back to what you had.', 'info', 7000);
}
function updatePhotoBanner() {
  $('#photo-banner').hidden = !state.photo;
  $('#photo-card').hidden = !photoApi();
}
{
  const drop = $('#ph-drop');
  on('#photo-open', 'click', openPhoto);
  on('#ph-close', 'click', closePhoto);
  on('#ph-back', 'click', () => phStage(0));
  on('#ph-file', 'change', e => phPick(e.target.files[0]));
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => phPick(e.dataTransfer.files[0]));
  on('#ph-go', 'click', phGo);
  on('#ph-stop', 'click', () => { if (phs.ctl) phs.ctl.abort(); });
  on('#ph-build', 'click', phBuild);
  on('#photo-modal', 'click', e => { if (e.target.id === 'photo-modal' && $('#ph-s1').hidden === false) closePhoto(); });
  on('#photo-measured', 'click', () => { state.photo = false; persist(); refresh(); });
}

/* ---------- init ---------- */
if (!restore()) {                                                  // opens ready to work: an 18 x 22 x 3 in drawer
  state.gap = DEFAULT_GAP;
  state.drawer = { w: 144 * EIGHTH, l: 176 * EIGHTH, h: 24 * EIGHTH };
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
    const size = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(+v * IN)));
    const w = size(m.dims.width, 5 * IN, 47 * IN), l = size(m.dims.length, 5 * IN, 47 * IN), h = size(m.dims.height, IN / 2, 15 * IN);
    if (![w, l, h].every(Number.isFinite)) return;
    state.drawer = { w: w + 2 * state.gap, l: l + 2 * state.gap, h: h + state.gap };
    state.photo = false;                                                          // the order form's size is the customer's own, not a photo estimate
    if ([w, l, h].some(v => v % EIGHTH !== 0)) state.decimal = true;           // a size that is not a whole 1/8 in needs decimal input
    sizesChanged();
  });
  function sendPlan() {
    const pb = priceBreakdown();
    const { W, L, H } = drawerSize();
    const pdf = makePlanPdf();
    const buf = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength);
    window.parent.postMessage({
      type: 'drawer-insert-plan', version: 1,
      dims: { width: W, length: L, height: H }, label: drawerLabel(),
      dividerCount: pb.dividers, dividerArea: pb.dividerArea, total: Math.round(pb.total * 100) / 100, weight: pb.shipping.billable,
      json: jsonText(), pdf: buf,
    }, '*', [buf]);
    showUpload('progress', 0);
  }
  // A layout with no dividers is allowed (an empty tray), but the customer is asked to confirm it.
  const ask = document.createElement('div');
  ask.id = 'confirm-overlay'; ask.hidden = true;
  ask.innerHTML = '<div class="ov-card" role="alertdialog" aria-labelledby="ask-title"><div class="ov-title" id="ask-title">This layout is empty</div><div class="ov-sub">It has no dividers, so it will be built as a plain tray: a bottom and four walls. Use it anyway?</div><div class="ask-buttons"><button type="button" class="btn" id="ask-back">Keep designing</button><button type="button" class="btn primary" id="ask-yes">Yes, use an empty tray</button></div></div>';
  document.body.appendChild(ask);
  // A layout suggested from a photo has only an estimated drawer size: it is confirmed as measured before the plan can be sent.
  const measureAsk = document.createElement('div');
  measureAsk.id = 'measure-overlay'; measureAsk.className = 'confirm-ov'; measureAsk.hidden = true;
  measureAsk.innerHTML = '<div class="ov-card" role="alertdialog" aria-labelledby="meas-title"><div class="ov-title" id="meas-title">Did you measure your drawer?</div><div class="ov-sub">This layout was suggested from a photo, so the drawer size is only an estimate. Your insert is cut to the size shown, so please measure the inside of the drawer (side to side and front to back) and make sure the sizes under Drawer interior are right.</div><div class="ask-buttons"><button type="button" class="btn" id="meas-back">Go back and check</button><button type="button" class="btn primary" id="meas-yes">Yes, the sizes are measured</button></div></div>';
  document.body.appendChild(measureAsk);
  on('#meas-back', 'click', () => { measureAsk.hidden = true; });
  on('#meas-yes', 'click', () => { measureAsk.hidden = true; state.photo = false; persist(); refresh(); $('#finish').click(); });
  on('#finish', 'click', () => {
    if (state.photo) { measureAsk.hidden = false; $('#meas-back').focus(); return; }
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

