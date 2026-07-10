# Design: Smarter source-file discovery + richer context + smarter installer

**Date:** 2026-07-11
**Status:** Approved

## Problem

The editor's "intelligence" is thin at three points:

1. **Naive file guessing** — `aveGuessFile()` in `overlay/overlay.js` only checks a
   `data-file` attribute or falls back to `location.pathname` → `index.html`. For any
   bundled framework (Vite, Next.js, …) the guess is nearly always wrong, so Claude must
   search from scratch on every task (slow, token-hungry).
2. **Minimal element context** — outerHTML truncated at 500 chars, only 10 computed
   styles, no parent chain, no distinctive text, no framework info.
3. **Static prompt builder** — `buildPrompt()` in `server/utils.js` doesn't use the
   existing `listProjectFiles()`, doesn't detect framework/styling, and does no
   pre-search for candidate files.

Additionally, `prompt.md` (the paste-in installer) requires manual CONFIG values that
are auto-detectable, has no post-install verification, and lacks recipes for Remix,
Angular, SolidStart, and monorepos.

## Goals

- Claude finds the correct source file on the first attempt for typical projects.
- All improvements are additive and backwards-compatible with the existing `context`
  payload and `/task` API.
- No new npm dependencies. Pre-search must never block or fail a task.

## Non-goals

- Diff preview, undo, screenshot context (roadmap items, out of scope).
- Changes to the recovery / hot-reload subsystems.

## Design

### 1. Richer element context (`overlay/overlay.js`)

Extend `aveCollectContext(el)` — all fields additive:

- `html`: truncation limit raised 500 → **2000** chars.
- `text`: distinctive trimmed `innerText`, ~200 chars — the strongest search signal.
- `parents`: compact ancestor chain, up to 3 levels (`tag.class > tag.class`).
- `attrs`: notable attributes (`href`, `src`, `alt`, `aria-label`, `data-*`).
- `sourceHint`: best-effort `{ file, line }` from framework dev metadata, each probe
  wrapped in try/catch:
  - React fiber `_debugSource` (walk `__reactFiber$*` keys),
  - Svelte `__svelte_meta.loc`,
  - Vue component `__file`.
- `framework`: page-level detection (`__NEXT_DATA__`, `__NUXT__`, `__SVELTEKIT__`, …).

### 2. Server-side pre-search (new `server/search.js`)

`findCandidateFiles(projectRoot, context)` runs before spawning Claude:

- **Search tokens**, in priority order: distinctive text snippets (highest), `id`,
  non-utility classes, `sourceHint.file`.
- **Utility-class filtering**: classes that match in many files score low — this
  automatically demotes Tailwind/utility classes without a hardcoded list.
- **Scan**: pure Node over files with extensions
  `html css js ts jsx tsx vue svelte astro`, sourced from the existing
  `listProjectFiles()` (max 400 files, skips `node_modules` etc.); files > ~300 KB
  skipped.
- **Output**: top 5 candidates `{ file, line, snippet, reason }`, ranked by weighted
  token score.
- **Resilience**: any error or empty result → task proceeds with no candidates.
  Pre-search must never reject.

### 3. Project-aware prompt builder (`server/utils.js`, `server/claude.js`)

- `buildPrompt()` gains sections for:
  - candidate files with matched lines ("automatic search results — verify before
    editing"),
  - project type detected from `package.json` deps + presence of `tailwind.config.*`
    (e.g. "Next.js App Router, styling: Tailwind"),
  - a short file-tree summary when no strong candidate exists.
- `SYSTEM_PROMPT` in `claude.js` gains verification rules: match the element's
  text/classes in the file before editing; if candidates miss, fall back to Grep.

### 4. Smarter installer (`prompt.md`)

- CONFIG becomes **optional**: `PROJECT_ID` auto-detected from `basename $(pwd)`;
  `EDITOR_URL` defaults to `http://localhost:3000`, verified with
  `curl EDITOR_URL/status` — only ask the user if the check fails.
- **Post-install verification** step: fetch `overlay.js?project=<id>`; on failure,
  diagnose (server down / wrong port / folder outside workspace roots).
- New recipes: **Remix, Angular, SolidStart**; a monorepo note (PROJECT_ID = package
  folder name, `WORKSPACE_ROOTS`).
- Short **uninstall** section.

### 5. Testing

- `server/search.test.js`: fixture mini-project; asserts candidate ranking, utility
  class demotion, resilience on empty/broken input. Uses `node:test` like
  `recovery.test.js`.
- `buildPrompt` tests covering: with candidates, without candidates, framework
  detection.

## Error handling summary

| Failure | Behaviour |
|---|---|
| Pre-search throws / times out | Task runs without candidates |
| Framework probe throws in browser | Field omitted from context |
| `package.json` unreadable | Project-type line omitted |
| Installer `curl /status` fails | Ask user for EDITOR_URL |
