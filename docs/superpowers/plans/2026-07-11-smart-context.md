# Smart Source Discovery & Richer Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the editor find the correct source file on the first attempt by pre-searching candidate files server-side, sending richer element context from the overlay, and making the paste-in installer (`prompt.md`) self-configuring.

**Architecture:** The overlay collects a richer context payload (text, ancestors, attrs, framework source hints). Before spawning Claude, the server runs a pure-Node candidate-file search (`server/search.js`) over the project and injects ranked candidates plus detected project type into the prompt (`buildPrompt`). All additions are additive and fail-open: any search error means the task simply runs without candidates.

**Tech Stack:** Node 18+ ESM, Express, `node:test`. No new npm dependencies.

## Global Constraints

- No new npm dependencies (spec: "No new npm dependencies").
- Pre-search must never reject or block a task — all failures return empty results.
- All context fields are additive; the existing `context` payload and `/task` API stay backwards-compatible.
- Do not touch the recovery / hot-reload subsystems (`recovery.js`, `devservers.js`, `hotreload.js`).
- Tests use `node:test` + `node:assert/strict` (pattern: `server/recovery.test.js`); run with `npm test`.

---

### Task 1: Server-side pre-search (`server/search.js`)

**Files:**
- Create: `server/search.js`
- Test: `server/search.test.js`

**Interfaces:**
- Consumes: `listProjectFiles(projectRoot, { maxEntries })` from `server/utils.js` (exists).
- Produces:
  - `extractSearchTokens(context) → [{ kind: 'text'|'id'|'class', value: string }]`
  - `findCandidateFiles(projectRoot, context, { maxCandidates = 5 }?) → Promise<[{ file, line, snippet, reason }]>` — never rejects.

- [ ] **Step 1: Write the failing tests**

Create `server/search.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractSearchTokens, findCandidateFiles } from './search.js';

/** Write a throwaway project folder from a { relPath: content } map. */
function makeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ave-search-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('extractSearchTokens pulls text, id and classes', () => {
  const tokens = extractSearchTokens({
    text: 'Welcome to Nimbus Analytics',
    selector: '#hero-title > span.accent',
    classList: ['accent', 'xl'],
  });
  assert.deepEqual(tokens, [
    { kind: 'text', value: 'Welcome to Nimbus Analytics' },
    { kind: 'id', value: 'hero-title' },
    { kind: 'class', value: 'accent' },
  ]);
});

test('extractSearchTokens ignores short text and short classes', () => {
  const tokens = extractSearchTokens({ text: 'Hi', classList: ['xl'] });
  assert.deepEqual(tokens, []);
});

test('distinctive text ranks the containing file first', async () => {
  const root = makeFixture({
    'index.html': '<h1>Welcome to Nimbus Analytics</h1>',
    'about.html': '<h1>About us</h1>',
    'styles.css': '.hero { color: red }',
  });
  const out = await findCandidateFiles(root, { text: 'Welcome to Nimbus Analytics' });
  assert.equal(out[0].file, 'index.html');
  assert.equal(out[0].line, 1);
  assert.match(out[0].reason, /text/);
});

test('utility class found in many files is demoted below a unique match', async () => {
  const files = { 'components/Hero.jsx': '<div className="flex hero-card">Hi</div>' };
  for (let i = 0; i < 6; i++) files[`pages/p${i}.jsx`] = '<div className="flex">page</div>';
  const root = makeFixture(files);
  const out = await findCandidateFiles(root, { classList: ['flex', 'hero-card'] });
  assert.equal(out[0].file, 'components/Hero.jsx');
});

test('framework source hint surfaces the file even without token matches', async () => {
  const root = makeFixture({
    'src/components/Hero.tsx': 'export const Hero = () => <h1>{t.title}</h1>;',
    'src/other.tsx': 'export const O = () => null;',
  });
  const out = await findCandidateFiles(root, {
    sourceHint: { file: 'src/components/Hero.tsx', line: 1 },
  });
  assert.equal(out[0].file, 'src/components/Hero.tsx');
  assert.match(out[0].reason, /source hint/);
});

test('returns [] on a nonexistent root or empty context', async () => {
  assert.deepEqual(await findCandidateFiles('/nonexistent-ave-path', { text: 'whatever text here' }), []);
  const root = makeFixture({ 'index.html': '<h1>x</h1>' });
  assert.deepEqual(await findCandidateFiles(root, {}), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- server/search.test.js`
Expected: FAIL — `Cannot find module ... server/search.js`

- [ ] **Step 3: Implement `server/search.js`**

```js
import path from 'node:path';
import fsp from 'node:fs/promises';
import { listProjectFiles } from './utils.js';

// Pre-search: find likely source files for a clicked element BEFORE spawning
// Claude, so the prompt can point at candidates instead of making the model
// search from scratch. Fail-open: any error returns [] and the task proceeds.

const SEARCHABLE_EXT = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx', '.vue', '.svelte', '.astro',
]);
const MAX_FILE_BYTES = 300 * 1024;
const WIDESPREAD_FILE_COUNT = 5; // token in more files than this = weak signal
const WEIGHT = { text: 10, id: 8, class: 3 };
const SOURCE_HINT_SCORE = 15;

/** Turn the clicked-element context into ranked search tokens. */
export function extractSearchTokens(context = {}) {
  const tokens = [];
  const text = String(context.text || '').replace(/\s+/g, ' ').trim();
  if (text.length >= 8) {
    let snippet = text.slice(0, 60);
    if (text.length > 60 && snippet.includes(' ')) {
      snippet = snippet.slice(0, snippet.lastIndexOf(' '));
    }
    tokens.push({ kind: 'text', value: snippet.trim() });
  }
  const idMatch = String(context.selector || '').match(/#([A-Za-z0-9_-]{2,})/);
  if (idMatch) tokens.push({ kind: 'id', value: idMatch[1] });
  for (const c of context.classList || []) {
    if (typeof c === 'string' && c.length >= 3) tokens.push({ kind: 'class', value: c });
  }
  return tokens;
}

/**
 * Rank project files likely to contain the clicked element.
 * Returns up to `maxCandidates` of { file, line, snippet, reason }. Never rejects.
 */
export async function findCandidateFiles(projectRoot, context = {}, { maxCandidates = 5 } = {}) {
  try {
    const tokens = extractSearchTokens(context);
    const hintFile = context.sourceHint?.file ? String(context.sourceHint.file) : null;
    if (!tokens.length && !hintFile) return [];

    const files = (await listProjectFiles(projectRoot))
      .filter((f) => SEARCHABLE_EXT.has(path.extname(f).toLowerCase()));

    // Pass 1: raw matches per file + how many files each token appears in.
    const matches = new Map();       // file → [{ token, line, snippet }]
    const filesPerToken = new Map(); // token value → file count
    for (const file of files) {
      const full = path.join(projectRoot, file);
      let content;
      try {
        const stat = await fsp.stat(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        content = await fsp.readFile(full, 'utf8');
      } catch {
        continue;
      }
      for (const token of tokens) {
        const idx = content.indexOf(token.value);
        if (idx === -1) continue;
        filesPerToken.set(token.value, (filesPerToken.get(token.value) || 0) + 1);
        const line = content.slice(0, idx).split('\n').length;
        const snippet = content.split('\n')[line - 1].trim().slice(0, 120);
        if (!matches.has(file)) matches.set(file, []);
        matches.get(file).push({ token, line, snippet });
      }
    }

    // Pass 2: score files, demoting tokens that match many files (utility
    // classes like Tailwind's demote themselves — no hardcoded list needed).
    const scored = [];
    for (const [file, fileMatches] of matches) {
      let score = 0;
      let best = fileMatches[0];
      let bestWeight = -1;
      const reasons = [];
      for (const m of fileMatches) {
        const spread = filesPerToken.get(m.token.value) || 1;
        const weight = spread > WIDESPREAD_FILE_COUNT ? 0.5 : WEIGHT[m.token.kind];
        score += weight;
        reasons.push(`${m.token.kind} "${m.token.value}"`);
        if (weight > bestWeight) { bestWeight = weight; best = m; }
      }
      if (hintFile && (file.endsWith(hintFile) || hintFile.endsWith(file))) {
        score += SOURCE_HINT_SCORE;
        reasons.push('framework source hint');
      }
      scored.push({ file, line: best.line, snippet: best.snippet, score, reason: reasons.join(', ') });
    }

    // The hinted file may contain no token match — still surface it.
    if (hintFile && !scored.some((s) => s.reason.includes('framework source hint'))) {
      const hit = files.find((f) => f.endsWith(hintFile) || hintFile.endsWith(f));
      if (hit) {
        scored.push({
          file: hit,
          line: context.sourceHint.line || 1,
          snippet: '',
          score: SOURCE_HINT_SCORE,
          reason: 'framework source hint',
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored
      .slice(0, maxCandidates)
      .map(({ file, line, snippet, reason }) => ({ file, line, snippet, reason }));
  } catch {
    return []; // pre-search must never block a task
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- server/search.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Run the full suite, then commit**

Run: `npm test`
Expected: PASS (existing devservers/recovery tests + new search tests)

```bash
git add server/search.js server/search.test.js
git commit -m "feat(search): server-side candidate-file pre-search for clicked elements"
```

---

### Task 2: Project detection + smarter prompt builder (`server/utils.js`, `server/search.js`)

**Files:**
- Modify: `server/utils.js:70-99` (replace `buildPrompt`), add `detectProjectInfo` after `listProjectFiles`
- Modify: `server/search.js` (append `prepareTaskIntel`)
- Test: `server/utils.test.js`

**Interfaces:**
- Consumes: `findCandidateFiles`, `listProjectFiles` from Task 1 / existing utils.
- Produces:
  - `detectProjectInfo(projectRoot) → { framework: string, styling: string|null }` (sync, in `utils.js`)
  - `prepareTaskIntel(projectRoot, context) → Promise<{ candidates, projectInfo, fileSummary }>` (in `search.js`, never rejects)
  - `buildPrompt({ prompt, context = {}, intel = {} }, projectRoot) → string` — new optional `intel` param; existing callers passing only `{ prompt, context }` keep working.

- [ ] **Step 1: Write the failing tests**

Create `server/utils.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPrompt, detectProjectInfo } from './utils.js';

function makeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ave-utils-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('detectProjectInfo: Next.js App Router + Tailwind', () => {
  const root = makeFixture({
    'package.json': JSON.stringify({ dependencies: { next: '15.0.0', tailwindcss: '4.0.0' } }),
    'app/layout.tsx': 'export default function L(){}',
  });
  assert.deepEqual(detectProjectInfo(root), {
    framework: 'Next.js (App Router)',
    styling: 'Tailwind CSS',
  });
});

test('detectProjectInfo: no package.json → static HTML', () => {
  const root = makeFixture({ 'index.html': '<h1>x</h1>' });
  assert.deepEqual(detectProjectInfo(root), {
    framework: 'static HTML / unknown',
    styling: null,
  });
});

test('buildPrompt includes candidates and project type', () => {
  const out = buildPrompt({
    prompt: 'make it blue',
    context: { selector: '.hero', text: 'Welcome home', parents: 'main > section.hero' },
    intel: {
      candidates: [{ file: 'src/Hero.tsx', line: 12, snippet: '<h1>Welcome home</h1>', reason: 'text "Welcome home"' }],
      projectInfo: { framework: 'Vite + React', styling: 'Tailwind CSS' },
      fileSummary: [],
    },
  }, '/proj');
  assert.match(out, /Candidate source files/);
  assert.match(out, /src\/Hero\.tsx:12/);
  assert.match(out, /Project type: Vite \+ React, styling: Tailwind CSS/);
  assert.match(out, /Element text: Welcome home/);
  assert.match(out, /Ancestors: main > section\.hero/);
  assert.match(out, /TASK: make it blue/);
});

test('buildPrompt falls back to a file summary when there are no candidates', () => {
  const out = buildPrompt({
    prompt: 'change footer',
    context: {},
    intel: { candidates: [], projectInfo: null, fileSummary: ['index.html', 'styles.css'] },
  }, '/proj');
  assert.match(out, /Project files \(partial\)/);
  assert.match(out, /styles\.css/);
  assert.doesNotMatch(out, /Candidate source files/);
});

test('buildPrompt still works without intel (backwards compatible)', () => {
  const out = buildPrompt({ prompt: 'hi', context: { selector: '#a' } }, '/proj');
  assert.match(out, /TASK: hi/);
  assert.match(out, /CSS selector: #a/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- server/utils.test.js`
Expected: FAIL — `detectProjectInfo` is not exported / candidate assertions fail.

- [ ] **Step 3: Add `detectProjectInfo` to `server/utils.js`** (insert after `listProjectFiles`)

```js
/**
 * Detect the project's framework and styling system from package.json and
 * well-known files. Best-effort — returns a generic label when unknown.
 */
export function detectProjectInfo(projectRoot) {
  const info = { framework: null, styling: null };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const hasDir = (d) => fs.existsSync(path.join(projectRoot, d));
    if (deps.next) info.framework = hasDir('app') || hasDir('src/app') ? 'Next.js (App Router)' : 'Next.js (Pages Router)';
    else if (deps.nuxt) info.framework = 'Nuxt';
    else if (deps['@sveltejs/kit']) info.framework = 'SvelteKit';
    else if (deps.astro) info.framework = 'Astro';
    else if (deps['@remix-run/react']) info.framework = 'Remix';
    else if (deps['@angular/core']) info.framework = 'Angular';
    else if (deps['solid-js']) info.framework = 'Solid';
    else if (deps['react-scripts']) info.framework = 'Create React App';
    else if (deps.vite && deps.react) info.framework = 'Vite + React';
    else if (deps.vite && deps.vue) info.framework = 'Vite + Vue';
    else if (deps.vite && deps.svelte) info.framework = 'Vite + Svelte';
    else if (deps.vite) info.framework = 'Vite';
    else if (deps.react) info.framework = 'React';
    else if (deps.vue) info.framework = 'Vue';
    if (deps.tailwindcss) info.styling = 'Tailwind CSS';
  } catch {
    // No/unreadable package.json — probably a static site.
  }
  if (!info.styling) {
    for (const f of ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs']) {
      if (fs.existsSync(path.join(projectRoot, f))) { info.styling = 'Tailwind CSS'; break; }
    }
  }
  if (!info.framework) info.framework = 'static HTML / unknown';
  return info;
}
```

- [ ] **Step 4: Replace `buildPrompt` in `server/utils.js`**

Replace the whole existing `buildPrompt` function (currently lines 66-99, from the doc comment through the closing brace) with:

```js
/**
 * Build the full prompt Claude receives: the user's task, the collected
 * element context, and (when available) pre-searched candidate files and
 * detected project type. Kept deliberately explicit and readable.
 */
export function buildPrompt({ prompt, context = {}, intel = {} }, projectRoot) {
  const { selector, html, css, file, classList, text, parents, attrs, sourceHint, framework } = context;
  const { candidates = [], projectInfo = null, fileSummary = [] } = intel;
  const lines = [];

  lines.push('You are editing a live website project.');
  lines.push(`Project root: ${projectRoot}`);
  if (projectInfo?.framework) {
    lines.push(`Project type: ${projectInfo.framework}${projectInfo.styling ? `, styling: ${projectInfo.styling}` : ''}`);
  }
  if (file) lines.push(`Page path hint (from the browser URL): ${file}`);
  lines.push('');
  lines.push('--- Clicked element context ---');
  if (selector) lines.push(`CSS selector: ${selector}`);
  if (classList && classList.length) lines.push(`classList: ${classList.join(', ')}`);
  if (text) lines.push(`Element text: ${text}`);
  if (parents) lines.push(`Ancestors: ${parents}`);
  if (attrs && Object.keys(attrs).length) {
    lines.push('Attributes:');
    for (const [k, v] of Object.entries(attrs)) lines.push(`  ${k}="${v}"`);
  }
  if (framework) lines.push(`Page framework: ${framework}`);
  if (sourceHint?.file) {
    lines.push(`Framework dev source: ${sourceHint.file}${sourceHint.line ? `:${sourceHint.line}` : ''}`);
  }
  if (html) {
    lines.push('Current outerHTML (may be truncated):');
    lines.push(html);
  }
  if (css && Object.keys(css).length) {
    lines.push('Current computed styles:');
    for (const [k, v] of Object.entries(css)) lines.push(`  ${k}: ${v}`);
  }
  lines.push('--- End context ---');
  lines.push('');
  if (candidates.length) {
    lines.push('--- Candidate source files (automatic search — verify before editing) ---');
    candidates.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.file}:${c.line}${c.snippet ? ` — ${c.snippet}` : ''}`);
      lines.push(`   matched: ${c.reason}`);
    });
    lines.push('--- End candidates ---');
    lines.push('');
  } else if (fileSummary.length) {
    lines.push('--- Project files (partial) ---');
    for (const f of fileSummary) lines.push(`  ${f}`);
    lines.push('--- End files ---');
    lines.push('');
  }
  lines.push(`TASK: ${prompt}`);
  lines.push('');
  lines.push('Start from the highest-ranked candidate file. Verify the element is really there (match its text/classes) before editing. If no candidate matches, search with Grep. Make the edit directly and save the file now.');

  return lines.join('\n');
}
```

- [ ] **Step 5: Append `prepareTaskIntel` to `server/search.js`**

Add the import of `detectProjectInfo` to the existing import line at the top:

```js
import { listProjectFiles, detectProjectInfo } from './utils.js';
```

Append at the end of the file:

```js
/**
 * One-call intel gathering for a task: candidate files, project type, and —
 * only when no candidates were found — a short file summary to orient Claude.
 * Never rejects.
 */
export async function prepareTaskIntel(projectRoot, context = {}) {
  const candidates = await findCandidateFiles(projectRoot, context);
  let fileSummary = [];
  if (!candidates.length) {
    try {
      fileSummary = await listProjectFiles(projectRoot, { maxEntries: 40 });
    } catch {
      fileSummary = [];
    }
  }
  let projectInfo = null;
  try {
    projectInfo = detectProjectInfo(projectRoot);
  } catch {
    projectInfo = null;
  }
  return { candidates, projectInfo, fileSummary };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all suites)

- [ ] **Step 7: Commit**

```bash
git add server/utils.js server/utils.test.js server/search.js
git commit -m "feat(prompt): project-aware prompt builder with candidate files and framework detection"
```

---

### Task 3: Wire intel into the task pipeline (`server/claude.js`, `server/index.js`)

**Files:**
- Modify: `server/claude.js:22-26` (SYSTEM_PROMPT), `server/claude.js:33-35` (runTask signature + buildPrompt call)
- Modify: `server/index.js` (import + `/task` handler, around lines 10-13 and 368-374)

**Interfaces:**
- Consumes: `prepareTaskIntel(projectRoot, context)` from Task 2; `buildPrompt({ prompt, context, intel }, projectRoot)` from Task 2.
- Produces: `runTask({ prompt, context, intel, projectRoot, sessionId, model }, emit)` — new optional `intel` field; existing callers (e.g. `devservers.js` recovery `runTask` calls) keep working without it.

- [ ] **Step 1: Update `SYSTEM_PROMPT` in `server/claude.js`**

Replace lines 22-26 (the whole `SYSTEM_PROMPT` constant) with:

```js
const SYSTEM_PROMPT = `You are editing files in a live web project.
- Edit files directly. Never ask for confirmation — just make the change.
- The prompt may include "Candidate source files" found by an automatic pre-search. Start from the top candidate, but VERIFY the file really contains the clicked element (match its text, classes, or structure) before editing.
- If no candidate matches, locate the source yourself with Grep/Glob using the element's text and class names.
- Never delete or rewrite code you were not asked to touch. Make the smallest edit that satisfies the task.
- Read a file before editing it so your changes are precise.
- When done, reply with a 1-2 sentence summary of exactly what you changed.`;
```

- [ ] **Step 2: Thread `intel` through `runTask` in `server/claude.js`**

Change the function signature and first lines (currently lines 33-35):

```js
export function runTask({ prompt, context, intel, projectRoot, sessionId, model }, emit) {
  if (!projectRoot) throw new Error('runTask requires a projectRoot.');
  const fullPrompt = buildPrompt({ prompt, context, intel }, projectRoot);
```

- [ ] **Step 3: Compute intel in the `/task` handler in `server/index.js`**

Add `prepareTaskIntel` to the imports (after the existing `import { readTasks, appendTask } from './utils.js';` on line 13):

```js
import { prepareTaskIntel } from './search.js';
```

In the `/task` handler, directly after the `emit('start', …)` line (currently line 364) and before the `useSession` line, insert:

```js
  // Pre-search candidate files + detect framework. Fail-open by design.
  const intel = await prepareTaskIntel(project.root, context || {});
  if (intel.candidates.length) {
    emit('tool', { name: 'pre-search', input: { file_path: intel.candidates[0].file } });
  }
```

Then pass it to `runTask` (currently line 372):

```js
    const { summary, editedFiles, sessionId: newSession, usage } = await runTask(
      { prompt, context, intel, projectRoot: project.root, sessionId: useSession, model: chosenModel },
      emit
    );
```

- [ ] **Step 4: Verify syntax and tests**

Run: `node --check server/claude.js && node --check server/index.js && npm test`
Expected: no syntax errors; all tests PASS.

- [ ] **Step 5: Smoke-test the server boots**

```bash
node server/index.js & SERVER_PID=$!
sleep 1.5
curl -s http://localhost:3000/status | head -c 200; echo
kill $SERVER_PID
```

Expected: JSON containing `"ok":true`.

- [ ] **Step 6: Commit**

```bash
git add server/claude.js server/index.js
git commit -m "feat(task): run candidate pre-search and pass intel to Claude"
```

---

### Task 4: Richer element context in the overlay (`overlay/overlay.js`)

**Files:**
- Modify: `overlay/overlay.js:57-79` (replace `aveGuessFile` comment context + `aveCollectContext`, add helpers)

**Interfaces:**
- Consumes: nothing new (browser DOM APIs only).
- Produces: extended `context` payload consumed by `buildPrompt` (Task 2): adds `text`, `parents`, `attrs`, `sourceHint: { file, line }|null`, `framework: string|null`. Existing fields (`selector`, `classList`, `html`, `css`, `file`) unchanged.

- [ ] **Step 1: Add helper functions and replace `aveCollectContext`**

In `overlay/overlay.js`, insert the following between `aveGuessFile` (ends line 66) and the current `aveCollectContext` (line 68):

```js
/** Distinctive element text — the strongest search signal. */
function aveCollectText(el) {
  const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 200);
}

/** Compact ancestor chain, e.g. "main.content > section.hero". */
function aveParentChain(el, levels = 3) {
  const parts = [];
  let node = el.parentElement;
  while (node && node !== document.body && parts.length < levels) {
    let part = node.tagName.toLowerCase();
    const cls = Array.from(node.classList)
      .filter((c) => !c.startsWith('ave-'))
      .slice(0, 2);
    if (cls.length) part += '.' + cls.join('.');
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

/** Notable attributes that help locate the source. */
function aveCollectAttrs(el) {
  const out = {};
  for (const name of ['href', 'src', 'alt', 'aria-label', 'title', 'placeholder', 'type', 'name']) {
    const v = el.getAttribute && el.getAttribute(name);
    if (v) out[name] = String(v).slice(0, 120);
  }
  for (const a of el.attributes || []) {
    if (a.name.startsWith('data-') && a.name !== 'data-file' && Object.keys(out).length < 12) {
      out[a.name] = String(a.value).slice(0, 120);
    }
  }
  return out;
}

/** Best-effort source file/line from framework dev-mode metadata. */
function aveSourceHint(el) {
  try {
    // React (dev builds): walk the fiber tree for _debugSource.
    for (const key of Object.keys(el)) {
      if (!key.startsWith('__reactFiber$')) continue;
      let fiber = el[key];
      for (let i = 0; fiber && i < 10; i++) {
        const src = fiber._debugSource;
        if (src && src.fileName) return { file: String(src.fileName), line: src.lineNumber || null };
        fiber = fiber.return;
      }
    }
  } catch { /* ignore */ }
  try {
    // Svelte (dev builds)
    const meta = el.__svelte_meta;
    if (meta && meta.loc && meta.loc.file) return { file: String(meta.loc.file), line: meta.loc.line || null };
  } catch { /* ignore */ }
  try {
    // Vue (dev builds)
    const comp = el.__vueParentComponent;
    const file = comp && comp.type && comp.type.__file;
    if (file) return { file: String(file), line: null };
  } catch { /* ignore */ }
  return null;
}

/** Which framework rendered this page (best effort). */
function aveDetectFramework(el) {
  try {
    if (window.__NEXT_DATA__ || window.next) return 'next';
    if (window.__NUXT__ || window.useNuxtApp) return 'nuxt';
    if (document.querySelector('[data-sveltekit-preload-data]')) return 'sveltekit';
    if (document.querySelector('astro-island, [data-astro-cid]')) return 'astro';
    if (el && Object.keys(el).some((k) => k.startsWith('__reactFiber$'))) return 'react';
    if (el && el.__vueParentComponent) return 'vue';
  } catch { /* ignore */ }
  return null;
}
```

Then replace the existing `aveCollectContext` (lines 68-79, including its doc comment) with:

```js
/** Collect everything Claude needs about the clicked element. */
function aveCollectContext(el) {
  let html = el.outerHTML || '';
  if (html.length > 2000) html = html.slice(0, 2000) + '…(truncated)';
  return {
    selector: aveGetSelector(el),
    classList: Array.from(el.classList).filter((c) => !c.startsWith('ave-')),
    html,
    css: aveCollectCss(el),
    file: aveGuessFile(el),
    text: aveCollectText(el),
    parents: aveParentChain(el),
    attrs: aveCollectAttrs(el),
    sourceHint: aveSourceHint(el),
    framework: aveDetectFramework(el),
  };
}
```

- [ ] **Step 2: Verify syntax and that the bundle still builds**

```bash
node --check overlay/overlay.js
node server/index.js & SERVER_PID=$!
sleep 1.5
curl -s 'http://localhost:3000/overlay.js' | grep -c 'aveSourceHint'
kill $SERVER_PID
```

Expected: `node --check` silent; grep prints a count ≥ 1 (the bundle contains the new helper).

- [ ] **Step 3: Commit**

```bash
git add overlay/overlay.js
git commit -m "feat(overlay): richer element context — text, ancestors, attrs, framework source hints"
```

---

### Task 5: Self-configuring installer (`prompt.md`)

**Files:**
- Modify: `prompt.md` (targeted section edits below)

**Interfaces:** none (documentation/prompt only).

- [ ] **Step 1: Make CONFIG optional with auto-detection**

Replace the CONFIG section (lines 18-22, from `## CONFIG` through the `PROJECT_ID` comment lines) with:

```
## CONFIG (opsional — deteksi otomatis dulu, hanya tanya kalau gagal)
- EDITOR_URL  = http://localhost:3000
- PROJECT_ID  = (auto)

Deteksi otomatis SEBELUM bertanya apa pun:
1. PROJECT_ID: jalankan `basename "$(pwd)"` — nama folder project ini ADALAH
   PROJECT_ID (server menemukan folder lewat auto-discovery berdasarkan nama).
2. EDITOR_URL: coba `curl -s --max-time 3 http://localhost:3000/status`.
   - Kalau balasannya JSON dengan "ok":true → pakai http://localhost:3000.
   - Kalau gagal → TANYAKAN ke saya di port berapa server editor berjalan
     (atau minta saya menjalankan `npm start` di repo editor dulu).
Hanya bertanya kalau salah satu deteksi di atas gagal.
```

- [ ] **Step 2: Add a post-install verification step**

In the `## YANG HARUS KAMU LAKUKAN` list, insert a new step between the current step 4 (`Jangan mengubah hal lain...`) and step 5 (`Setelah selesai, cetak ringkasan`), renumbering the old step 5 to 6:

```
5) VERIFIKASI pemasangan sebelum melapor selesai:
   - Jalankan: curl -s --max-time 3 "EDITOR_URL/overlay.js?project=PROJECT_ID" | head -c 100
   - Sukses = balasannya JavaScript yang diawali komentar "AI Visual Editor overlay bundle".
   - Kalau GAGAL, diagnosis dan laporkan mana yang terjadi:
     a. Server editor tidak jalan → minta saya `npm start` di repo editor.
     b. Port salah → cocokkan EDITOR_URL dengan SERVER_PORT di .env editor.
     c. Folder project di luar workspace editor → jalankan `pwd`, cetak path
        absolutnya, dan beri tahu saya untuk menambahkannya ke WORKSPACE_ROOTS
        di .env editor atau mendaftarkannya via POST /register {id, root}.
```

- [ ] **Step 3: Add recipes for Remix, Angular, and SolidStart**

Insert before the `### I. Stack lain` section:

```
### I2. Remix (`app/root.tsx`)
Di dalam <body> (mis. setelah {children}), render dev-only:
    {process.env.NODE_ENV === 'development' && (
      <script src="EDITOR_URL/overlay.js?project=PROJECT_ID" />
    )}

### I3. Angular (`src/main.ts`)
    import { isDevMode } from '@angular/core';
    // ...setelah bootstrap:
    if (isDevMode()) {
      const s = document.createElement('script');
      s.src = 'EDITOR_URL/overlay.js?project=PROJECT_ID';
      document.body.appendChild(s);
    }

### I4. SolidStart (`src/entry-client.tsx`)
    if (import.meta.env.DEV) {
      const s = document.createElement('script');
      s.src = 'EDITOR_URL/overlay.js?project=PROJECT_ID';
      document.body.appendChild(s);
    }
```

Then rename the existing `### I. Stack lain` heading to `### Z. Stack lain` so it stays the catch-all at the end.

- [ ] **Step 4: Add monorepo + uninstall notes to `## CATATAN`**

Append to the `## CATATAN` bullet list:

```
- MONOREPO: PROJECT_ID = nama folder PACKAGE yang di-serve (mis. `apps/web` →
  "web"), bukan nama root repo. Kalau nama package tidak unik di workspace,
  beri tahu saya supaya saya daftarkan manual via POST /register.
- UNINSTALL: untuk melepas editor, hapus blok/snippet yang memuat
  "overlay.js?project=" dari file yang kamu ubah (cari string itu) — tidak ada
  jejak lain di project ini.
```

- [ ] **Step 5: Verify and commit**

Manually re-read the edited `prompt.md` top-to-bottom: CONFIG auto-detect present, steps numbered 1-6 with verification at 5, recipes A-H + I2/I3/I4 + Z, monorepo/uninstall notes in CATATAN. No literal "TBD" anywhere.

```bash
git add prompt.md
git commit -m "feat(installer): self-configuring prompt.md — auto-detect config, verify install, more stacks"
```

---

### Task 6: Final verification

**Files:** none new.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS — search, utils, devservers, recovery suites all green.

- [ ] **Step 2: End-to-end smoke with the bundled demo site**

```bash
node server/index.js & SERVER_PID=$!
sleep 1.5
curl -s 'http://localhost:3000/overlay.js?project=example-site' | head -c 60; echo
curl -s http://localhost:3000/projects
kill $SERVER_PID
```

Expected: bundle header comment printed; `example-site` present in `/projects` (auto-registered).

- [ ] **Step 3: Commit any stragglers and report**

```bash
git status --short
```

Expected: clean tree. Report: tests green, smoke passed, summary of the five commits.
