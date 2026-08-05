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
import { mountSidebar } from "./sidebar.js";
import { requireAuth, setPfp } from "./authguard.js";
import { mountDialogs } from "./confirm.js";

(function () {
  "use strict";

  // Lazily load the enrichment bundle (Shiki + KaTeX) from /assets on first code
  // or math block. The URL is computed so the app bundler leaves it external —
  // the heavy grammars never touch the app entry, and text-only chats never
  // fetch them. Fail-soft: if it can't load, prose stays as plain markdown.
  var _enrich;
  function enrich(el) {
    if (!_enrich) {
      _enrich = import(new URL("/assets/enrich.js", document.baseURI).href)
        .then(function (m) { return m.enrich; })
        .catch(function () { return function () {}; });
    }
    _enrich.then(function (fn) { fn(el); });
  }

  // Right-pointing chevron for timeline step rows; rotates 90° (→ down) when open.
  var CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
  // Step icons for the activity stepper (16px, stroke=currentColor).
  var SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  var ICON_CLOCK = '<svg ' + SVG + '><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  var ICON_GLOBE = '<svg ' + SVG + '><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18"/></svg>';
  var ICON_TOOL = '<svg ' + SVG + '><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2-2 2.6-2.6z"/></svg>';
  var ICON_PAGE = '<svg ' + SVG + '><path d="M6 2h7l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M13 2v5h5"/><path d="M8 13h8M8 17h6"/></svg>';
  var ICON_EXT = '<svg ' + SVG + '><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>';

  var SEND ='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>';

  var $ = function (id) { return document.getElementById(id); };
  var thread = $("thread"), scroll = $("scroll"), jump = $("jump");
  var input = $("input"), send = $("send"), composer = $("composer");
  var title = $("title"), status = $("status"), conn = $("conn");
  var pill = $("pill"), pillModel = $("pillModel"), picker = $("picker");
  var ctx = $("ctx"), ctxbar = $("ctxbar"), ctxpct = $("ctxpct");
  var queueEl = $("queue"), queueCount = $("queueCount"), queueItems = $("queueItems");
  var stagedEl = $("staged"), attachBtn = $("attach");

  // ---- state -------------------------------------------------------------
  var convId = null;          // current conversation id
  var source = null;          // active EventSource
  var streaming = false;      // a run is in flight for the current conversation
  var atBottom = true;
  var models = [], selected = null;
  var msgs = Object.create(null);      // messageId -> assistant render record
  var pending = Object.create(null);   // runId -> optimistic user turn awaiting echo
  var queued = Object.create(null);    // runId -> { content, attachments } (staging panel)
  var flushHandle = null;
  var lastUsage = null;                // real token usage from the last completed turn
  var staged = [];                     // attachments uploaded and waiting on the next send

  // ---- attachments -------------------------------------------------------
  // Uploads go to the content-addressed blob store first; the send/steer body
  // then carries lightweight refs ({sha256,name,mime,kind}), never bytes.
  var IMG = /^image\//;
  function attKind(mime) { return IMG.test(mime) ? "image" : "file"; }
  // Serve URL for a stored blob, carrying the original name so a download keeps it.
  function blobUrl(a) {
    return "/api/blobs/" + encodeURIComponent(a.sha256) + "?name=" + encodeURIComponent(a.name);
  }
  var FILE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/></svg>';

  function uploadingCount() {
    var n = 0;
    for (var i = 0; i < staged.length; i++) if (staged[i].uploading) n++;
    return n;
  }
  // A ref suitable for the message body (drops local-only fields).
  function attachmentRef(it) { return { sha256: it.sha256, name: it.name, mime: it.mime, kind: it.kind }; }

  async function uploadOne(file) {
    var it = { name: file.name || "file", mime: file.type || "application/octet-stream",
               kind: attKind(file.type || ""), sha256: null, uploading: true,
               url: IMG.test(file.type || "") ? URL.createObjectURL(file) : null };
    staged.push(it);
    renderStaged(); updateSend();
    try {
      var res = await fetch("/api/blobs", { method: "POST", headers: { "content-type": it.mime }, body: file });
      if (!res.ok) throw new Error("upload failed (" + res.status + ")");
      var j = await res.json();
      it.sha256 = j.sha256; it.uploading = false;
    } catch (e) {
      // Drop a failed upload from the tray; nothing was staged for send.
      var i = staged.indexOf(it); if (i >= 0) staged.splice(i, 1);
      if (it.url) URL.revokeObjectURL(it.url);
      console.warn("attachment:", e && e.message);
    }
    renderStaged(); updateSend();
  }
  function stageFiles(list) {
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) uploadOne(list[i]);
  }
  function removeStaged(it) {
    var i = staged.indexOf(it); if (i < 0) return;
    staged.splice(i, 1);
    if (it.url) URL.revokeObjectURL(it.url);
    renderStaged(); updateSend();
  }
  function clearStaged() {
    for (var i = 0; i < staged.length; i++) if (staged[i].url) URL.revokeObjectURL(staged[i].url);
    staged = [];
    renderStaged(); updateSend();
  }
  function renderStaged() {
    stagedEl.classList.toggle("hidden", staged.length === 0);
    stagedEl.innerHTML = "";
    staged.forEach(function (it) {
      var chip = document.createElement("div");
      chip.className = "chip" + (it.uploading ? " uploading" : "") + (it.kind === "image" ? " img" : "");
      if (it.kind === "image" && it.url) {
        var img = document.createElement("img");
        img.src = it.url; img.alt = it.name; chip.appendChild(img);
      } else {
        var ic = document.createElement("span"); ic.className = "fi"; ic.innerHTML = FILE_SVG; chip.appendChild(ic);
      }
      var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = it.name; chip.appendChild(nm);
      var x = document.createElement("button");
      x.type = "button"; x.className = "x"; x.setAttribute("aria-label", "Remove " + it.name); x.textContent = "×";
      x.onclick = function () { removeStaged(it); };
      chip.appendChild(x);
      stagedEl.appendChild(chip);
    });
  }
  // Renders a turn's attachments (images as thumbnails, other files as chips).
  function renderAttachments(container, attachments) {
    if (!attachments || !attachments.length) return;
    var wrap = document.createElement("div");
    wrap.className = "attachments";
    attachments.forEach(function (a) {
      var link = document.createElement("a");
      link.href = blobUrl(a); link.target = "_blank"; link.rel = "noopener noreferrer";
      if (a.kind === "image") {
        link.className = "att img";
        var img = document.createElement("img"); img.src = blobUrl(a); img.alt = a.name; img.loading = "lazy";
        link.appendChild(img);
      } else {
        link.className = "att file"; link.setAttribute("download", a.name);
        var ic = document.createElement("span"); ic.className = "fi"; ic.innerHTML = FILE_SVG; link.appendChild(ic);
        var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = a.name; link.appendChild(nm);
      }
      wrap.appendChild(link);
    });
    container.appendChild(wrap);
  }

  // ---- streaming-markdown rendering --------------------------------------
  // Wrap smd's default renderer to harden URLs. smd never emits raw HTML tags
  // (model text lands in text nodes), so href/src are the only injection
  // vector — we neutralize dangerous schemes and reveal external link targets.
  function makeRenderer(root) {
    var r = smd.default_renderer(root);
    r._stripped = false;
    var base = r.set_attr;
    r.set_attr = function (data, type, value) {
      var out = value;
      if (type === smd.HREF || type === smd.SRC) {
        if (/^\s*(javascript|vbscript|file):/i.test(value)) out = "#";
        else if (/^\s*data:/i.test(value) &&
                 !(type === smd.SRC && /^\s*data:image\//i.test(value))) out = "#";
        if (out !== value) r._stripped = true;
      }
      base(data, type, out);
      if (type === smd.HREF) {
        var node = data.nodes[data.index];
        if (node && node.tagName === "A") {
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer nofollow");
          node.setAttribute("title", out); // spec: show the full URL before navigating
        }
      }
    };
    return r;
  }
  function newParser(root) {
    var renderer = makeRenderer(root);
    return { renderer: renderer, parser: smd.parser(renderer) };
  }
  // Reports whether the renderer had to neutralize a dangerous URL. No HTML
  // sanitizer needed: smd builds the DOM node-by-node and never emits raw tags,
  // so there's no untrusted HTML string to purify — only the href/src the
  // wrapped renderer already guarded.
  function finalize(renderer) { return !!(renderer && renderer._stripped); }
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
    smd.parser_write(np.parser, text);
    smd.parser_end(np.parser);
    enrich(el);
    return finalize(np.renderer);
  }

  // rAF-batched delta flush: models emit faster than the eye needs (spec).
  function scheduleFlush() { if (!flushHandle) flushHandle = requestAnimationFrame(flush); }
  function flush() {
    flushHandle = null;
    var painted = false;
    for (var id in msgs) {
      var r = msgs[id];
      var or = r.activity && r.activity.openReasoning;
      if (or && or.buf) { smd.parser_write(or.parser, or.buf); or.buf = ""; painted = true; updateReasoningPreview(or); }
      var ts = r.textSink;
      if (ts && ts.buf) { smd.parser_write(ts.parser, ts.buf); ts.buf = ""; painted = true; liveMeta(r); }
    }
    if (painted) autoScroll();
  }

  // ---- helpers -----------------------------------------------------------
  function autoScroll() { if (atBottom) scroll.scrollTop = scroll.scrollHeight; }
  // Compact context-window label: 1000000 -> "1M", 1048576 -> "1M", 1500000 -> "1.5M", else "Nk".
  function fmtCtx(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    return Math.round(n / 1000) + "k";
  }
  // Real context fill: the last completed turn's input + output tokens (that's
  // what the provider actually counted, and the baseline the next turn sends).
  function usedTokens(u) {
    if (!u) return null;
    if (u.inputTokens != null || u.outputTokens != null) return (u.inputTokens || 0) + (u.outputTokens || 0);
    if (u.totalTokens != null) return u.totalTokens;
    return null;
  }
  function updateCtx() {
    var used = usedTokens(lastUsage);
    if (!selected || !selected.contextWindow || used == null) { ctx.classList.add("hidden"); return; }
    var pct = Math.max(0, Math.min(100, Math.round((used / selected.contextWindow) * 100)));
    var n = 12, f = Math.round((pct / 100) * n);
    ctxbar.textContent = "▓".repeat(f) + "░".repeat(n - f);
    ctxpct.textContent = pct + "%";
    ctx.classList.remove("hidden");
    ctx.title = used.toLocaleString() + " / " + selected.contextWindow.toLocaleString() + " tokens";
  }
  function updateSend() {
    // One button in the action slot: Stop while a run streams, Send otherwise.
    // Mid-run you still queue by pressing Enter (submit() steers when streaming);
    // the panel above the composer shows what's staged.
    $("stop").style.display = streaming ? "inline-flex" : "none";
    send.style.display = streaming ? "none" : "inline-flex";
    send.innerHTML = SEND;
    // Sendable with text OR staged attachments; blocked while an upload is still
    // in flight (its sha256 isn't known yet, so the ref would be incomplete).
    var has = (input.value.trim().length > 0 || staged.length > 0) && selected && uploadingCount() === 0;
    send.className = "send" + (has ? " ready" : "");
    send.disabled = !has;
    send.setAttribute("aria-label", "Send");
  }
  // While streaming we don't have real token counts yet (the provider reports
  // usage only at the end), so show only measured wall-clock: ttft + elapsed.
  // No estimated token rate — real counts land on message-end.
  function liveMeta(rec) {
    var elapsed = (Date.now() - rec.startedAt) / 1000;
    var ttft = rec.firstDeltaAt ? ((rec.firstDeltaAt - rec.startedAt) / 1000).toFixed(1) + "s ttft · " : "";
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
    lastUsage = null;
    if (flushHandle) { cancelAnimationFrame(flushHandle); flushHandle = null; }
  }
  function makeTurn(who, cls) {
    var t = document.createElement("article");
    t.className = "turn" + (cls ? " " + cls : "");
    t.innerHTML =
      '<div class="label"><span class="who' + (who === "You" ? " user" : "") + '"></span><span class="meta"></span></div>' +
      '<div class="body" aria-live="polite"></div>';
    t.querySelector(".who").textContent = who;
    thread.appendChild(t);
    return t;
  }

  function optimisticUser(content, runId, attachments) {
    var t = makeTurn("You", "pending");
    var body = t.querySelector(".body");
    if (content) renderStaticMd(body, content);
    renderAttachments(body, attachments);
    autoScroll();
    pending[runId] = { turn: t, content: content, attachments: attachments };
  }
  function confirmUser(runId, content, attachments) {
    // A queued steer being promoted by the flush: drop it from the staging
    // panel — it now enters the thread as a real turn (rendered fresh below,
    // the first time it appears there).
    if (queued[runId] !== undefined) { delete queued[runId]; renderQueue(); }
    var p = pending[runId];
    if (p) { p.turn.classList.remove("pending", "failed"); delete pending[runId]; return; }
    // Not ours (history, another device, or a promoted steer): render fresh.
    var t = makeTurn("You");
    var body = t.querySelector(".body");
    if (content) renderStaticMd(body, content);
    renderAttachments(body, attachments);
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
    btn.type = "button"; btn.textContent = "Retry";
    btn.onclick = function () {
      p.turn.remove(); delete pending[runId];
      doSend(p.content, runId, p.attachments);
    };
    fb.appendChild(btn);
    p.turn.querySelector(".body").appendChild(fb);
  }

  function assistantTurn(messageId) {
    if (msgs[messageId]) return msgs[messageId];
    var t = makeTurn("Assistant", "generating");
    var rec = {
      turn: t, body: t.querySelector(".body"), meta: t.querySelector(".meta"),
      // The turn body is an ordered run of segments: answer prose blocks and
      // activity blocks (each a self-contained stepper of thinking + tools).
      // They interleave in arrival order — a run of thinking/tools between two
      // chunks of answer text becomes its own stepper, sitting between them.
      activity: null,           // the currently open activity block (see newActivityBlock)
      proses: [],               // every answer prose block (for the final flush)
      textSink: null,           // the currently open prose { el, parser, renderer, buf }
      toolSteps: null,          // toolCallId -> tool step (carries its block)
      firstReasoning: null,     // first reasoning step of the whole turn (gets the duration)
      firstReasoningBlock: null,
      startedAt: Date.now(), firstDeltaAt: 0,
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
    sum.innerHTML = '<span class="stepicon"></span><span class="steplabel activity-label"></span>' + CHEV;
    var stepper = document.createElement("div");
    stepper.className = "stepper";
    d.appendChild(sum); d.appendChild(stepper);
    rec.body.appendChild(d); // in arrival order, below whatever preceded it
    return {
      details: d, stepper: stepper,
      headIcon: sum.querySelector(".stepicon"), headLabel: sum.querySelector(".activity-label"),
      openReasoning: null, firstReasoning: null, thoughtLabel: "", stepCount: 0,
      tools: [], activeTool: null, // tools: ordered {name, input}; activeTool: the in-flight one
    };
  }
  // The current open activity block. Opening one closes the current prose block
  // (flushing it), so a later text delta starts a fresh prose block below.
  function openActivity(rec) {
    if (rec.textSink) {
      if (rec.textSink.buf) { smd.parser_write(rec.textSink.parser, rec.textSink.buf); rec.textSink.buf = ""; }
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
    return a.tools.filter(function (e) { return e.name === name; });
  }
  // The collapsed header. While a step is live it reflects that step; once the
  // block settles it summarizes the LATEST tool used (last-tool-wins for a mixed
  // block), or the thinking if no tools ran. Per-tool phrasing comes from TOOL_UI.
  function blockHeadState(a) {
    if (a.openReasoning) return { icon: ICON_CLOCK, label: "Thinking", working: true };
    if (a.activeTool) {
      var ui = toolUI(a.activeTool.name);
      return { icon: ui.icon, label: ui.summary(stepsOfTool(a, a.activeTool.name), true, a.activeTool.name), working: true };
    }
    if (a.tools.length) {
      var last = a.tools[a.tools.length - 1];
      var lui = toolUI(last.name);
      return { icon: lui.icon, label: lui.summary(stepsOfTool(a, last.name), false, last.name), working: false };
    }
    if (a.firstReasoning) return { icon: ICON_CLOCK, label: a.thoughtLabel || "Thought", working: false };
    return null;
  }
  function blockUpdateHead(a) {
    var s = blockHeadState(a);
    if (!s) return;
    a.headIcon.innerHTML = s.icon;
    a.headLabel.textContent = s.label;
    a.details.classList.toggle("working", s.working);
  }
  // A stepper row in block `a`. `expandable` rows are <details> (reasoning,
  // tools). Returns the row, its label span, and (if any) its body.
  function makeStepIn(a, cls, icon, expandable) {
    var row, label, body = null;
    if (expandable) {
      row = document.createElement("details");
      row.className = "step " + cls;
      var sum = document.createElement("summary");
      sum.innerHTML = '<span class="stepicon">' + icon + '</span><span class="steplabel"></span>' + CHEV;
      body = document.createElement("div"); body.className = "stepbody";
      row.appendChild(sum); row.appendChild(body);
      label = sum.querySelector(".steplabel");
    } else {
      row = document.createElement("div");
      row.className = "step " + cls;
      row.innerHTML = '<span class="stepicon">' + icon + '</span><span class="steplabel"></span>';
      label = row.querySelector(".steplabel");
    }
    a.stepper.appendChild(row);
    a.details.open = true; // working → reveal the steps
    // A block with one step needs no summarizing header (it would just duplicate
    // that step); the ".single" class hides the header so the lone step stands
    // alone. The header earns its place only once there are multiple steps.
    a.stepCount++;
    a.details.classList.toggle("single", a.stepCount === 1);
    return { row: row, label: label, body: body };
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
    var rr = { row: step.row, label: step.label, body: step.body,
               parser: np.parser, renderer: np.renderer, buf: "", ended: false };
    if (!a.firstReasoning) a.firstReasoning = rr;
    if (!rec.firstReasoning) { rec.firstReasoning = rr; rec.firstReasoningBlock = a; }
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
      if (rr.buf) { smd.parser_write(rr.parser, rr.buf); rr.buf = ""; }
      smd.parser_end(rr.parser); rr.ended = true;
      enrich(rr.body);
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
    rr.label.textContent = reasoningMs != null
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
    var sink = { el: el, parser: np.parser, renderer: np.renderer, buf: "" };
    rec.proses.push(sink);
    rec.textSink = sink;
    autoScroll();
    return sink;
  }
  // Pretty value for a tool's args/result (JSON, or a string as-is).
  function toolValue(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
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
    var step = makeStepIn(a, "tool thinking" + (ui.summaryDom ? " " + data.toolName : ""), ui.icon, true);
    if (ui.summaryDom) {
      // The tool fully owns its summary (custom icon / label / right-side link).
      step.label = ui.summaryDom(step.row.querySelector("summary"), data.input).label;
    } else {
      step.label.textContent = ui.row(data.input, data.toolName);
    }
    // Unknown tools show their raw args (a known tool conveys its input via the
    // row label + a custom result renderer, so args would be redundant there).
    if (ui === DEFAULT_TOOL) {
      var args = toolValue(data.input);
      if (args && args !== "{}") {
        var el = document.createElement("div"); el.className = "targs"; el.textContent = args;
        step.body.appendChild(el);
      }
    }
    var t = { row: step.row, label: step.label, body: step.body, toolName: data.toolName, block: a };
    rec.toolSteps[data.toolCallId] = t;
    var entry = { name: data.toolName, input: data.input };
    a.tools.push(entry);
    a.activeTool = entry;
    blockUpdateHead(a);
    autoScroll();
    return t;
  }
  function toolResult(rec, data) {
    var t = (rec.toolSteps && rec.toolSteps[data.toolCallId]) || toolStep(rec, data);
    t.row.classList.remove("thinking");
    if (data.isError) {
      console.error("[kloe tool error]", data.toolName, data.output);
      t.row.classList.add("errored");
      errorResult(t, data.output); // errors render uniformly for every tool
    } else {
      toolUI(t.toolName).result(t, data.output); // success rendering is per-tool
    }
    t.block.activeTool = null; // this tool finished
    blockUpdateHead(t.block);
    autoScroll();
  }
  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return ""; }
  }
  // Search results as a card: each row a favicon + title + domain, linking out.
  // Puts the result count in the step summary. Favicons load from a public
  // service and hide themselves on error, so a missing icon leaves the row clean.
  function renderSearchResults(t, results) {
    var sum = t.row.querySelector("summary");
    if (sum && !sum.querySelector(".count")) {
      var c = document.createElement("span"); c.className = "count";
      c.textContent = results.length + (results.length === 1 ? " result" : " results");
      sum.insertBefore(c, sum.querySelector(".chev"));
    }
    var card = document.createElement("div"); card.className = "results";
    results.forEach(function (r) {
      var a = document.createElement("a");
      a.className = "result"; a.href = r.url; a.target = "_blank"; a.rel = "noopener noreferrer nofollow";
      var domain = domainOf(r.url);
      var img = document.createElement("img");
      img.className = "favicon"; img.alt = ""; img.loading = "lazy";
      img.src = "https://icons.duckduckgo.com/ip3/" + domain + ".ico";
      img.onerror = function () { img.style.visibility = "hidden"; };
      var title = document.createElement("span"); title.className = "rtitle"; title.textContent = r.title || domain || r.url;
      var dom = document.createElement("span"); dom.className = "rdomain"; dom.textContent = domain;
      a.appendChild(img); a.appendChild(title); a.appendChild(dom);
      card.appendChild(a);
    });
    t.body.appendChild(card);
  }
  // A fetched page: the summary row's label becomes the page title (the hostname
  // link is already in the summary), and the body holds the content.
  function renderFetchResult(t, output) {
    if (output.title && t.label) t.label.textContent = output.title;
    if (output.content) {
      // Only markdown gets prose-rendered; raw text/JSON/XML stays verbatim in a
      // preformatted block, so non-HTML content doesn't get mangled by the parser.
      if (output.format === "text") {
        var pre = document.createElement("div"); pre.className = "tout"; pre.textContent = output.content;
        t.body.appendChild(pre);
      } else {
        renderStaticMd(t.body, output.content);
      }
    }
    if (output.truncated) { var n = document.createElement("div"); n.className = "tnote"; n.textContent = "(truncated)"; t.body.appendChild(n); }
  }
  // Generic result body: the value as text/JSON. `errorResult` is the same, in red.
  function defaultResult(t, output) {
    var out = document.createElement("div"); out.className = "tout"; out.textContent = toolValue(output);
    t.body.appendChild(out);
  }
  function errorResult(t, output) {
    var out = document.createElement("div"); out.className = "tout err"; out.textContent = toolValue(output);
    t.body.appendChild(out);
  }
  // ---- per-tool UI registry ----------------------------------------------
  // How each tool renders: its icon, the step-row label (from the call input),
  // the collapsed-header summary (given this tool's steps in the block + whether
  // it's live), and the success result body. Unknown tools fall back to
  // DEFAULT_TOOL — so a new tool renders sensibly with zero UI code, and gets a
  // nicer treatment by adding one entry here.
  function lastInput(steps) { return steps.length ? steps[steps.length - 1].input || {} : {}; }
  var TOOL_UI = {
    web_search: {
      icon: ICON_GLOBE,
      row: function (input) { return (input && input.query) || "web_search"; },
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
      summaryDom: function (sum, input) {
        var url = (input && input.url) || "";
        var hostName = domainOf(url) || "link";
        sum.innerHTML = "";
        var icon = document.createElement("span"); icon.className = "stepicon";
        var img = document.createElement("img"); img.className = "favicon"; img.alt = ""; img.loading = "lazy";
        img.src = "https://icons.duckduckgo.com/ip3/" + hostName + ".ico";
        img.onerror = function () { icon.innerHTML = ICON_PAGE; }; // no favicon → page icon
        icon.appendChild(img);
        var label = document.createElement("span"); label.className = "steplabel"; label.textContent = hostName;
        var link = document.createElement("a"); link.className = "stephost";
        link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer nofollow";
        var hspan = document.createElement("span"); hspan.textContent = hostName;
        link.appendChild(hspan); link.insertAdjacentHTML("beforeend", ICON_EXT);
        link.addEventListener("click", function (e) { e.stopPropagation(); }); // open the link, don't toggle
        sum.appendChild(icon); sum.appendChild(label); sum.appendChild(link);
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
  };
  var DEFAULT_TOOL = {
    icon: ICON_TOOL,
    row: function (_input, name) { return name; },
    summary: function (steps, active, name) {
      return (active ? "Running " : "Ran ") + name + (steps.length > 1 ? " ×" + steps.length : "");
    },
    result: defaultResult,
  };
  function toolUI(name) { return TOOL_UI[name] || DEFAULT_TOOL; }
  function endAssistant(rec, finishReason, usage, reasoningMs) {
    closeActivity(rec); // finish + collapse any open activity block
    // The server reports one reasoning duration for the turn (start → first
    // answer token); it belongs to the first thinking block. Stamp its step and
    // its block header with "Thought for Ns".
    if (rec.firstReasoning) {
      labelThought(rec.firstReasoning, reasoningMs);
      if (rec.firstReasoningBlock) {
        rec.firstReasoningBlock.thoughtLabel = reasoningMs != null
          ? "Thought for " + Math.max(0, Math.round(reasoningMs / 1000)) + "s" : "Thought";
        blockUpdateHead(rec.firstReasoningBlock);
      }
    }
    // Finalize every answer prose block (the open one plus any an activity block
    // closed): flush remaining text, end the parser, run the completed-block
    // enhancers (code highlight, math).
    var stripped = false;
    for (var i = 0; i < rec.proses.length; i++) {
      var p = rec.proses[i];
      if (p.buf) { smd.parser_write(p.parser, p.buf); p.buf = ""; }
      smd.parser_end(p.parser);
      if (finalize(p.renderer)) stripped = true;
      enrich(p.el);
    }
    rec.turn.classList.remove("generating");
    if (finishReason === "aborted") {
      rec.meta.textContent = "";
      canceledMark(rec.body);
    } else if (finishReason === "error") {
      rec.turn.classList.add("failed"); failbar(rec.body, "generation failed"); rec.meta.textContent = "error";
    } else {
      var elapsed = (Date.now() - rec.startedAt) / 1000;
      var live = elapsed >= 0.3; // actually streamed in this session vs replayed from the log
      var out = usage && usage.outputTokens != null ? usage.outputTokens : null;
      if (out != null && live) {
        var ttft = rec.firstDeltaAt ? ((rec.firstDeltaAt - rec.startedAt) / 1000).toFixed(1) + "s ttft · " : "";
        rec.meta.textContent = ttft + out.toLocaleString() + " tok · " + Math.round(out / elapsed) + " tok/s";
      } else if (out != null) {
        rec.meta.textContent = out.toLocaleString() + " tok"; // replayed: real count, no synthetic rate
      } else if (!live) {
        rec.meta.textContent = "";
      } else {
        liveMeta(rec); // provider reported no usage: fall back to wall-clock
      }
    }
    if (usage) { lastUsage = usage; updateCtx(); }
    if (stripped) failbar(rec.body, "some content was removed by the sanitizer");
  }
  function failbar(bodyEl, msg) {
    if (bodyEl.querySelector(".failbar")) return;
    var fb = document.createElement("div");
    fb.className = "failbar"; fb.textContent = msg;
    bodyEl.appendChild(fb);
  }
  // Italic "canceled" under a stopped turn. As a block it sits on its own line
  // below whatever text streamed; when nothing streamed it's the only child, so
  // the :not(:first-child) margin drops out and there's no leading blank line.
  function canceledMark(bodyEl) {
    if (bodyEl.querySelector(".canceled")) return; // idempotent across replays
    var el = document.createElement("div");
    el.className = "canceled"; el.textContent = "canceled";
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
      case "tool-result":
        toolResult(assistantTurn(data.messageId), data);
        break;
      case "text-delta": {
        var rec = assistantTurn(data.messageId);
        var sink = openText(rec); // ends any open thinking; collapses the stepper
        if (!rec.firstDeltaAt) rec.firstDeltaAt = Date.now();
        sink.buf += data.delta;
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
        if (la) { la.turn.classList.add("failed"); failbar(la.body, String(data.error || "run error")); la.meta.textContent = "error"; }
        updateSend();
        break;
      }
      case "run-started":
      case "cancelled":
        break;
    }
  }

  // ---- SSE stream --------------------------------------------------------
  var connTimer = null;
  var SSE_EVENTS = ["user-message", "queued-message", "queued-cancelled", "run-started",
    "message-start", "reasoning-delta", "tool-call", "tool-result", "text-delta",
    "message-end", "run-error", "cancelled"];

  // Open a conversation: batch-load the whole history in ONE request and render
  // it in a single pass (far faster than streaming the entire log back over SSE,
  // especially over a tunnel), then open the live SSE stream for only the events
  // after what we already have. The history events reconstruct the steer queue
  // on their own, so no separate fetch is needed.
  function openStream(id) {
    if (source) { source.close(); source = null; }
    if (connTimer) { clearTimeout(connTimer); connTimer = null; }
    clearThread();
    convId = id;
    atBottom = true; // a freshly opened conversation should land at the end
    void loadHistoryThenStream(id);
  }
  async function loadHistoryThenStream(id) {
    var lastId = null;
    try {
      var res = await fetch("/api/conversations/" + encodeURIComponent(id) + "/events");
      if (convId !== id) return; // switched conversations while loading
      var events = await res.json();
      if (convId !== id) return;
      if (Array.isArray(events) && events.length) {
        for (var i = 0; i < events.length; i++) applyEvent(events[i].event, events[i].data);
        if (flushHandle) { cancelAnimationFrame(flushHandle); flushHandle = null; }
        flush(); // render any buffered deltas now (completed turns already rendered on message-end)
        scroll.scrollTop = scroll.scrollHeight;
        lastId = events[events.length - 1].id;
      }
    } catch (_) { /* fall through: the stream (no ?after) replays from the start */ }
    if (convId !== id) return;
    connectStream(id, lastId);
  }
  function connectStream(id, afterId) {
    var url = "/api/conversations/" + encodeURIComponent(id) + "/stream";
    if (afterId) url += "?after=" + encodeURIComponent(afterId); // only the tail after the batch
    var es = new EventSource(url);
    source = es;
    SSE_EVENTS.forEach(function (nm) {
      es.addEventListener(nm, function (ev) {
        var data; try { data = JSON.parse(ev.data); } catch (_) { return; }
        applyEvent(nm, data);
      });
    });
    es.onopen = function () { setConn("connected"); };
    es.onerror = function () {
      // readyState 2 (CLOSED) is terminal; 0 (CONNECTING) is the browser already
      // auto-reconnecting — usually done within a second. Only surface
      // "reconnecting" if the gap actually lingers, so a quick reconnect doesn't
      // flash the header. (On reconnect the browser sends Last-Event-ID, which
      // the server prefers over the initial ?after cursor.)
      if (es.readyState === 2) { setConn("offline"); return; }
      if (!connTimer) connTimer = setTimeout(function () { connTimer = null; setConn("reconnecting"); }, 1500);
    };
  }
  function setConn(s) {
    if (s === "connected" && connTimer) { clearTimeout(connTimer); connTimer = null; }
    status.dataset.state = s;
    conn.textContent = s === "reconnecting" ? "reconnecting…" : s;
  }

  // ---- composer / sending ------------------------------------------------
  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.44) + "px";
  }
  function submit() {
    var content = input.value.trim();
    // Sendable with text or attachments; nothing to send if both are empty.
    if ((!content && staged.length === 0) || !selected || uploadingCount() > 0) return;
    var attachments = staged.map(attachmentRef);
    input.value = ""; autosize(); clearStaged();
    var runId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    // While a run is in flight the message joins the steer queue; otherwise it
    // starts a run.
    if (streaming) { doSteer(content, runId, attachments); return; }
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
    streaming = true; updateSend(); // job is queued + cancellable even pre-first-token
    try {
      var res = await fetch("/api/conversations/" + encodeURIComponent(convId) + "/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyFor(content, runId, attachments),
      });
      if (!res.ok) {
        streaming = false; updateSend();
        var err = await res.json().catch(function () { return {}; });
        failUser(runId);
        if (err.error) console.warn("prompt rejected:", err.error);
        return;
      }
      if (wasNew && content) { title.textContent = content.slice(0, 80); setDocTitle(content.slice(0, 80)); setTimeout(loadConversations, 400); }
    } catch (e) {
      streaming = false; updateSend();
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
        var err = await res.json().catch(function () { return {}; });
        if (queued[runId] !== undefined) { delete queued[runId]; renderQueue(); }
        if (err.error) console.warn("steer rejected:", err.error);
      }
    } catch (e) {
      if (queued[runId] !== undefined) { delete queued[runId]; renderQueue(); }
    }
  }
  // Remove a still-pending steer. Optimistic: drop it locally now, then DELETE;
  // the queued-cancelled echo keeps other devices in sync (idempotent here).
  async function cancelSteer(runId) {
    delete queued[runId]; renderQueue();
    try {
      await fetch("/api/conversations/" + encodeURIComponent(convId) + "/steer/" + encodeURIComponent(runId),
        { method: "DELETE" });
    } catch (e) { /* the panel already reflects the removal */ }
  }
  function stop() {
    if (!streaming) return;
    // Acknowledge the click immediately: leave the streaming state and mark the
    // live turn "stopping…" rather than waiting for the aborted message-end to
    // round-trip. endAssistant reconciles to the final "stopped" when it lands.
    streaming = false; updateSend();
    var rec = lastAssistant();
    if (rec && rec.turn.classList.contains("generating")) {
      rec.turn.classList.remove("generating");
      rec.meta.textContent = "stopping…";
    }
    fetch("/api/conversations/" + encodeURIComponent(convId) + "/cancel", { method: "POST" }).catch(function () {});
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
      x.type = "button"; x.className = "qx"; x.setAttribute("aria-label", "Remove from queue"); x.textContent = "×";
      x.onclick = function () { cancelSteer(runId); };
      li.appendChild(x);
      queueItems.appendChild(li);
    });
  }

  // ---- conversation rail -------------------------------------------------
  // The sidebar (recents list, nav, collapse/overlay toggle) is shared with the
  // Conversations page; this page just tells it how to open/create a chat.
  var conversations = [];
  var dialogs = mountDialogs();
  var sidebar = mountSidebar({
    onSelect: function (id, t) { selectConversation(id, t); },
    onNew: function () { newConversation(); },
    activeId: function () { return convId; },
    dialogs: dialogs,
    reload: function () { loadConversations(); },
  });
  function hasConversation(id) { return conversations.some(function (c) { return c.id === id; }); }
  async function loadConversations() {
    try {
      var res = await fetch("/api/conversations");
      conversations = (await res.json()).conversations || [];
    } catch (_) { conversations = []; }
    sidebar.render(conversations);
  }
  // Browser tab: "<conversation> - Kloe" once a conversation has a title, else
  // just "Kloe".
  function setDocTitle(t) { document.title = t ? t + " - Kloe" : "Kloe"; }
  function selectConversation(id, t) { title.textContent = t || "Conversation"; setDocTitle(t); openStream(id); sidebar.render(conversations); }
  function newConversation() {
    var id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    title.textContent = "New conversation"; setDocTitle(null);
    openStream(id); sidebar.render(conversations); sidebar.closeRail(); input.focus();
  }

  // ---- model picker ------------------------------------------------------
  async function loadModels() {
    try { models = (await (await fetch("/api/models/chat")).json()).models || []; }
    catch (_) { models = []; }
    var saved = localStorage.getItem("kloe.model");
    selected = models.find(function (m) { return m.ref === saved; }) || models[0] || null;
    renderPicker(); renderPill(); updateSend(); updateCtx();
  }
  function renderPill() {
    pill.disabled = models.length === 0;
    pillModel.textContent = selected ? selected.name : (models.length ? "Select model" : "No models");
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
      b.className = "opt"; b.type = "button"; b.setAttribute("role", "option");
      if (selected && m.ref === selected.ref) b.setAttribute("aria-selected", "true");
      var sub = [];
      if (m.contextWindow) sub.push(fmtCtx(m.contextWindow) + " ctx");
      if (m.reasoningLevels && m.reasoningLevels.length) sub.push("reasoning");
      if (m.supportsImages) sub.push("images");
      b.innerHTML = '<div class="name"></div>' + (sub.length ? '<div class="sub">' + sub.join(" · ") + "</div>" : "");
      b.querySelector(".name").textContent = m.name;
      b.onclick = function () {
        selected = m; localStorage.setItem("kloe.model", m.ref);
        renderPill(); renderPicker(); updateSend(); updateCtx(); closePicker();
      };
      picker.appendChild(b);
    });
  }
  function openPicker() { picker.hidden = false; pill.setAttribute("aria-expanded", "true"); }
  function closePicker() { picker.hidden = true; pill.setAttribute("aria-expanded", "false"); }

  // ---- wiring ------------------------------------------------------------
  composer.addEventListener("submit", function (e) { e.preventDefault(); submit(); });
  input.addEventListener("input", function () { autosize(); updateSend(); });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  $("stop").addEventListener("click", function () { if (streaming) stop(); });

  // Attachments: a hidden file input behind the paperclip, plus drag-drop onto
  // the composer and image paste from the clipboard. All routes funnel to
  // stageFiles → upload → staged tray.
  var fileInput = document.createElement("input");
  fileInput.type = "file"; fileInput.multiple = true; fileInput.style.display = "none";
  document.body.appendChild(fileInput);
  attachBtn.addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () { stageFiles(fileInput.files); fileInput.value = ""; });
  composer.addEventListener("dragover", function (e) { e.preventDefault(); composer.classList.add("drop"); });
  composer.addEventListener("dragleave", function (e) {
    if (e.target === composer || !composer.contains(e.relatedTarget)) composer.classList.remove("drop");
  });
  composer.addEventListener("drop", function (e) {
    e.preventDefault(); composer.classList.remove("drop");
    if (e.dataTransfer && e.dataTransfer.files) stageFiles(e.dataTransfer.files);
  });
  input.addEventListener("paste", function (e) {
    var items = e.clipboardData && e.clipboardData.files;
    if (items && items.length) { e.preventDefault(); stageFiles(items); }
  });
  pill.addEventListener("click", function () { if (picker.hidden) openPicker(); else closePicker(); });
  document.addEventListener("click", function (e) {
    if (!picker.hidden && !picker.contains(e.target) && e.target !== pill && !pill.contains(e.target)) closePicker();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePicker(); });
  scroll.addEventListener("scroll", function () {
    atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
    jump.style.display = atBottom ? "none" : "block";
  });
  jump.addEventListener("click", function () { atBottom = true; jump.style.display = "none"; scroll.scrollTop = scroll.scrollHeight; });
  // Keep the view pinned to the bottom while `atBottom` as the thread grows —
  // opening a large conversation, async enrich (code/math), and images all add
  // height AFTER the last scroll, which otherwise leaves us short of the end.
  if (window.ResizeObserver) {
    new ResizeObserver(function () { if (atBottom) scroll.scrollTop = scroll.scrollHeight; }).observe(thread);
  }

  // ---- boot --------------------------------------------------------------
  (async function init() {
    // Fire the auth check and the data loads together so /api/me doesn't add a
    // serial round-trip to every page load. If unauthenticated we redirect (the
    // loads may 401 harmlessly as we navigate away).
    var mePromise = requireAuth();
    var dataPromise = Promise.all([loadModels(), loadConversations()]);
    var me = await mePromise;
    if (!me) return; // redirecting to login
    setPfp(me);
    await dataPromise;
    // Deep links from the conversations page: ?new starts fresh, ?c=<id> opens
    // a specific conversation. Strip the query afterward so a reload is clean.
    var params = new URLSearchParams(location.search);
    if (params.has("new")) {
      newConversation();
      history.replaceState(null, "", "/");
    } else if (params.get("c")) {
      var id = params.get("c");
      var c = conversations.find(function (x) { return x.id === id; });
      selectConversation(id, c ? c.title : null);
      history.replaceState(null, "", "/");
    } else if (conversations.length) {
      selectConversation(conversations[0].id, conversations[0].title);
    } else {
      newConversation();
    }
    updateSend();
  })();
})();
