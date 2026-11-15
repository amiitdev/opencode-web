# opencode-web — your terminal AI agent, in the browser

A ChatGPT-style web UI for **OpenCode**. It is not a chatbot copy — it is
the **real OpenCode agent** running on your laptop: same tools, same
models, same memory. The browser page is only the face; the muscle stays
on your machine.

This README explains **how this project was built, step by step, from
zero** — how the bridge works, how the API was discovered, and every
problem that came up and how it was solved.

## What it looks like

```
┌──────────────────────┐      ┌───────────────────┐      ┌─────────────────────────┐
│  Browser (Chrome)    │      │  bridge.js        │      │  OpenCode server        │
│  ChatGPT-style UI    │ ───► │  port 5175        │ ───► │  port 4321              │
│  mic 🎤 + speaker 🔊 │      │  70 lines of Node │      │  THE real agent:        │
│  tool cards, markdown│ ◄─── │  static + /oc/*   │ ◄─── │  tools, models, sessions│
└──────────────────────┘      └───────────────────┘      └─────────────────────────┘
        the face                    the glue                   the brain (laptop)
```

- The brain never leaves the laptop. The browser talks only to `localhost`.
- No cloud service, no API keys in the app, no build step, no `npm install`.

## Run it

```bash
cd ~/Desktop/opencode-web
./start.sh          # starts opencode server (4321) + bridge (5175)
# open http://127.0.0.1:5175/ in Chrome
```

| Process | Port | Log |
|---|---|---|
| `opencode web --port 4321` | 4321 | `/tmp/opencode-server.log` |
| `node bridge.js` | 5175 | `/tmp/opencode-bridge.log` |

## Files

| File | What it does |
|---|---|
| `bridge.js` | serves `public/` + proxies `/oc/*` → OpenCode server |
| `public/index.html` | the page: sidebar, chat, composer, voice overlay |
| `public/style.css` | dark-only theme, mobile responsive, animations |
| `public/app.js` | all logic: sessions, streaming, markdown, voice, menus |
| `public/vendor/` | marked + DOMPurify + highlight.js + KaTeX (self-contained) |
| `screenshots/` | real screenshots from working runs |

## Step 0 — The discovery that made everything possible

OpenCode (the terminal tool) is **not one program — it is two**:

```
┌──────────────┐         ┌──────────────────────┐
│  TUI         │ ──────► │  background SERVER   │
│  (terminal)  │  HTTP   │  the real agent      │
│  just a face │         │  sessions, tools,    │
└──────────────┘         │  models, permissions │
                         └──────────────────────┘
```

The terminal UI you type in is **only a client**. The real agent runs in
a background server. Any client can talk to that server — a terminal, a
desktop app, or **a web page in your browser**.

OpenCode even ships the API docs: start a server and open
`http://127.0.0.1:4321/doc` → a full OpenAPI spec. The goal of this
project: build my own client for that server, with a ChatGPT-like face
and voice.

## Step 1 — Discovering the protocol (by probing the live server)

No guessing — the running server was probed with `curl` until the real
protocol was clear. What works (opencode 1.19.4):

| Purpose | Call |
|---|---|
| Create session | `POST /session?directory=DIR` → session id |
| Send a prompt | `POST /session/{id}/prompt_async` body `{parts:[{type:"text",text}], model:{providerID,modelID}, agent:"build"}` → 204 |
| Live stream | `GET /global/event` (SSE) — envelope `{directory, payload:{type, properties}}` |
| History | `GET /session/{id}/message?limit=100` |
| Session list | `GET /session?directory=DIR&roots=true&limit=55` |
| Models | `GET /config/providers?directory=DIR` → `{providers, default}` |
| Stop | `POST /session/{id}/abort` |
| Permission | `POST /session/{id}/permissions/{permissionID}` `{response:"once"\|"always"\|"reject"}` |
| Rename | `PATCH /session/{id}` `{title}` |
| Delete | `DELETE /session/{id}` |

Stream events used by the UI (filtered by `properties.sessionID`):

| Event | Used for |
|---|---|
| `message.updated` | learn a message's role, timing, errors |
| `message.part.updated` | full part snapshot: text / tool state |
| `session.status` | provider limits & retries (the amber banner) |
| `session.updated` | agent-generated chat titles |
| `session.idle` | generation finished → release stop button, trigger TTS |
| `permission.*` | Allow once / Always / Reject banner |

Gotcha found here: this build's *new* `/api/session/{id}/prompt` route is
broken (`SQLiteError: no such table: session_input`), so the app uses the
same **legacy** endpoints the official web UI uses — proven by capturing
the official UI's own network traffic with Playwright.

## Step 2 — The bridge (`bridge.js`, ~70 lines, zero dependencies)

### Why a bridge exists at all

The page lives on `http://127.0.0.1:5175` and the agent lives on
`http://127.0.0.1:4321`. Different ports = different origins = **CORS**
blocks browser requests. The bridge fixes this by making the page
same-origin: everything the page calls goes through its own server.

```
browser                bridge.js                    opencode server
  │  GET /                    │                            │
  │ ─────────────────────────►│  serve public/index.html   │
  │  GET /oc/session/abc      │                            │
  │ ─────────────────────────►│  rewrite → /session/abc    │
  │                           │ ──────────────────────────►│
  │                           │  ◄─────── response ────────│
  │  ◄───── same response ────│                            │
```

### The three jobs of `bridge.js`

1. **Serve static files** — `GET /` returns `public/index.html`, `/style.css`,
   `/app.js`, `/vendor/*`. It refuses paths that escape the `public/` folder
   (path-traversal protection).

2. **Proxy `/oc/*`** — any request starting with `/oc/` has the prefix
   stripped and is forwarded to the OpenCode server:
   `/oc/session/abc` → `http://127.0.0.1:4321/session/abc`.
   Method, body and query string are preserved.

3. **Stream untouched** — the response is piped straight through
   (`ur.pipe(res)`), so Server-Sent Events arrive chunk-by-chunk as the
   agent works. No buffering, no waiting for the whole reply.

That's the whole bridge. The browser has **no CORS, no auth headers, no
secrets** — it only ever talks to `127.0.0.1:5175`.

## Step 3 — The UI (`index.html` + `style.css` + `app.js`)

### One-time boot sequence (`init()`)

```
bindUI()          → buttons, keys, mic, toggles
connectEvents()   → one EventSource on /oc/global/event (SSE)
loadProjects()    → 3 workspaces in the dropdown
loadModels()      → free models first, then other providers
loadSessions()    → sidebar list from GET /session
openSession()     → history from GET /session/{id}/message
```

### Sending a message

```
type → Enter
  ├─ autoTitle()     first question renames the chat in the sidebar
  ├─ POST /oc/session/{id}/prompt_async  → 204 (accepted)
  └─ renderAll() waits — content arrives over the SSE stream
```

### Receiving (the interesting part)

The UI keeps `state.messages` — a map of `messageID → {role, parts}`.
Every `message.part.updated` event upserts a **full snapshot** of a part
(text, tool call, state). `renderAll()` then rebuilds the chat from that
map: user bubble, markdown reply, tool cards, error cards, timing chip,
footer buttons. Simple, and fast enough at this scale.

While the agent works: red **■ stop** button, blinking **caret**, live
**⚡ timer** counting up until `session.idle` freezes it.

### Tool cards

Tool parts render as `<details>` with ✅/⏳/❌ status, the tool name
(`bash`, `write`, …), a one-line preview, and the expandable input/output.

### Permissions

If the agent asks for permission (event `permission.*`), an amber banner
offers **Allow once / Always / Reject** → `POST …/permissions/{id}`.

## Step 4 — Voice 🎭

| Direction | Tech | How |
|---|---|---|
| You → agent | Web Speech API (`SpeechRecognition`) | press 🎤 → full-screen **orb overlay** (pulsing rings + wave bars), live transcript, auto-sends when you stop talking, tap anywhere to stop |
| Agent → you | `speechSynthesis` | toggle "Speak replies" → each new reply is read aloud (en-IN), equalizer indicator, tap to stop |

Both are **native browser APIs** — no API keys, no cloud voice service.
Works in Chrome/Edge; other browsers get a graceful "needs Chrome" note.

## Step 5 — Rich replies (markdown, code, math, copy)

Libraries are **vendored** in `public/vendor/` (downloaded once, committed,
works offline): marked + DOMPurify + highlight.js + KaTeX.

Pipeline for each assistant text part:

```
raw markdown
  → normalize bare [ … ] display-math lines to $$
  → marked.parse()          markdown → HTML
  → DOMPurify.sanitize()    XSS safety
  → insert into bubble
  → hljs.highlightElement() syntax colors per code block
  → add Copy button on each code block
  → renderMathInElement()   KaTeX ($$, $, \[ \])
```

**Copy reply (⧉)** writes both flavors at once:

- `text/html` — the rendered HTML → pasting into Gmail/Docs/WhatsApp keeps
  bold, lists, tables
- `text/plain` — clean text built from the **rendered DOM** → no `**`, no
  backticks, real line breaks; KaTeX math replaced by its accessible text

The ⚡ timing chip shows `message.time.completed - message.time.created`
per reply (live while streaming, frozen when done).

## Step 6 — The hard problem: ContextOverflowError on free models

**Symptom:** deepseek worked in the terminal (19,446 tokens) but every
fresh browser session failed with `ContextOverflowError`.

**Evidence gathering:**

1. Inspected the failing session's messages → iceman's upstream error said
   **"Input token count (320,561)"** for a single "hey".
2. Reproduced in a fresh session → failed in *both* `~/` and `~/Desktop`,
   so it wasn't the directory.
3. Probed `~/.config/opencode/opencode.json` → **13 MCP servers enabled**
   (rea 207 tools, vercel 250, github 46, playwright 25, …) ≈ 640 tool
   schemas ≈ **+300K tokens injected into every request**.
4. The terminal's working session simply **predates the MCP setup** — that
   was the whole difference.
5. Proof: started a throwaway server with the same config but MCP
   disabled → the identical request passed the context check instantly.

**Solution — workspace picker:**

| Workspace | Directory | MCP tools | Best for |
|---|---|---|---|
| **Web · light (free models)** ← default | `/home/amit/oc-web` | disabled by its own `opencode.json` | ALL free models incl. deepseek/iceman |
| Desktop (full tools) | `/home/amit/Desktop` | enabled | tasks needing playwright/vercel/rea… → use mimo/longcat/nemotron |
| Home (full tools) | `/home/amit` | enabled | same as Desktop |

The terminal config is **never touched** — the light workspace is an
isolated folder with its own config that disables MCP. Default lives under
a fresh localStorage key so existing browsers switch once automatically.

**Also:** opencode's *free-tier quota* is separate from context. It is
**one allowance per account shared by every free model**, and the gateway
refuses free models when the call does not come from OpenCode itself
(`Free-tier chat models require OpenCode` — a plain `curl` with the same
token gets `FreeUsageLimitError` even while the app is answering fine).

### The "Free usage exceeded · retry at 05:39" wall — solved

When one free model hits the cap, the chat used to be dead until the
window refilled. Now the app fixes it itself:

```
user sends                    free model answers "Free usage exceeded"
   │                                        │
   │                                        ▼
   │                         session.status {type:"retry"}
   │                                        │
   ▼                                        ▼
abort the limping run  ──►  pick the next free model  ──►  replay the
                                                            same message
   │
   └─► chat note: "⚡ deepseek-v4.1-flash-free hit the free usage cap
                    — retried on big-pickle"
```

| Detail | Behaviour |
|---|---|
| Detection | `session.status` retry **or** an error part matching `free usage / usage limit / rate limit / quota / 429` |
| Scope | only `opencode/*` free models (paid/other providers are left alone) |
| Budget | each model is tried once; a manual pick from the dropdown resets the budget |
| Exhausted | honest note: *every free model is rate-limited — retry at HH:MM*, with the Go link |

Proof (`screenshots/16-free-model-auto-fallback.png`): a real run where
`deepseek-v4.1-flash-free` was rate-limited, the app switched to
`big-pickle` and answered the same question 4.4 s later — no user action.

A note on **why the terminal kept working**: free-tier limits are counted
per model, so a terminal session on another free model still had room while
the browser's pick was capped. Nothing was broken in the bridge — the app
just needed to stop depending on a single model.

## Feature checklist (all verified with real runs)

- Real agent: same tools/models/memory as the terminal, runs on this laptop
- Streaming replies, red stop button, blinking caret, live ⚡ timers
- Tool cards (✅/⏳/❌), Allow/Deny permission banner
- 12 free models grouped first in the picker; model + workspace persist
- Sidebar: auto-title from first question, ⋯ menu → rename / delete
- Markdown: tables, lists, links; syntax-highlighted code + Copy buttons
- KaTeX math; rich-text + plain-text copy of any reply
- Voice: 🎤 orb overlay with live transcript (sends on silence), 🔊 read-aloud
- Provider limits / retries as amber banner (never a silent hang)
- **Auto-fallback**: a rate-limited free model is swapped for the next one and
  the message replayed automatically (no dead chat, no manual retry)
- Dark-only theme, mobile responsive (drawer sidebar, safe-area padding)
- `prefers-reduced-motion` respected

## Security

The OpenCode server can execute commands on the laptop, so:

- Everything binds **127.0.0.1 only** — never expose 4321/5175 to LAN/internet
  without setting `OPENCODE_SERVER_PASSWORD` first.
- The bridge proxies everything; the page itself holds no secrets.
- Model output is sanitized with DOMPurify before rendering.

## Known limits

- History loads the last 100 messages; messages re-render as full snapshots
  (fine at this scale; `message.part.delta` streaming could optimize it).
- No file/image attachments, no `/commands`, no `@mentions` yet.
- Voice needs Chrome/Edge (Web Speech API).
- The opencode 1.19.4 `/api/*` prompt + event routes are broken upstream
  (missing SQLite table) — this app uses the proven legacy routes.

## Screenshots

`screenshots/` — real runs: UI, streaming, tool proof on disk, markdown
+ code + table, KaTeX math, session menu, auto-title, mobile views,
quota banner, light-workspace success.

---

Made by [amiitdev](https://github.com/amiitdev) — built by probing a live
OpenCode server one `curl` at a time.
