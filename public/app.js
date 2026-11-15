/* app.js — opencode-web UI logic.
 *
 * Talks to the real OpenCode server through the bridge (same origin /oc/*).
 *
 * Protocol (proven against opencode 1.19.4):
 *   POST /oc/session?directory=DIR                     -> create session
 *   POST /oc/session/{id}/prompt_async?directory=DIR   -> send prompt (204)
 *   GET  /oc/global/event                              -> SSE event stream
 *   GET  /oc/session/{id}/message?directory=DIR        -> full history
 *   GET  /oc/session?directory=DIR&roots=true&limit=55 -> session list
 *   GET  /oc/config/providers?directory=DIR            -> models
 *   POST /oc/session/{id}/abort                        -> stop generation
 *   POST /oc/session/{id}/permissions/{permissionID}   -> reply to permission
 */

const qs = (s) => document.querySelector(s);

const state = {
  // ocw.dir2: fresh key so the light workspace becomes the default once
  // (the old saved "Desktop" choice was the reason deepseek kept overflowing)
  dir: localStorage.getItem("ocw.dir2") || "/home/amit/oc-web",
  model: JSON.parse(localStorage.getItem("ocw.model") || "null"),
  sessionID: null,
  tts: localStorage.getItem("ocw.tts") === "1",
  busy: false,
  messages: new Map(), // messageID -> {role, parts: Map(partID -> part), error}
  spoken: new Set(),   // assistant messageIDs already read aloud
  titles: {},          // sessionID -> known title
  titleOrigin: {},     // sessionID -> "auto" | "user" | "server"
  freeModels: [],      // every free opencode model we may switch to
  lastUserText: "",    // what to replay when a model gets rate-limited
  fallback: { tried: new Set(), busy: false },
};

/* ── tiny fetch helpers ─────────────────────────────────── */

async function api(path, opts = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `/oc${path}${opts.noDir ? "" : sep + "directory=" + encodeURIComponent(state.dir)}`;
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} -> ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* ── boot ───────────────────────────────────────────────── */

init().catch((e) => console.error(e));

async function init() {
  bindUI();
  connectEvents();
  await loadProjects();
  await loadModels();
  // small-context free models only fit the light workspace — say it where it matters
  qs("#sel-model").title = "deepseek / iceman / beam / flint need the 'Web · light' workspace (MCP tools are too big for them)";
  qs("#sel-project").title = "Web · light = all free models · Desktop/Home = every tool, big-context models only";
  await loadSessions();
  await openSession(localStorage.getItem("ocw.session." + state.dir) || null, true);
}

function bindUI() {
  qs("#chk-tts").checked = state.tts;
  qs("#chk-tts").onchange = (e) => {
    state.tts = e.target.checked;
    localStorage.setItem("ocw.tts", state.tts ? "1" : "0");
    if (!state.tts) stopSpeaking();
  };

  qs("#btn-new").onclick = () => { closeSidebar(); newSession(); };
  qs("#btn-send").onclick = sendCurrent;
  qs("#input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
  });
  qs("#input").addEventListener("input", () => { autoGrow(); updateSendEnabled(); });

  // suggestion chips on the empty state
  document.querySelectorAll(".chip").forEach((c) => {
    c.onclick = () => send(c.textContent);
  });

  qs("#sel-project").onchange = async (e) => {
    state.dir = e.target.value;
    localStorage.setItem("ocw.dir2", state.dir);
    clearChat();
    await loadSessions();
    await openSession(localStorage.getItem("ocw.session." + state.dir) || null, true);
  };
  qs("#sel-model").onchange = (e) => {
    state.model = JSON.parse(e.target.value);
    localStorage.setItem("ocw.model", JSON.stringify(state.model));
    state.fallback.tried.clear(); // a manual pick gets a fresh fallback budget
  };

  // mobile drawer
  qs("#btn-menu").onclick = () => openSidebar();
  qs("#btn-close-side").onclick = closeSidebar;
  qs("#backdrop").onclick = closeSidebar;

  setupMic();
  setupSpeech();
  updateSendEnabled();
}

/* ── mobile sidebar drawer ──────────────────────────────── */

function openSidebar() { qs("#sidebar").classList.add("open"); qs("#backdrop").classList.add("show"); }
function closeSidebar() { qs("#sidebar").classList.remove("open"); qs("#backdrop").classList.remove("show"); }

/* ── projects & models ──────────────────────────────────── */

async function loadProjects() {
  const sel = qs("#sel-project");
  // "light" workspace disables the 13 MCP servers via its project config —
  // free models with small context windows (deepseek, iceman…) only fit there
  const projects = [
    ["/home/amit/oc-web", "Web · light (free models)"],
    ["/home/amit/Desktop", "Desktop (full tools)"],
    ["/home/amit", "Home (full tools)"],
  ];
  sel.innerHTML = "";
  for (const [d, n] of projects) {
    const el = document.createElement("option");
    el.value = d;
    el.textContent = n;
    if (d === state.dir) el.selected = true;
    sel.appendChild(el);
  }
}

async function loadModels() {
  try {
    const cfg = await api("/config/providers");
    const sel = qs("#sel-model");
    sel.innerHTML = "";

    if (!state.model) {
      const d = cfg.default || {};
      state.model = { providerID: "opencode", modelID: d.opencode || "big-pickle" };
      localStorage.setItem("ocw.model", JSON.stringify(state.model));
    }
    const saved = JSON.stringify(state.model);
    const savedKnown = (cfg.providers || []).some(
      (p) => p.id === state.model.providerID && (p.models || {})[state.model.modelID]
    );

    const addOpt = (m, label, group) => {
      const el = document.createElement("option");
      el.value = JSON.stringify(m);          // set as DOM property: JSON-safe
      el.textContent = label;
      if (JSON.stringify(m) === saved) el.selected = true;
      group.appendChild(el);
    };

    // ── group 1: opencode's free models (the star of the show)
    const oc = (cfg.providers || []).find((p) => p.id === "opencode");
    if (oc) {
      // remember them: if the picked one hits the free-tier cap we hop to the next
      state.freeModels = Object.keys(oc.models || {});
      const g = document.createElement("optgroup");
      g.label = "⚡ OpenCode · free models";
      for (const id of Object.keys(oc.models || {})) {
        addOpt({ providerID: "opencode", modelID: id }, id, g);
      }
      sel.appendChild(g);
    }

    // ── group 2: every other provider, its default model
    const others = (cfg.providers || []).filter((p) => p.id !== "opencode");
    if (others.length) {
      const g = document.createElement("optgroup");
      g.label = "Other providers";
      for (const p of others) {
        const modelID = cfg.default?.[p.id] || Object.keys(p.models || {})[0];
        if (!modelID) continue;
        addOpt({ providerID: p.id, modelID }, `${p.id} / ${modelID}`, g);
      }
      sel.appendChild(g);
    }

    // restore a saved pick that isn't in the lists
    if (!savedKnown && !sel.value) {
      const g = sel.querySelector("optgroup");
      addOpt(state.model, `${state.model.providerID} / ${state.model.modelID}`, g);
      sel.value = saved;
    }
  } catch (e) {
    console.error("loadModels", e);
  }
}

/* ── sessions ───────────────────────────────────────────── */

async function loadSessions() {
  const list = qs("#sessions");
  list.innerHTML = "";
  try {
    const sessions = await api(`/session?roots=true&limit=55`);
    const items = Array.isArray(sessions) ? sessions : sessions.data || [];
    items
      .filter((s) => !s.parentID)
      .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
      .forEach((s) => {
        state.titles[s.id] = s.title || "New chat";
        const el = document.createElement("div");
        el.className = "session-item";
        el.innerHTML = `<span class="s-title">${escapeHTML(s.title || "New chat")}</span><button class="s-menu" title="Options">⋯</button>`;
        el.dataset.sid = s.id;
        el.onclick = (e) => {
          if (e.target.closest(".s-menu")) { openSessionMenu(e, s); return; }
          closeSidebar();
          openSession(s.id);
        };
        list.appendChild(el);
      });
    markActive();
  } catch (e) {
    console.error("loadSessions", e);
  }
}

function markActive() {
  document.querySelectorAll(".session-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.sid === state.sessionID);
  });
}

function clearChat() {
  state.sessionID = null;
  state.status = null;
  state.lastUserText = "";
  state.fallback.tried.clear();
  state.messages.clear();
  qs("#messages").innerHTML = "";
  qs("#banner-slot").innerHTML = "";
  qs("#perm-slot").innerHTML = "";
  updateEmpty();
}

function updateEmpty() {
  qs("#empty").style.display = state.messages.size ? "none" : "";
}

async function newSession() {
  clearChat();
  try {
    const res = await api("/session", { method: "POST", body: { title: "New chat" } });
    const s = res.info || res.data || res;
    state.sessionID = s.id;
    localStorage.setItem("ocw.session." + state.dir, s.id);
    await loadSessions();
    markActive();
  } catch (e) {
    console.error(e);
  }
}

async function openSession(sid, silentFail) {
  clearChat();
  if (!sid) return;
  try {
    state.sessionID = sid;
    localStorage.setItem("ocw.session." + state.dir, sid);
    const msgs = await api(`/session/${sid}/message?limit=100`);
    const items = Array.isArray(msgs) ? msgs : msgs.data || [];
    items.forEach((m) => ingestMessage(m));
    // pick up an in-flight status (e.g. provider retry) that streamed before we opened
    try {
      const st = await api(`/session/status`);
      const mine = st?.[sid] || null;
      if (mine && mine.type && mine.type !== "idle") { state.status = mine; renderStatus(); }
    } catch { /* optional */ }
    renderAll();
    markActive();
    scrollDown(true);
  } catch (e) {
    if (!silentFail) console.error(e);
  }
}

/* ── sending ────────────────────────────────────────────── */

function sendCurrent() {
  const input = qs("#input");
  const text = input.value.trim();
  if (!text || state.busy) return;
  send(text);
  input.value = "";
  autoGrow();
  updateSendEnabled();
}

async function send(text, opts = {}) {
  stopSpeaking();
  if (!state.sessionID) await newSession();
  if (!state.sessionID) return;
  // a fresh user message starts a new fallback budget; a replay keeps it
  if (!opts.replay) {
    state.fallback.tried.clear();
    state.lastUserText = text;
  }
  // auto-title: first question names the chat in the sidebar
  autoTitle(state.sessionID, text);
  state.busy = true;
  updateSendBtn();
  try {
    await api(`/session/${state.sessionID}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text }], model: state.model, agent: "build" },
    });
    // 204 = accepted; content arrives over the event stream
  } catch (e) {
    console.error(e);
    state.busy = false;
    updateSendBtn();
    addSystemNote("Failed to send: " + e.message);
  }
}

/* ── free-tier limit → hop to another free model ──────────
 * The free models share one account-wide allowance, so any of them can
 * answer "Free usage exceeded · retry at HH:MM". Instead of leaving the
 * user stuck, we stop the run and replay the same message on the next
 * free model. Guarded so it can never loop forever. */

const LIMIT_RE = /free usage|usage limit|rate limit|quota|too many requests|\b429\b/i;

function isLimitStatus(s) {
  if (!s) return false;
  const text = (s.message || "") + " " + (s.type || "");
  return LIMIT_RE.test(text);
}

function setModel(m) {
  state.model = m;
  localStorage.setItem("ocw.model", JSON.stringify(m));
  const sel = qs("#sel-model");
  if (sel) {
    const want = JSON.stringify(m);
    const hit = [...sel.options].find((o) => o.value === want);
    if (hit) sel.value = want;
  }
}

function nextFreeModel() {
  const cur = state.model?.modelID;
  const pool = state.freeModels.filter(
    (id) => id !== cur && !state.fallback.tried.has(id)
  );
  return pool.length ? { providerID: "opencode", modelID: pool[0] } : null;
}

async function tryFallback(status) {
  if (state.fallback.busy) return;
  if (!isLimitStatus(status)) return;
  if (state.model?.providerID !== "opencode") return; // not a free model — leave it alone
  if (!state.lastUserText) return;

  state.fallback.tried.add(state.model.modelID);
  const next = nextFreeModel();
  const when = status.next
    ? new Date(status.next).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

  if (!next) {
    addSystemNote(
      `⏳ Every free model is rate-limited right now${when ? ` — retry at ${when}` : ""}. ` +
        `Pick another provider in the model menu, or subscribe to OpenCode Go.`
    );
    return;
  }

  state.fallback.busy = true;
  const from = state.model.modelID;
  try {
    await abort();                       // stop the limping run first
    await new Promise((r) => setTimeout(r, 600));
    dropFailedAttempt();                 // hide the rate-limit error card
    setModel(next);
    addSystemNote(`⚡ ${from} hit the free usage cap — retried on ${next.modelID}`);
    state.busy = false;
    await send(state.lastUserText, { replay: true });
  } finally {
    state.fallback.busy = false;
  }
}

// remove assistant bubbles that ended in an error (the rate-limited attempt)
function dropFailedAttempt() {
  for (const [mid, msg] of [...state.messages.entries()]) {
    if (msg.role !== "user" && msg.error) {
      state.messages.delete(mid);
      const el = qs(`#messages [data-mid="${mid}"]`);
      if (el) el.remove();
    }
  }
}

async function abort() {
  if (!state.sessionID) return;
  try { await api(`/session/${state.sessionID}/abort`, { method: "POST", body: {} }); } catch (e) { console.error(e); }
}

function updateSendEnabled() {
  const b = qs("#btn-send");
  if (state.busy) return; // stop-mode styling handles it
  b.disabled = !qs("#input").value.trim();
}

function updateSendBtn() {
  const b = qs("#btn-send");
  if (state.busy) {
    b.textContent = "■";
    b.classList.add("stop");
    b.disabled = false;
    b.title = "Stop";
    b.onclick = abort;
  } else {
    b.textContent = "➤";
    b.classList.remove("stop");
    b.disabled = !qs("#input").value.trim();
    b.title = "Send";
    b.onclick = sendCurrent;
  }
}

/* ── event stream ───────────────────────────────────────── */

function connectEvents() {
  const es = new EventSource("/oc/global/event");
  es.onopen = () => setConn("live", true);
  es.onerror = () => setConn("reconnecting…", false);
  es.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch { return; }
    const p = d.payload || {};
    const props = p.properties || {};
    const type = p.type || "";
    if (!props.sessionID || props.sessionID !== state.sessionID) return;

    if (type === "message.updated") ingestMessageInfo(props.info);
    else if (type === "message.part.updated") ingestPart(props.part);
    else if (type.startsWith("permission")) handlePermission(p, props);
    else if (type === "session.status") handleStatus(props);
    else if (type === "session.updated") syncServerTitle(props);
    else if (type === "session.idle") onIdle();
    renderAll();
  };
}

function setConn(text, ok) {
  const el = qs("#conn");
  el.innerHTML = `<i class="dot"></i>${text}`;
  el.className = "conn " + (ok ? "ok" : "down");
}

/* ── message state ──────────────────────────────────────── */

function ingestMessage(m) {           // from history: {info, parts}
  if (m.info) ingestMessageInfo(m.info);
  (m.parts || []).forEach(ingestPart);
}

function ingestMessageInfo(info) {
  if (!info || !info.id) return;
  const msg = state.messages.get(info.id) || { parts: new Map() };
  msg.role = info.role;
  if (info.time?.created) msg.time = info.time;
  if (info.error && info.error.name) msg.error = info.error;
  state.messages.set(info.id, msg);

  // some failures arrive only as a message error (no session.status event)
  if (info.error && !state.status && state.busy && state.lastUserText) {
    const text = info.error.data?.message || info.error.name || "";
    tryFallback({ type: "error", message: text }).catch((e) => console.error("fallback", e));
  }
}

function ingestPart(part) {
  if (!part || !part.messageID) return;
  const msg = state.messages.get(part.messageID) || { parts: new Map() };
  if (!msg.role) msg.role = part.type === "text" ? "user" : "assistant";
  state.messages.set(part.messageID, msg);
  const pid = part.id || part.callID || Math.random().toString(36).slice(2);
  msg.parts.set(pid, part);
}

/* ── rendering ──────────────────────────────────────────── */

function renderAll() {
  const box = qs("#messages");
  [...state.messages.keys()].forEach((mid) => {
    const msg = state.messages.get(mid);
    let el = box.querySelector(`[data-mid="${mid}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "msg";
      el.dataset.mid = mid;
      box.appendChild(el);
    }
    el.classList.toggle("user", msg.role === "user");
    el.classList.toggle("assistant", msg.role !== "user");
    const who = msg.role === "user" ? "You" : "opencode";

    // streaming caret on the last assistant bubble while the agent works
    const isLastAssistant =
      state.busy && msg.role !== "user" && [...state.messages.keys()].pop() === mid;
    const caret = isLastAssistant ? '<span class="caret"></span>' : "";

    const partsHTML = [...msg.parts.values()].map(renderPart).join("");
    const errHTML = msg.error
      ? `<details class="tool"><summary><span class="tstatus">❌</span> <b>${escapeHTML(msg.error.name)}</b><span class="tarrow">▸</span></summary><pre>${escapeHTML(msg.error.data?.message || JSON.stringify(msg.error))}</pre></details>`
      : "";

    // footer: how long the response took + copy button (assistant only)
    const footer =
      msg.role === "user"
        ? ""
        : `<div class="msg-foot">${timeChipHTML(mid)}<button class="msg-copy" data-copy-msg="${mid}" title="Copy reply">⧉ copy</button></div>`;

    // what follows the parts: error card > caret (still working) > thinking (no parts yet)
    const tail = errHTML || caret;
    const placeholder = partsHTML || msg.role === "user" ? "" : '<span class="thinking pulse">thinking…</span>';
    const body = msg.role === "user"
      ? escapeHTML([...msg.parts.values()].filter((p) => p.type === "text").map((p) => p.text || "").join("\n"))
      : partsHTML;
    el.innerHTML = `<div class="who">${who}</div><div class="bubble">${body}${tail || placeholder}</div>${footer}`;

    // markdown + code + math go in after the DOM exists (assistant text parts)
    if (msg.role !== "user") {
      const texts = [...msg.parts.values()].filter((p) => p.type === "text" && p.text);
      el.querySelectorAll(".md").forEach((div, i) => renderRich(div, texts[i]?.text || ""));
    }
  });
  box.querySelectorAll("[data-mid]").forEach((el) => {
    if (!state.messages.has(el.dataset.mid)) el.remove();
  });
  updateEmpty();
  scrollDown();
}

/* ── markdown rendering (marked + purify + hljs + katex) ── */

function renderRich(container, markdownText) {
  let html;
  let md = markdownText || "";
  // models often emit display math as bare [ … ] lines; normalize to $$
  md = md
    .replace(/^[ \t]*\\\[([ \t]*)$/gm, "$$")
    .replace(/^[ \t]*\\\]([ \t]*)$/gm, "$$")
    .replace(/^[ \t]*\[([ \t]*)$/gm, "$$")
    .replace(/^[ \t]*\]([ \t]*)$/gm, "$$");
  try {
    html = marked.parse(md);
    html = DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
  } catch {
    container.textContent = markdownText; // fallback: plain text
    return;
  }
  container.innerHTML = html;

  // syntax highlighting + copy button on every code block
  container.querySelectorAll("pre > code").forEach((code) => {
    try { hljs.highlightElement(code); } catch {}
    const pre = code.parentElement;
    pre.classList.add("codeblock");
    const btn = document.createElement("button");
    btn.className = "code-copy";
    btn.textContent = "Copy";
    btn.onclick = () => {
      navigator.clipboard.writeText(code.textContent).then(() => {
        btn.textContent = "Copied ✓";
        setTimeout(() => (btn.textContent = "Copy"), 1400);
      });
    };
    pre.appendChild(btn);
  });

  // math: $...$ inline, $$...$$ / \[...] display
  if (window.renderMathInElement) {
    try {
      renderMathInElement(container, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "\\(", right: "\\)", display: false },
          { left: "$", right: "$", display: false },
        ],
        throwOnError: false,
      });
    } catch {}
  }

  // open external links in a new tab
  container.querySelectorAll("a[href]").forEach((a) => {
    a.target = "_blank";
    a.rel = "noopener";
  });
}

/* ── response timing (how long the agent took) ──────────── */

function fmtDuration(ms) {
  if (ms < 1000) return (ms / 100).toFixed(1) + "s"; // <1s shows tenths
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function timeChipHTML(mid) {
  const msg = state.messages.get(mid);
  if (!msg || msg.role === "user" || !msg.time?.created) return "";
  const done = msg.time.completed;
  const ms = (done || Date.now()) - msg.time.created;
  return `<div class="time-chip" data-live="${done ? "" : mid}">⚡ ${fmtDuration(Math.max(0, ms))}${done ? "" : "…"}</div>`;
}

// live-update unfinished timers twice a second
setInterval(() => {
  document.querySelectorAll("[data-live]").forEach((el) => {
    const mid = el.dataset.live;
    const msg = state.messages.get(mid);
    if (!msg || !msg.time?.created) return;
    el.textContent = `⚡ ${fmtDuration(Math.max(0, Date.now() - msg.time.created))}…`;
  });
}, 500);

const HIDDEN_PARTS = ["reasoning", "step-start", "step-finish", "compaction", "patch"];

function renderPart(p) {
  if (HIDDEN_PARTS.includes(p.type)) return "";
  if (p.type === "text") {
    // user text is escaped plain; assistant text is markdown → rendered post-insert
    return '<div class="md"></div>';
  }
  // generic tool part
  const tool = p.tool || p.type;
  const st = p.state || {};
  const statusIcon = st.status === "completed" ? "✅" : st.status === "error" ? "❌" : "⏳";
  const preview = st.input?.command || st.input?.filePath || st.input?.description || "";
  const input = st.input ? JSON.stringify(st.input, null, 1) : "";
  const output = (st.output || st.error || "").toString();
  const body = [input && "input:\n" + input, output && "output:\n" + output.slice(0, 3000)]
    .filter(Boolean).join("\n\n");
  return `<details class="tool">
    <summary><span class="tstatus">${statusIcon}</span><span class="tname">${escapeHTML(tool)}</span>
    ${preview ? `<span style="color:var(--text-faint);font-family:var(--mono);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px">${escapeHTML(String(preview).slice(0, 60))}</span>` : ""}
    <span class="tarrow">▸</span></summary>
    <pre>${escapeHTML(body || "…")}</pre></details>`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function scrollDown(force) {
  const chat = qs("#chat");
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160;
  if (force || nearBottom) chat.scrollTop = chat.scrollHeight;
}

function addSystemNote(text) {
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="who">opencode</div><div class="bubble"><em>${escapeHTML(text)}</em></div>`;
  qs("#messages").appendChild(el);
  scrollDown(true);
}

/* ── session status (retry / provider limits) ───────────── */

function handleStatus(props) {
  state.status = props.status || null;
  renderStatus();
  // a free-tier cap here would leave the chat dead — hop to the next free model
  if (state.status) tryFallback(state.status).catch((e) => console.error("fallback", e));
}

function renderStatus() {
  const slot = qs("#banner-slot");
  const s = state.status;
  if (!s) { slot.innerHTML = ""; return; }
  const isRetry = s.type === "retry";
  const when = s.next ? new Date(s.next).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  slot.innerHTML = `<div class="perm"><div class="perm-inner" style="border-color:${isRetry ? "var(--warn-line)" : "rgba(248,113,113,0.4)"}">
    <span class="ptext">${isRetry ? "⏳" : "❌"} ${escapeHTML(s.message || s.type)}${when ? ` · retry at ${when}` : ""}</span>
    <button class="stop-run">Stop</button></div></div>`;
  slot.querySelector(".stop-run").onclick = abort;
}

/* ── idle → TTS ─────────────────────────────────────────── */

function onIdle() {
  state.busy = false;
  state.status = null;
  renderStatus();
  updateSendBtn();
  if (!state.tts) return;
  const ids = [...state.messages.entries()].reverse();
  for (const [mid, msg] of ids) {
    if (msg.role !== "user" && !state.spoken.has(mid)) {
      const text = [...msg.parts.values()]
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text)
        .join(" ");
      state.spoken.add(mid);
      if (text.trim()) speak(text);
      break;
    }
  }
}

/* ── speech synthesis (reply readout) ───────────────────── */

function setupSpeech() {
  const ind = qs("#tts-indicator");
  ind.onclick = stopSpeaking;
  if (!("speechSynthesis" in window)) return;
  // keep the little equalizer honest
  setInterval(() => {
    ind.hidden = !speechSynthesis.speaking;
  }, 400);
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  stopSpeaking();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-IN";
  speechSynthesis.speak(u);
}

function stopSpeaking() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

/* ── speech recognition (mic → orb → text → send) ───────── */

let recognition = null;

function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = qs("#btn-mic");
  const overlay = qs("#voice-overlay");
  if (!SR) {
    btn.title = "Voice input needs Chrome/Edge";
    btn.onclick = () => { qs("#mic-status").textContent = "Voice input needs Chrome or Edge (Web Speech API)."; };
    return;
  }

  btn.onclick = () => {
    if (recognition) { recognition.stop(); return; }
    recognition = new SR();
    recognition.lang = "en-IN";
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onstart = () => {
      btn.classList.add("listening");
      overlay.hidden = false;
      qs("#voice-text").textContent = "Listening…";
      const st = qs("#mic-status");
      st.textContent = "listening…";
      st.className = "listening";
    };
    recognition.onresult = (e) => {
      let final = "";
      let interim = "";
      for (const r of e.results) (r.isFinal ? (final += r[0].transcript) : (interim += r[0].transcript));
      const t = (final + interim).trim();
      qs("#input").value = t;
      qs("#voice-text").textContent = t || "Listening…";
      autoGrow();
      updateSendEnabled();
    };
    recognition.onerror = (e) => {
      qs("#mic-status").textContent = "mic error: " + e.error;
    };
    recognition.onend = () => {
      recognition = null;
      btn.classList.remove("listening");
      overlay.hidden = true;
      const st = qs("#mic-status");
      st.textContent = "";
      st.className = "";
      const text = qs("#input").value.trim();
      if (text) send(text), (qs("#input").value = ""), autoGrow(), updateSendEnabled(); // heard something → send it
    };
    recognition.start();
  };

  // tap the overlay anywhere to stop listening
  overlay.onclick = () => { if (recognition) recognition.stop(); };
}

/* ── permissions ────────────────────────────────────────── */

function handlePermission(payload, props) {
  const pid = props.id || props.requestID || props.permission?.id;
  const title = props.title || props.action || props.permission?.title || "permission requested";
  if (!pid) return;
  const slot = qs("#perm-slot");
  if (slot.querySelector(`[data-pid="${pid}"]`)) return;
  const el = document.createElement("div");
  el.className = "perm";
  el.dataset.pid = pid;
  el.innerHTML = `<div class="perm-inner"><span class="ptext">⚠️ ${escapeHTML(title)}</span>
    <button class="allow">Allow once</button>
    <button data-r="always">Always</button>
    <button data-r="reject">Reject</button></div>`;
  el.querySelector(".allow").onclick = () => replyPermission(pid, "once", el);
  el.querySelectorAll("[data-r]").forEach((b) => {
    b.onclick = () => replyPermission(pid, b.dataset.r === "always" ? "always" : "reject", el);
  });
  slot.appendChild(el);
  scrollDown(true);
}

async function replyPermission(pid, response, el) {
  try {
    await api(`/session/${state.sessionID}/permissions/${pid}`, { method: "POST", body: { response } });
  } catch (e) { console.error(e); }
  el.remove();
}

/* ── auto-title from the first question ─────────────────── */

// the agent may generate its own (nicer) title later — adopt it unless renamed manually
function syncServerTitle(props) {
  const info = props.info || props.session || props;
  const title = info?.title;
  if (!title || props.sessionID !== state.sessionID) return;
  if (state.titleOrigin[props.sessionID] === "user") return;
  if (title === "New chat" || title === state.titles[props.sessionID]) return;
  state.titles[props.sessionID] = title;
  state.titleOrigin[props.sessionID] = "server";
  updateSidebarTitle(props.sessionID, title);
}

function autoTitle(sid, question) {
  const current = state.titles[sid];
  const origin = state.titleOrigin[sid];
  if (origin === "user") return;                    // never overwrite a manual rename
  if (current && current !== "New chat" && origin !== "auto") return;
  const title = question.replace(/\s+/g, " ").trim().slice(0, 48) || "New chat";
  state.titles[sid] = title;
  state.titleOrigin[sid] = "auto";
  updateSidebarTitle(sid, title);
  api(`/session/${sid}`, { method: "PATCH", body: { title } }).catch(() => {});
}

function updateSidebarTitle(sid, title) {
  const item = document.querySelector(`.session-item[data-sid="${sid}"] .s-title`);
  if (item) item.textContent = title;
}

/* ── session menu (rename / delete) ─────────────────────── */

function openSessionMenu(e, session) {
  closeSessionMenu();
  const btn = e.target.closest(".s-menu");
  const rect = btn.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "session-menu";
  menu.innerHTML = `
    <button data-act="rename">✏️ Rename</button>
    <button data-act="delete" class="danger">🗑 Delete</button>`;
  menu.style.top = rect.bottom + 4 + "px";
  menu.style.left = Math.min(rect.left, window.innerWidth - 170) + "px";
  document.body.appendChild(menu);

  menu.querySelector('[data-act="rename"]').onclick = () => {
    closeSessionMenu();
    const item = btn.closest(".session-item");
    inlineRename(item, session);
  };
  menu.querySelector('[data-act="delete"]').onclick = async () => {
    closeSessionMenu();
    btn.closest(".session-item").remove();
    try { await api(`/session/${session.id}`, { method: "DELETE", body: {} }); } catch (err) { console.error(err); }
    if (session.id === state.sessionID) { clearChat(); state.sessionID = null; }
    loadSessions();
  };
}

function closeSessionMenu() {
  document.querySelectorAll(".session-menu").forEach((m) => m.remove());
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".session-menu") && !e.target.closest(".s-menu")) closeSessionMenu();
});

function inlineRename(item, session) {
  const span = item.querySelector(".s-title");
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = span.textContent;
  span.replaceWith(input);
  input.focus();
  input.select();
  const commit = async () => {
    const title = input.value.trim() || "New chat";
    state.titles[session.id] = title;
    state.titleOrigin[session.id] = "user";
    try { await api(`/session/${session.id}`, { method: "PATCH", body: { title } }); } catch (err) { console.error(err); }
    span.textContent = title;
    input.replaceWith(span);
    loadSessions();
  };
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") input.blur();
    if (ev.key === "Escape") { input.value = session.title || ""; input.blur(); }
  };
  input.onblur = commit;
}

/* ── copy whole reply (event delegation on the chat) ────── */
// Copies the RENDERED reply: rich HTML (keeps bold/lists/tables when pasting
// into Gmail/Docs/WhatsApp) + a clean plain-text fallback without markdown
// symbols like ** or `.

function replyRichParts(mid) {
  const el = document.querySelector(`.msg[data-mid="${mid}"]`);
  if (!el) return null;
  const mds = [...el.querySelectorAll(".md")];
  if (!mds.length) return null;
  const holder = document.createElement("div");
  mds.forEach((md, i) => {
    if (i) holder.appendChild(document.createElement("br"));
    [...md.childNodes].forEach((n) => holder.appendChild(n.cloneNode(true)));
  });
  // plain version from the rendered DOM: no **, no backticks — just clean text.
  // KaTeX renders each formula twice (visual span + hidden MathML); keep only
  // the MathML text so copied math stays readable.
  const plainSource = document.createElement("div");
  mds.forEach((md, i) => {
    if (i) plainSource.appendChild(document.createElement("p"));
    plainSource.appendChild(md.cloneNode(true));
  });
  plainSource.querySelectorAll(".katex").forEach((k) => {
    const ml = k.querySelector("annotation[encoding='application/x-tex']") || k.querySelector(".katex-mathml");
    if (ml) k.replaceWith(document.createTextNode(ml.textContent || ""));
  });
  const plain = plainSource.innerText.replace(/\n{3,}/g, "\n\n").trim();
  return { html: holder.innerHTML, plain };
}

qs("#messages").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy-msg]");
  if (!btn) return;
  const parts = replyRichParts(btn.dataset.copyMsg);
  if (!parts) return;
  const done = () => {
    btn.textContent = "✓ copied";
    setTimeout(() => (btn.textContent = "⧉ copy"), 1400);
  };
  if (window.ClipboardItem && navigator.clipboard.write) {
    navigator.clipboard
      .write(new ClipboardItem({
        "text/html": new Blob([parts.html], { type: "text/html" }),
        "text/plain": new Blob([parts.plain], { type: "text/plain" }),
      }))
      .then(done)
      .catch(() => navigator.clipboard.writeText(parts.plain).then(done));
  } else {
    navigator.clipboard.writeText(parts.plain).then(done);
  }
});

/* ── misc ───────────────────────────────────────────────── */

function autoGrow() {
  const input = qs("#input");
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
}
