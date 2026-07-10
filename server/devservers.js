import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { spawn, execFile } from 'node:child_process';

import { recoverProject } from './recovery.js';

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

/**
 * Manage each project's dev server as a tracked child process so a post-edit
 * 500 can be auto-recovered by restarting (and, if needed, a Claude code fix).
 * `projects` is the shared registry Map; `runTask` is the Claude runner;
 * `broadcast(event, data)` mirrors recovery/status events to the dashboard.
 */
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
