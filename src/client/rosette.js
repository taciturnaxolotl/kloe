/*
 * The empty state: a dithered rosette with messages routing across it.
 *
 * Ports around a rim, a smaller ring of relays inside, and an edge from every
 * port to every relay — so any port reaches any other through the middle. It is
 * the shape of the thing the app does, drawn in the same bayer dither the
 * context gauge and the reconnect sweep use, which is why it belongs here rather
 * than being a decorative spinner.
 *
 * It costs nothing when nothing is happening. The loop parks itself the moment
 * every streak has faded and breathing is off, sleeps on a hidden tab, and stops
 * entirely while the canvas has no layout box — which is most of the time, since
 * the empty state is only visible before the first message.
 */
import { BAYER, smoothstep } from "./dither.js";

/** CSS pixels per dither pixel. Chunky on purpose; it's the same grid as the bar. */
const SCALE = 2;
/** How many streaks may be in flight at once. High enough that clicking a lot
 *  actually sends a lot; affordable because a row only ever tests the streaks
 *  that cross it (see render). */
const MAX_STREAKS = 25;

/** Minimum gap between click-spawned streaks. Fast clicking should feel
 *  generous, not dump the whole budget into one frame. */
const CLICK_MS = 90;
/** Gap between streaks: rare enough to be a punctuation rather than a texture,
 *  and re-rolled each time so they never settle into a rhythm. */
const SPAWN_MIN_MS = 6_000;
const SPAWN_MAX_MS = 10_000;

/**
 * The mesh at rest, and a streak at full brightness.
 *
 * Deliberately not `--accent`: the theme accent is a UI colour, sized to carry
 * a button, and at the scale of the whole empty state it shouts. These are the
 * quieter blues the drawing was designed around.
 */
const REST = [0x74, 0x89, 0xab];
const LIT = [0x8f, 0xb4, 0xf0];

/** Squared distance from a point to a segment, plus how far along it landed. */
function segDist2(px, py, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = px - a.x;
  const wy = py - a.y;
  const len = vx * vx + vy * vy;
  let t = len ? (wx * vx + wy * vy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = wx - vx * t;
  const qy = wy - vy * t;
  return { d2: qx * qx + qy * qy, t };
}

export function mountRosette(canvas, opts) {
  const cfg = {
    ports: 10,
    mids: 5,
    midR: 0.36,
    lineR: 1.05,
    ink: 1,
    breathe: true,
    ...(opts || {}),
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ctx = canvas.getContext("2d");
  const off = document.createElement("canvas");
  const octx = off.getContext("2d");

  let pw = 0;
  let ph = 0;
  let img = null;
  let base = null;
  let net = null;
  /** Every streak in flight. Several at once is the whole point: one message
   *  crossing an idle machine reads as a demo; four reads as a system. */
  let streaks = [];
  let breath = 0;
  let raf = null;
  let visible = !document.hidden;
  /** Whether the canvas currently has a box to draw into. False for the whole
   *  life of a conversation that has messages — the empty state is display:none
   *  — and the loop must not run then, or the first message would leave a
   *  render loop burning behind it forever. */
  let live = false;

  function layout() {
    const cx = pw / 2;
    const cy = ph / 2;
    const R = Math.min(pw, ph) * 0.45;
    const rim = Array.from({ length: cfg.ports }, (_, i) => {
      const a = -Math.PI / 2 + (i / cfg.ports) * Math.PI * 2;
      return { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, r: 3.2 };
    });
    const mid = Array.from({ length: cfg.mids }, (_, i) => {
      const a = -Math.PI / 2 + ((i + 0.5) / cfg.mids) * Math.PI * 2;
      return { x: cx + Math.cos(a) * R * cfg.midR, y: cy + Math.sin(a) * R * cfg.midR, r: 3.9 };
    });
    const edges = [];
    for (const p of rim) for (const m of mid) edges.push({ a: p, b: m });
    net = { rim, mid, edges, nodes: [...rim, ...mid] };
  }

  /** The still image: thin edges and hollow node rings, baked once per resize. */
  function bake() {
    base = new Float32Array(pw * ph);
    const lr = cfg.lineR;
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        let d = 0;
        for (const e of net.edges)
          d += Math.exp(-segDist2(x + 0.5, y + 0.5, e.a, e.b).d2 / (lr * lr)) * 0.62;
        for (const n of net.nodes) {
          const r = Math.hypot(x + 0.5 - n.x, y + 0.5 - n.y);
          d = Math.max(
            d,
            smoothstep(n.r + 1.1, n.r - 0.2, r) * smoothstep(n.r * 0.3, n.r * 0.7, r),
          );
        }
        base[y * pw + x] = Math.min(1, d);
      }
    }
  }

  function resize() {
    const box = canvas.parentElement.getBoundingClientRect();
    if (!box.width || !box.height) return false; // hidden: nothing to size against
    const side = Math.max(180, Math.min(box.width, box.height, 420));
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.style.width = `${Math.round(side)}px`;
    canvas.style.height = `${Math.round(side)}px`;
    canvas.width = Math.round(side * dpr);
    canvas.height = Math.round(side * dpr);
    ctx.imageSmoothingEnabled = false;
    pw = Math.round(side / SCALE);
    ph = Math.round(side / SCALE);
    off.width = pw;
    off.height = ph;
    img = octx.createImageData(pw, ph);
    layout();
    bake();
    return true;
  }

  /**
   * Brightness contributed at one pixel by the streaks crossing this row.
   *
   * `live` is prefiltered per row by the caller, so a pixel never looks at a
   * streak on the far side of the drawing. That row filter is what makes a
   * couple of dozen streaks cost about what a couple used to.
   */
  function streakAt(x, y, live) {
    const lr = cfg.lineR;
    let best = 0;
    for (const s of live) {
      if (x < s.x0 || x > s.x1) continue; // two compares, then skip
      for (let si = 0; si < 2; si++) {
        const seg = s.segs[si];
        const { d2, t } = segDist2(x + 0.5, y + 0.5, seg.a, seg.b);
        // Reduced motion: no travelling head — the whole path lights and fades.
        const lag = reduced ? s.phase * 0.6 : s.phase - (si + t) / 2;
        if (lag < 0 || lag > 0.62) continue;
        const tail = lag < 0.05 ? 1 : 1 - smoothstep(0.05, 0.62, lag);
        best = Math.max(best, tail * Math.exp(-d2 / (lr * lr * 1.35)));
      }
      for (let i = 0; i < 3; i++) {
        const n = s.nodes[i];
        const lag = reduced ? s.phase * 0.6 : s.phase - i * 0.5;
        if (lag < 0 || lag > 0.34) continue;
        const r = Math.hypot(x + 0.5 - n.x, y + 0.5 - n.y);
        best = Math.max(best, (1 - smoothstep(0, 0.34, lag)) * smoothstep(n.r * 2.6, n.r * 0.6, r));
      }
    }
    return best;
  }

  /** Send one message: a rim port, through a relay, to a different rim port. */
  function pulse() {
    if (!net || !live || streaks.length >= MAX_STREAKS) return;
    const pick = (arr) => arr[(Math.random() * arr.length) | 0];
    const a = pick(net.rim);
    const m = pick(net.mid);
    let b = pick(net.rim);
    for (let guard = 0; b === a && guard < 24; guard++) b = pick(net.rim);
    // A bounding box around everything this streak can ever light: the three
    // nodes, widened by the segment glow and the node flash. Without it, every
    // extra streak costs a full pass over every pixel, and a burst of clicks
    // would trade the frame rate for the burst.
    const pad = Math.max(cfg.lineR * 3, a.r * 2.6, m.r * 2.6, b.r * 2.6);
    const xs = [a.x, m.x, b.x];
    const ys = [a.y, m.y, b.y];
    streaks.push({
      segs: [
        { a, b: m },
        { a: m, b },
      ],
      nodes: [a, m, b],
      phase: 0,
      x0: Math.min(...xs) - pad,
      x1: Math.max(...xs) + pad,
      y0: Math.min(...ys) - pad,
      y1: Math.max(...ys) + pad,
    });
    wake();
  }

  function render() {
    // Breathing: a slow swell in the resting mesh, deep enough to read as alive
    // from across the room rather than only when you stare at it.
    const gain = (cfg.breathe && !reduced ? 0.9 + Math.sin(breath) * 0.16 : 1) * cfg.ink;
    const d = img.data;
    const row = [];
    for (let y = 0; y < ph; y++) {
      const brow = BAYER[y & 3];
      // Which streaks reach this row at all. Computed once per row rather than
      // per pixel, which is the difference between 25 streaks being affordable
      // and being a slideshow.
      row.length = 0;
      for (const s of streaks) if (y >= s.y0 && y <= s.y1) row.push(s);
      for (let x = 0; x < pw; x++) {
        const i = y * pw + x;
        const hl = row.length ? streakAt(x, y, row) : 0;
        const v = Math.min(0.88, base[i] * gain + hl * 0.3);
        const o = i * 4;
        if (v <= (brow[x & 3] + 0.5) / 16) {
          d[o + 3] = 0;
          continue;
        }
        // A streak lifts the resting blue toward the brighter one.
        const k = Math.min(1, hl * 1.25);
        d[o] = Math.round(REST[0] + (LIT[0] - REST[0]) * k);
        d[o + 1] = Math.round(REST[1] + (LIT[1] - REST[1]) * k);
        d[o + 2] = Math.round(REST[2] + (LIT[2] - REST[2]) * k);
        d[o + 3] = Math.round(34 + v * 52 + k * 88);
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  }

  function frame() {
    raf = null;
    if (!visible || !live || !base) return;
    if (cfg.breathe && !reduced) breath += 0.009;
    for (const s of streaks) s.phase += 0.01;
    streaks = streaks.filter((s) => s.phase <= 1.72);
    render();
    // Park as soon as nothing is moving. With breathing off and no streaks in
    // flight this draws one frame and then costs nothing at all.
    if ((cfg.breathe && !reduced) || streaks.length) raf = requestAnimationFrame(frame);
  }
  function wake() {
    if (!raf && visible && live && base) raf = requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", () => {
    visible = !document.hidden;
    if (visible) wake();
    else if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
  });

  // Re-bake when the box changes — and this is also how it starts, since the
  // empty state is display:none until a conversation is actually empty.
  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      live = resize();
      if (live) wake();
      else if (raf) {
        cancelAnimationFrame(raf);
        raf = null;
        streaks = []; // nothing in flight should survive being hidden
      }
    }).observe(canvas.parentElement);
  }
  live = resize();
  wake();

  // Traffic. A fresh delay each time rather than a fixed interval, so the
  // spacing never becomes a pattern you can anticipate.
  let timer = null;
  function schedule() {
    timer = setTimeout(
      () => {
        if (!document.hidden) pulse();
        schedule();
      },
      SPAWN_MIN_MS + Math.random() * (SPAWN_MAX_MS - SPAWN_MIN_MS),
    );
  }
  schedule();
  // And on demand: the drawing is the one thing on an empty screen worth poking.
  let lastClick = 0;
  canvas.addEventListener("click", () => {
    const now = performance.now();
    if (now - lastClick < CLICK_MS) return;
    lastClick = now;
    pulse();
  });

  return {
    pulse,
    stop() {
      clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
