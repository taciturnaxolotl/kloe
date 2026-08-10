/*
 * The connection hat — a short strip that grows out of the composer's top edge
 * whenever the stream isn't live, and collapses when it is.
 *
 * Reconnecting and catching-up are one bound lifecycle: the hat waits on a
 * spinner, and the moment the socket returns it plays a single dither sweep (the
 * gap draining out of the event log from Last-Event-ID) and then self-terminates
 * to live. One pass, done — the sweep is determinate, so it means something.
 *
 * Offline and error are the branches. Offline is quiet: input still works and
 * sends queue. Error is the only real alarm, and the caller only escalates to it
 * once a run of quiet retries has failed — so a blip stays yellow.
 *
 * Each state is two or three words and a mark. The one exception is a `retryAt`,
 * which any state may carry: the hat counts it down, so waiting reads as waiting
 * rather than as a dead end.
 *
 * The element owns no state of its own; `set()` is idempotent and the caller
 * (app.js) remains the authority on what the connection is actually doing.
 */

import { ditherSweep } from "./dither.js";

const SWEEP_MS = 750;
// The sweep landing and the strip collapsing in the same frame reads as a
// glitch. Hold on the finished bar for a beat so the recovery gets to land.
const HOLD_MS = 600;

const COPY = {
  reconnecting: { txt: "Reconnecting", ind: "comet" },
  resumed: { txt: "Reconnected", ind: "dot" },
  offline: { txt: "Offline", ind: "dot" },
  error: { txt: "Can't reach the server", ind: "dot", retry: true },
};

const COMET =
  '<svg viewBox="0 0 14 14"><circle class="track" cx="7" cy="7" r="5.3"/>' +
  '<circle class="head" cx="7" cy="7" r="5.3" stroke-dasharray="14 34"/></svg>';
const RETRY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/>' +
  '<path d="M3 3v5h5"/></svg>';

export function mountConn(host, opts) {
  const onRetry = (opts && opts.onRetry) || function () {};
  host.innerHTML =
    '<span class="hatwash"></span><canvas class="hatsweep" aria-hidden="true"></canvas>' +
    '<span class="hatrow"><span class="hatind" aria-hidden="true"></span>' +
    '<span class="hattxt"></span><span class="hatsay"></span>' +
    '<span class="hatgrow"></span><span class="hattail"></span></span>';
  const sweepEl = host.querySelector(".hatsweep");
  const indEl = host.querySelector(".hatind");
  const txtEl = host.querySelector(".hattxt");
  const sayEl = host.querySelector(".hatsay");
  const tailEl = host.querySelector(".hattail");

  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.className = "hatretry";
  retryBtn.innerHTML = `${RETRY_ICON}Retry`;
  retryBtn.addEventListener("click", onRetry);

  let state = "live";
  let raf = null;
  let countdown = null;
  let hold = null;

  function say(text) {
    sayEl.textContent = text ? `· ${text}` : "";
  }

  // The sweep is a one-shot: it drives itself to 1, holds, then hands over to
  // live. If the socket drops again mid-pass, `set` cancels it and the next
  // reconnect starts the pass over.
  function sweep(t0) {
    raf = requestAnimationFrame(function step(now) {
      const p = Math.min(1, (now - t0) / SWEEP_MS);
      ditherSweep(sweepEl, p);
      if (p < 1) raf = requestAnimationFrame(step);
      else {
        raf = null;
        hold = setTimeout(() => set("live"), HOLD_MS);
      }
    });
  }

  function tick(retryAt) {
    const left = Math.max(0, Math.round((retryAt - Date.now()) / 1000));
    say(left ? `retrying in ${left}s` : "retrying…");
  }

  function set(next, detail) {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    if (countdown) {
      clearInterval(countdown);
      countdown = null;
    }
    clearTimeout(hold);
    hold = null;
    state = next;
    host.dataset.state = next;
    host.parentElement.dataset.conn = next;
    // Error is the one state worth interrupting a screen reader for.
    host.setAttribute("role", next === "error" ? "alert" : "status");

    const c = COPY[next];
    if (!c) {
      // live — everything collapses; leave the text in place so it doesn't blink
      // out a frame before the strip finishes closing.
      return;
    }
    txtEl.textContent = c.txt;
    indEl.className = `hatind ${c.ind}`;
    indEl.innerHTML = c.ind === "comet" ? COMET : "";
    tailEl.replaceChildren(...(c.retry ? [retryBtn] : []));

    if (detail?.retryAt) {
      const at = detail.retryAt;
      tick(at);
      countdown = setInterval(() => tick(at), 1000);
    } else say("");

    if (next === "resumed") sweep(performance.now());
  }

  set("live");
  return {
    set,
    get state() {
      return state;
    },
  };
}
