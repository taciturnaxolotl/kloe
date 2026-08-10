/*
 * Bayer-dithered canvas fills, in the accent colour.
 *
 * Two callers: the composer's context gauge (a static fill) and the connection
 * hat's catch-up sweep (a travelling band). Both draw one canvas pixel per CELL
 * CSS px and rely on `image-rendering: pixelated` to blow it back up, so the
 * pattern stays chunky and legible instead of dissolving into a gradient.
 */

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// --accent is authored as a hex literal and flips with the theme, so re-read it
// each paint and memoize on the string itself.
let accentRaw = "";
let accentRgb = [85, 119, 163];
function accent() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  if (raw && raw !== accentRaw) {
    accentRaw = raw;
    let h = raw.replace("#", "");
    if (h.length === 3)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    const n = Number.parseInt(h, 16);
    if (Number.isFinite(n)) accentRgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return accentRgb;
}

// `column(p)` returns `[coverage, alpha]` for a horizontal position: how much of
// the column is inked, and how strongly. The pattern is constant down each
// column, so it's evaluated once per x rather than once per pixel.
function paint(canvas, cell, column) {
  const w = Math.max(4, Math.round(canvas.clientWidth / cell));
  const h = Math.max(3, Math.round(canvas.clientHeight / cell));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const cols = new Array(w);
  for (let x = 0; x < w; x++) cols[x] = column(w > 1 ? x / (w - 1) : 0);
  const c2d = canvas.getContext("2d");
  const [r, g, b] = accent();
  const img = c2d.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = cols[x][0] > (BAYER[y & 3][x & 3] + 0.5) / 16 ? cols[x][1] : 0;
    }
  }
  c2d.putImageData(img, 0, 0);
}

// Dithered fill from the left edge to `frac` (0..1). Two regimes, not a ramp
// between them: the fill is the dither at full strength (sharp, fully-lit pixels
// — the whole point of the technique), and the empty remainder is its own faint
// stipple so the bar reads as a bar without competing with the fill. The contrast
// lives in the step between them; blending the alpha across the whole bar just
// dissolves the texture.
export function ditherFill(canvas, frac) {
  paint(canvas, 2, (p) => {
    const inFill = 1 - smoothstep(frac - 0.05, frac + 0.05, p);
    return inFill > 0.5 ? [0.94 * inFill, 255] : [0.42, 62];
  });
}

// A compact band trailing a front at `progress` (0..1) — the gap draining.
export function ditherSweep(canvas, progress) {
  paint(canvas, 3, (p) => [
    0.03 +
      0.3 *
        ((1 - smoothstep(progress - 0.02, progress + 0.1, p)) *
          smoothstep(progress - 0.34, progress - 0.02, p)),
    170,
  ]);
}
