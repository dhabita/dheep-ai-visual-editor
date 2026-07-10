<div align="center">

# 🎨 Dheep AI Visual Editor

### Edit any website visually from your browser — click an element, chat with AI, and watch your local source files update in real time.

A lightweight, open-source **AI visual editor** and **vibe-coding** tool. Point at any element on your running site, describe the change in plain language, and **Claude Code** edits the actual source file on your machine — then the page hot-reloads instantly. **No API key required** (it uses your existing Claude CLI login).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/dhabita/dheep-ai-visual-editor/pulls)
[![Stars](https://img.shields.io/github/stars/dhabita/dheep-ai-visual-editor?style=social)](https://github.com/dhabita/dheep-ai-visual-editor/stargazers)

</div>

<!-- Add a demo GIF here once recorded:  ![demo](docs/demo.gif)  -->

```
 ┌─────────────────────────┐     click element + chat      ┌──────────────────────┐
 │   Your site in browser  │ ────────────────────────────▶ │  Local editor server │
 │  (sidebar chat overlay) │                                │   (Express + SSE)    │
 │            ▲            │                                └──────────┬───────────┘
 │            │ hot-reload │                                   spawns  │
 │            │            │                                           ▼
 │            │            │                                ┌──────────────────────┐
 │            └────────────┼──── WebSocket "reload" ◀────── │  Claude Code CLI      │
 └─────────────────────────┘     chokidar watches files     │  reads & edits files  │
                                                             └──────────────────────┘
```

---

## Table of contents

- [Why this exists](#why-this-exists)
- [Features](#features)
- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Using the chat sidebar](#using-the-chat-sidebar)
- [Live dashboard](#live-dashboard)
- [Multiple projects at once](#multiple-projects-at-once)
- [Add it to your own project](#add-it-to-your-own-project)
- [Configuration](#configuration)
- [API reference](#api-reference)
- [Project structure](#project-structure)
- [Security](#security)
- [FAQ & troubleshooting](#faq--troubleshooting)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Why this exists

Most "edit your site with AI" tools are cloud platforms that own your code. **Dheep AI Visual Editor runs entirely on your machine** and edits *your* real files in *your* repo, with *your* framework. It's the missing bridge between a live page in the browser and an AI coding agent on your laptop:

- **Designers & founders** can change copy, colors, and layout by pointing and describing — no CSS knowledge needed.
- **Developers** get a fast feedback loop: click → describe → done, without leaving the browser or hunting for the right file.

It's local-first, framework-agnostic, and free to run if you already have a Claude subscription.

## Features

- 🖱️ **Click-to-edit overlay** — Figma-style blue highlight on hover; click any element to target it.
- 💬 **Chat sidebar (vibe coding)** — a docked AI chat panel right on your page, with streaming responses and a persistent conversation.
- 🧠 **Powered by Claude Code** — the AI edits real source files with its own `Read`/`Edit`/`Write` tools.
- 🎯 **Smart source discovery** — before Claude even starts, the server pre-searches your project for the clicked element (its text, id, classes, and framework dev-source hints) and hands Claude ranked candidate files with line numbers, so it edits the right file on the first try.
- 🔑 **No API key needed** — uses your local `claude` CLI login (subscription), so nothing is billed per token by this tool and no secrets are stored.
- ⚡ **Instant hot reload** — `chokidar` watches your files and reloads the browser the moment a change lands.
- 💾 **Persistent chat & context** — the conversation, session, and attached element survive page/hot reloads (saved per project in `localStorage`); reloads are deferred until a task finishes so nothing is lost mid-stream.
- 📊 **Context meter & auto-compaction** — a live meter shows how full the Claude conversation context is (tokens, %, cost); the CLI auto-compacts large conversations and the sidebar flags it with a `🗜 context auto-compacted` line.
- 🗂️ **Multi-project** — one server edits many projects in different folders, in parallel, each isolated.
- 🧩 **Framework-agnostic** — plain HTML, Vite, Next.js, React (CRA), Astro, SvelteKit, Nuxt, and more. Drop in one `<script>` tag (dev only).
- 🪶 **Tiny & dependency-light** — a small Express server and a single injected JS bundle. No build step.
- 🔒 **Local-first & private** — your code never leaves your machine.

## How it works

1. You open your site in the browser with a one-line overlay `<script>` (dev only).
2. The overlay renders a **chat sidebar**. You type a request (optionally after clicking an element to attach it as context).
3. The browser sends the request to the local server (`POST /task`) over **Server-Sent Events**. The overlay attaches rich element context: distinctive text, ancestor chain, attributes, computed styles, and — in dev builds of React/Svelte/Vue — the exact source file and line.
4. The server **pre-searches** the project for that element (matching its text, id, and classes; utility classes like Tailwind's are automatically demoted) and detects the framework and styling system from `package.json`. The top candidate files, with line numbers, go into the prompt.
5. The server spawns the **Claude Code CLI** in headless mode with your project as the working directory:

   ```bash
   claude -p "<your request + element context>" \
     --output-format stream-json --verbose \
     --model sonnet --permission-mode acceptEdits \
     --allowedTools Read Edit Write MultiEdit Glob Grep \
     --append-system-prompt "<editing rules>"
   ```

6. Claude reads and edits the real files. The server streams its progress back into the sidebar.
7. `chokidar` detects the file change and tells the browser to reload over WebSocket. **You see the change immediately.**

The conversation continues across messages (the server resumes the same Claude session), so follow-ups like *"now make it bigger"* just work.

## Prerequisites

- **Node.js 18+**
- **[Claude Code CLI](https://docs.claude.com/en/docs/claude-code)** installed and logged in. Verify:
  ```bash
  claude --version    # prints a version
  claude -p "say hi"  # responds → you're logged in
  ```

> No `ANTHROPIC_API_KEY` is required — editing runs through your Claude CLI login.

## Quick start

```bash
# 1. Clone & install
git clone https://github.com/dhabita/dheep-ai-visual-editor.git
cd dheep-ai-visual-editor
npm install

# 2. Configure (no API key needed)
cp .env.example .env
cp projects.example.json projects.json   # optional: for multiple projects

# 3. Run the editor server
npm start

# 4. In another terminal, serve the bundled demo site
npx serve -l 5050 ./example-site
```

Open **http://localhost:5050**, and the AI chat sidebar appears on the right. Type *"make the hero background a dark gradient"* and hit Enter. 🎉

Open **http://localhost:3000** (or your `SERVER_PORT`) for the **live dashboard** — see [Live dashboard](#live-dashboard).

## Using the chat sidebar

- The **sidebar** appears automatically when the editor server is online (a floating ✦ button reopens it if minimized).
- **Just chat** — describe any change to the whole page and send.
- **Target an element** — click **◎** in the sidebar (or press **Ctrl+Shift+E**), hover (blue highlight), then click the element. Its selector attaches as a chip to your next message.
- **Keep the thread going** — say *"now center it"* or *"undo that"*; the session remembers context.
- **History survives reloads** — when the page hot-reloads after an edit, the chat and attached context are restored from `localStorage`.
- **Multiple chats per project** — hit **＋** to start a new chat with a fresh Claude context (useful when the context meter fills up), and open the **🕘** history menu to switch between past chats or delete them permanently.
- Status dot shows server/CLI health; each message streams Claude's tool activity (`› Read`, `✎ edited styles.css`) and a summary.
- **Context meter** (above the input) shows how full the conversation context is — e.g. `context 78% · 156k/200k · $0.420` — turning amber past 70% and red past 90%. When the CLI auto-compacts a long conversation, a `🗜 context auto-compacted` line appears. Hit **⌫** to start fresh if you want a smaller context.

## Live dashboard

Open the server root (e.g. `http://localhost:3000`) for a real-time control panel that shows **exactly what the AI is doing**:

- **Live activity** — every running `claude` task as an animated card: project, prompt, a ticking elapsed timer, the current step, a streaming step log (`Read`, `✎ edited …`, `🗜 compacted`), edited-file chips, and a context-usage meter — updated live.
- **KPI cards** — active tasks, total tasks, files edited, session cost, and tokens (with a sparkline).
- **Activity chart** — tasks per minute (inline SVG).
- **Projects** — each registered project with its path, task/edit counts, last-used time, the **detected dev-server port** with a live up/down status, and an **Open ↗** button to launch the running site in a new tab. (The port is detected automatically from the project page's overlay connection; the server TCP-probes it for status.)
- **Recent tasks** — a timeline of completed tasks with summaries and edited files, plus toasts for starts/finishes, file changes, and auto-registered projects.

It streams over Server-Sent Events (`GET /events`) — no polling. The feed reflects edits triggered from any browser or project.

## Multiple projects at once

One server can edit several projects in different folders **simultaneously**. Register them in `projects.json`:

```json
{
  "nimbus": "./example-site",
  "shop":   "../my-shop",
  "blog":   "/absolute/path/to/your/site"
}
```

Each page declares which project it belongs to via `?project=<id>`:

```html
<script src="http://localhost:3000/overlay.js?project=shop"></script>
```

- The id picks the **working directory** for that task's `claude` process.
- Each task is its own subprocess, so **edits in different projects run in parallel**.
- Hot reload is **per project** — a change in `shop` only reloads shop tabs.
- `GET /projects` lists what's registered; `GET /history?project=shop` filters history.

If `projects.json` is absent, the server falls back to the single `PROJECT_ROOT` in `.env`.

### Zero-config: new projects register themselves

You usually don't need to edit `projects.json` at all. When an overlay loads with a `?project=<id>` the server hasn't seen, it **auto-discovers** a folder named `<id>` under its **workspace roots** (default: the folder containing this editor repo, e.g. `~/Documents/GitHub`), registers it live (starts watching + persists), and uses it — **no manual edit, no restart**.

So adding the editor to a new project is just: inject the overlay `<script ...?project=<folder-name>>` (see [`prompt.md`](./prompt.md)) and open it. As long as the folder name matches the id and lives under a workspace root, it just works.

- Set `WORKSPACE_ROOTS` (comma/colon-separated) to search more places: `WORKSPACE_ROOTS=~/Documents/GitHub,~/work`.
- For a project **outside** the workspace roots, register it explicitly: `POST /register { "id", "root" }` (the root must be inside `ALLOWED_PROJECT_ROOTS`, which defaults to the workspace roots).

## Add it to your own project

Want to use it on an existing app? Two options:

**1. One `<script>` tag (dev only)** — add before `</body>`:

```html
<script src="http://localhost:3000/overlay.js?project=my-app"></script>
```

**2. Bookmarklet (no HTML edits)** — make a bookmark with:

```
javascript:(function(){var s=document.createElement('script');s.src='http://localhost:3000/overlay.js?project=my-app&t='+Date.now();document.body.appendChild(s);})();
```

**3. Let AI install it for you** — copy [`prompt.md`](./prompt.md) into Claude Code inside your project. It's fully self-configuring: it auto-detects the project id and editor URL, detects your framework (Vite, Next.js, Astro, SvelteKit, Nuxt, CRA, Remix, Angular, SolidStart…), injects the overlay **only in development**, and verifies the install against the running editor server before reporting done.

> Tip: tag elements with `data-file="path/to/source"` so Claude knows exactly which file owns them.

## Configuration

Copy `.env.example` → `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PROJECT_ROOT` | `./example-site` | Folder Claude edits (used when no `projects.json`). |
| `SERVER_PORT` | `3000` | HTTP/SSE server port (serves `overlay.js`, `/task`). |
| `WS_PORT` | `3001` | Hot-reload WebSocket port. |
| `CLAUDE_MODEL` | `sonnet` | Model alias/name passed to the CLI. |
| `PERMISSION_MODE` | `acceptEdits` | `acceptEdits` \| `bypassPermissions` \| `default`. |
| `CLAUDE_BIN` | `claude` | Path to the `claude` binary if not on `PATH`. |
| `TASK_TIMEOUT_MS` | `240000` | Per-task timeout. |

## API reference

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/status` | Health, model, registered projects, CLI availability + version. |
| `GET` | `/projects` | List registered projects. |
| `POST` | `/register` | Register a project explicitly. Body: `{ id, root }` (root must be inside an allowed base). |
| `GET` | `/events` | Live dashboard feed (**SSE**): `hello` snapshot, then `task:start`/`task:update`/`task:end`/`task:remove`, `reload`, `project`. |
| `GET` | `/projects/status` | Probe each project's detected dev-server port: `[{ id, origin, up }]`. |
| `GET` | `/history` | Task log (newest first). `?project=<id>` filters. |
| `POST` | `/task` | Run an edit. Body: `{ prompt, context?, projectId?, sessionId? }`. Responds as **SSE** (`start`, `text`, `tool`, `edited`, `done`, `error`). |
| `GET` | `/overlay.js` | The bundled overlay. `?project=<id>` selects the project. |
| `GET` | `/bookmarklet.js` | Tiny injector for the bookmarklet. |

## Project structure

```
dheep-ai-visual-editor/
├── server/
│   ├── index.js       Express server: /task (SSE), /status, /projects, /history, serves overlay
│   ├── claude.js      Spawns the Claude CLI (stream-json), parses events, resumes sessions
│   ├── search.js      Pre-search: ranks candidate source files for the clicked element
│   ├── projects.js    Multi-project registry (projects.json or PROJECT_ROOT fallback)
│   ├── hotreload.js   One WebSocket server + one chokidar watcher per project
│   └── utils.js       Prompt builder, framework detection + tasks.json helpers
├── overlay/
│   ├── overlay.js     Toggle, hover, click, selector + context collection, hot-reload client
│   ├── sidebar.js     Docked chat sidebar: messages, streaming, session, element attach
│   ├── highlight.js   Blue hover outline + selector/size label
│   └── overlay.css    Sidebar & highlight styles
├── client/index.html  Live dashboard (SSE): running tasks, projects, stats, charts
├── example-site/      Demo site to try it on
├── prompt.md          Paste-into-your-project installer prompt
├── projects.example.json
└── .env.example
```

## Security

This is a **local development tool**. Please:

- **Don't expose the server to the public internet.** It lets a browser trigger file edits on your machine.
- Run it only against projects you trust. `PERMISSION_MODE=bypassPermissions` widens what the AI may do — use deliberately.
- The injected `<script>` is for **development only**; the [`prompt.md`](./prompt.md) recipes guard it behind dev-mode checks so it never ships to production.
- No API keys are stored by this tool; auth comes from your local `claude` login. `.env`, `projects.json`, and `tasks.json` are git-ignored.

## FAQ & troubleshooting

**Do I need an Anthropic API key?**
No. It uses your local Claude Code CLI login (subscription).

**The sidebar says the server is offline.**
Start `npm start`, and make sure the `<script src>` port matches `SERVER_PORT`.

**Dashboard shows "claude CLI not found".**
Ensure `claude --version` works in the same shell you launch the server from; set `CLAUDE_BIN` to its full path if needed.

**A task errors with an auth/login message.**
Run `claude` once interactively to log in, then retry.

**The page doesn't reload after an edit.**
Confirm the project folder being served matches `PROJECT_ROOT`/`projects.json`, and that the WebSocket port isn't blocked.

**Does it work with my framework?**
Yes — plain HTML, Vite, Next.js (App & Pages Router), CRA, Astro, SvelteKit, Nuxt, and others. See [`prompt.md`](./prompt.md).

## Roadmap

- [ ] Screenshot/visual context sent with the prompt
- [ ] Diff preview before applying edits
- [ ] Undo / revert from the sidebar
- [ ] Multi-element selection
- [ ] Optional auth for remote/team setups

Have an idea? [Open an issue](https://github.com/dhabita/dheep-ai-visual-editor/issues).

## Contributing

Contributions are welcome! Fork the repo, create a branch, and open a pull request. For larger changes, please open an issue first to discuss what you'd like to change.

## License

[MIT](./LICENSE) © Bisri Mustofa (@dhabita)

---

<div align="center">

**Keywords:** AI visual editor · edit website from browser · click to edit · Claude Code visual editor · vibe coding tool · AI website builder · browser overlay editor · local AI code editor · no-code / low-code · live hot reload editor · open source

If this project helps you, please ⭐ star it to help others find it!

</div>
