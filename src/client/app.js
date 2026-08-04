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
      if (r.buf) { smd.parser_write(r.parser, r.buf); r.buf = ""; painted = true; liveMeta(r); }
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
    var body = t.querySelector(".body");
    var prose = proseBlock(body); // deltas stream into this block
    var np = newParser(prose);
    var rec = {
      turn: t, body: body, prose: prose, meta: t.querySelector(".meta"),
      parser: np.parser, renderer: np.renderer, buf: "",
      startedAt: Date.now(), firstDeltaAt: 0,
    };
    msgs[messageId] = rec;
    autoScroll();
    return rec;
  }
  function endAssistant(rec, finishReason, usage) {
    if (rec.buf) { smd.parser_write(rec.parser, rec.buf); rec.buf = ""; }
    smd.parser_end(rec.parser);
    var stripped = finalize(rec.renderer);
    enrich(rec.prose); // completed turn: highlight code, render math
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
      case "text-delta": {
        var rec = assistantTurn(data.messageId);
        if (!rec.firstDeltaAt) rec.firstDeltaAt = Date.now();
        rec.buf += data.delta;
        scheduleFlush();
        break;
      }
      case "message-end": {
        streaming = false;
        var r = msgs[data.messageId];
        if (r) endAssistant(r, data.finishReason, data.usage);
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
  function openStream(id) {
    if (source) { source.close(); source = null; }
    if (connTimer) { clearTimeout(connTimer); connTimer = null; }
    clearThread();
    convId = id;
    // The stream replays from seq 0 on a fresh EventSource, so the queued-message
    // events reconstruct the steer queue on their own — no separate fetch needed.
    var es = new EventSource("/api/conversations/" + encodeURIComponent(id) + "/stream");
    source = es;
    ["user-message", "queued-message", "queued-cancelled", "run-started", "message-start",
     "text-delta", "message-end", "run-error", "cancelled"].forEach(function (nm) {
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
      // flash the header.
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

  // ---- boot --------------------------------------------------------------
  (async function init() {
    await Promise.all([loadModels(), loadConversations()]);
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
