/*
 * kloe chat frontend — aligned with spec.md.
 *
 *  - Eagerness (spec "Eagerness"): the user's own message is appended
 *    OPTIMISTICALLY the instant they submit — network is off the feedback path.
 *    The message carries a client-generated runId; the server echoes that same
 *    runId back over SSE, and we dedupe against it. POST failure marks the turn
 *    failed and offers retry (the spec's rollback).
 *  - Rendering (spec "Rendering"): assistant deltas are streamed into the DOM
 *    with streaming-markdown (smd) — append-only, so already-streamed text is
 *    never re-parsed (no O(n²) re-render). Writes are batched to a rAF (~60fps).
 *    Sanitization is structural: smd never emits raw HTML (verified — raw tags
 *    become text nodes), so the only XSS vector is link/image URLs, which the
 *    wrapped renderer neutralizes as they render. That makes a heavyweight
 *    HTML sanitizer (DOMPurify, ~118KB) unnecessary — it's deliberately absent.
 *
 * No framework, no build step: an ES module importing one small vendored,
 * zero-dep library (streaming-markdown, ~3KB brotli). The durable event log
 * stays authoritative — optimism is a local projection reconciled by the echo.
 */
import * as smd from "streaming-markdown";
import { requireAuth, setPfp } from "./authguard.js";
import { mountDialogs } from "./confirm.js";
import { mountConn } from "./conn.js";
import { fmtConvDate } from "./convrow.js";
import { showContextMenu } from "./ctxmenu.js";
import { ditherFill } from "./dither.js";
import {
  CHECK_ICON as CHECK,
  CHEV_ICON as CHEV,
  COPY_ICON,
  FILE_ICON as FILE_SVG,
  BLANK_ICON as ICON_BLANK,
  CLOCK_ICON as ICON_CLOCK,
  EXT_ICON as ICON_EXT,
  GLOBE_ICON as ICON_GLOBE,
  PAGE_ICON as ICON_PAGE,
  PENCIL_ICON as ICON_PENCIL,
  RESEARCH_ICON as ICON_RESEARCH,
  TERMINAL_ICON as ICON_TERMINAL,
  TOOL_ICON as ICON_TOOL,
  IMAGE_ICON,
  SEND_ICON as SEND,
  X_ICON,
} from "./icons.js";
import { openLightbox } from "./lightbox.js";
import {
  enrich,
  enrichMod,
  strippedUrl as finalize,
  newParser,
  protectMath,
  smdWrite,
} from "./md.js";
import { mountRosette } from "./rosette.js";
import { createRouter } from "./router.js";
import { mountSidebar } from "./sidebar.js";

(function () {
  "use strict";

  // Live syntax highlighting for the ACTIVE (last, still-growing) code block of a
  // streaming turn. Only one block is ever streaming — completed blocks are done
  // by the end-of-turn enrich pass — so we re-highlight just that one, throttled:
  // a single pass in flight per block, and whatever streamed in meanwhile is kept
  // as a plain tail and picked up on the next pass. `_hlLen` is the text length
  // we've highlighted through, so an unchanged block is skipped. Pathologically
  // large blocks fall back to end-of-turn highlighting to avoid O(n²) churn.
  var HL_MAX = 20000;
  function streamHighlightActive(proseEl) {
    var codes = proseEl.querySelectorAll("pre > code");
    if (!codes.length) return;
    var el = codes[codes.length - 1];
    var len = el.textContent.length;
    if (el._hlLen === len || len > HL_MAX) return;
    streamHl(el);
  }
  function streamHl(el) {
    if (el._hlBusy) return; // a pass is running; it re-checks the length when done
    var text = el.textContent;
    if (el._hlLen === text.length) return;
    el._hlBusy = true;
    enrichMod().then(function (m) {
      if (!m.highlightInner) {
        el._hlBusy = false;
        return;
      }
      m.highlightInner(el, text)
        .then(function (inner) {
          // Record the length we attempted, success OR failure. Without this a
          // failed highlight (null) would leave _hlLen unset, so the "did it grow?"
          // check below stays true forever and re-calls in a tight async loop that
          // freezes the page. On failure we just leave the block plain.
          el._hlLen = text.length;
          if (inner != null) {
            // smd may have appended more text while we highlighted; it only appends,
            // so `text` is still a prefix — keep the tail plain for the next pass.
            var cur = el.textContent;
            var tail = cur.length > text.length ? cur.slice(text.length) : "";
            el.innerHTML = inner;
            if (tail) el.appendChild(document.createTextNode(tail));
            el.classList.add("hl"); // enables the token colors (see app.css)
          }
          el._hlBusy = false;
          if (el.textContent.length !== el._hlLen && el.textContent.length <= HL_MAX) streamHl(el);
        })
        .catch(function () {
          el._hlLen = text.length; // don't retry the same text in a loop
          el._hlBusy = false;
        });
    });
  }

  // Defer a completed block's enrichment until its turn scrolls into view. On a
  // long conversation this avoids highlighting every off-screen turn up front —
  // the biggest load cost — and doesn't fetch the Shiki/KaTeX chunks until
  // something visible needs them. Falls back to immediate enrich if there's no
  // turn ancestor or no IntersectionObserver.
  var enrichObserver = null;
  var enrichPending = new WeakMap(); // turn element -> [blocks awaiting enrich]
  function ensureEnrichObserver() {
    if (enrichObserver || !window.IntersectionObserver) return enrichObserver;
    enrichObserver = new IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) continue;
          var turn = entries[i].target;
          enrichObserver.unobserve(turn);
          var list = enrichPending.get(turn);
          enrichPending.delete(turn);
          if (list) for (var j = 0; j < list.length; j++) enrich(list[j]);
        }
      },
      { root: scroll, rootMargin: "800px 0px" },
    ); // enrich a bit before it's visible
    return enrichObserver;
  }
  function queueEnrich(el) {
    var obs = ensureEnrichObserver();
    var turn = obs && el && el.closest ? el.closest(".turn") : null;
    if (!turn) {
      enrich(el);
      return;
    }
    var list = enrichPending.get(turn);
    if (!list) {
      list = [];
      enrichPending.set(turn, list);
      obs.observe(turn);
    }
    list.push(el);
  }

  var $ = function (id) {
    return document.getElementById(id);
  };
  var thread = $("thread"),
    scroll = $("scroll"),
    jump = $("jump");
  var input = $("input"),
    send = $("send"),
    composer = $("composer");
  var title = $("title");
  var hat = mountConn($("hat"), {
    onRetry: function () {
      reconnectNow();
    },
  });
  var pill = $("pill"),
    pillModel = $("pillModel"),
    picker = $("picker");
  var ctx = $("ctx"),
    ctxbar = $("ctxbar"),
    ctxpct = $("ctxpct");
  var queueEl = $("queue"),
    queueCount = $("queueCount"),
    queueItems = $("queueItems");
  var stagedEl = $("staged"),
    attachBtn = $("attach");

  // ---- state -------------------------------------------------------------
  var convId = null; // current conversation id
  // Opened from a project page (/?project=<id>): file the new chat into it once
  // its first message creates the conversation. We fetch the project's name up
  // front so the header breadcrumb can show it before the first message lands.
  var pendingProject = new URLSearchParams(location.search).get("project");
  var pendingProjectName = null;
  var source = null; // active EventSource
  var streaming = false; // a run is in flight for the current conversation
  var atBottom = true;
  var models = [],
    selected = null;
  var msgs = Object.create(null); // messageId -> assistant render record
  var pending = Object.create(null); // runId -> optimistic user turn awaiting echo
  var queued = Object.create(null); // runId -> { content, attachments } (staging panel)
  var flushHandle = null;
  var lastUsage = null; // real token usage from the last completed turn
  var lastUsageConv = null; // which conversation lastUsage belongs to (empty chats have none)
  var ctxDisplayed = 0; // the token count the gauge is currently showing (animated)
  var ctxAnim = null; // rAF handle for the gauge tween
  var staged = []; // attachments uploaded and waiting on the next send

  // ---- attachments -------------------------------------------------------
  // Uploads go to the content-addressed blob store first; the send/steer body
  // then carries lightweight refs ({sha256,name,mime,kind}), never bytes.
  var IMG = /^image\//;
  function attKind(mime) {
    return IMG.test(mime) ? "image" : "file";
  }
  // Serve URL for a stored blob, carrying the original name so a download keeps it.
  function blobUrl(a) {
    return "/api/blobs/" + encodeURIComponent(a.sha256) + "?name=" + encodeURIComponent(a.name);
  }

  function uploadingCount() {
    var n = 0;
    for (var i = 0; i < staged.length; i++) if (staged[i].uploading) n++;
    return n;
  }
  // A ref suitable for the message body (drops local-only fields).
  function attachmentRef(it) {
    return { sha256: it.sha256, name: it.name, mime: it.mime, kind: it.kind };
  }
  // Only files whose bytes are actually in the store can be referenced. A chip
  // whose upload failed stays visible so it can be retried or removed, but it
  // has no sha256 — sending it would attach a reference to nothing.
  function sendableStaged() {
    return staged.filter(function (it) {
      return it.sha256 && !it.uploading;
    });
  }

  async function uploadOne(file) {
    var it = {
      file: file, // kept so a failed upload can be retried without re-picking it
      name: file.name || "file",
      mime: file.type || "application/octet-stream",
      kind: attKind(file.type || ""),
      sha256: null,
      uploading: true,
      failed: false,
      url: IMG.test(file.type || "") ? URL.createObjectURL(file) : null,
    };
    staged.push(it);
    renderStaged();
    updateSend();
    await sendBlob(it);
  }
  /**
   * Upload one staged file's bytes.
   *
   * A failure LEAVES the chip in the tray, marked. Dropping it (what this used
   * to do) meant a file the user watched themselves attach vanished with only a
   * console warning — indistinguishable from never having dropped it, and they
   * find out by sending a message that doesn't have it. Staying put with a
   * Retry says what happened and offers the one thing worth doing about it.
   */
  async function sendBlob(it) {
    it.uploading = true;
    it.failed = false;
    renderStaged();
    updateSend();
    try {
      var res = await fetch("/api/blobs", {
        method: "POST",
        headers: { "content-type": it.mime },
        body: it.file,
      });
      if (!res.ok) throw new Error("upload failed (" + res.status + ")");
      var j = await res.json();
      it.sha256 = j.sha256;
      it.uploading = false;
    } catch (e) {
      it.uploading = false;
      it.failed = true;
      console.warn("attachment:", e && e.message);
    }
    renderStaged();
    updateSend();
  }
  function stageFiles(list) {
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) uploadOne(list[i]);
  }
  function removeStaged(it) {
    var i = staged.indexOf(it);
    if (i < 0) return;
    staged.splice(i, 1);
    if (it.url) URL.revokeObjectURL(it.url);
    renderStaged();
    updateSend();
  }
  function clearStaged() {
    for (var i = 0; i < staged.length; i++) if (staged[i].url) URL.revokeObjectURL(staged[i].url);
    staged = [];
    renderStaged();
    updateSend();
  }
  function renderStaged() {
    stagedEl.classList.toggle("hidden", staged.length === 0);
    stagedEl.innerHTML = "";
    staged.forEach(function (it) {
      var chip = document.createElement("div");
      chip.className =
        "chip" +
        (it.uploading ? " uploading" : "") +
        (it.failed ? " failed" : "") +
        (it.kind === "image" ? " img" : "");
      if (it.kind === "image" && it.url) {
        var img = document.createElement("img");
        img.src = it.url;
        img.alt = it.name;
        // An image the browser can't decode still shows as an image — the
        // broken-image glyph reads as a failed upload, which it isn't.
        img.onerror = function () {
          chip.classList.remove("img");
          var ic = document.createElement("span");
          ic.className = "fi";
          ic.innerHTML = IMAGE_ICON;
          chip.replaceChild(ic, img);
          chip.classList.remove("previewable");
        };
        img.addEventListener("click", function () {
          // Located by url, not by identity: `stagedShot` builds a fresh object
          // each call, so an indexOf against a new one never matches.
          var shots = stagedImages();
          var here = shots.findIndex(function (shot) {
            return shot.url === it.url;
          });
          openLightbox(shots, here < 0 ? 0 : here);
        });
        chip.classList.add("previewable");
        chip.appendChild(img);
      } else {
        var ic = document.createElement("span");
        ic.className = "fi";
        ic.innerHTML = FILE_SVG;
        chip.appendChild(ic);
      }
      var nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = it.failed ? it.name + " — failed" : it.name;
      chip.appendChild(nm);
      if (it.failed) {
        var retry = document.createElement("button");
        retry.type = "button";
        retry.className = "chipbtn retry";
        retry.textContent = "Retry";
        retry.onclick = function () {
          void sendBlob(it);
        };
        chip.appendChild(retry);
      }
      var x = document.createElement("button");
      x.type = "button";
      x.className = "chipbtn x";
      x.title = "Remove " + it.name;
      x.setAttribute("aria-label", "Remove " + it.name);
      x.innerHTML = X_ICON;
      x.onclick = function () {
        removeStaged(it);
      };
      chip.appendChild(x);
      stagedEl.appendChild(chip);
    });
  }
  // Staged images, as lightbox items. Recomputed per click rather than cached:
  // the tray changes as uploads land and files are removed.
  function stagedShot(it) {
    return { url: it.url, name: it.name, href: it.sha256 ? blobUrl(it) : it.url };
  }
  function stagedImages() {
    return staged.filter((it) => it.kind === "image" && it.url).map(stagedShot);
  }
  // Renders a turn's attachments (images as thumbnails, other files as chips).
  /**
   * What to show for an image the browser refuses to decode.
   *
   * Which formats those are is not a list worth keeping: Safari shows HEIC and
   * Chrome doesn't, AVIF arrived in one browser years before another, and a
   * hardcoded denylist would be wrong in both directions on the day it shipped.
   * So the image is attempted and the browser answers — `onerror` is the only
   * reliable, always-current test of "can you render this?". The cost is the
   * request, which was going to happen anyway.
   *
   * It falls back to a plain image icon rather than a crossed-out one: the file
   * is a perfectly good photo, and this browser's inability to draw it is our
   * limitation to report quietly, not a defect to mark on the user's upload.
   */
  function unrenderable(link, name) {
    link.className = "att file noimg";
    link.setAttribute("download", name);
    link.title = name + " — this format can't be previewed here. Click to download.";
    link.innerHTML = "";
    var ic = document.createElement("span");
    ic.className = "fi";
    ic.innerHTML = IMAGE_ICON;
    var nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = name;
    link.appendChild(ic);
    link.appendChild(nm);
  }

  /**
   * The images of one attachment group that actually rendered.
   *
   * Read off the DOM at click time, so a HEIC that fell back to a file chip is
   * simply not in the list — arrowing through a gallery onto a blank frame is
   * worse than not offering it.
   */
  function renderableImages(wrap) {
    var out = [];
    wrap.querySelectorAll(".att.img img").forEach(function (img) {
      out.push({ url: img.src, name: img.alt, href: img.src });
    });
    return out;
  }

  function renderAttachments(container, attachments) {
    if (!attachments || !attachments.length) return;
    var wrap = document.createElement("div");
    wrap.className = "attachments";
    attachments.forEach(function (a) {
      var link = document.createElement("a");
      link.href = blobUrl(a);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      if (a.kind === "image") {
        link.className = "att img";
        var img = document.createElement("img");
        img.src = blobUrl(a);
        img.alt = a.name;
        img.loading = "lazy";
        img.onerror = function () {
          unrenderable(link, a.name);
        };
        // Open in place rather than navigating away. The href stays a real URL
        // underneath, so cmd-click and "open in new tab" keep working — the
        // lightbox is an enhancement of the link, not a replacement for it.
        link.addEventListener("click", function (e) {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          var shots = renderableImages(wrap);
          var here = shots.findIndex(function (s) {
            return s.url === blobUrl(a);
          });
          if (here < 0) return; // this one failed to decode; let the link do its job
          e.preventDefault();
          openLightbox(shots, here);
        });
        link.appendChild(img);
      } else {
        link.className = "att file";
        link.setAttribute("download", a.name);
        var ic = document.createElement("span");
        ic.className = "fi";
        ic.innerHTML = FILE_SVG;
        link.appendChild(ic);
        var nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = a.name;
        link.appendChild(nm);
      }
      wrap.appendChild(link);
    });
    container.appendChild(wrap);
  }

  // A turn body is an ordered container of blocks; markdown (user text, or a
  // streamed assistant turn) lives in a `.block.prose`. Tool/thinking blocks
  // (later) append as their own block types alongside it.
  function proseBlock(container) {
    var el = document.createElement("div");
    el.className = "block prose";
    container.appendChild(el);
    return el;
  }
  // Static (non-streamed) markdown: render into a fresh prose block, then run the
  // completed-block enhancers (code highlight, math). Returns whether a URL was stripped.
  function renderStaticMd(container, text) {
    var el = proseBlock(container);
    var np = newParser(el);
    smd.parser_write(np.parser, protectMath(text)); // full text → wrap math, mask stray `$`
    smd.parser_end(np.parser);
    queueEnrich(el);
    return finalize(np.renderer);
  }

  // rAF-batched delta flush: models emit faster than the eye needs (spec).
  function scheduleFlush() {
    if (!flushHandle) flushHandle = requestAnimationFrame(flush);
  }
  function flush() {
    flushHandle = null;
    var painted = false;
    for (var id in msgs) {
      var r = msgs[id];
      var or = r.activity && r.activity.openReasoning;
      if (or && or.buf) {
        smdWrite(or.parser, or.buf);
        or.buf = "";
        painted = true;
        updateReasoningPreview(or);
      }
      var ts = r.textSink;
      if (ts && ts.buf) {
        smdWrite(ts.parser, ts.buf);
        ts.buf = "";
        painted = true;
        liveMeta(r);
        streamHighlightActive(ts.el); // live-highlight the active code block, if any
      }
    }
    if (painted) autoScroll();
  }

  // ---- helpers -----------------------------------------------------------
  // Reading scrollHeight forces a synchronous reflow, so a per-event call during
  // a bulk history load thrashes layout. `bulkLoading` suppresses it while a
  // conversation is applied in one pass; the caller scrolls once at the end.
  var bulkLoading = false;
  function autoScroll() {
    if (!bulkLoading && atBottom) scroll.scrollTop = scroll.scrollHeight;
  }
  // Compact context-window label: 1000000 -> "1M", 1048576 -> "1M", 1500000 -> "1.5M", else "Nk".
  function fmtCtx(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    return Math.round(n / 1000) + "k";
  }
  // Real context fill: what the last completed turn left resident in the window.
  // The server reports that as `contextTokens`; input+output is a fallback for
  // turns recorded before it existed, and reads high on tool-heavy turns because
  // it sums every step of the loop.
  function usedTokens(u) {
    if (!u) return null;
    if (u.contextTokens != null) return u.contextTokens;
    if (u.inputTokens != null || u.outputTokens != null)
      return (u.inputTokens || 0) + (u.outputTokens || 0);
    if (u.totalTokens != null) return u.totalTokens;
    return null;
  }
  // Paint the gauge for a specific token count. `used == null` (or no model
  // window) hides it. Fractional `used` is fine — the tween feeds it fractions.
  function renderCtx(used) {
    if (!selected || !selected.contextWindow || used == null) {
      ctx.classList.add("hidden");
      return;
    }
    var frac = Math.max(0, Math.min(1, used / selected.contextWindow));
    // A `~` when the count came from measuring the prompt rather than from the
    // provider's tokenizer — the gauge should say which kind of number it is.
    var approx = !!(lastUsage && lastUsage.contextEstimated);
    ctx.classList.remove("hidden"); // unhide first: a display:none canvas measures 0
    ditherFill(ctxbar, frac);
    ctxpct.textContent = (approx ? "~" : "") + Math.round(frac * 100) + "%";
    ctx.title =
      (approx ? "about " : "") +
      Math.round(used).toLocaleString() +
      " / " +
      selected.contextWindow.toLocaleString() +
      " tokens";
  }
  // Animate the gauge from what it's showing to lastUsage's value, so switching
  // conversations glides the fill rather than blanking and popping. An empty chat
  // (or no model window) drains to zero, then hides.
  function updateCtx() {
    var target = usedTokens(lastUsage);
    var hideAfter = target == null || !selected || !selected.contextWindow;
    if (ctxAnim) cancelAnimationFrame(ctxAnim);
    if (hideAfter && ctx.classList.contains("hidden") && ctxDisplayed === 0) return; // nothing to do
    var to = hideAfter ? 0 : target;
    var from = ctxDisplayed,
      t0 = null;
    function step(now) {
      if (t0 === null) t0 = now;
      var p = Math.min(1, (now - t0) / 320);
      var eased = 1 - (1 - p) ** 3; // easeOutCubic
      ctxDisplayed = from + (to - from) * eased;
      renderCtx(hideAfter && p >= 1 ? null : ctxDisplayed);
      if (p < 1) ctxAnim = requestAnimationFrame(step);
      else {
        ctxAnim = null;
        if (hideAfter) ctxDisplayed = 0;
      }
    }
    ctxAnim = requestAnimationFrame(step);
  }
  function updateSend() {
    // One button in the action slot: Stop while a run streams, Send otherwise.
    // Mid-run you still queue by pressing Enter (submit() steers when streaming);
    // the panel above the composer shows what's staged.
    // Skip during a bulk history load — replaying each turn's message-start/end
    // would strobe the button between Stop and Send; the caller repaints once after.
    if (bulkLoading) return;
    $("stop").style.display = streaming ? "inline-flex" : "none";
    send.style.display = streaming ? "none" : "inline-flex";
    send.innerHTML = SEND;
    // Sendable with text OR staged attachments; blocked while an upload is still
    // in flight (its sha256 isn't known yet, so the ref would be incomplete).
    var has =
      (input.value.trim().length > 0 || staged.length > 0) && selected && uploadingCount() === 0;
    send.className = "send" + (has ? " ready" : "");
    send.disabled = !has;
    send.setAttribute("aria-label", "Send");
  }
  // While streaming we don't have real token counts yet (the provider reports
  // usage only at the end), so show only measured wall-clock: ttft + elapsed.
  // No estimated token rate — real counts land on message-end.
  function liveMeta(rec) {
    var elapsed = (Date.now() - rec.startedAt) / 1000;
    var ttft = rec.firstDeltaAt
      ? ((rec.firstDeltaAt - rec.startedAt) / 1000).toFixed(1) + "s ttft · "
      : "";
    rec.meta.textContent = ttft + elapsed.toFixed(1) + "s";
  }

  // ---- thread rendering --------------------------------------------------
  function clearThread() {
    thread.innerHTML = "";
    msgs = Object.create(null);
    pending = Object.create(null);
    queued = Object.create(null);
    renderQueue();
    clearStaged();
    streaming = false;
    // Note: lastUsage is intentionally NOT reset here — the gauge keeps the
    // previous conversation's value so it can animate to the next one. openStream
    // / loadHistoryThenStream own the gauge reset (drain to empty for a new chat).
    if (flushHandle) {
      cancelAnimationFrame(flushHandle);
      flushHandle = null;
    }
    // Drop pending enrichment for the turns we just removed (new turns re-observe).
    if (enrichObserver) enrichObserver.disconnect();
    enrichPending = new WeakMap();
  }
  // Copying inside the thread: the browser's native text/plain pads block
  // boundaries with newlines (the .body > .prose > <p> chrome leaves trailing
  // blank lines). `sel.toString()` is the clean text, so drive the clipboard from
  // it — trim surrounding newlines and collapse any 3+ blank-line runs — and keep
  // the selection's HTML so rich paste still works.
  thread.addEventListener("copy", function (e) {
    var sel = window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || !sel.rangeCount || !e.clipboardData) return;
    var cleaned = sel
      .toString()
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "")
      .replace(/[ \t\n]+$/, "");
    if (!cleaned) return; // nothing meaningful selected — leave native copy alone
    var frag = document.createElement("div");
    frag.appendChild(sel.getRangeAt(0).cloneContents());
    e.clipboardData.setData("text/plain", cleaned);
    e.clipboardData.setData("text/html", frag.innerHTML);
    e.preventDefault();
  });

  // While backfilling older history, `renderAnchor` is the turn to insert BEFORE
  // (so older turns stack in order above the already-rendered newest ones); null
  // means append (live turns, and the newest-first phase).
  var renderAnchor = null;

  // ---- copying a message --------------------------------------------------
  // The markdown a turn was rendered FROM, not its rendered DOM. A model writes
  // markdown, the user typed markdown, and that is what someone pasting into an
  // editor wants back — headings as `#`, code still fenced, tables intact.
  // Scraping innerText would hand them the shape of the screen instead.
  var turnMd = new WeakMap();
  /** Remember a turn's source text, and give it the affordance to copy it. */
  function markCopyable(turn, md) {
    if (!turn || !md || !md.trim()) return;
    turnMd.set(turn, md);
    if (turn.querySelector(".turnfoot")) return;
    var foot = document.createElement("div");
    foot.className = "turnfoot";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copymsg";
    btn.title = "Copy as Markdown";
    btn.setAttribute("aria-label", "Copy message as Markdown");
    btn.innerHTML = COPY_ICON;
    btn.addEventListener("click", function () {
      var text = turnMd.get(turn);
      if (!text) return;
      navigator.clipboard.writeText(text).then(function () {
        // The tick IS the confirmation — a message that said "Copied" would
        // move the thread by a line every time anyone pressed it.
        btn.innerHTML = CHECK;
        btn.classList.add("copied");
        setTimeout(function () {
          btn.innerHTML = COPY_ICON;
          btn.classList.remove("copied");
        }, 1400);
      });
    });
    foot.appendChild(btn);
    turn.appendChild(foot); // after the body and any documents: the end of the message
  }
  /** An assistant turn's answer: its prose segments, minus the tool traces. */
  function answerMarkdown(rec) {
    var out = "";
    for (var i = 0; i < rec.proses.length; i++) out += rec.proses[i].full || "";
    return out;
  }

  function makeTurn(who, cls) {
    var t = document.createElement("article");
    t.className = "turn" + (cls ? " " + cls : "");
    t.innerHTML =
      '<div class="label"><span class="who' +
      (who === "You" ? " user" : "") +
      '"></span><span class="meta"></span></div>' +
      '<div class="body" aria-live="polite"></div>';
    t.querySelector(".who").textContent = who;
    if (renderAnchor) thread.insertBefore(t, renderAnchor);
    else thread.appendChild(t);
    return t;
  }

  function optimisticUser(content, runId, attachments) {
    var t = makeTurn("You", "pending");
    var body = t.querySelector(".body");
    if (content) renderStaticMd(body, content);
    renderAttachments(body, attachments);
    markCopyable(t, content);
    autoScroll();
    pending[runId] = { turn: t, content: content, attachments: attachments };
  }
  function confirmUser(runId, content, attachments) {
    // A queued steer being promoted by the flush: drop it from the staging
    // panel — it now enters the thread as a real turn (rendered fresh below,
    // the first time it appears there).
    if (queued[runId] !== undefined) {
      delete queued[runId];
      renderQueue();
    }
    var p = pending[runId];
    if (p) {
      p.turn.classList.remove("pending", "failed");
      delete pending[runId];
      return;
    }
    // Not ours (history, another device, or a promoted steer): render fresh.
    var t = makeTurn("You");
    var body = t.querySelector(".body");
    if (content) renderStaticMd(body, content);
    renderAttachments(body, attachments);
    markCopyable(t, content);
    autoScroll();
  }
  function confirmQueued(runId, content, attachments) {
    // Staging only: queued steers never enter the thread until promoted. The
    // panel is the single view of the pending queue.
    queued[runId] = { content: content, attachments: attachments };
    renderQueue();
  }
  function confirmCancelled(runId) {
    if (queued[runId] === undefined) return;
    delete queued[runId];
    renderQueue();
  }
  function failUser(runId) {
    var p = pending[runId];
    if (!p) return;
    p.turn.classList.remove("pending");
    p.turn.classList.add("failed");
    if (p.turn.querySelector(".failbar")) return;
    var fb = document.createElement("div");
    fb.className = "failbar";
    fb.textContent = "not sent — ";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Retry";
    btn.onclick = function () {
      p.turn.remove();
      delete pending[runId];
      doSend(p.content, runId, p.attachments);
    };
    fb.appendChild(btn);
    p.turn.querySelector(".body").appendChild(fb);
  }

  function assistantTurn(messageId) {
    if (msgs[messageId]) return msgs[messageId];
    var t = makeTurn("Assistant", "generating");
    var rec = {
      turn: t,
      body: t.querySelector(".body"),
      meta: t.querySelector(".meta"),
      // The turn body is an ordered run of segments: answer prose blocks and
      // activity blocks (each a self-contained stepper of thinking + tools).
      // They interleave in arrival order — a run of thinking/tools between two
      // chunks of answer text becomes its own stepper, sitting between them.
      activity: null, // the currently open activity block (see newActivityBlock)
      proses: [], // every answer prose block (for the final flush)
      textSink: null, // the currently open prose { el, parser, renderer, buf }
      toolSteps: null, // toolCallId -> tool step (carries its block)
      firstReasoning: null, // first reasoning step of the whole turn (gets the duration)
      firstReasoningBlock: null,
      startedAt: Date.now(),
      firstDeltaAt: 0,
    };
    msgs[messageId] = rec;
    autoScroll();
    return rec;
  }
  // ---- activity stepper (interleaved) ------------------------------------
  // Each contiguous run of thinking + tool steps is one collapsible block: a
  // vertical stepper with icons on a connector rail. Auto-opened while the model
  // works, auto-collapsed to a one-line summary header once the answer text
  // resumes (or the turn ends). A turn may hold several, interleaved with prose.

  function newActivityBlock(rec) {
    var d = document.createElement("details");
    d.className = "block activity";
    var sum = document.createElement("summary");
    sum.className = "activity-head";
    sum.innerHTML =
      '<span class="stepicon"></span><span class="steplabel activity-label"></span>' + CHEV;
    var stepper = document.createElement("div");
    stepper.className = "stepper";
    d.appendChild(sum);
    d.appendChild(stepper);
    rec.body.appendChild(d); // in arrival order, below whatever preceded it
    return {
      details: d,
      stepper: stepper,
      headIcon: sum.querySelector(".stepicon"),
      headLabel: sum.querySelector(".activity-label"),
      openReasoning: null,
      firstReasoning: null,
      thoughtLabel: "",
      stepCount: 0,
      tools: [],
      activeTool: null, // tools: ordered {name, input}; activeTool: the in-flight one
      // The turn this block belongs to, so a step can reach message-level things
      // (artifacts collect on the turn, not in the gutter).
      rec: rec,
    };
  }
  // The current open activity block. Opening one closes the current prose block
  // (flushing it), so a later text delta starts a fresh prose block below.
  function openActivity(rec) {
    if (rec.textSink) {
      if (rec.textSink.buf) {
        smdWrite(rec.textSink.parser, rec.textSink.buf);
        rec.textSink.buf = "";
      }
      rec.textSink = null;
    }
    if (rec.activity) return rec.activity;
    rec.activity = newActivityBlock(rec);
    return rec.activity;
  }
  // Close the current activity block: finish its thinking, collapse it, settle
  // its header. The next thinking/tool step opens a new block below.
  function closeActivity(rec) {
    var a = rec.activity;
    if (!a) return;
    blockEndReasoning(a);
    // Multi-step blocks collapse to their summary header; a single-step block has
    // no header (it would duplicate the step), so it stays open showing that row.
    if (a.stepCount > 1) a.details.open = false;
    blockUpdateHead(a);
    rec.activity = null;
  }
  // The header for one block: while a step is live, reflect it ("Thinking",
  // "Searching the web for cats"); once settled, summarize — tools win over
  // thinking, so a block that searched reads "Searched the web for cats" and a
  // pure-thinking block reads "Thought for Ns". No "Done".
  // Steps in this block that used a given tool (for per-tool counts/summaries).
  function stepsOfTool(a, name) {
    return a.tools.filter(function (e) {
      return e.name === name;
    });
  }
  // Favicons collected from fetch_url RESULTS, keyed by the request's domain (the
  // input host — GitHub's github.com, not the raw.githubusercontent.com the fetch
  // was rewritten to). The header prefers these (real SVG + dark variant) over the
  // flat service icon. A session cache — replayed results repopulate it on load.
  var siteFavicons = Object.create(null);

  // Distinct domains read in this block (fetch_url calls), first-seen order, capped.
  // Drives the favicons shown in the collapsed header instead of a generic icon.
  function fetchDomains(a, max) {
    var seen = Object.create(null),
      out = [];
    for (var i = 0; i < a.tools.length && out.length < max; i++) {
      if (a.tools[i].name !== "fetch_url") continue;
      var d = domainOf((a.tools[i].input && a.tools[i].input.url) || "");
      if (d && !seen[d]) {
        seen[d] = 1;
        out.push(d);
      }
    }
    return out;
  }
  // The collapsed header. While a step is live it reflects that step; once the
  // block settles it summarizes the LATEST tool used (last-tool-wins for a mixed
  // block), or the thinking if no tools ran. Per-tool phrasing comes from TOOL_UI.
  function blockHeadState(a) {
    if (a.openReasoning) return { icon: ICON_CLOCK, label: "Thinking", working: true };
    if (a.activeTool) {
      var ui = toolUI(a.activeTool.name);
      return {
        icon: ui.icon,
        label: ui.summary(stepsOfTool(a, a.activeTool.name), true, a.activeTool.name),
        working: true,
      };
    }
    if (a.tools.length) {
      // Distinct tool types in first-seen order → overlapping icons + a summary
      // per type joined ("Ran 5 commands · Read 2 pages"). One type collapses to
      // the familiar single icon + summary.
      var names = [];
      a.tools.forEach(function (e) {
        if (names.indexOf(e.name) < 0) names.push(e.name);
      });
      // fetch_url contributes the read sites' favicons (deduped, capped) instead
      // of one generic page icon; other tools keep their single icon.
      var icons = [];
      names.forEach(function (n) {
        if (n === "fetch_url") {
          var doms = fetchDomains(a, 5);
          if (doms.length)
            doms.forEach(function (d) {
              icons.push({ fav: d });
            });
          else icons.push(toolUI(n).icon);
        } else {
          icons.push(toolUI(n).icon);
        }
      });
      var label = names
        .map(function (n) {
          return toolUI(n).summary(stepsOfTool(a, n), false, n);
        })
        .join(" · ");
      return { icons: icons, label: label, working: false };
    }
    if (a.firstReasoning)
      return { icon: ICON_CLOCK, label: a.thoughtLabel || "Thought", working: false };
    return null;
  }
  // A header icon is either an SVG string (a tool icon) or { fav: domain } (a read
  // site's favicon). Favicons load from the DDG service, falling back to the page
  // icon if there's none.
  function headIconInto(host, ic) {
    if (typeof ic === "string") {
      host.innerHTML = ic;
      return;
    }
    host.classList.add("favic");
    var f = siteFavicons[ic.fav]; // { svg?, dark? } from the fetch result, if seen
    var img = document.createElement("img");
    img.className = "favicon";
    img.alt = "";
    img.loading = "lazy";
    // Prefer the page's own SVG (adaptive ones self-fix dark mode); else the DDG
    // service icon.
    img.src = (f && f.svg) || "https://icons.duckduckgo.com/ip3/" + ic.fav + ".ico";
    img.onerror = function () {
      host.classList.remove("favic");
      host.innerHTML = ICON_PAGE;
    };
    // A known dark variant → a <picture> source, so the dark theme shows a legible
    // mark natively.
    if (f && f.dark) {
      var pic = document.createElement("picture");
      var src = document.createElement("source");
      src.media = "(prefers-color-scheme: dark)";
      src.srcset = f.dark;
      pic.appendChild(src);
      pic.appendChild(img);
      host.appendChild(pic);
    } else {
      host.appendChild(img);
    }
  }
  function blockUpdateHead(a) {
    var s = blockHeadState(a);
    if (!s) return;
    var icons = s.icons || [s.icon];
    a.headIcon.innerHTML = "";
    a.headIcon.classList.remove("favic");
    if (icons.length > 1) {
      a.headIcon.classList.add("iconstack");
      icons.forEach(function (ic) {
        var slot = document.createElement("span");
        slot.className = "ic";
        headIconInto(slot, ic);
        a.headIcon.appendChild(slot);
      });
    } else {
      a.headIcon.classList.remove("iconstack");
      headIconInto(a.headIcon, icons[0]);
    }
    a.headLabel.textContent = s.label;
    a.details.classList.toggle("working", s.working);
  }
  // A stepper row in block `a`. `expandable` rows are <details> (reasoning,
  // tools). Returns the row, its label span, and (if any) its body.
  function makeStepIn(a, cls, icon, expandable) {
    var row,
      label,
      body = null;
    // Each step lives in a positioned wrapper so a step can place non-toggle
    // controls (fetch_url's out-link) OUTSIDE its <summary> — a <summary> owns
    // Enter/Space, so an interactive element inside it isn't keyboard-reachable.
    var host = document.createElement("div");
    host.className = "steprow";
    if (expandable) {
      row = document.createElement("details");
      row.className = "step " + cls;
      var sum = document.createElement("summary");
      sum.innerHTML =
        '<span class="stepicon">' + icon + '</span><span class="steplabel"></span>' + CHEV;
      body = document.createElement("div");
      body.className = "stepbody";
      row.appendChild(sum);
      row.appendChild(body);
      label = sum.querySelector(".steplabel");
    } else {
      row = document.createElement("div");
      row.className = "step " + cls;
      row.innerHTML = '<span class="stepicon">' + icon + '</span><span class="steplabel"></span>';
      label = row.querySelector(".steplabel");
    }
    host.appendChild(row);
    a.stepper.appendChild(host);
    a.details.open = true; // working → reveal the steps
    // A block with one step needs no summarizing header (it would just duplicate
    // that step); the ".single" class hides the header so the lone step stands
    // alone. The header earns its place only once there are multiple steps.
    a.stepCount++;
    a.details.classList.toggle("single", a.stepCount === 1);
    return { row: row, label: label, body: body, host: host };
  }
  // The reasoning step currently streaming in the open block. Shimmers "Thinking"
  // while live, then settles to "Thought"; the turn's first reasoning gets the
  // server's authoritative duration at message-end.
  function openReasoning(rec) {
    var a = openActivity(rec);
    if (a.openReasoning) return a.openReasoning;
    var step = makeStepIn(a, "reasoning thinking", ICON_CLOCK, true);
    step.label.textContent = "Thinking";
    var np = newParser(step.body);
    var rr = {
      row: step.row,
      label: step.label,
      body: step.body,
      parser: np.parser,
      renderer: np.renderer,
      buf: "",
      ended: false,
    };
    if (!a.firstReasoning) a.firstReasoning = rr;
    if (!rec.firstReasoning) {
      rec.firstReasoning = rr;
      rec.firstReasoningBlock = a;
    }
    a.openReasoning = rr;
    rr.row.open = true; // stream the chain-of-thought open so it can be watched
    blockUpdateHead(a);
    autoScroll();
    return rr;
  }
  // Follow the reasoning stream to the bottom while its row is expanded.
  function updateReasoningPreview(rc) {
    if (rc.row.open) rc.body.scrollTop = rc.body.scrollHeight;
  }
  // Finish the block's streaming reasoning step: flush + enrich it, stop the
  // shimmer, settle the label.
  function blockEndReasoning(a) {
    var rr = a.openReasoning;
    if (!rr) return;
    a.openReasoning = null;
    if (!rr.ended) {
      if (rr.buf) {
        smdWrite(rr.parser, rr.buf);
        rr.buf = "";
      }
      smd.parser_end(rr.parser);
      rr.ended = true;
      queueEnrich(rr.body);
    }
    rr.row.classList.remove("thinking");
    rr.row.open = false; // thinking done → tuck the chain-of-thought away
    if (rr.label.textContent === "Thinking") rr.label.textContent = "Thought";
    if (!a.thoughtLabel) a.thoughtLabel = "Thought"; // upgraded to a duration at message-end
    blockUpdateHead(a);
  }
  function labelThought(rr, reasoningMs) {
    if (!rr) return;
    rr.row.classList.remove("thinking");
    rr.label.textContent =
      reasoningMs != null
        ? "Thought for " + Math.max(0, Math.round(reasoningMs / 1000)) + "s"
        : "Thought";
  }
  // An answer prose block. Creating it closes the current activity block
  // (collapsing it) — we've exited the work section into the answer.
  function openText(rec) {
    if (rec.textSink) return rec.textSink;
    closeActivity(rec);
    var el = proseBlock(rec.body);
    var np = newParser(el);
    var sink = { el: el, parser: np.parser, renderer: np.renderer, buf: "", full: "" };
    rec.proses.push(sink);
    rec.textSink = sink;
    autoScroll();
    return sink;
  }
  // Pretty value for a tool's args/result (JSON, or a string as-is).
  function toolValue(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch (_) {
      return String(v);
    }
  }
  // A tool call: a stepper row in the open block, iconed by kind (globe for
  // web_search, else a generic tool icon), labelled by the query (search) or the
  // tool name. Keyed by toolCallId so the result attaches. Shimmers while running.
  function toolStep(rec, data) {
    rec.toolSteps = rec.toolSteps || Object.create(null);
    if (rec.toolSteps[data.toolCallId]) return rec.toolSteps[data.toolCallId];
    var a = openActivity(rec);
    blockEndReasoning(a); // the thinking that led to this call is done
    var ui = toolUI(data.toolName);
    var step = makeStepIn(
      a,
      "tool thinking" + (ui.summaryDom ? " " + data.toolName : ""),
      ui.icon,
      true,
    );
    if (ui.summaryDom) {
      // The tool fully owns its summary (custom icon / label). `host` is the step
      // wrapper, where a right-side out-link goes so it stays out of the summary.
      step.label = ui.summaryDom(step.row.querySelector("summary"), data.input, step.host).label;
    } else {
      step.label.textContent = ui.row(data.input, data.toolName);
    }
    // Unknown tools show their raw args (a known tool conveys its input via the
    // row label + a custom result renderer, so args would be redundant there).
    if (ui === DEFAULT_TOOL) {
      var args = toolValue(data.input);
      if (args && args !== "{}") {
        var el = document.createElement("div");
        el.className = "targs";
        el.textContent = args;
        step.body.appendChild(el);
      }
    }
    var t = {
      row: step.row,
      label: step.label,
      body: step.body,
      toolName: data.toolName,
      input: data.input,
      block: a,
    };
    rec.toolSteps[data.toolCallId] = t;
    var entry = { name: data.toolName, input: data.input };
    // The block's collapsed header summarizes from these entries, so a tool whose
    // summary reports on its result (deep_research: pages read, seconds spent)
    // needs the result to land back on the entry — see toolResult.
    t.entry = entry;
    a.tools.push(entry);
    a.activeTool = entry;
    blockUpdateHead(a);
    autoScroll();
    return t;
  }
  // ---- live tool progress (deep_research) --------------------------------
  // A tool that runs for minutes reports as it goes (see ToolProgressData). The
  // panel is built once per tool call and mutated in place by each phase, so a
  // hundred progress events cost a hundred text assignments rather than a
  // hundred rebuilds. Phases the client doesn't know are ignored, which is what
  // lets the server add one without a client release.
  function researchPanel(t) {
    if (t.panel) return t.panel;
    var wrap = document.createElement("div");
    wrap.className = "rsrch";
    var p = {
      root: wrap,
      plan: rsrchStep(wrap, "Planning the research"),
      agents: document.createElement("div"),
      gather: rsrchStep(wrap, "Gathering sources"),
      tally: document.createElement("div"),
      write: rsrchStep(wrap, "Writing the report"),
      lanes: {},
      domains: {},
      order: [],
      read: 0,
    };
    p.agents.className = "rsrchagents";
    p.plan.appendChild(p.agents);
    p.tally.className = "rsrchtally";
    p.gather.appendChild(p.tally);
    t.body.appendChild(wrap);
    if (t.row.tagName === "DETAILS") t.row.open = true;
    t.panel = p;
    return p;
  }
  function rsrchStep(wrap, label) {
    var el = document.createElement("div");
    el.className = "rsrchstep";
    el.innerHTML = '<span class="rsrchdot"></span><span class="rsrchlabel"></span>';
    el.querySelector(".rsrchlabel").textContent = label;
    wrap.appendChild(el);
    return el;
  }
  // One lane per worker: its angle, and a live count of what it has read. The
  // run's shape is "four of these at once", so the panel shows four of them.
  function rsrchLane(p, agent, angle) {
    var lane = p.lanes[agent];
    if (lane) return lane;
    var el = document.createElement("div");
    el.className = "rsrchlane";
    var name = document.createElement("span");
    name.className = "rsrchangle";
    name.textContent = angle || "Angle " + (agent + 1);
    var count = document.createElement("span");
    count.className = "rsrchlanecount";
    el.appendChild(name);
    el.appendChild(count);
    p.agents.appendChild(el);
    lane = { el: el, count: count, read: 0, searches: 0 };
    p.lanes[agent] = lane;
    return lane;
  }
  function rsrchLaneCount(lane) {
    var bits = [];
    if (lane.searches) bits.push(lane.searches + (lane.searches === 1 ? " search" : " searches"));
    if (lane.read) bits.push(lane.read + (lane.read === 1 ? " page" : " pages"));
    lane.count.textContent = bits.join(" \u00b7 ");
  }
  // Mark a milestone: "active" is the one in flight, "done" is behind us.
  function rsrchState(el, state) {
    el.classList.remove("active", "done");
    if (state) el.classList.add(state);
  }
  function rsrchLabel(el, text) {
    el.querySelector(".rsrchlabel").textContent = text;
  }
  // Per-domain counts with a bar each, longest first — at a glance, where the
  // research actually went.
  function rsrchTally(p) {
    p.tally.innerHTML = "";
    var rows = p.order
      .map(function (d) {
        return { domain: d, n: p.domains[d] };
      })
      .sort(function (a, b) {
        return b.n - a.n;
      });
    var top = rows.slice(0, 6);
    var max = top.length ? top[0].n : 1;
    top.forEach(function (r) {
      var row = document.createElement("div");
      row.className = "rsrchsrc";
      var img = document.createElement("img");
      img.className = "favicon";
      img.alt = "";
      img.loading = "lazy";
      img.src = "https://icons.duckduckgo.com/ip3/" + r.domain + ".ico";
      img.onerror = function () {
        img.style.visibility = "hidden";
      };
      var name = document.createElement("span");
      name.className = "rsrchdomain";
      name.textContent = r.domain;
      var count = document.createElement("span");
      count.className = "rsrchcount";
      count.textContent = r.n + (r.n === 1 ? " source" : " sources");
      var track = document.createElement("span");
      track.className = "rsrchbar";
      var fill = document.createElement("span");
      fill.style.width = Math.round((r.n / max) * 100) + "%";
      track.appendChild(fill);
      row.appendChild(img);
      row.appendChild(name);
      row.appendChild(count);
      row.appendChild(track);
      p.tally.appendChild(row);
    });
    if (rows.length > top.length) {
      var more = document.createElement("div");
      more.className = "rsrchmore";
      var n = rows.length - top.length;
      more.textContent = "\u2026 " + n + (n === 1 ? " other domain" : " other domains");
      p.tally.appendChild(more);
    }
  }
  function toolProgress(rec, data) {
    // Progress can beat its own tool-call event to the client when the provider
    // streams the call and starts the tool in one tick, so the step is created
    // here if it doesn't exist yet — same lazy pattern as toolResult.
    var t =
      (rec.toolSteps && rec.toolSteps[data.toolCallId]) ||
      toolStep(rec, {
        toolCallId: data.toolCallId,
        toolName: data.toolName,
        input: (data.data && { question: data.data.question }) || {},
      });
    if (data.toolName !== "deep_research") return; // nothing else reports yet
    var p = researchPanel(t);
    var d = data.data || {};
    var lane = d.agent != null ? rsrchLane(p, d.agent, d.angle) : null;
    switch (data.phase) {
      case "planning":
        rsrchState(p.plan, "active");
        break;
      case "plan": {
        rsrchState(p.plan, "done");
        var n = d.angles ? d.angles.length : 1;
        rsrchLabel(p.plan, "Researching " + n + (n === 1 ? " angle" : " angles"));
        rsrchState(p.gather, "active");
        break;
      }
      case "agent":
        rsrchLane(p, d.agent, d.angle);
        break;
      case "search":
        if (lane) {
          lane.searches++;
          rsrchLaneCount(lane);
        }
        rsrchState(p.gather, "active");
        break;
      case "read": {
        p.read++;
        if (lane) {
          lane.read++;
          rsrchLaneCount(lane);
        }
        var host = domainOf(d.url) || "link";
        if (!p.domains[host]) {
          p.domains[host] = 0;
          p.order.push(host);
        }
        p.domains[host]++;
        rsrchLabel(p.gather, "Gathering " + p.read + (p.read === 1 ? " source" : " sources"));
        rsrchTally(p);
        break;
      }
      case "synthesis":
        rsrchState(p.gather, "done");
        rsrchLabel(p.gather, "Gathered " + p.read + (p.read === 1 ? " source" : " sources"));
        rsrchState(p.write, "active");
        rsrchLabel(p.write, "Writing the report");
        break;
      case "report":
        rsrchState(p.write, "active");
        rsrchLabel(p.write, d.title ? "Created \u201c" + d.title + "\u201d" : "Writing the report");
        break;
      case "done":
        rsrchState(p.write, "done");
        rsrchLabel(p.write, d.title ? "Created \u201c" + d.title + "\u201d" : "Report written");
        // The card comes from the tool-result's artifacts[]; this copy of the
        // text is kept only so its preview can render without waiting on a fetch
        // during the run that produced it.
        if (d.report) t.liveReport = d.report;
        break;
    }
    autoScroll();
  }
  function toolResult(rec, data) {
    var t = (rec.toolSteps && rec.toolSteps[data.toolCallId]) || toolStep(rec, data);
    t.row.classList.remove("thinking");
    if (data.isError) {
      console.error("[kloe tool error]", data.toolName, data.output);
      t.row.classList.add("errored");
      errorResult(t, data.output); // errors render uniformly for every tool
    } else {
      if (t.entry) t.entry.output = data.output;
      toolUI(t.toolName).result(t, data.output); // success rendering is per-tool
      renderArtifacts(rec, t, data); // documents, whichever tool made them
    }
    t.block.activeTool = null; // this tool finished
    blockUpdateHead(t.block);
    autoScroll();
  }
  function domainOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (_) {
      return "";
    }
  }
  // Search results as a card: each row a favicon + title + domain, linking out.
  // Puts the result count in the step summary. Favicons load from a public
  // service and hide themselves on error, so a missing icon leaves the row clean.
  function renderSearchResults(t, results) {
    var sum = t.row.querySelector("summary");
    if (sum && !sum.querySelector(".count")) {
      var c = document.createElement("span");
      c.className = "count";
      c.textContent = results.length + (results.length === 1 ? " result" : " results");
      sum.insertBefore(c, sum.querySelector(".chev"));
    }
    t.body.appendChild(resultsCard(results));
  }
  // The linked-favicon list, shared by search hits and research sources — each is
  // a title, a domain and a URL, and they should look the same because they are
  // the same thing at different stages.
  function resultsCard(results) {
    var card = document.createElement("div");
    card.className = "results";
    results.forEach(function (r) {
      var a = document.createElement("a");
      a.className = "result";
      a.href = r.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer nofollow";
      var domain = domainOf(r.url);
      var img = document.createElement("img");
      img.className = "favicon";
      img.alt = "";
      img.loading = "lazy";
      img.src = "https://icons.duckduckgo.com/ip3/" + domain + ".ico";
      img.onerror = function () {
        img.style.visibility = "hidden";
      };
      var title = document.createElement("span");
      title.className = "rtitle";
      title.textContent = r.title || domain || r.url;
      var dom = document.createElement("span");
      dom.className = "rdomain";
      dom.textContent = domain;
      a.appendChild(img);
      a.appendChild(title);
      a.appendChild(dom);
      card.appendChild(a);
    });
    return card;
  }
  // A research run: the findings as prose, then the sources it cites as a linked
  // card (the same one web_search results use — a citation IS a search result the
  // subagent thought was worth reading). `[n]` in the prose lines up with the nth
  // row, because the server renumbered them to agree before sending.
  // ---- the artifact pane -------------------------------------------------
  // A document opened out of the thread: the markdown rendered properly (same
  // renderer the conversation uses, so code and math get the same treatment),
  // with copy and download. One pane, reused — opening a second artifact
  // replaces the first rather than stacking.
  var paneDoc = null;
  // HTML documents show their rendered self by default and their source on
  // request. Per-open rather than sticky: the point of the pane is the document.
  var paneSource = false;
  // Every stored revision of the open document, newest first. Empty until the
  // history comes back, and for a one-version document it stays that way.
  var paneVersions = [];
  // The pane has two modes and one frame: the conversation's documents, and one
  // of them open. Same panel either way — a list that behaved like a dropdown
  // while the document behaved like a panel would be two idioms for one thing.
  var paneMode = "doc";
  function showPane() {
    $("pane").hidden = false;
    $("app").classList.add("pane-open");
    $("docsBtn").hidden = true;
  }
  function paneChrome(mode) {
    paneMode = mode;
    // Expanding a list of documents means nothing; the control belongs to the
    // document itself, alongside copy and download.
    $("paneFull").hidden = mode !== "doc";
    $("paneDocActions").hidden = mode !== "doc";
    // Only a document with a rendering distinct from its source has a source to
    // switch to; markdown in the pane already IS the rendering.
    $("paneSourceBtn").hidden = mode !== "doc" || !isHtmlDoc(paneDoc);
    $("paneVersions").hidden = mode !== "doc" || paneVersions.length < 2;
    paintPublicChip();
    $("paneSourceBtn").textContent = paneSource ? "Preview" : "Source";
    // The header button and an open pane say the same thing, so only one of them
    // says it. Closing the pane brings the button back.
    $("docsBtn").hidden = !artifactList.length;
  }
  /** The conversation's documents, newest first. */
  function openPaneList() {
    paneDoc = null;
    paneChrome("list");
    $("paneTitle").textContent =
      artifactList.length + (artifactList.length === 1 ? " document" : " documents");
    var body = $("paneBody");
    body.innerHTML = "";
    var list = document.createElement("div");
    list.className = "doclist";
    artifactList.forEach(function (a) {
      var row = document.createElement("button");
      row.type = "button";
      row.className = "docrow";
      var name = document.createElement("span");
      name.className = "docname";
      name.textContent = a.title || a.name;
      var meta = document.createElement("span");
      meta.className = "docmeta";
      meta.textContent =
        a.name + (a.versions > 1 ? " · v" + a.version : "") + " · " + fmtBytes(a.size);
      row.appendChild(name);
      row.appendChild(meta);
      row.addEventListener("click", function () {
        openPane(a);
      });
      list.appendChild(row);
    });
    body.appendChild(list);
    body.scrollTop = 0;
    showPane();
  }
  /**
   * Citation markers, upgraded to source pills.
   *
   * The markdown keeps plain `[1]` links and a numbered Sources list, because a
   * downloaded file has to read correctly on its own. The pill is the renderer's
   * job: a bare number tells you nothing about whether to believe the sentence
   * you just read, and "propublica.org" tells you a great deal. Titles come from
   * the document's own bibliography, so this needs nothing the file doesn't have.
   */
  /**
   * The bibliography is for the file, not the screen.
   *
   * A downloaded document needs its sources listed — that's why the generator
   * appends them. On screen the pills already carry the source of every claim,
   * so the block at the bottom is a second copy of what you just read past.
   * Stripped for rendering only: copy and download still get the whole file.
   */
  function stripSources(md) {
    return md.replace(/\n#{1,3}\s+Sources\s*\n[\s\S]*$/, "\n");
  }
  function parseSources(md) {
    var out = {};
    var re = /^(\d+)\.\s+\[([^\]]*)\]\(([^)\s]+)\)/gm;
    var m = re.exec(md);
    while (m) {
      out[Number(m[1])] = { title: m[2], url: m[3] };
      m = re.exec(md);
    }
    return out;
  }
  function enhanceCitations(root, sources) {
    root.querySelectorAll("a").forEach(function (a) {
      // A citation is a link whose whole text is a number that the document's
      // own bibliography knows. Requiring the number to resolve is what keeps an
      // ordinary link that happens to read "2024" from becoming a pill.
      var text = (a.textContent || "").trim();
      if (!/^\d+$/.test(text)) return;
      var src = sources[Number(text)];
      if (!src) return;
      var host = domainOf(a.href) || "source";
      a.className = "cite";
      a.target = "_blank";
      a.rel = "noopener noreferrer nofollow";
      // Native tooltip: the page title and its URL, which is what you want to
      // know before deciding whether to follow it.
      a.title = (src && src.title ? src.title + "\n" : "") + a.href;
      a.textContent = "";
      var img = document.createElement("img");
      img.className = "citefav";
      img.alt = "";
      img.loading = "lazy";
      img.src = "https://icons.duckduckgo.com/ip3/" + host + ".ico";
      img.onerror = function () {
        img.remove();
      };
      var label = document.createElement("span");
      label.textContent = host;
      a.appendChild(img);
      a.appendChild(label);
    });
  }
  function fmtBytes(n) {
    if (!n) return "0 B";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }
  // Artifacts are blob references, so the pane fetches the bytes rather than the
  // event carrying them: content-addressed and immutable, which is exactly the
  // cache the browser is good at (one GET per sha, then never again).
  function isHtmlDoc(doc) {
    return !!doc && /^text\/html\b/.test(doc.mime || "");
  }
  /**
   * A page, rendered as a page — inside a frame that cannot reach the app.
   *
   * `sandbox="allow-scripts"` WITHOUT `allow-same-origin` is the whole security
   * argument: the two together would hand the document our origin back and undo
   * the sandbox entirely, so they must never both appear. Scripts alone run in
   * an opaque origin, which is what makes a chart or a little interactive demo
   * work while leaving it unable to read the conversation or call the API.
   *
   * `srcdoc` rather than pointing the frame at /api/blobs: the served response
   * carries a `sandbox` CSP that kills scripting outright, which is right for a
   * stray visit and wrong for the one place we mean to render.
   */
  function renderHtmlDoc(body, text) {
    var frame = document.createElement("iframe");
    frame.className = "htmlframe";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.srcdoc = text;
    body.appendChild(frame);
  }
  /** The source behind a rendered page, highlighted by the usual markdown path. */
  function renderHtmlSource(body, text) {
    renderStaticMd(body, "```html\n" + text + "\n```");
  }
  function paintPaneDoc() {
    var body = $("paneBody");
    body.innerHTML = "";
    var text = paneDoc.content;
    if (isHtmlDoc(paneDoc)) {
      if (paneSource) renderHtmlSource(body, text);
      else renderHtmlDoc(body, text);
    } else {
      renderStaticMd(body, stripSources(text));
      enhanceCitations(body, parseSources(text));
    }
    body.scrollTop = 0;
  }
  // ---- document history ----------------------------------------------------
  // Writing a file twice makes a version, not a new document, so a document in
  // the pane is one of several revisions and the header says which. Fetched on
  // open rather than carried on the card: a card records the bytes it produced
  // and knows nothing about the rewrites that came after it.
  /**
   * The revision on screen, matched by sha256 rather than version number —
   * that's the only thing a thread card and a history row are guaranteed to
   * agree on.
   */
  function currentVersion() {
    if (!paneDoc) return null;
    for (var i = 0; i < paneVersions.length; i++)
      if (paneVersions[i].sha256 === paneDoc.sha256) return paneVersions[i];
    return null;
  }
  function fmtVersionTime(ms) {
    return (
      fmtConvDate(ms) +
      " " +
      new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    );
  }
  function paintPaneVersions(versions) {
    paneVersions = versions || [];
    var btn = $("paneVersions");
    // One revision is not a history, and the control for choosing among one
    // thing is no control at all.
    paintPublicChip(); // the token rides the version rows, so it lands with them
    if (paneMode !== "doc" || paneVersions.length < 2) {
      btn.hidden = true;
      return;
    }
    var cur = currentVersion();
    btn.hidden = false;
    btn.textContent = "";
    var label = document.createElement("span");
    label.textContent = cur ? "v" + cur.version : paneVersions.length + " versions";
    btn.appendChild(label);
    btn.insertAdjacentHTML("beforeend", CHEV);
    btn.title = paneVersions.length + " versions";
  }
  // ---- publishing ----------------------------------------------------------
  // A document has at most ONE public link, and that link is either pinned to a
  // version or following the newest. Private, frozen, live: three states, so
  // the chip can say which one you are looking at instead of merely that a link
  // exists somewhere.
  var panePublication = null; // { token, mode, version } for the open document
  function publicLink(token) {
    return location.origin + "/s/" + token;
  }
  /** Whether the link, as configured, serves the revision currently on screen. */
  function showingPublished() {
    var cur = currentVersion();
    if (!panePublication || !cur) return false;
    if (panePublication.mode === "latest") return cur.version === newestVersion();
    return cur.version === panePublication.version;
  }
  function newestVersion() {
    return paneVersions.length ? paneVersions[0].version : (paneDoc && paneDoc.version) || 0;
  }
  function paintPublicChip() {
    var chip = $("panePublic");
    chip.hidden = paneMode !== "doc" || !showingPublished();
    chip.textContent = "Public";
    chip.title =
      panePublication && panePublication.mode === "latest"
        ? "Public link — follows the newest version. Click to copy."
        : "Public link — pinned to this version. Click to copy.";
  }
  function copyPublicLink() {
    if (!panePublication) return;
    var chip = $("panePublic");
    navigator.clipboard.writeText(publicLink(panePublication.token)).then(function () {
      if (chip.hidden) return; // copied from the menu while viewing another revision
      chip.textContent = "Link copied";
      setTimeout(paintPublicChip, 1400);
    });
  }
  /** The version the pane is acting on: the history knows best, the card will do. */
  function actingVersion() {
    return currentVersion() || (paneDoc && paneDoc.version ? paneDoc : null);
  }
  function postPublication(version, mode) {
    return fetch("/api/conversations/" + encodeURIComponent(convId) + "/publications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: paneDoc.name, version: version, mode: mode }),
    })
      .then(function (r) {
        return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status));
      })
      .then(function (d) {
        panePublication = { token: d.token, mode: d.mode, version: d.version };
        paintPublicChip();
        return d;
      })
      .catch(function () {
        dialogs.confirm({
          title: "Could not publish",
          body: "Nothing was changed. Try again in a moment.",
          ok: "OK",
        });
      });
  }
  /**
   * Publish the document, frozen at the revision on screen.
   *
   * Confirmed first, and worded plainly: this is the one action in the pane
   * that hands a document to people who were never in the conversation, and it
   * cannot be undone for anyone who already has the link. Pinned is the default
   * because a link that quietly starts serving something else is the surprise
   * worth not defaulting to; following is one menu item away.
   */
  function publishCurrent() {
    var cur = actingVersion();
    if (!cur || !convId) return;
    dialogs
      .confirm({
        title: "Publish this document?",
        body:
          "Anyone with the link will be able to read " +
          (paneDoc.title || paneDoc.name) +
          " without signing in. The link stays on this version until you change it, and you can " +
          "unpublish at any time — though not un-share a link someone already has.",
        ok: "Publish",
      })
      .then(function (ok) {
        if (!ok) return;
        return postPublication(cur.version, "pinned").then(function (d) {
          if (d) copyPublicLink(); // published and on the clipboard, in one press
        });
      });
  }
  /**
   * Switch what the existing link serves, keeping the link itself.
   *
   * The token survives a mode change, which is the point: "actually, let it
   * follow along" should not mean re-sending a URL to everyone you gave it to.
   */
  function setPublishMode(mode) {
    var cur = actingVersion();
    if (!panePublication || !cur || !convId) return;
    if (mode === "pinned") return void postPublication(cur.version, "pinned");
    dialogs
      .confirm({
        title: "Let the link follow the newest version?",
        body:
          "Anyone holding the link will see whatever this document becomes, including revisions " +
          "you have not written yet. The link itself does not change.",
        ok: "Follow the newest",
      })
      .then(function (ok) {
        if (ok) postPublication(cur.version, "latest");
      });
  }
  function unpublishCurrent() {
    if (!panePublication || !convId) return;
    var token = panePublication.token;
    dialogs
      .confirm({
        title: "Unpublish this document?",
        body: "The link stops working for everyone who has it.",
        ok: "Unpublish",
        danger: true,
      })
      .then(function (ok) {
        if (!ok) return;
        return fetch(
          "/api/conversations/" +
            encodeURIComponent(convId) +
            "/publications/" +
            encodeURIComponent(token),
          { method: "DELETE" },
        ).then(function () {
          panePublication = null;
          paintPublicChip();
        });
      });
  }
  /** The pane's overflow menu, which depends on whether the document is shared. */
  function paneMenuItems() {
    var items = [];
    if (!panePublication) items.push({ label: "Publish\u2026", onClick: publishCurrent });
    else {
      items.push({ label: "Copy public link", onClick: copyPublicLink });
      items.push(
        panePublication.mode === "latest"
          ? {
              label: "Pin the link to this version",
              onClick: function () {
                setPublishMode("pinned");
              },
            }
          : {
              label: "Let the link follow the newest",
              onClick: function () {
                setPublishMode("latest");
              },
            },
      );
      items.push({ label: "Unpublish", danger: true, onClick: unpublishCurrent });
    }
    items.push({ label: "Download as Markdown", onClick: downloadMd });
    items.push({ label: "Print / Save as PDF", onClick: printPane });
    return items;
  }
  function loadPaneVersions(doc) {
    panePublication = null;
    paintPaneVersions([]);
    if (!doc || !convId) return;
    var want = doc.sha256;
    fetch(
      "/api/conversations/" +
        encodeURIComponent(convId) +
        "/artifacts?name=" +
        encodeURIComponent(doc.name),
    )
      .then(function (r) {
        return r.ok ? r.json() : { versions: [] };
      })
      .then(function (d) {
        if (!paneDoc || paneDoc.sha256 !== want) return; // opened something else meanwhile
        panePublication = d.publication || null;
        paintPaneVersions(d.versions || []);
      })
      .catch(function () {});
  }
  function openPane(doc, versions) {
    paneDoc = doc;
    paneSource = false; // a page opens rendered; the source is the deliberate click
    paneVersions = versions || [];
    paneChrome("doc");
    $("paneTitle").textContent = doc.title || doc.name;
    var body = $("paneBody");
    body.innerHTML = "";
    showPane();
    // Switching revisions already has the history in hand; opening fresh doesn't.
    if (versions) paintPaneVersions(versions);
    else loadPaneVersions(doc);
    var want = doc.sha256;
    fetch("/api/blobs/" + encodeURIComponent(doc.sha256))
      .then(function (r) {
        return r.ok ? r.text() : Promise.reject(new Error("HTTP " + r.status));
      })
      .then(function (text) {
        if (!paneDoc || paneDoc.sha256 !== want) return; // opened something else meanwhile
        paneDoc.content = text;
        paintPaneDoc();
      })
      .catch(function () {
        if (!paneDoc || paneDoc.sha256 !== want) return;
        body.textContent = "This document could not be loaded.";
      });
  }
  function closePane() {
    paneDoc = null;
    paneVersions = [];
    panePublication = null;
    $("pane").hidden = true;
    $("paneBody").innerHTML = "";
    $("app").classList.remove("pane-open", "pane-full");
    $("docsBtn").hidden = !artifactList.length;
  }
  // The blob endpoint sets Content-Disposition from `?name`, so the browser
  // saves it under its real filename without the app re-encoding the bytes.
  function downloadMd() {
    if (!paneDoc) return;
    var a = document.createElement("a");
    a.href =
      "/api/blobs/" +
      encodeURIComponent(paneDoc.sha256) +
      "?name=" +
      encodeURIComponent(paneDoc.name);
    a.download = paneDoc.name;
    a.click();
  }
  // PDF via the browser's own print pipeline rather than a bundled generator:
  // the pane is already the rendered document, so print CSS hides everything
  // else and what you'd export is exactly what you're looking at.
  function printPane() {
    if (!paneDoc) return;
    // The document title is the print dialog's default filename, so it's borrowed
    // for the duration and handed back afterwards.
    var prev = document.title;
    document.title = paneDoc.title;
    var restore = function () {
      document.title = prev;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  }
  // ---- the documents button ----------------------------------------------
  // What this chat has produced, listed from the artifacts projection rather
  // than by walking the thread. It appears only once there IS a document, so a
  // chat that never made one carries no chrome for it.
  var artifactList = [];
  function refreshArtifacts(id) {
    var btn = $("docsBtn");
    if (!id) {
      artifactList = [];
      btn.hidden = true;
      return;
    }
    fetch("/api/conversations/" + encodeURIComponent(id) + "/artifacts")
      .then(function (r) {
        return r.ok ? r.json() : { artifacts: [] };
      })
      .then(function (d) {
        if (convId !== id) return; // switched chats while it was in flight
        artifactList = d.artifacts || [];
        btn.hidden = artifactList.length === 0 || !$("pane").hidden;
        $("docsCount").textContent = artifactList.length || "";
      })
      .catch(function () {});
  }
  function mountDocsButton() {
    // Toggling: a second press on an open list closes it, the way a panel
    // toggle should behave.
    $("docsBtn").addEventListener("click", function () {
      if (!artifactList.length) return;
      if (paneMode === "list" && !$("pane").hidden) closePane();
      else openPaneList();
    });
  }
  // How wide the document sits, remembered across sessions. A reader who widens
  // it for one long report means it for the next one too.
  var PANE_W_KEY = "kloe:panew";
  var PANE_MIN = 320;
  function setPaneWidth(px) {
    var max = Math.max(PANE_MIN, window.innerWidth - 420); // never crowd the thread out
    var w = Math.round(Math.min(max, Math.max(PANE_MIN, px)));
    document.documentElement.style.setProperty("--pane-w", w + "px");
    try {
      localStorage.setItem(PANE_W_KEY, String(w));
    } catch (_) {}
  }
  function mountPaneResize() {
    var saved = Number(localStorage.getItem(PANE_W_KEY) || 0);
    if (saved) setPaneWidth(saved);
    var handle = $("paneResize");
    handle.addEventListener("pointerdown", function (e) {
      // Capture on the handle so the drag survives the pointer outrunning it,
      // and suppress selection while the seam moves.
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add("resizing");
      var move = function (ev) {
        setPaneWidth(window.innerWidth - ev.clientX);
      };
      var up = function () {
        handle.releasePointerCapture(e.pointerId);
        document.body.classList.remove("resizing");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
    // Keyboard: a separator should be movable without a pointer.
    handle.addEventListener("keydown", function (e) {
      var cur = $("pane").getBoundingClientRect().width;
      if (e.key === "ArrowLeft") setPaneWidth(cur + 40);
      else if (e.key === "ArrowRight") setPaneWidth(cur - 40);
      else return;
      e.preventDefault();
    });
  }
  function togglePaneFull() {
    var full = $("app").classList.toggle("pane-full");
    var btn = $("paneFull");
    btn.setAttribute("aria-label", full ? "Restore document" : "Expand document");
    btn.title = full ? "Restore document" : "Expand document";
  }
  function mountPane() {
    mountDocsButton();
    mountPaneResize();
    $("paneFull").addEventListener("click", togglePaneFull);
    $("paneClose").addEventListener("click", closePane);
    $("paneSourceBtn").addEventListener("click", function () {
      if (!paneDoc || !paneDoc.content) return;
      paneSource = !paneSource;
      $("paneSourceBtn").textContent = paneSource ? "Preview" : "Source";
      paintPaneDoc();
    });
    // The history, newest first. Picking one re-opens the pane on those bytes;
    // the list is already loaded, so it goes along rather than being refetched.
    $("paneVersions").addEventListener("click", function (e) {
      if (paneVersions.length < 2) return;
      e.stopPropagation(); // the menu's own outside-click handler closes it
      var btn = $("paneVersions");
      var r = btn.getBoundingClientRect();
      var cur = currentVersion();
      var versions = paneVersions;
      showContextMenu(
        r.right,
        r.bottom + 6,
        versions.map(function (v) {
          return {
            // Every row reserves the tick's width, so the labels line up whether
            // or not the row is the one you're looking at.
            icon: cur && cur.version === v.version ? CHECK : ICON_BLANK,
            label: "v" + v.version + " · " + fmtVersionTime(v.createdAt),
            onClick: function () {
              openPane(v, versions);
            },
          };
        }),
        { align: "right", trigger: btn },
      );
    });
    $("panePublic").addEventListener("click", copyPublicLink);
    $("paneCopy").addEventListener("click", function () {
      if (!paneDoc) return;
      var btn = $("paneCopy");
      navigator.clipboard.writeText(paneDoc.content).then(function () {
        btn.textContent = "Copied";
        setTimeout(function () {
          btn.textContent = "Copy";
        }, 1400);
      });
    });
    // Everything that isn't the common case lives behind the chevron.
    var more = $("paneMore");
    more.addEventListener("click", function (e) {
      if (!paneDoc) return;
      e.stopPropagation(); // the menu's own outside-click handler closes it
      var r = more.getBoundingClientRect();
      showContextMenu(r.right, r.bottom + 6, paneMenuItems(), { align: "right", trigger: more });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || $("pane").hidden) return;
      closePane();
    });
  }
  // A document, as a card: it names the thing, shows a scrap of it, and opens it
  // in the pane. Built from a blob reference, so this is not research-specific —
  // any tool's promoted file renders the same way.
  function artifactCard(ref, peekText) {
    var title = ref.title || ref.name;
    var wrap = document.createElement("button");
    wrap.type = "button";
    wrap.className = "artifact";
    wrap.addEventListener("click", function () {
      openPane(ref);
    });

    var text = document.createElement("span");
    text.className = "artifacttext";
    var h = document.createElement("span");
    h.className = "artifacttitle";
    h.textContent = title;
    var kind = document.createElement("span");
    kind.className = "artifactkind";
    // Version only once there IS history — "v1" on a document written once is
    // noise about a thing that hasn't happened.
    kind.textContent =
      (isHtmlDoc(ref) ? "Page" : "Document") + (ref.version > 1 ? " \u00b7 v" + ref.version : "");
    text.appendChild(h);
    text.appendChild(kind);

    // A tilted scrap of the real text — enough to recognize the document by, not
    // enough to read. Deliberately not an icon: the preview IS the content.
    var peek = document.createElement("span");
    peek.className = "artifactpeek";
    var paper = document.createElement("span");
    paper.className = "artifactpaper";
    peek.appendChild(paper);
    // The peek is meant to be recognizable prose, and a page's opening bytes are
    // `<!doctype html><head><style>…` — its markup tells you nothing about it,
    // so preview what the page would SAY rather than how it is built.
    var forPeek = function (s) {
      return isHtmlDoc(ref) ? htmlToText(s) : s;
    };
    if (peekText) paper.textContent = peekPreview(forPeek(peekText));
    // No live copy (a replayed log): pull just enough of the blob to preview.
    else
      fetch("/api/blobs/" + encodeURIComponent(ref.sha256))
        .then(function (r) {
          return r.ok ? r.text() : "";
        })
        .then(function (body) {
          paper.textContent = peekPreview(forPeek(body));
        })
        .catch(function () {});

    wrap.appendChild(text);
    wrap.appendChild(peek);
    return wrap;
  }
  /**
   * The words out of a page, for previewing.
   *
   * Done with string work rather than by parsing into a detached DOM on purpose:
   * assigning untrusted markup to innerHTML runs no <script>, but it happily
   * fetches an <img src=x onerror=…>, and this text arrives from a model. Regex
   * is the blunter tool and the safe one — it never builds a live node.
   */
  function htmlToText(s) {
    return String(s || "")
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/&(nbsp|amp|lt|gt|quot|#39);/gi, function (_, e) {
        return { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[e.toLowerCase()];
      })
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n\s*/g, "\n")
      .trim();
  }
  function peekPreview(body) {
    return String(body || "")
      .split("\n")
      .filter(function (l) {
        return l.trim();
      })
      .slice(0, 14)
      .join("\n");
  }
  // Any tool's documents, off the event itself. `artifacts[]` is on tool-result
  // for every tool (see spec, "Artifacts — the promotion path"), so this is not a
  // research feature — a sandbox step that promotes an output file renders the
  // same card by the same path.
  // Artifacts belong to the message, not to the step that happened to make them:
  // a document produced halfway through a turn shouldn't be buried in a tool
  // gutter above three more paragraphs of reply.
  //
  // They hang off the TURN, after `.body`, rather than inside it. Inside, the
  // best we could do is move the container to the end each time one lands — and
  // the reply is still streaming, so the next prose block appends after it and
  // the document ends up in the middle again. Outside the body it has nothing to
  // race: `.body` is the turn's last child, so anything after it is last, always.
  function addArtifact(rec, el) {
    if (!rec.artifacts) {
      rec.artifacts = document.createElement("div");
      rec.artifacts.className = "artifacts";
      rec.turn.appendChild(rec.artifacts);
    }
    rec.artifacts.appendChild(el);
  }
  function renderArtifacts(rec, t, data) {
    if (!Array.isArray(data.artifacts) || !data.artifacts.length) return;
    if (t.artifacted) return;
    t.artifacted = true;
    for (const ref of data.artifacts) {
      addArtifact(rec, artifactCard(ref, t.liveReport));
    }
    refreshArtifacts(convId); // the header list just gained one
  }
  // Upgrade a fetched page's favicon from the default service .ico using what the
  // page actually declares (fetch.ts pageFavicons): prefer its own SVG favicon
  // (adaptive SVGs self-fix dark mode via the media query inside them, rendered
  // through <img>), and when a dark variant is known, add a <picture> source so a
  // dark theme shows a legible mark natively. Each candidate is preloaded first,
  // so a 404 or bad guess keeps the reliable default instead of a broken image.
  function preloadImg(url, ok) {
    var i = new Image();
    i.onload = ok;
    i.src = url;
  }
  function upgradeFavicon(t, output) {
    var img = t.row.querySelector("img.favicon");
    if (!img || img.tagName !== "IMG") return; // onerror already swapped to ICON_PAGE
    if (output.faviconSvg)
      preloadImg(output.faviconSvg, function () {
        img.src = output.faviconSvg;
      });
    if (output.faviconDark)
      preloadImg(output.faviconDark, function () {
        if (!img.parentNode || img.parentNode.tagName === "PICTURE") return;
        var pic = document.createElement("picture");
        var src = document.createElement("source");
        src.media = "(prefers-color-scheme: dark)";
        src.srcset = output.faviconDark;
        img.parentNode.insertBefore(pic, img);
        pic.appendChild(src);
        pic.appendChild(img);
      });
  }
  // A fetched page: the summary row's label becomes the page title (the hostname
  // link is already in the summary), and the body holds the content.
  function renderFetchResult(t, output) {
    if (output.title && t.label) t.label.textContent = output.title;
    upgradeFavicon(t, output);
    // Stash the collected favicons under the REQUEST's domain (not output.url,
    // which may be the rewritten raw host) so the collapsed header can reuse them.
    var favDom = domainOf((t.input && t.input.url) || output.url || "");
    if (favDom && (output.faviconSvg || output.faviconDark))
      siteFavicons[favDom] = { svg: output.faviconSvg, dark: output.faviconDark };
    if (output.content) {
      // Only markdown gets prose-rendered; raw text/JSON/XML stays verbatim in a
      // preformatted block, so non-HTML content doesn't get mangled by the parser.
      if (output.format === "text") {
        var pre = document.createElement("div");
        pre.className = "tout";
        pre.textContent = output.content;
        t.body.appendChild(pre);
      } else {
        renderStaticMd(t.body, output.content);
      }
    }
    if (output.truncated) {
      var n = document.createElement("div");
      n.className = "tnote";
      n.textContent = "(truncated)";
      t.body.appendChild(n);
    }
  }
  // Generic result body: the value as text/JSON. `errorResult` is the same, in red.
  function defaultResult(t, output) {
    var out = document.createElement("div");
    out.className = "tout";
    out.textContent = toolValue(output);
    t.body.appendChild(out);
  }
  // A shell run as a terminal card: the command on a `$` prompt line, its output
  // below. The result string is already `exit code:…\n\nstdout:…` — shown verbatim.
  function firstLine(s) {
    s = String(s || "");
    var i = s.indexOf("\n");
    return i < 0 ? s : s.slice(0, i) + " …";
  }
  function renderShellResult(t, output) {
    // A command that promoted files returns { output, artifacts } instead of the
    // bare transcript; the documents render from the event, so only the text
    // belongs in the terminal card.
    if (output && typeof output === "object" && typeof output.output === "string")
      output = output.output;
    var term = document.createElement("div");
    term.className = "term";
    if (t.input && t.input.command) {
      var cmd = document.createElement("div");
      cmd.className = "termcmd";
      cmd.textContent = t.input.command;
      term.appendChild(cmd);
    }
    var out = document.createElement("div");
    out.className = "termout";
    out.textContent = toolValue(output);
    term.appendChild(out);
    t.body.appendChild(term);
  }
  function errorResult(t, output) {
    var out = document.createElement("div");
    out.className = "tout err";
    out.textContent = toolValue(output);
    t.body.appendChild(out);
  }
  // ---- per-tool UI registry ----------------------------------------------
  // How each tool renders: its icon, the step-row label (from the call input),
  // the collapsed-header summary (given this tool's steps in the block + whether
  // it's live), and the success result body. Unknown tools fall back to
  // DEFAULT_TOOL — so a new tool renders sensibly with zero UI code, and gets a
  // nicer treatment by adding one entry here.
  function lastInput(steps) {
    return steps.length ? steps[steps.length - 1].input || {} : {};
  }
  function lastOutput(steps) {
    return steps.length ? steps[steps.length - 1].output : null;
  }
  var TOOL_UI = {
    web_search: {
      icon: ICON_GLOBE,
      row: function (input) {
        return (input && input.query) || "web_search";
      },
      summary: function (steps, active) {
        var verb = active ? "Searching the web" : "Searched the web";
        if (steps.length > 1) return verb + " · " + steps.length + " searches";
        var q = lastInput(steps).query;
        return q ? verb + " for " + q : verb;
      },
      result: function (t, output) {
        if (output && Array.isArray(output.results)) renderSearchResults(t, output.results);
        else defaultResult(t, output);
      },
    },
    fetch_url: {
      icon: ICON_PAGE,
      // Full custom summary: favicon + the page title (filled in on result), with
      // the hostname as a clickable out-link on the right. No chevron — click the
      // row to expand. Returns the label element so the result can set the title.
      summaryDom: function (sum, input, host) {
        var url = (input && input.url) || "";
        var hostName = domainOf(url) || "link";
        sum.innerHTML = "";
        var icon = document.createElement("span");
        icon.className = "stepicon";
        var img = document.createElement("img");
        img.className = "favicon";
        img.alt = "";
        img.loading = "lazy";
        img.src = "https://icons.duckduckgo.com/ip3/" + hostName + ".ico";
        img.onerror = function () {
          icon.innerHTML = ICON_PAGE;
        }; // no favicon → page icon
        icon.appendChild(img);
        var label = document.createElement("span");
        label.className = "steplabel";
        label.textContent = hostName;
        var link = document.createElement("a");
        link.className = "stephost";
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer nofollow";
        var hspan = document.createElement("span");
        hspan.textContent = hostName;
        link.appendChild(hspan);
        link.insertAdjacentHTML("beforeend", ICON_EXT);
        sum.appendChild(icon);
        sum.appendChild(label);
        // The out-link lives on the wrapper (a sibling of the <summary>), not
        // inside it — keyboard-reachable, and positioned over the row's right.
        (host || sum).appendChild(link);
        return { label: label };
      },
      summary: function (steps, active) {
        var verb = active ? "Reading" : "Read";
        if (steps.length > 1) return verb + " " + steps.length + " pages";
        return verb + " " + (domainOf(lastInput(steps).url) || "a page");
      },
      result: function (t, output) {
        if (output && output.content != null) renderFetchResult(t, output);
        else defaultResult(t, output);
      },
    },
    deep_research: {
      icon: ICON_RESEARCH,
      row: function (input) {
        return (input && input.question) || "deep_research";
      },
      summary: function (steps, active) {
        if (active) return "Researching";
        // Once it lands, say what it cost: the shape of the work is the honest
        // summary of a step that took minutes.
        var out = lastOutput(steps);
        var s = out && out.stats;
        if (!s) return "Researched";
        var read = s.read + (s.read === 1 ? " page" : " pages");
        return "Researched · " + read + " in " + Math.round(s.ms / 1000) + "s";
      },
      // The document renders from the event's artifacts[] like any other tool's
      // output files, so there's nothing left to draw here — just fold the panel
      // away. It opened itself to show the work; the work is over, and the step
      // summary ("Researched · 35 pages in 214s") says what happened.
      result: function (t) {
        if (t.row.tagName === "DETAILS") t.row.open = false;
      },
    },
    get_attachment: {
      icon: FILE_SVG,
      row: function (input) {
        return (input && input.name) || "get_attachment";
      },
      summary: function (steps, active) {
        var n = lastInput(steps).name;
        return (active ? "Loading " : "Loaded ") + (n || "a file") + " into the sandbox";
      },
    },
    read_artifact: {
      icon: ICON_RESEARCH,
      row: function (input) {
        return (input && input.filename) || "read_artifact";
      },
      summary: function (steps, active) {
        var f = lastInput(steps).filename;
        return (active ? "Reading " : "Read ") + (f || "a document");
      },
    },
    run_shell: {
      icon: ICON_TERMINAL,
      // The command as the row label (first line; the full command shows in the
      // expanded terminal card).
      row: function (input) {
        return input && input.command ? firstLine(input.command) : "run_shell";
      },
      summary: function (steps, active) {
        var verb = active ? "Running" : "Ran";
        return steps.length > 1 ? verb + " " + steps.length + " commands" : verb + " a command";
      },
      result: renderShellResult,
    },
    // The file tools name the file they touched, because that is the whole
    // story of the step: which file, and what happened to it. The result body
    // (numbered lines, or a one-line report) renders with the default.
    view_file: {
      icon: ICON_PAGE,
      row: function (input) {
        return (input && input.path) || "view_file";
      },
      summary: function (steps, active) {
        var verb = active ? "Reading" : "Read";
        if (steps.length > 1) return verb + " " + steps.length + " files";
        return verb + " " + (baseName(lastInput(steps).path) || "a file");
      },
      result: defaultResult,
    },
    write_file: {
      icon: ICON_PAGE,
      row: function (input) {
        return (input && input.path) || "write_file";
      },
      summary: function (steps, active) {
        var verb = active ? "Writing" : "Wrote";
        if (steps.length > 1) return verb + " " + steps.length + " files";
        return verb + " " + (baseName(lastInput(steps).path) || "a file");
      },
      result: defaultResult,
    },
    edit_file: {
      icon: ICON_PENCIL,
      row: function (input) {
        return (input && input.path) || "edit_file";
      },
      summary: function (steps, active) {
        var verb = active ? "Editing" : "Edited";
        if (steps.length > 1) return verb + " " + steps.length + " files";
        return verb + " " + (baseName(lastInput(steps).path) || "a file");
      },
      result: defaultResult,
    },
  };
  /** The last path segment — a step reads better as "main.py" than as its path. */
  function baseName(p) {
    if (!p) return "";
    var parts = String(p).split("/");
    return parts[parts.length - 1] || p;
  }
  var DEFAULT_TOOL = {
    icon: ICON_TOOL,
    row: function (_input, name) {
      return name;
    },
    summary: function (steps, active, name) {
      return (active ? "Running " : "Ran ") + name + (steps.length > 1 ? " ×" + steps.length : "");
    },
    result: defaultResult,
  };
  function toolUI(name) {
    return TOOL_UI[name] || DEFAULT_TOOL;
  }
  function endAssistant(rec, finishReason, usage, reasoningMs) {
    closeActivity(rec); // finish + collapse any open activity block
    // The server reports one reasoning duration for the turn (start → first
    // answer token); it belongs to the first thinking block. Stamp its step and
    // its block header with "Thought for Ns".
    if (rec.firstReasoning) {
      labelThought(rec.firstReasoning, reasoningMs);
      if (rec.firstReasoningBlock) {
        rec.firstReasoningBlock.thoughtLabel =
          reasoningMs != null
            ? "Thought for " + Math.max(0, Math.round(reasoningMs / 1000)) + "s"
            : "Thought";
        blockUpdateHead(rec.firstReasoningBlock);
      }
    }
    // Finalize every answer prose block (the open one plus any an activity block
    // closed): flush remaining text, end the parser, run the completed-block
    // enhancers (code highlight, math).
    var stripped = false;
    for (var i = 0; i < rec.proses.length; i++) {
      var p = rec.proses[i];
      if (p.buf) {
        smdWrite(p.parser, p.buf);
        p.buf = "";
      }
      smd.parser_end(p.parser);
      if (finalize(p.renderer)) stripped = true;
      // The live stream masks `$` (no full text to scan), so math content was
      // parsed with markdown mangling. Now that the block is complete, re-render
      // it once from the full text with math properly protected.
      if (p.full && p.full.indexOf("$") >= 0) {
        p.el.textContent = "";
        var rp = newParser(p.el);
        smd.parser_write(rp.parser, protectMath(p.full));
        smd.parser_end(rp.parser);
        if (finalize(rp.renderer)) stripped = true;
      }
      queueEnrich(p.el);
    }
    // Copy lands at the END of a turn, not during it: half an answer is not a
    // thing anyone means to paste.
    markCopyable(rec.turn, answerMarkdown(rec));
    rec.turn.classList.remove("generating");
    if (finishReason === "aborted") {
      rec.meta.textContent = "";
      canceledMark(rec.body);
    } else if (finishReason === "error") {
      rec.turn.classList.add("failed");
      failbar(rec.body, "generation failed");
      rec.meta.textContent = "error";
    } else {
      var elapsed = (Date.now() - rec.startedAt) / 1000;
      var live = elapsed >= 0.3; // actually streamed in this session vs replayed from the log
      var out = usage && usage.outputTokens != null ? usage.outputTokens : null;
      if (out != null && live) {
        var ttft = rec.firstDeltaAt
          ? ((rec.firstDeltaAt - rec.startedAt) / 1000).toFixed(1) + "s ttft · "
          : "";
        rec.meta.textContent =
          ttft + out.toLocaleString() + " tok · " + Math.round(out / elapsed) + " tok/s";
      } else if (out != null) {
        rec.meta.textContent = out.toLocaleString() + " tok"; // replayed: real count, no synthetic rate
      } else if (!live) {
        rec.meta.textContent = "";
      } else {
        liveMeta(rec); // provider reported no usage: fall back to wall-clock
      }
    }
    // The gauge tracks the NEWEST turn's usage. `renderAnchor` is set only while
    // backfilling older turns above the tail — those must not clobber it, or the
    // gauge flashes down to an old (small) value as history loads in.
    if (usage && !renderAnchor) {
      lastUsage = usage;
      lastUsageConv = convId;
      updateCtx();
    }
    if (stripped) failbar(rec.body, "some content was removed by the sanitizer");
  }
  function failbar(bodyEl, msg) {
    if (bodyEl.querySelector(".failbar")) return;
    var fb = document.createElement("div");
    fb.className = "failbar";
    fb.textContent = msg;
    bodyEl.appendChild(fb);
  }
  // Italic "canceled" under a stopped turn. As a block it sits on its own line
  // below whatever text streamed; when nothing streamed it's the only child, so
  // the :not(:first-child) margin drops out and there's no leading blank line.
  function canceledMark(bodyEl) {
    if (bodyEl.querySelector(".canceled")) return; // idempotent across replays
    var el = document.createElement("div");
    el.className = "canceled";
    el.textContent = "canceled";
    bodyEl.appendChild(el);
  }
  function lastAssistant() {
    var keys = Object.keys(msgs);
    return keys.length ? msgs[keys[keys.length - 1]] : null;
  }

  function applyEvent(name, data) {
    switch (name) {
      case "user-message":
        confirmUser(data.runId, data.content, data.attachments);
        break;
      case "queued-message":
        confirmQueued(data.runId, data.content, data.attachments);
        break;
      case "queued-cancelled":
        confirmCancelled(data.runId);
        break;
      case "message-start":
        streaming = true;
        assistantTurn(data.messageId);
        updateSend();
        break;
      case "reasoning-delta": {
        var rrec = assistantTurn(data.messageId);
        openReasoning(rrec).buf += data.delta;
        scheduleFlush();
        break;
      }
      case "tool-call":
        toolStep(assistantTurn(data.messageId), data);
        break;
      case "tool-progress":
        toolProgress(assistantTurn(data.messageId), data);
        break;
      case "tool-result":
        toolResult(assistantTurn(data.messageId), data);
        break;
      case "text-delta": {
        var rec = assistantTurn(data.messageId);
        // Providers emit whitespace-only text (e.g. "\n\n") between tool rounds;
        // opening a text sink for it would close the activity block and split
        // consecutive tool calls into separate traces. While a tool trace is
        // open, skip blank deltas — real text (or anything once the answer has
        // started, when rec.activity is null) flows through and ends the trace.
        if (rec.activity && !data.delta.trim()) break;
        var sink = openText(rec); // ends any open thinking; collapses the stepper
        if (!rec.firstDeltaAt) rec.firstDeltaAt = Date.now();
        sink.buf += data.delta;
        sink.full += data.delta; // kept for the math-correct re-render at finalize
        scheduleFlush();
        break;
      }
      case "message-end": {
        streaming = false;
        var r = msgs[data.messageId];
        if (r) endAssistant(r, data.finishReason, data.usage, data.reasoningMs);
        updateSend();
        // The flush's promotions arrive as their own user-message events
        // (confirmUser drops each from the panel), so there's nothing to
        // reconcile here — the event stream keeps the queue in sync.
        break;
      }
      case "run-error": {
        streaming = false;
        var la = lastAssistant();
        if (la) {
          la.turn.classList.add("failed");
          failbar(la.body, String(data.error || "run error"));
          la.meta.textContent = "error";
        }
        updateSend();
        break;
      }
      case "conversation-title":
        applyTitle(data.title);
        break;
      case "run-started":
      case "cancelled":
        break;
    }
  }

  // ---- SSE stream --------------------------------------------------------
  var connTimer = null; // debounce before admitting a gap is worth showing
  var retryTimer = null; // pending automatic reconnect after a terminal failure
  // A dropped socket is usually a blip, so the first retries come fast and the
  // backoff widens gently. Only once a whole run of them has failed is the
  // connection worth calling broken, and the hat allowed to go red.
  var RETRY_MIN = 600,
    RETRY_MAX = 20000,
    RETRY_GROWTH = 1.6,
    RETRIES_BEFORE_ERROR = 5;
  var retryDelay = RETRY_MIN;
  var retryCount = 0;
  var lastSeenId = null; // newest event id received on the current stream
  var SSE_EVENTS = [
    "user-message",
    "queued-message",
    "queued-cancelled",
    "run-started",
    "message-start",
    "reasoning-delta",
    "tool-call",
    "tool-progress",
    "tool-result",
    "text-delta",
    "message-end",
    "run-error",
    "cancelled",
    "conversation-title",
  ];

  // Open a conversation: batch-load the whole history in ONE request and render
  // it in a single pass (far faster than streaming the entire log back over SSE,
  // especially over a tunnel), then open the live SSE stream for only the events
  // after what we already have. The history events reconstruct the steer queue
  // on their own, so no separate fetch is needed.
  // Optimistic prefetch: the most-recently-opened conversation (remembered in
  // localStorage) is usually the one we open on the next load, so start fetching
  // its history in parallel with the boot calls instead of waiting for the
  // conversation list to arrive first. `{ id, promise }` is consumed by
  // loadHistoryThenStream when the ids match, saving a serial round-trip.
  var TAIL_TURNS = 3; // how many recent turns to render instantly at the bottom
  function eventsUrl(id, query) {
    return "/api/conversations/" + encodeURIComponent(id) + "/events" + (query ? "?" + query : "");
  }
  function seqOfId(eid) {
    return Number(eid.slice(eid.lastIndexOf(":") + 1));
  }

  // Optimistic prefetch: the most-recently-opened conversation (localStorage) is
  // usually the one we open next, so start fetching its TAIL (the bottom turns)
  // in parallel with the boot calls. Resolves to the Response so it can stream.
  var prefetch = null;
  function prefetchEvents(id) {
    if (!id) return;
    prefetch = {
      id: id,
      promise: fetch(eventsUrl(id, "tailTurns=" + TAIL_TURNS)).catch(function () {
        return null;
      }),
    };
  }

  function openStream(id) {
    if (source) {
      source.close();
      source = null;
    }
    if (connTimer) {
      clearTimeout(connTimer);
      connTimer = null;
    }
    // A deliberate switch starts clean: no stale retry for the old conversation,
    // and no leftover hat claiming this one is degraded.
    clearTimeout(retryTimer);
    retryTimer = null;
    retryDelay = RETRY_MIN;
    retryCount = 0;
    hat.set("live");
    $("chatShell").classList.remove("loaded"); // until this one's history lands
    convId = id;
    // The open document belongs to the conversation being left, so it goes with
    // it rather than hanging over the next one.
    closePane();
    refreshArtifacts(id);
    // Clear the previous conversation's thread synchronously, before the async
    // history load. Otherwise, when the chat shell is re-revealed after a detour
    // through a satellite view, it briefly shows the old conversation (a full
    // round-trip for a new chat) until loadHistoryThenStream's fetch returns.
    clearThread();
    // Leave the gauge showing the previous conversation's value here; the tail
    // load below animates it to the new conversation's usage (or drains it to
    // empty if this chat has none), so switching glides instead of blanking.
    atBottom = true; // a freshly opened conversation should land at the end
    void loadHistoryThenStream(id);
  }
  // Bottom-first: render the last few turns instantly at the bottom, open the live
  // stream, then backfill everything older ABOVE (scroll anchoring keeps the
  // bottom stable) — so a big conversation is usable immediately and never blanks.
  async function loadHistoryThenStream(id) {
    var pre = prefetch && prefetch.id === id ? prefetch.promise : null; // single-use
    prefetch = null;
    var res = null;
    try {
      res = pre ? await pre : await fetch(eventsUrl(id, "tailTurns=" + TAIL_TURNS));
    } catch (_) {
      res = null;
    }
    if (convId !== id) return; // switched conversations while loading
    var tail = await streamInto(res, id, null, true); // phase 1: newest turns at the bottom
    if (convId !== id) return;
    // History has settled, so an empty thread now means an empty CONVERSATION
    // rather than one still loading. Only then may the empty state show — the
    // CSS can see that #thread has no turns, but not why.
    $("chatShell").classList.add("loaded");
    // No completed turn carried usage for this conversation (a new/empty chat, or
    // one whose last turn had none): the gauge is still showing the previous
    // conversation's value, so drain it to empty now.
    if (lastUsageConv !== id) {
      lastUsage = null;
      updateCtx();
    }
    updateSend(); // repaint the action button once to the final state (no strobe)
    connectStream(id, tail.lastId); // live tail from the newest event we have
    if (tail.rendered && tail.firstSeq > 1) void backfill(id, tail.firstSeq); // older turns, in the background
  }
  // Fetch + render everything older than `beforeSeq`, inserting it ABOVE the
  // current top turn. The browser's scroll anchoring holds the viewport, so this
  // is invisible unless the user scrolls up into it.
  async function backfill(id, beforeSeq) {
    var res = null;
    try {
      res = await fetch(eventsUrl(id, "before=" + beforeSeq));
    } catch (_) {
      return;
    }
    if (convId !== id || !res) return;
    // Backfill replays OLD, complete turns — don't let their message-start/end
    // clobber the live streaming state (e.g. when the conversation opened mid-run).
    var savedStreaming = streaming;
    await streamInto(res, id, thread.firstChild, false); // prepend before the current top; don't scroll
    if (convId !== id) return;
    streaming = savedStreaming;
    updateSend();
  }
  // Read an NDJSON history stream (the browser decompresses the brotli response on
  // the fly) and apply events incrementally. `prepend` (a turn element) inserts
  // new turns before it; null appends. Applies each network chunk synchronously
  // with the anchor set, then clears it — so live SSE events (which fire only
  // between awaits) are never misplaced by the prepend anchor.
  async function streamInto(res, id, prepend, scrollBottom) {
    var out = { lastId: null, firstSeq: Infinity, rendered: false };
    if (!res || !res.ok || !res.body || !res.body.getReader) {
      if (!prepend) clearThread();
      return out;
    }
    var reader = res.body.getReader(),
      decoder = new TextDecoder(),
      buf = "";
    var cleared = !!prepend; // backfill prepends onto existing content; never clears
    function applyLine(line) {
      if (!line) return;
      var ev;
      try {
        ev = JSON.parse(line);
      } catch (_) {
        return;
      }
      if (!cleared) {
        clearThread();
        cleared = true;
      } // swap on first event → no empty flash
      applyEvent(ev.event, ev.data);
      out.lastId = ev.id;
      out.rendered = true;
      var s = seqOfId(ev.id);
      if (s < out.firstSeq) out.firstSeq = s;
    }
    bulkLoading = true;
    try {
      for (;;) {
        var chunk = await reader.read();
        if (convId !== id) {
          try {
            reader.cancel();
          } catch (_) {}
          bulkLoading = false;
          return out;
        }
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        renderAnchor = prepend; // scoped to this synchronous burst
        var nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          applyLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
        renderAnchor = null;
        flush();
        if (scrollBottom) scroll.scrollTop = scroll.scrollHeight; // follow the bottom as it fills
      }
      renderAnchor = prepend;
      buf += decoder.decode();
      applyLine(buf);
      renderAnchor = null;
    } catch (_) {
      /* stream dropped — keep what rendered; the SSE tail fills any gap */
    }
    bulkLoading = false;
    if (!cleared) clearThread(); // empty conversation
    flush();
    if (scrollBottom) {
      scroll.scrollTop = scroll.scrollHeight;
      pinToBottom(900); // hold it there while estimated heights become real
    }
    return out;
  }
  function connectStream(id, afterId) {
    var url = "/api/conversations/" + encodeURIComponent(id) + "/stream";
    if (afterId) url += "?after=" + encodeURIComponent(afterId); // only the tail after the batch
    lastSeenId = afterId || null;
    var es = new EventSource(url);
    source = es;
    SSE_EVENTS.forEach(function (nm) {
      es.addEventListener(nm, function (ev) {
        // Remember the cursor ourselves: a manual retry builds a NEW EventSource,
        // which starts with an empty Last-Event-ID, so ?after= has to carry it.
        if (ev.lastEventId) lastSeenId = ev.lastEventId;
        var data;
        try {
          data = JSON.parse(ev.data);
        } catch (_) {
          return;
        }
        applyEvent(nm, data);
      });
    });
    es.onopen = function () {
      retryDelay = RETRY_MIN;
      retryCount = 0;
      setConn("connected");
    };
    es.onerror = function () {
      if (source !== es) return; // a stale socket we already replaced
      if (!navigator.onLine) {
        setConn("offline");
        return;
      }
      // readyState 0 (CONNECTING) is the browser's own auto-reconnect on the
      // `retry:` interval the stream sets — fast, and silent, because a blip
      // should heal before it's worth mentioning. readyState 2 (CLOSED) is
      // terminal. Either way, once a gap outlives the debounce we take the
      // schedule over: the browser's interval is flat, and a real outage wants a
      // widening one with something to look at.
      if (es.readyState === 2 || retryCount > 0) {
        takeOver();
        return;
      }
      if (!connTimer)
        connTimer = setTimeout(function () {
          connTimer = null;
          takeOver();
        }, 1200);
    };
  }
  // Stop the browser retrying on its own cadence and put the gap on ours. Red is
  // only reached once a run of our own attempts has failed.
  function takeOver() {
    if (source) source.close();
    setConn(retryCount < RETRIES_BEFORE_ERROR ? "reconnecting" : "error", true);
  }
  // Rebuild the stream from the last event we actually saw. Used by the hat's
  // Retry, by the backoff timer, and by the browser coming back online.
  function reconnectNow() {
    if (!convId) return;
    clearTimeout(retryTimer);
    retryTimer = null;
    if (source) source.close();
    setConn("reconnecting");
    connectStream(convId, lastSeenId);
  }
  // Book the next attempt and hand back when it lands, so the hat can count it
  // down. Early attempts come back fast; the delay widens gently from there.
  function scheduleRetry() {
    clearTimeout(retryTimer);
    var at = Date.now() + retryDelay;
    retryTimer = setTimeout(reconnectNow, retryDelay);
    retryDelay = Math.min(RETRY_MAX, retryDelay * RETRY_GROWTH);
    retryCount++;
    return at;
  }
  // `retry` marks the states where WE own the next attempt (a terminal close),
  // as opposed to the ones where the browser or the network does.
  function setConn(s, retry) {
    if (s !== "reconnecting" && connTimer) {
      clearTimeout(connTimer);
      connTimer = null;
    }
    if (!retry) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (s === "connected") {
      // Only celebrate a return if something was actually shown to be wrong;
      // the first connect of a conversation goes straight to live.
      hat.set(hat.state === "live" ? "live" : "resumed");
      return;
    }
    hat.set(s, retry ? { retryAt: scheduleRetry() } : null);
  }
  // The browser knows about the network before a socket times out: trust it for
  // the offline branch, and take "online" as permission to try again at once.
  addEventListener("offline", function () {
    if (source) setConn("offline");
  });
  addEventListener("online", function () {
    if (source && hat.state !== "live") reconnectNow();
  });

  // ---- composer / sending ------------------------------------------------
  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.44) + "px";
  }
  function submit() {
    var content = input.value.trim();
    // Sendable with text or attachments; nothing to send if both are empty.
    if ((!content && staged.length === 0) || !selected || uploadingCount() > 0) return;
    var attachments = sendableStaged().map(attachmentRef);
    input.value = "";
    autosize();
    clearStaged();
    var runId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
    // While a run is in flight the message joins the steer queue; otherwise it
    // starts a run.
    if (streaming) {
      doSteer(content, runId, attachments);
      return;
    }
    doSend(content, runId, attachments);
  }
  // Only send `attachments` in the body when there are some, so a plain text
  // message stays byte-identical to before.
  function bodyFor(content, runId, attachments) {
    var b = { content: content, model: selected.ref, runId: runId };
    if (attachments && attachments.length) b.attachments = attachments;
    return JSON.stringify(b);
  }
  // Optimistic apply now, POST after: the user's turn is on screen before the
  // request leaves. Reconciled by the server's user-message echo (same runId).
  async function doSend(content, runId, attachments) {
    var wasNew = !hasConversation(convId);
    optimisticUser(content, runId, attachments);
    streaming = true;
    updateSend(); // job is queued + cancellable even pre-first-token
    try {
      var res = await fetch("/api/conversations/" + encodeURIComponent(convId) + "/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyFor(content, runId, attachments),
      });
      if (!res.ok) {
        streaming = false;
        updateSend();
        var err = await res.json().catch(function () {
          return {};
        });
        failUser(runId);
        if (err.error) console.warn("prompt rejected:", err.error);
        return;
      }
      if (wasNew && content) {
        setHeader(
          content.slice(0, 80),
          pendingProject ? { id: pendingProject, name: pendingProjectName } : null,
        );
        setUrl("/c/" + encodeURIComponent(convId), true); // a new chat is now saved — reflect it in the URL
        if (pendingProject) {
          fetch("/api/conversations/" + encodeURIComponent(convId) + "/project", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ projectId: pendingProject }),
          }).catch(function () {});
          pendingProject = null;
        }
        setTimeout(loadConversations, 400);
      }
    } catch (_e) {
      streaming = false;
      updateSend();
      failUser(runId);
    }
  }
  // Steer mid-run: the message joins the staging queue above the composer and
  // flushes with the whole queue as one batched run when the current run ends.
  // It enters the thread only once the flush promotes it (its user-message echo).
  async function doSteer(content, runId, attachments) {
    queued[runId] = { content: content, attachments: attachments };
    renderQueue();
    try {
      var res = await fetch("/api/conversations/" + encodeURIComponent(convId) + "/steer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyFor(content, runId, attachments),
      });
      if (!res.ok) {
        var err = await res.json().catch(function () {
          return {};
        });
        if (queued[runId] !== undefined) {
          delete queued[runId];
          renderQueue();
        }
        if (err.error) console.warn("steer rejected:", err.error);
      }
    } catch (_e) {
      if (queued[runId] !== undefined) {
        delete queued[runId];
        renderQueue();
      }
    }
  }
  // Remove a still-pending steer. Optimistic: drop it locally now, then DELETE;
  // the queued-cancelled echo keeps other devices in sync (idempotent here).
  async function cancelSteer(runId) {
    delete queued[runId];
    renderQueue();
    try {
      await fetch(
        "/api/conversations/" + encodeURIComponent(convId) + "/steer/" + encodeURIComponent(runId),
        { method: "DELETE" },
      );
    } catch (_e) {
      /* the panel already reflects the removal */
    }
  }
  function stop() {
    if (!streaming) return;
    // Acknowledge the click immediately: leave the streaming state and mark the
    // live turn "stopping…" rather than waiting for the aborted message-end to
    // round-trip. endAssistant reconciles to the final "stopped" when it lands.
    streaming = false;
    updateSend();
    var rec = lastAssistant();
    if (rec && rec.turn.classList.contains("generating")) {
      rec.turn.classList.remove("generating");
      rec.meta.textContent = "stopping…";
    }
    fetch("/api/conversations/" + encodeURIComponent(convId) + "/cancel", { method: "POST" }).catch(
      function () {},
    );
  }

  // ---- steer queue -------------------------------------------------------
  // The staging panel above the composer is the ONLY view of pending steers,
  // and the `queued` map is its single source of truth. The event stream keeps
  // it honest: queued-message adds, user-message (promotion) removes. On
  // (re)connect the stream replays from seq 0, so the queue rebuilds itself —
  // no separate fetch, no reconciliation with in-thread turns.
  function renderQueue() {
    var ids = Object.keys(queued);
    queueEl.classList.toggle("hidden", ids.length === 0);
    queueCount.textContent = ids.length;
    queueItems.innerHTML = "";
    ids.forEach(function (runId) {
      var item = queued[runId];
      var li = document.createElement("li");
      var main = document.createElement("div");
      main.className = "qmain";
      var text = document.createElement("span");
      text.className = "qtext";
      text.textContent = item.content || (item.attachments && item.attachments.length ? "" : "");
      main.appendChild(text);
      if (item.attachments && item.attachments.length) renderAttachments(main, item.attachments);
      li.appendChild(main);
      var x = document.createElement("button");
      x.type = "button";
      x.className = "qx";
      x.setAttribute("aria-label", "Remove from queue");
      x.textContent = "×";
      x.onclick = function () {
        cancelSteer(runId);
      };
      li.appendChild(x);
      queueItems.appendChild(li);
    });
  }

  // ---- conversation rail -------------------------------------------------
  // The sidebar (recents list, nav, collapse/overlay toggle) is shared with the
  // Conversations page; this page just tells it how to open/create a chat.
  var conversations = [];
  var dialogs = mountDialogs();
  mountPane();
  // The empty state. CSS decides when it's visible (see .emptystate); the
  // rosette itself sleeps whenever it has no box to draw into, so mounting it
  // unconditionally costs nothing in a conversation that already has messages.
  mountRosette($("rosette"));
  // The section the router is currently showing ("chat" | "conversations" |
  // "projects" | "settings"). The sidebar's "New chat" highlight is a chat-view
  // concern, so it only lights up while we're actually on chat.
  var currentSection = "chat";
  var sidebar = mountSidebar({
    onChat: function () {
      return currentSection === "chat";
    },
    // Route through the router so these work from any view: if a satellite is
    // mounted, it's torn down and the chat shell comes back; on chat, it's a
    // normal soft-nav. `router` is assigned below (before any user click fires).
    onSelect: function (id) {
      router.navigate("/c/" + encodeURIComponent(id));
    },
    onNew: function () {
      // "New chat" always yields a fresh conversation. Already home → reset in
      // place; otherwise navigate home, where enterChat starts a fresh one.
      if (location.pathname === "/" && !location.search) newConversation("none");
      else router.navigate("/");
    },
    activeId: function () {
      return convId;
    },
    dialogs: dialogs,
    reload: function () {
      loadConversations();
    },
  });
  function hasConversation(id) {
    return conversations.some(function (c) {
      return c.id === id;
    });
  }
  async function loadConversations() {
    try {
      var res = await fetch("/api/conversations");
      conversations = (await res.json()).conversations || [];
    } catch (_) {
      conversations = [];
    }
    sidebar.render(conversations);
  }
  // Browser tab: "<conversation> - Kloe" once a conversation has a title, else
  // just "Kloe".
  function setDocTitle(t) {
    // Collapse whitespace and cap length — a raw first-message title (up to 80
    // chars, possibly with newlines) makes a broken-looking browser tab.
    var s = t ? String(t).replace(/\s+/g, " ").trim() : "";
    if (s.length > 60) s = s.slice(0, 60).trimEnd() + "…";
    document.title = s ? s + " - Kloe" : "Kloe";
  }
  // A live title update (generated server-side): reflect it in the header, the
  // tab, and the sidebar entry without a reload.
  function applyTitle(t) {
    if (!t) return;
    var ct = title.querySelector(".crumbtitle");
    if (ct) ct.textContent = t;
    setDocTitle(t);
    var c = conversations.find(function (x) {
      return x.id === convId;
    });
    if (c) {
      c.title = t;
      sidebar.render(conversations);
    }
  }
  // The header shows the chat title, and — when the chat is filed under a
  // project — a `Project / title` breadcrumb whose project name links back to
  // the project page. `project` is {id, name} or null.
  function setHeader(t, project) {
    title.innerHTML = "";
    if (project && project.id) {
      var a = document.createElement("a");
      a.className = "crumblink";
      a.href = "/p/" + encodeURIComponent(project.id);
      a.textContent = project.name || "Project";
      var sep = document.createElement("span");
      sep.className = "crumbsep";
      sep.textContent = "/";
      title.appendChild(a);
      title.appendChild(sep);
    }
    var tt = document.createElement("span");
    tt.className = "crumbtitle";
    tt.textContent = t || "Conversation";
    title.appendChild(tt);
    setDocTitle(t);
  }
  // The project (if any) for a conversation id, from the sidebar list data.
  function projectOf(id) {
    var c = conversations.find(function (x) {
      return x.id === id;
    });
    return c && c.projectId ? { id: c.projectId, name: c.projectName } : null;
  }
  // URL ⇄ conversation. `/c/<id>` deep-links a conversation (reload/bookmark/back
  // all work); "/" is a fresh chat. `nav` on select/new controls history:
  // "push" (default, a user action) adds an entry, "replace" swaps the current
  // one (initial load, or a new chat becoming saved), "none" leaves the URL as
  // is (we arrived here FROM a popstate, so the browser already changed it).
  function convIdFromPath() {
    var m = location.pathname.match(/^\/c\/([^/]+)\/?$/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setUrl(path, replace) {
    if (location.pathname + location.search === path) return;
    if (replace) history.replaceState({}, "", path);
    else history.pushState({}, "", path);
  }
  function selectConversation(id, t, nav) {
    setHeader(t, projectOf(id));
    openStream(id);
    sidebar.render(conversations);
    if (nav !== "none") setUrl("/c/" + encodeURIComponent(id), nav === "replace");
  }
  function newConversation(nav) {
    var id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
    // A brand-new chat opened from a project already knows its project (pending);
    // otherwise it's unfiled until its first message optionally files it.
    setHeader(
      "New conversation",
      pendingProject ? { id: pendingProject, name: pendingProjectName } : null,
    );
    openStream(id);
    sidebar.render(conversations);
    sidebar.closeRail();
    input.focus();
    if (nav !== "none") setUrl("/", nav === "replace");
  }
  // Learn a pending project's name so a new chat's header breadcrumb reads
  // "Project / …" rather than a bare caret. Shared by boot and a soft-nav
  // project-scoped new chat (/?new=1&project=<id>).
  function enrichPendingProject() {
    fetch("/api/projects/" + encodeURIComponent(pendingProject))
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (d) {
        // Still pending only while the new chat is unfiled; if it's been cleared
        // (first message filed it), leave the header alone.
        if (!d || !d.project || !pendingProject) return;
        pendingProjectName = d.project.name;
        var cur = title.querySelector(".crumbtitle");
        setHeader(cur ? cur.textContent : "New conversation", {
          id: pendingProject,
          name: pendingProjectName,
        });
      })
      .catch(function () {});
  }

  // Enter (or re-enter) the chat view for a resolved route. The router owns the
  // URL, so nav mode is always "none" here — we only open the right conversation.
  // Called on click-nav to chat, on popstate landing on chat, and at boot.
  function enterChat(params) {
    if (params && params.isNew) {
      // A project-scoped new chat carries its project in the URL; on soft-nav the
      // module-level pendingProject isn't set from the query, so set it here.
      pendingProject = params.project || null;
      pendingProjectName = null;
      newConversation("none");
      if (pendingProject) enrichPendingProject();
      return;
    }
    if (params && params.id) {
      var c = conversations.find(function (x) {
        return x.id === params.id;
      });
      selectConversation(params.id, c ? c.title : null, "none");
      return;
    }
    newConversation("none"); // bare "/" — a fresh chat, not the last conversation
  }

  // The route table. Chat ("/", "/c/:id", legacy "/?c=" and "/?new") is the
  // persistent home; /projects is a mounted view. Everything else returns null so
  // the router lets the browser do a real navigation (not yet SPA-converted).
  function resolveRoute(path) {
    var u = new URL(path, location.origin);
    var q = new URLSearchParams(u.search);
    if (u.pathname === "/") {
      if (q.has("new"))
        return { kind: "chat", nav: "chat", params: { isNew: true, project: q.get("project") } };
      if (q.get("c")) return { kind: "chat", nav: "chat", params: { id: q.get("c") } };
      return { kind: "chat", nav: "chat", params: {} };
    }
    var m = u.pathname.match(/^\/c\/([^/]+)\/?$/);
    if (m) return { kind: "chat", nav: "chat", params: { id: decodeURIComponent(m[1]) } };
    var pm = u.pathname.match(/^\/p\/([^/]+)\/?$/);
    if (pm) {
      return {
        kind: "view",
        nav: "projects",
        params: { id: decodeURIComponent(pm[1]) },
        load: function () {
          return import("./views/project.js");
        },
      };
    }
    if (u.pathname === "/conversations") {
      return {
        kind: "view",
        nav: "conversations",
        params: {},
        load: function () {
          return import("./views/conversations.js");
        },
      };
    }
    if (u.pathname === "/projects") {
      return {
        kind: "view",
        nav: "projects",
        params: {},
        load: function () {
          return import("./views/projects.js");
        },
      };
    }
    if (u.pathname === "/settings") {
      return {
        kind: "view",
        nav: "settings",
        params: {},
        load: function () {
          return import("./views/settings.js");
        },
      };
    }
    return null;
  }

  // Light up the rail row for the current section (the MPA baked this into each
  // page's HTML; soft-nav has to do it live). "New chat" and the active recent are
  // handled separately by sidebar.render, so chat clears both top rows.
  function setActiveNav(section) {
    currentSection = section;
    document.getElementById("chatsBtn").classList.toggle("active", section === "conversations");
    document.getElementById("projectsBtn").classList.toggle("active", section === "projects");
    // Leaving chat clears the "New chat" highlight now (views like Projects don't
    // re-render the sidebar); on chat, enterChat's sidebar.render sets it.
    if (section !== "chat") document.getElementById("new").classList.remove("active");
  }

  // Shared context handed to mounted views: the live sidebar, the dialog helpers,
  // soft navigation, and the rail toggle (each view wires its own header button).
  var viewCtx = {
    sidebar: sidebar,
    dialogs: dialogs,
    navigate: function (path) {
      router.navigate(path);
    },
    toggleRail: function () {
      sidebar.toggleRail();
    },
  };
  var router = createRouter({
    outlet: document.getElementById("viewOutlet"),
    chatShell: document.getElementById("chatShell"),
    resolve: resolveRoute,
    enterChat: enterChat,
    onNav: setActiveNav,
    ctx: viewCtx,
    // Instant swap. The content paints synchronously from cache, so a crossfade
    // is pure perceived latency on top of an already-there view — a snap reads as
    // faster. (The cross-document @view-transition still smooths real page loads.)
    transition: false,
  });

  // ---- model picker ------------------------------------------------------
  async function loadModels() {
    try {
      models = (await (await fetch("/api/models/chat")).json()).models || [];
    } catch (_) {
      models = [];
    }
    var saved = localStorage.getItem("kloe.model");
    selected =
      models.find(function (m) {
        return m.ref === saved;
      }) ||
      models[0] ||
      null;
    renderPicker();
    renderPill();
    updateSend();
    updateCtx();
  }
  function renderPill() {
    pill.disabled = models.length === 0;
    pillModel.textContent = selected ? selected.name : models.length ? "Select model" : "No models";
  }
  function renderPicker() {
    picker.innerHTML = "";
    if (models.length === 0) {
      var none = document.createElement("div");
      none.className = "none";
      none.innerHTML = 'No models enabled. Turn some on in <a href="/settings">Settings</a>.';
      picker.appendChild(none);
      return;
    }
    models.forEach(function (m) {
      var b = document.createElement("button");
      b.className = "opt";
      b.type = "button";
      b.setAttribute("role", "option");
      if (selected && m.ref === selected.ref) b.setAttribute("aria-selected", "true");
      var sub = [];
      if (m.contextWindow) sub.push(fmtCtx(m.contextWindow) + " ctx");
      if (m.reasoningLevels && m.reasoningLevels.length) sub.push("reasoning");
      if (m.supportsImages) sub.push("images");
      b.innerHTML =
        '<div class="name"></div>' +
        (sub.length ? '<div class="sub">' + sub.join(" · ") + "</div>" : "");
      b.querySelector(".name").textContent = m.name;
      b.onclick = function () {
        selected = m;
        localStorage.setItem("kloe.model", m.ref);
        renderPill();
        renderPicker();
        updateSend();
        updateCtx();
        closePicker();
      };
      picker.appendChild(b);
    });
  }
  function openPicker() {
    picker.hidden = false;
    pill.setAttribute("aria-expanded", "true");
  }
  function closePicker() {
    picker.hidden = true;
    pill.setAttribute("aria-expanded", "false");
  }

  // ---- wiring ------------------------------------------------------------
  composer.addEventListener("submit", function (e) {
    e.preventDefault();
    submit();
  });
  input.addEventListener("input", function () {
    autosize();
    updateSend();
  });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  $("stop").addEventListener("click", function () {
    if (streaming) stop();
  });

  // Attachments: a hidden file input behind the paperclip, plus drag-drop onto
  // the composer and image paste from the clipboard. All routes funnel to
  // stageFiles → upload → staged tray.
  var fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);
  attachBtn.addEventListener("click", function () {
    fileInput.click();
  });
  fileInput.addEventListener("change", function () {
    stageFiles(fileInput.files);
    fileInput.value = "";
  });
  composer.addEventListener("dragover", function (e) {
    e.preventDefault();
    composer.classList.add("drop");
  });
  composer.addEventListener("dragleave", function (e) {
    if (e.target === composer || !composer.contains(e.relatedTarget))
      composer.classList.remove("drop");
  });
  composer.addEventListener("drop", function (e) {
    e.preventDefault();
    composer.classList.remove("drop");
    if (e.dataTransfer && e.dataTransfer.files) stageFiles(e.dataTransfer.files);
  });
  input.addEventListener("paste", function (e) {
    var items = e.clipboardData && e.clipboardData.files;
    if (items && items.length) {
      e.preventDefault();
      stageFiles(items);
    }
  });
  pill.addEventListener("click", function () {
    if (picker.hidden) openPicker();
    else closePicker();
  });
  document.addEventListener("click", function (e) {
    if (
      !picker.hidden &&
      !picker.contains(e.target) &&
      e.target !== pill &&
      !pill.contains(e.target)
    )
      closePicker();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closePicker();
  });
  // How far from the end before the jump button is worth offering, in viewport
  // heights. Two separate thresholds on purpose: `atBottom` decides whether a
  // streaming reply keeps the view pinned, so it has to mean "essentially at the
  // end" — while the button is only useful once scrolling back is a chore.
  // Sharing one number would either unpin the stream early or offer a shortcut
  // to somewhere already on screen.
  var JUMP_AFTER_SCREENS = 2.5;
  /**
   * Following the end is an INTENT, not a position.
   *
   * The gap to the bottom widens for two very different reasons. One is the
   * reader scrolling away, which should stop the view following. The other is
   * the thread growing under a stationary reader — a turn whose 240px estimate
   * is replaced by its real height (fifteen document cards is a long way from
   * 240px), a code block that gains a highlighter, an image that loads. Reading
   * position alone can't tell those apart, so it used to treat both as "they
   * left", and a document-heavy turn would strand the view above the end: jump
   * to the bottom, the turn below resolves taller, and the end has moved on
   * without you.
   *
   * So a gesture is what clears the flag, and arriving at the end re-arms it.
   * Growth can no longer revoke an intent the reader never changed.
   */
  // A gesture's scrolling doesn't all arrive with the gesture, so "recent" is
  // the test rather than "simultaneous" — one flick keeps scrolling after the
  // wheel stops, and a scrollbar drag scrolls with no wheel at all (hence the
  // pointer, held down for as long as the drag lasts).
  var GESTURE_MS = 700;
  var gestureAt = 0,
    dragging = false;
  function noteGesture() {
    gestureAt = Date.now();
    settleUntil = 0; // the reader's own scrolling outranks any settling pin
  }
  function userDriven() {
    return dragging || Date.now() - gestureAt < GESTURE_MS;
  }
  scroll.addEventListener("scroll", function () {
    var gap = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    if (gap < 40) atBottom = true;
    else if (userDriven()) atBottom = false;
    jump.classList.toggle("show", gap > scroll.clientHeight * JUMP_AFTER_SCREENS);
  });
  // Every way a reader moves the thread themselves: the wheel and a finger (both
  // below, where they also call off a glide), the scrollbar, and the keys that
  // scroll — ignored while they're typing, where the same keys move a caret.
  var SCROLL_KEYS = /^(PageUp|PageDown|Home|End|ArrowUp|ArrowDown| )$/;
  scroll.addEventListener(
    "pointerdown",
    function () {
      dragging = true;
      noteGesture();
    },
    { passive: true },
  );
  // On window, so releasing outside the thread still ends the drag.
  window.addEventListener("pointerup", function () {
    if (!dragging) return;
    dragging = false;
    noteGesture(); // the scroll from the last drag movement is still arriving
  });
  window.addEventListener("pointercancel", function () {
    dragging = false;
  });
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (SCROLL_KEYS.test(e.key)) noteGesture();
  });
  // Glide to the end rather than teleporting, so it's clear the thread moved
  // rather than swapped — but on our clock, not the browser's. Native smooth
  // scrolling paces itself by distance and takes well over a second down a long
  // conversation. Streaming's own autoScroll stays instant; a tween per flush
  // would fight itself.
  // Snappy off the line, and distance barely lengthens it: a screen away and a
  // hundred screens away should both feel like one flick.
  var JUMP_BASE_MS = 80;
  var JUMP_MS_PER_PX = 0.06;
  var JUMP_MAX_MS = 500;
  var jumpAnim = null;
  function glideToBottom() {
    if (jumpAnim) cancelAnimationFrame(jumpAnim);
    jumpAnim = null;
    var from = scroll.scrollTop;
    var dist = scroll.scrollHeight - scroll.clientHeight - from;
    if (dist <= 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      scroll.scrollTop = scroll.scrollHeight;
      pinToBottom(700);
      return;
    }
    // Short hops shouldn't take as long as long ones, but nothing takes longer
    // than the ceiling.
    var ms = Math.min(JUMP_MAX_MS, JUMP_BASE_MS + dist * JUMP_MS_PER_PX);
    var t0 = null;
    jumpAnim = requestAnimationFrame(function step(now) {
      if (t0 === null) t0 = now;
      var p = Math.min(1, (now - t0) / ms);
      var eased = 1 - (1 - p) ** 3; // easeOutCubic, same as the context gauge
      // Re-read the end each frame: a live run can extend the thread mid-flight.
      scroll.scrollTop = from + (scroll.scrollHeight - scroll.clientHeight - from) * eased;
      if (p < 1) jumpAnim = requestAnimationFrame(step);
      else {
        jumpAnim = null;
        scroll.scrollTop = scroll.scrollHeight;
        // Landing isn't arriving: the turns just revealed are still resolving
        // their real heights, so hold the end for a beat the way opening a
        // conversation does. Any gesture ends it early.
        pinToBottom(700);
      }
    });
  }
  // Our own scrollTop writes fire `scroll`, so a wheel/touch is how we tell that
  // the user changed their mind. Give way immediately when they do.
  function cancelGlide() {
    noteGesture(); // which also calls off the post-load settling
    if (!jumpAnim) return;
    cancelAnimationFrame(jumpAnim);
    jumpAnim = null;
  }
  scroll.addEventListener("wheel", cancelGlide, { passive: true });
  scroll.addEventListener("touchstart", cancelGlide, { passive: true });
  jump.addEventListener("click", function () {
    atBottom = true;
    jump.classList.remove("show");
    glideToBottom();
  });
  /**
   * Hold the view at the end for a beat after a conversation opens.
   *
   * The ResizeObserver below re-pins as the thread grows, but only while
   * `atBottom` — and that flag is exactly what a freshly opened conversation
   * loses. Turns carry `content-visibility: auto`, so everything offscreen sits
   * at a 240px estimate until it's scrolled near; as real heights replace those
   * estimates the browser anchors the scroll to keep the visual position, which
   * moves us off the bottom, clears the flag, and strands the view a little
   * short. A chat full of long reports is where the estimate is most wrong.
   *
   * So this pins unconditionally for a window, and any deliberate scroll ends
   * it — the user's intent always wins over the settling.
   */
  var settleUntil = 0;
  function pinToBottom(ms) {
    var already = settleUntil > Date.now();
    settleUntil = Date.now() + ms;
    if (already) return; // a loop is already running
    var step = function () {
      if (Date.now() > settleUntil) return;
      scroll.scrollTop = scroll.scrollHeight;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  // The gauge is a bitmap sized to its box, so a box that changes size — the
  // composer narrowing, the container query hiding and restoring it, the window
  // resizing — leaves it stretched until something repaints it. Nothing else
  // would: it only redraws when the token count moves.
  if (window.ResizeObserver) {
    new ResizeObserver(function () {
      if (!ctx.classList.contains("hidden")) renderCtx(ctxDisplayed);
    }).observe(ctxbar);
  }
  // Keep the view pinned to the bottom while `atBottom` as the thread grows —
  // opening a large conversation, async enrich (code/math), and images all add
  // height AFTER the last scroll, which otherwise leaves us short of the end.
  if (window.ResizeObserver) {
    new ResizeObserver(function () {
      if (atBottom) scroll.scrollTop = scroll.scrollHeight;
    }).observe(thread);
  }

  // ---- boot --------------------------------------------------------------
  (async function init() {
    // Fire the auth check, the data loads, AND the last conversation's history
    // all together, so nothing waits serially: /api/me, the model + conversation
    // lists, and the (usually reopened) conversation's /events overlap in one
    // round-trip window instead of chaining.
    // Which conversation to open comes from the URL: the /c/<id> path, or the
    // legacy ?c= / ?new query (from the conversations page). Prefetch that one so
    // its history overlaps the boot round-trip. A bare `/` starts a new chat
    // (below), so there's nothing to prefetch there.
    var params = new URLSearchParams(location.search);
    var wantId = convIdFromPath() || params.get("c");
    if (wantId) prefetchEvents(wantId);

    var mePromise = requireAuth();
    var dataPromise = Promise.all([loadModels(), loadConversations()]);
    var me = await mePromise;
    if (!me) return; // redirecting to login
    setPfp(me);
    await dataPromise;

    // A project-scoped new chat landed on directly (/?new=1&project=<id>):
    // pendingProject was captured from the URL at module load; learn its name.
    if (pendingProject) enrichPendingProject();

    // Normalize a "?new" landing to "/" (drop the query so a refresh and the
    // "New chat" home-check both see a canonical fresh chat); the project, if any,
    // was already captured in pendingProject. Then hand off to the router, which
    // enters chat or mounts the matching view for whatever URL we loaded on.
    if (params.has("new")) history.replaceState({}, "", "/");
    router.start(location.pathname + location.search);
    updateSend();
  })();

  // Register the service worker (instant cold paint + offline shell + instant
  // chat-open). Progressive enhancement: absent/unsupported, the app runs exactly
  // as before. Deferred to load so it never competes with the boot fetches.
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    });
  }
})();
