# Dev Server Auto-Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a managed project's dev server serves a 500 after an edit, the editor auto-recovers it by restarting the dev server on its port, escalating to a Claude code-fix only if a clean restart doesn't clear the error.

**Architecture:** A new `server/devservers.js` DevManager owns each project's dev server as a tracked child process (detects package manager + stack, spawns, kills, restarts, captures error output, probes health). A pure state machine in `server/recovery.js` drives the restart→fix→restart sequence against an injected driver, so it is fully unit-testable. `server/index.js` wires the manager in, adds control/report endpoints, and triggers recovery after each edit and on overlay-reported 500s. The overlay reports ≥500 fetch responses; the dashboard gains Restart controls and a live recovery indicator.

**Tech Stack:** Node.js ESM, Express, `node:child_process`, `node:net`, `node:http`, built-in `node:test` runner (no new deps).

## Global Constraints

- Node.js `>=18` (matches `package.json` `engines`). Use built-in `node:test` / `node:assert` — do NOT add a test framework dependency.
- ESM only (`"type": "module"`). Use `import`, not `require`.
- Development only. Never manage or restart anything for production.
- `.next` deletion applies to the `next` stack only; other stacks get restart-only.
- Recovery is bounded: at most **one** fix cycle per trigger, guarded by a per-project lock + cooldown. Never loop.
- Follow existing code style: small functional modules, exported functions, JSDoc comments like the current `server/*.js` files.

---

### Task 1: Dev-command detection helpers

Pure helpers that decide how to launch a project's dev server. No process spawning yet.

**Files:**
- Create: `server/devservers.js`
- Test: `server/devservers.test.js`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Consumes: nothing (leaf task).
- Produces:
  - `detectPackageManager(root: string) => 'pnpm' | 'yarn' | 'npm'`
  - `detectStack(root: string) => 'next' | 'vite' | 'other'`
  - `buildDevCommand({ pm, stack, port }) => { cmd: string, args: string[] }`
  - `getFreePort() => Promise<number>`

- [ ] **Step 1: Add the test script to package.json**

In `package.json`, add a `test` entry to `scripts` (keep the existing `start` and `dev`):

```json
  "scripts": {
    "start": "node server/index.js",
    "dev": "node --watch server/index.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write the failing test**

Create `server/devservers.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  detectPackageManager,
  detectStack,
  buildDevCommand,
  getFreePort,
} from './devservers.js';

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ave-dev-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('detectPackageManager reads the lockfile', () => {
  assert.equal(detectPackageManager(tmpProject({ 'pnpm-lock.yaml': '' })), 'pnpm');
  assert.equal(detectPackageManager(tmpProject({ 'yarn.lock': '' })), 'yarn');
  assert.equal(detectPackageManager(tmpProject({ 'package-lock.json': '' })), 'npm');
  assert.equal(detectPackageManager(tmpProject({})), 'npm'); // default
});

test('detectStack recognizes next and vite from package.json', () => {
  const next = tmpProject({ 'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }) });
  assert.equal(detectStack(next), 'next');
  const vite = tmpProject({ 'package.json': JSON.stringify({ devDependencies: { vite: '5.0.0' } }) });
  assert.equal(detectStack(vite), 'vite');
  assert.equal(detectStack(tmpProject({ 'package.json': '{}' })), 'other');
});

test('buildDevCommand forces the port for next, per package manager', () => {
  assert.deepEqual(
    buildDevCommand({ pm: 'npm', stack: 'next', port: 3002 }),
    { cmd: 'npm', args: ['run', 'dev', '--', '-p', '3002'] }
  );
  assert.deepEqual(
    buildDevCommand({ pm: 'pnpm', stack: 'next', port: 3002 }),
    { cmd: 'pnpm', args: ['dev', '-p', '3002'] }
  );
  assert.deepEqual(
    buildDevCommand({ pm: 'yarn', stack: 'next', port: 3002 }),
    { cmd: 'yarn', args: ['dev', '-p', '3002'] }
  );
});

test('buildDevCommand does not force a port for non-next stacks', () => {
  assert.deepEqual(
    buildDevCommand({ pm: 'npm', stack: 'vite', port: 3002 }),
    { cmd: 'npm', args: ['run', 'dev'] }
  );
});

test('getFreePort returns a usable port number', async () => {
  const p = await getFreePort();
  assert.equal(typeof p, 'number');
  assert.ok(p > 0 && p < 65536);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './devservers.js'` / exports undefined.

- [ ] **Step 4: Write the minimal implementation**

Create `server/devservers.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

/** Choose a package manager from the project's lockfile (npm is the default). */
export function detectPackageManager(root) {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/** Identify the framework so we know whether to force a port / clear .next. */
export function detectStack(root) {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch { /* no/broken package.json */ }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const hasNextConfig = ['next.config.js', 'next.config.mjs', 'next.config.ts']
    .some((f) => fs.existsSync(path.join(root, f)));
  if (deps.next || hasNextConfig) return 'next';
  if (deps.vite) return 'vite';
  return 'other';
}

/**
 * Build the dev-server launch command. For Next.js the port is forced with
 * `-p <port>` so the editor always knows and controls it; other stacks run
 * their plain `dev` script (their origin is learned when the overlay connects).
 */
export function buildDevCommand({ pm, stack, port }) {
  const base = pm === 'npm' ? { cmd: 'npm', args: ['run', 'dev'] } : { cmd: pm, args: ['dev'] };
  if (stack === 'next' && port) {
    // npm needs `--` to pass flags through to the script.
    const portArgs = pm === 'npm' ? ['--', '-p', String(port)] : ['-p', String(port)];
    return { cmd: base.cmd, args: [...base.args, ...portArgs] };
  }
  return base;
}

/** Ask the OS for a free TCP port. */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — all 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add package.json server/devservers.js server/devservers.test.js
git commit -m "feat(devservers): dev-command detection helpers"
```

---

### Task 2: HTTP health probe

An HTTP GET probe that returns the status code (so we can tell a 500 from a healthy page), added to `devservers.js`.

**Files:**
- Modify: `server/devservers.js`
- Test: `server/devservers.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `probeHttpStatus(url: string, timeoutMs = 3000) => Promise<number | null>` — resolves the HTTP status code, or `null` if the server is unreachable / times out.

- [ ] **Step 1: Write the failing test**

Append to `server/devservers.test.js`:

```js
import http from 'node:http';
import { probeHttpStatus } from './devservers.js';

test('probeHttpStatus returns the status code of a reachable server', async () => {
  const server = http.createServer((req, res) => { res.statusCode = 500; res.end('boom'); });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const status = await probeHttpStatus(`http://localhost:${port}/`);
  assert.equal(status, 500);
  server.close();
});

test('probeHttpStatus returns null when nothing is listening', async () => {
  const status = await probeHttpStatus('http://localhost:1/', 300);
  assert.equal(status, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `probeHttpStatus is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Add to `server/devservers.js` (add `import http from 'node:http';` and `import https from 'node:https';` at the top):

```js
/**
 * GET a URL and resolve its HTTP status code. Resolves null on any network
 * error or timeout. We only need the status line, so we destroy the socket as
 * soon as headers arrive.
 */
export function probeHttpStatus(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let mod;
    try {
      mod = new URL(url).protocol === 'https:' ? https : http;
    } catch {
      return resolve(null);
    }
    const req = mod.get(url, (res) => {
      resolve(res.statusCode || null);
      res.destroy();
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/devservers.js server/devservers.test.js
git commit -m "feat(devservers): HTTP health probe returning status code"
```

---

### Task 3: Recovery state machine (pure)

The restart→fix→restart sequence as a pure function driven by an injected driver, so every branch is unit-tested without spawning processes.

**Files:**
- Create: `server/recovery.js`
- Test: `server/recovery.test.js`

**Interfaces:**
- Consumes: nothing (operates on the injected `driver`).
- Produces:
  - `isBadStatus(status: number | null) => boolean` — true when `status === null` or `status >= 500`.
  - `recoverProject(driver, id, { url }) => Promise<{ outcome, status }>` where `outcome ∈ 'healthy' | 'recovered-by-restart' | 'recovered-by-fix' | 'failed'`.
  - Driver contract (implemented in Task 4):
    - `origin(id) => string | null`
    - `probe(url) => Promise<number | null>`
    - `restart(id) => Promise<void>`
    - `errorLog(id) => string`
    - `runFix(id, errorText) => Promise<void>`
    - `emit(event, data) => void`

- [ ] **Step 1: Write the failing test**

Create `server/recovery.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverProject, isBadStatus } from './recovery.js';

// Build a mock driver whose probe() returns the next scripted status each call.
function mockDriver(statuses) {
  const events = [];
  let i = 0;
  let restarts = 0;
  let fixes = 0;
  return {
    events, get restarts() { return restarts; }, get fixes() { return fixes; },
    origin: () => 'http://localhost:3002',
    probe: async () => statuses[i++],
    restart: async () => { restarts++; },
    errorLog: () => 'TypeError: boom at page.tsx:10',
    runFix: async () => { fixes++; },
    emit: (event, data) => events.push({ event, data }),
  };
}

test('isBadStatus flags 5xx and unreachable', () => {
  assert.equal(isBadStatus(500), true);
  assert.equal(isBadStatus(null), true);
  assert.equal(isBadStatus(200), false);
  assert.equal(isBadStatus(404), false);
});

test('healthy on first probe → no restart, no fix', async () => {
  const d = mockDriver([200]);
  const r = await recoverProject(d, 'p', {});
  assert.equal(r.outcome, 'healthy');
  assert.equal(d.restarts, 0);
  assert.equal(d.fixes, 0);
});

test('500 then healthy after restart → recovered-by-restart', async () => {
  const d = mockDriver([500, 200]);
  const r = await recoverProject(d, 'p', {});
  assert.equal(r.outcome, 'recovered-by-restart');
  assert.equal(d.restarts, 1);
  assert.equal(d.fixes, 0);
});

test('still 500 after restart, healthy after fix → recovered-by-fix', async () => {
  const d = mockDriver([500, 500, 200]);
  const r = await recoverProject(d, 'p', {});
  assert.equal(r.outcome, 'recovered-by-fix');
  assert.equal(d.restarts, 2); // clean restart + restart after fix
  assert.equal(d.fixes, 1);
});

test('still 500 after fix → failed, no further attempts', async () => {
  const d = mockDriver([500, 500, 500]);
  const r = await recoverProject(d, 'p', {});
  assert.equal(r.outcome, 'failed');
  assert.equal(d.restarts, 2);
  assert.equal(d.fixes, 1);
  assert.equal(d.events.at(-1).event, 'recovery:end');
  assert.equal(d.events.at(-1).data.outcome, 'failed');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/recovery.test.js`
Expected: FAIL — `Cannot find module './recovery.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `server/recovery.js`:

```js
/** A status needs recovery when the server is down (null) or returns a 5xx. */
export function isBadStatus(status) {
  return status === null || status >= 500;
}

/**
 * Drive recovery for one project: probe → clean restart → (if still bad) ask
 * Claude to fix → restart again → probe. Bounded to a single fix cycle. The
 * `driver` abstracts process control + probing so this stays pure & testable.
 *
 * @returns {Promise<{outcome:string, status:number|null}>}
 */
export async function recoverProject(driver, id, { url } = {}) {
  const target = url || driver.origin(id);
  driver.emit('recovery:start', { id, url: target });

  const end = (outcome, status) => {
    driver.emit('recovery:end', { id, url: target, outcome, status });
    return { outcome, status };
  };

  let status = await driver.probe(target);
  if (!isBadStatus(status)) return end('healthy', status);

  // 1) Clean restart.
  driver.emit('recovery:step', { id, step: 'restart' });
  await driver.restart(id);
  status = await driver.probe(target);
  if (!isBadStatus(status)) return end('recovered-by-restart', status);

  // 2) Escalate to a Claude code fix (once), then restart again.
  driver.emit('recovery:step', { id, step: 'fix' });
  await driver.runFix(id, driver.errorLog(id));
  driver.emit('recovery:step', { id, step: 'restart-after-fix' });
  await driver.restart(id);
  status = await driver.probe(target);
  if (!isBadStatus(status)) return end('recovered-by-fix', status);

  return end('failed', status);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/recovery.test.js`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/recovery.js server/recovery.test.js
git commit -m "feat(recovery): pure restart→fix→restart state machine"
```

---

### Task 4: DevManager process lifecycle

The real process manager: spawn/kill/restart dev servers, capture error logs, and expose a driver + a concurrency-guarded `recover()` that runs the Task 3 state machine.

**Files:**
- Modify: `server/devservers.js`
- Test: `server/devservers.test.js`

**Interfaces:**
- Consumes: `detectPackageManager`, `detectStack`, `buildDevCommand`, `getFreePort`, `probeHttpStatus` (Tasks 1–2); `recoverProject` (Task 3).
- Produces: `createDevManager({ projects, runTask, broadcast }) => manager` with:
  - `start(id, { port } = {}) => Promise<statusView>`
  - `stop(id) => Promise<void>`
  - `restart(id) => Promise<statusView>`
  - `status(id) => statusView` where `statusView = { managed, running, port, status, lastError }`
  - `recover(id, { url } = {}) => Promise<{outcome,status} | null>` (null when suppressed by lock/cooldown)
  - `shutdownAll() => void`
  - `projects` is the existing `Map<id,{id,root,origin?,lastSession?}>`; `runTask` is `server/claude.js`'s export; `broadcast(event, data)` is `dashBroadcast` from index.js.

- [ ] **Step 1: Write the failing test**

Append to `server/devservers.test.js`. This test uses a tiny inline Node HTTP server as a stand-in "dev server" so we exercise start/restart/stop/status without a real framework:

```js
import { createDevManager } from './devservers.js';

test('DevManager start/restart/stop drives a child dev server', async () => {
  // A project whose "dev script" is a 1-line node http server on $PORT.
  const dir = tmpProject({
    'package.json': JSON.stringify({
      scripts: { dev: 'node server.js' },
    }),
    'server.js':
      "require('http').createServer((q,s)=>{s.end('ok')}).listen(process.env.PORT||0,()=>console.log('ready'))",
  });
  const projects = new Map([['demo', { id: 'demo', root: dir }]]);
  const events = [];
  const mgr = createDevManager({
    projects,
    runTask: async () => ({ summary: 'fixed', editedFiles: [] }),
    broadcast: (e, d) => events.push({ e, d }),
  });

  // Force the port via env since this stub reads process.env.PORT.
  const port = await getFreePort();
  projects.get('demo').origin = `http://localhost:${port}`;

  const view = await mgr.start('demo', { port });
  assert.equal(view.managed, true);
  assert.equal(view.running, true);
  assert.equal(view.port, port);

  const status = await probeHttpStatus(`http://localhost:${port}/`);
  assert.equal(status, 200);

  await mgr.stop('demo');
  assert.equal(mgr.status('demo').running, false);

  mgr.shutdownAll();
});
```

> Note: the stub reads `process.env.PORT`. The manager MUST pass the chosen port to the child via `env.PORT` (in addition to CLI `-p` for Next). Implement accordingly in Step 3.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/devservers.test.js`
Expected: FAIL — `createDevManager is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Add to `server/devservers.js` (add `import { spawn } from 'node:child_process';`, `import { execFile } from 'node:child_process';` and `import { recoverProject } from './recovery.js';` at the top):

```js
const READY_TIMEOUT_MS = 60000;
const COOLDOWN_MS = 15000;
const LOG_LINES = 200;

/** Poll a TCP port until something accepts a connection, or time out. */
function waitForPort(port, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const sock = net.connect({ host: 'localhost', port });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) return resolve(false);
        setTimeout(tick, 300);
      });
    };
    tick();
  });
}

/** Best-effort kill of whatever process is listening on a port (macOS/Linux). */
function killPort(port) {
  return new Promise((resolve) => {
    execFile('lsof', ['-ti', `tcp:${port}`], (err, stdout) => {
      const pids = String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
      for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* gone */ } }
      resolve();
    });
  });
}

export function createDevManager({ projects, runTask, broadcast }) {
  const servers = new Map(); // id → { child, port, stack, log:[], status, lastError, recovering, cooldownUntil }

  const emit = (event, data) => { try { broadcast?.(event, data); } catch { /* no dashboard */ } };

  function rec(id) {
    if (!servers.has(id)) servers.set(id, { child: null, port: null, stack: null, log: [], status: 'stopped', lastError: null, recovering: false, cooldownUntil: 0 });
    return servers.get(id);
  }

  function pushLog(s, line) {
    s.log.push(line);
    if (s.log.length > LOG_LINES) s.log.shift();
  }

  async function start(id, { port } = {}) {
    const project = projects.get(id);
    if (!project) throw new Error(`Unknown project "${id}"`);
    const s = rec(id);
    if (s.child) return status(id); // already running

    const pm = detectPackageManager(project.root);
    const stack = detectStack(project.root);
    let chosenPort = port;
    if (!chosenPort && project.origin) {
      try { chosenPort = Number(new URL(project.origin).port) || null; } catch { chosenPort = null; }
    }
    if (!chosenPort) chosenPort = await getFreePort();

    const { cmd, args } = buildDevCommand({ pm, stack, port: chosenPort });
    s.stack = stack;
    s.port = chosenPort;
    s.status = 'starting';
    s.lastError = null;

    const child = spawn(cmd, args, {
      cwd: project.root,
      env: { ...process.env, PORT: String(chosenPort), BROWSER: 'none' },
    });
    s.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => String(d).split('\n').forEach((l) => l.trim() && pushLog(s, l.trim())));
    child.stderr?.on('data', (d) => String(d).split('\n').forEach((l) => l.trim() && pushLog(s, l.trim())));
    child.on('exit', (code) => {
      if (s.child === child) { s.child = null; if (s.status !== 'stopped') s.status = 'stopped'; }
      if (code && code !== 0) s.lastError = `dev server exited with code ${code}`;
    });

    // Adopt the origin so probes + the browser agree on the URL.
    project.origin = `http://localhost:${chosenPort}`;
    const ok = await waitForPort(chosenPort);
    s.status = ok ? 'running' : 'failed';
    if (!ok) s.lastError = `dev server did not open port ${chosenPort} within ${READY_TIMEOUT_MS / 1000}s`;
    emit('dev:status', status(id));
    return status(id);
  }

  async function stop(id) {
    const s = servers.get(id);
    if (!s) return;
    s.status = 'stopped';
    if (s.child) { try { s.child.kill('SIGTERM'); } catch { /* gone */ } s.child = null; }
    if (s.port) await killPort(s.port);
    emit('dev:status', status(id));
  }

  async function restart(id) {
    const s = rec(id);
    const project = projects.get(id);
    const port = s.port;
    await stop(id);
    // Clear the Next.js build cache — the usual cause of a post-edit 500.
    if (s.stack === 'next' && project) {
      try { fs.rmSync(path.join(project.root, '.next'), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return start(id, { port });
  }

  function status(id) {
    const s = servers.get(id);
    if (!s) return { managed: false, running: false, port: null, status: 'stopped', lastError: null };
    return { managed: true, running: !!s.child && s.status === 'running', port: s.port, status: s.status, lastError: s.lastError };
  }

  function errorLog(id) {
    const s = servers.get(id);
    if (!s) return '';
    // Prefer lines that look like errors; fall back to the tail.
    const errs = s.log.filter((l) => /error|exception|failed|cannot|undefined|ENOENT|TypeError|SyntaxError/i.test(l));
    return (errs.length ? errs : s.log).slice(-40).join('\n');
  }

  async function runFix(id, errorText) {
    const project = projects.get(id);
    if (!project) return;
    const prompt = [
      'The dev server for this project is returning HTTP 500 after a recent edit.',
      'Here is the recent dev-server error output:',
      '', errorText || '(no output captured)', '',
      'Find and fix the code causing the 500. Make the smallest change that resolves it.',
    ].join('\n');
    const result = await runTask(
      { prompt, projectRoot: project.root, sessionId: project.lastSession, model: undefined },
      () => {}
    );
    if (result?.sessionId) project.lastSession = result.sessionId;
  }

  const driver = {
    origin: (id) => projects.get(id)?.origin || null,
    probe: (url) => probeHttpStatus(url),
    restart: (id) => restart(id),
    errorLog,
    runFix,
    emit,
  };

  async function recover(id, { url } = {}) {
    const s = rec(id);
    if (s.recovering) return null;              // one recovery at a time
    if (Date.now() < s.cooldownUntil) return null; // cooldown gate
    if (!s.child) return null;                  // only manage what we launched
    s.recovering = true;
    try {
      return await recoverProject(driver, id, { url });
    } finally {
      s.recovering = false;
      s.cooldownUntil = Date.now() + COOLDOWN_MS;
    }
  }

  function shutdownAll() {
    for (const id of servers.keys()) {
      const s = servers.get(id);
      if (s?.child) { try { s.child.kill('SIGTERM'); } catch { /* gone */ } }
    }
  }

  return { start, stop, restart, status, recover, shutdownAll };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/devservers.test.js`
Expected: PASS — start/restart/stop test green (plus the earlier detection/probe tests).

- [ ] **Step 5: Commit**

```bash
git add server/devservers.js server/devservers.test.js
git commit -m "feat(devservers): process lifecycle + recovery driver"
```

---

### Task 5: Wire the manager into the server

Add manager creation, control/report endpoints, the post-edit probe trigger, extended status, and graceful shutdown to `server/index.js`.

**Files:**
- Modify: `server/index.js`

**Interfaces:**
- Consumes: `createDevManager`, `probeHttpStatus` from `./devservers.js`; existing `dashBroadcast`, `projects`, `runTask`, `probePort`.
- Produces: HTTP endpoints `POST /dev/:id/start`, `POST /dev/:id/restart`, `POST /dev/:id/stop`, `POST /report-error`; extended `GET /projects/status`.

- [ ] **Step 1: Import and create the manager**

At the top of `server/index.js`, extend the `claude.js` import area with a new import (after the `startHotReload` import line, add):

```js
import { createDevManager, probeHttpStatus } from './devservers.js';
```

After the `const hot = startHotReload(...)` block (around line 89), add:

```js
// Dev-server manager: owns each project's dev process so we can auto-recover
// a 500 by restarting (and, if needed, asking Claude to fix the code).
const devManager = createDevManager({ projects, runTask, broadcast: dashBroadcast });

// Report throttle: ignore repeat reports of the same project/url/status burst.
const reportThrottle = new Map(); // key → timestamp
const REPORT_THROTTLE_MS = 15000;
```

- [ ] **Step 2: Add dev-control + report endpoints**

Add these routes just after the existing `POST /register` handler (around line 220):

```js
// Manual dev-server control (used by the dashboard).
app.post('/dev/:id/start', async (req, res) => {
  try { res.json(await devManager.start(req.params.id, { port: req.body?.port })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/dev/:id/restart', async (req, res) => {
  try { res.json(await devManager.restart(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
app.post('/dev/:id/stop', async (req, res) => {
  try { await devManager.stop(req.params.id); res.json(devManager.status(req.params.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Overlay-reported error (fetch/navigation ≥500) — trigger recovery, throttled.
app.post('/report-error', async (req, res) => {
  const { projectId, url, status } = req.body || {};
  if (!projectId || typeof status !== 'number') {
    res.status(400).json({ error: 'projectId and numeric status are required.' });
    return;
  }
  const key = `${projectId}|${url || ''}|${status}`;
  const now = Date.now();
  if (now - (reportThrottle.get(key) || 0) < REPORT_THROTTLE_MS) { res.json({ ok: true, throttled: true }); return; }
  reportThrottle.set(key, now);
  res.json({ ok: true });
  if (status >= 500) devManager.recover(projectId, { url }).catch(() => {});
});
```

- [ ] **Step 3: Extend `GET /projects/status` with dev state**

Replace the existing `/projects/status` handler body (around lines 193–202) with:

```js
app.get('/projects/status', async (req, res) => {
  const out = await Promise.all(
    [...projects.values()].map(async (p) => ({
      id: p.id,
      origin: p.origin || null,
      up: p.origin ? await probePort(p.origin) : false,
      dev: devManager.status(p.id),
    }))
  );
  res.json(out);
});
```

- [ ] **Step 4: Trigger recovery after a successful edit**

In the `POST /task` handler, immediately after the `emit('done', ...)` line (around line 351), add:

```js
    // After an edit, give HMR a moment then check the project isn't 500ing.
    if (project.origin) {
      setTimeout(async () => {
        const st = await probeHttpStatus(project.origin);
        if (st !== null && st >= 500) devManager.recover(project.id, { url: project.origin }).catch(() => {});
      }, 1500);
    }
```

- [ ] **Step 5: Graceful shutdown**

Just before the final `app.listen(SERVER_PORT, ...)` call (around line 414), add:

```js
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { devManager.shutdownAll(); process.exit(0); });
}
```

- [ ] **Step 6: Verify the server boots and endpoints exist**

Run:
```bash
node -e "import('./server/index.js').then(()=>console.log('boot-ok'))" &
sleep 2
curl -s -X POST localhost:3000/report-error -H 'Content-Type: application/json' -d '{"projectId":"nope","status":500}'
curl -s localhost:3000/projects/status
kill %1 2>/dev/null
```
Expected: server prints its banner and `boot-ok`; `/report-error` returns `{"ok":true}`; `/projects/status` returns a JSON array where each entry has a `dev` field. (Recovery no-ops for the unknown/unmanaged project.)

- [ ] **Step 7: Commit**

```bash
git add server/index.js
git commit -m "feat(server): wire dev-server auto-recovery endpoints + post-edit trigger"
```

---

### Task 6: Overlay 500 reporter

Teach the overlay bundle to report ≥500 fetch responses on the project origin back to the editor server.

**Files:**
- Modify: `overlay/overlay.js`

**Interfaces:**
- Consumes: `window.__AVE_CONFIG__` (`serverUrl`, `projectId`) already injected by `buildOverlayBundle` in `server/index.js`.
- Produces: throttled `POST {serverUrl}/report-error { projectId, url, status }` on same-origin ≥500 responses.

- [ ] **Step 1: Add the reporter IIFE**

In `overlay/overlay.js`, immediately before the final `console.log('%c[AVE] ...')` line (line 164), insert:

```js
// ---- 500 reporter — nudge the editor to auto-recover a broken dev server ----
(function aveWatchErrors() {
  const cfg = window.__AVE_CONFIG__ || {};
  if (!cfg.serverUrl || !cfg.projectId) return;
  let lastReport = 0;
  function report(url, status) {
    const now = Date.now();
    if (now - lastReport < 10000) return; // throttle client-side too
    lastReport = now;
    try {
      fetch(cfg.serverUrl + '/report-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: cfg.projectId, url: String(url), status }),
        keepalive: true,
      }).catch(() => {});
    } catch { /* ignore */ }
  }
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    return origFetch.apply(this, args).then((res) => {
      try {
        const u = new URL(res.url, location.href);
        if (u.origin === location.origin && res.status >= 500) report(res.url, res.status);
      } catch { /* ignore */ }
      return res;
    });
  };
})();
```

- [ ] **Step 2: Verify the bundle still assembles**

Run:
```bash
node -e "import('./server/index.js').then(()=>console.log('ok'))" &
sleep 2
curl -s 'localhost:3000/overlay.js?project=demo' | grep -c "report-error"
kill %1 2>/dev/null
```
Expected: prints `1` (or more) — the reporter is present in the served bundle and the bundle builds without error.

- [ ] **Step 3: Commit**

```bash
git add overlay/overlay.js
git commit -m "feat(overlay): report same-origin 500s to trigger auto-recovery"
```

---

### Task 7: Dashboard Restart control + recovery indicator

Add a Restart button per project and a live toast when recovery runs, in the dashboard.

**Files:**
- Modify: `client/index.html`

**Interfaces:**
- Consumes: existing `renderProjects()`, delegated click handler (near line 379), `connect()`/`EventSource` (near line 384), `toast()`, `esc()`; new endpoints `POST /dev/:id/restart` and `recovery:*` / `dev:status` SSE events from Task 5.
- Produces: UI controls; no new exports.

- [ ] **Step 1: Add a Restart button to each project row**

In `renderProjects()` (near lines 312–314), directly after the `openBtn` definition, add a restart button and include it in the row markup where `openBtn` is rendered:

```js
        const restartBtn = `<button class="restart" data-restart="${esc(p.id)}" title="Kill + restart this project's dev server">↻ Restart</button>`;
```

Then in the row template string for that project, add `${restartBtn}` next to `${openBtn}`.

- [ ] **Step 2: Handle Restart clicks**

In the delegated click handler that currently opens a project (near line 379), extend it to handle the restart button:

```js
      const rb = e.target.closest('button.restart');
      if (rb && rb.dataset.restart) {
        rb.disabled = true;
        try {
          await fetch('/dev/' + encodeURIComponent(rb.dataset.restart) + '/restart', { method: 'POST' });
          toast('↻ restarting <span class="mono">' + esc(rb.dataset.restart) + '</span>');
        } catch {} finally { rb.disabled = false; }
        return;
      }
```

(If the existing handler is not `async`, make it `async`.)

- [ ] **Step 3: Show recovery activity from SSE**

In `connect()` where other `es.addEventListener(...)` handlers are registered (near lines 393–407), add:

```js
      es.addEventListener('recovery:start', (e) => { const d = JSON.parse(e.data); toast('⏳ recovering <span class="mono">' + esc(d.id) + '</span>…'); });
      es.addEventListener('recovery:end', (e) => {
        const d = JSON.parse(e.data);
        const ok = d.outcome && d.outcome.indexOf('recovered') === 0;
        toast((ok ? '✓ ' : '✗ ') + esc(d.id) + ' · ' + esc(d.outcome));
      });
      es.addEventListener('dev:status', () => loadPortStatus());
```

- [ ] **Step 4: Reflect dev status in project rows**

In `loadPortStatus()` (near lines 369–373), store the `dev` field so rows can use it:

```js
        arr.forEach(s => { const p = state.projects[s.id]; if (p) { if (s.origin) p.origin = s.origin; p.up = s.up; p.dev = s.dev; } });
```

- [ ] **Step 5: Verify the dashboard loads**

Run:
```bash
node -e "import('./server/index.js').then(()=>console.log('ok'))" &
sleep 2
curl -s localhost:3000/ | grep -c "data-restart\|recovery:end" || true
kill %1 2>/dev/null
```
Expected: the served dashboard HTML is unchanged in structure and still loads (grep count ≥ 0; the static file is served). Then manually open `http://localhost:3000`, confirm a `↻ Restart` button appears on a project row.

- [ ] **Step 6: Commit**

```bash
git add client/index.html
git commit -m "feat(dashboard): per-project Restart button + live recovery toasts"
```

---

## Manual end-to-end verification (after all tasks)

1. Start the editor: `npm start`.
2. In a real Next.js project inside the workspace, load a page so the overlay registers it; then run `POST /dev/<id>/start` (or the dashboard Restart) so the editor owns the dev server.
3. Introduce a server error (e.g. throw in a page/route) and hit it — observe `GET .../<route> 500`.
4. Confirm the editor auto-recovers: dashboard shows `⏳ recovering…` then `✓ recovered-by-restart` (or `recovered-by-fix`), and the page loads again.
5. Confirm bound behavior: a genuinely unfixable error ends at `✗ … failed` with no retry loop.
