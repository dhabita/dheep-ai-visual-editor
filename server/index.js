import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import express from 'express';
import cors from 'cors';

import { runTask } from './claude.js';
import { startHotReload } from './hotreload.js';
import { readTasks, appendTask } from './utils.js';
import {
  loadProjects,
  discoverProject,
  persistProjects,
  isAllowedRoot,
  getWorkspaceRoots,
} from './projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OVERLAY_DIR = path.join(ROOT, 'overlay');
const CLIENT_DIR = path.join(ROOT, 'client');

const SERVER_PORT = Number(process.env.SERVER_PORT || 3000);
const WS_PORT = Number(process.env.WS_PORT || 3001);

// Project registry (projects.json, or PROJECT_ROOT fallback).
const projects = loadProjects();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// Live dashboard event bus — broadcasts task activity to /events listeners.
// ---------------------------------------------------------------------------
const dashboardClients = new Set(); // open SSE responses
const activeTasks = new Map();      // taskId → live task record
let taskSeq = 0;
const stats = {
  startedAt: Date.now(),
  tasks: 0,
  edits: 0,
  errors: 0,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  activity: [],                     // recent task end timestamps (for the chart)
};

function dashBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of dashboardClients) {
    try { res.write(payload); } catch { /* dropped client */ }
  }
}

function publicStats() {
  return {
    uptimeMs: Date.now() - stats.startedAt,
    tasks: stats.tasks,
    edits: stats.edits,
    errors: stats.errors,
    tokensIn: stats.tokensIn,
    tokensOut: stats.tokensOut,
    costUsd: stats.costUsd,
    activeCount: activeTasks.size,
    activity: stats.activity.slice(-120),
  };
}

// ---------------------------------------------------------------------------
// Hot reload (one WebSocket server, one watcher per project)
// ---------------------------------------------------------------------------
const hot = startHotReload(WS_PORT, projects, (projectId, file) => {
  dashBroadcast('reload', { project: projectId, file, at: Date.now() });
});

/**
 * Make sure a project id is registered. If unknown, try to auto-discover a
 * matching folder under the workspace roots and register it live (watch +
 * persist) — so new projects work with zero manual setup. Returns {id,root} or null.
 */
function ensureProject(id) {
  if (!id) return null;
  if (projects.has(id)) return projects.get(id);
  const root = discoverProject(id);
  if (!root) return null;
  return registerProject(id, root);
}

function registerProject(id, root) {
  const entry = { id, root: path.resolve(root) };
  projects.set(id, entry);
  hot.watch(id, entry.root);
  persistProjects(projects);
  dashBroadcast('project', { id: entry.id, root: entry.root });
  console.log(`[projects] auto-registered "${id}" → ${entry.root}`);
  return entry;
}

// ---------------------------------------------------------------------------
// Overlay delivery — bundle highlight + popup + overlay + CSS into one file,
// with runtime config injected, so the target page needs only one <script>.
// The ?project=<id> query is baked into the bundle so the page knows which
// project it edits and which hot-reload stream to listen to.
// ---------------------------------------------------------------------------
function buildOverlayBundle(projectId) {
  const read = (f) => fs.readFileSync(path.join(OVERLAY_DIR, f), 'utf8');
  const css = read('overlay.css');
  const wsUrl = `ws://localhost:${WS_PORT}` + (projectId ? `?project=${encodeURIComponent(projectId)}` : '');
  const config = {
    serverUrl: `http://localhost:${SERVER_PORT}`,
    wsUrl,
    projectId: projectId || null,
  };
  return [
    `/* AI Visual Editor overlay bundle */`,
    `(function(){`,
    `window.__AVE_CONFIG__ = ${JSON.stringify(config)};`,
    `var __AVE_CSS__ = ${JSON.stringify(css)};`,
    `if(!document.getElementById('ave-style')){var s=document.createElement('style');s.id='ave-style';s.textContent=__AVE_CSS__;document.head.appendChild(s);}`,
    `if(window.__AVE_LOADED__){return;}window.__AVE_LOADED__=true;`,
    read('highlight.js'),
    read('sidebar.js'),
    read('overlay.js'),
    `})();`,
  ].join('\n');
}

app.get('/overlay.js', (req, res) => {
  // ?project=<id>; if omitted and there's exactly one project, use it.
  let projectId = req.query.project;
  if (!projectId && projects.size === 1) projectId = [...projects.keys()][0];
  // Auto-discover + register the project now, so its hot-reload watcher is live
  // even before the first edit — zero manual setup.
  if (projectId) ensureProject(projectId);
  try {
    res.type('application/javascript').send(buildOverlayBundle(projectId));
  } catch (err) {
    res.status(500).type('application/javascript').send(`console.error('AVE overlay failed:', ${JSON.stringify(err.message)});`);
  }
});

// Bookmarklet helper — injects overlay.js (with project id) into any page.
app.get('/bookmarklet.js', (req, res) => {
  const projectId = req.query.project ? `?project=${encodeURIComponent(req.query.project)}` : '';
  const src = `http://localhost:${SERVER_PORT}/overlay.js${projectId}`;
  res
    .type('application/javascript')
    .send(`(function(){var s=document.createElement('script');s.src=${JSON.stringify(src)}+(${JSON.stringify(projectId)}?'&':'?')+'t='+Date.now();document.body.appendChild(s);})();`);
});

// List registered projects.
app.get('/projects', (req, res) => {
  res.json([...projects.values()].map((p) => ({ id: p.id, root: p.root })));
});

// Explicit registration for projects outside the workspace roots.
// Body: { id, root }. Root must be an existing dir inside an allowed base.
app.post('/register', (req, res) => {
  const { id, root } = req.body || {};
  if (!id || !root) {
    res.status(400).json({ error: 'Both "id" and "root" are required.' });
    return;
  }
  if (!isAllowedRoot(root)) {
    res.status(400).json({
      error: `Root is not an allowed directory. Allowed bases: ${getWorkspaceRoots().join(', ')} (override with ALLOWED_PROJECT_ROOTS).`,
    });
    return;
  }
  const entry = registerProject(id, root);
  res.json({ ok: true, id: entry.id, root: entry.root });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.get('/status', (req, res) => {
  const bin = process.env.CLAUDE_BIN || 'claude';
  execFile(bin, ['--version'], { timeout: 4000 }, (err, stdout) => {
    res.json({
      ok: true,
      projects: [...projects.values()].map((p) => ({ id: p.id, root: p.root })),
      workspaceRoots: getWorkspaceRoots(),
      model: process.env.CLAUDE_MODEL || 'sonnet',
      wsPort: WS_PORT,
      cliAvailable: !err,
      cliVersion: err ? null : String(stdout).trim(),
    });
  });
});

app.get('/history', (req, res) => {
  const all = readTasks();
  const { project } = req.query;
  res.json(project ? all.filter((t) => t.project === project) : all);
});

/**
 * POST /task — run an edit. Responds as Server-Sent Events so the popup can
 * show Claude's progress live.
 */
app.post('/task', async (req, res) => {
  const { prompt, context, projectId, sessionId } = req.body || {};
  if (!prompt || !prompt.trim()) {
    res.status(400).json({ error: 'Missing prompt.' });
    return;
  }

  // Resolve which project folder this task targets (auto-discovering if needed).
  let project = null;
  if (projectId) {
    project = ensureProject(projectId); // registered, or discovered under workspace roots
  } else if (projects.size === 1) {
    project = [...projects.values()][0];
  }
  if (!project) {
    const known = [...projects.keys()].join(', ') || '(none)';
    res.status(400).json({
      error: projectId
        ? `Project "${projectId}" is not registered and no matching folder was found under the workspace roots (${getWorkspaceRoots().join(', ')}). Known: ${known}.`
        : `Missing "projectId". Known projects: ${known}.`,
    });
    return;
  }

  // SSE headers.
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  // Live task record mirrored to the dashboard.
  const taskId = `t${++taskSeq}`;
  const task = {
    id: taskId,
    project: project.id,
    prompt: prompt.slice(0, 240),
    selector: context?.selector || null,
    startedAt: Date.now(),
    status: 'running',
    step: 'starting…',
    steps: [],
    editedFiles: [],
    usage: null,
    error: null,
  };
  activeTasks.set(taskId, task);
  dashBroadcast('task:start', task);

  const pushStep = (text, kind) => {
    task.step = text;
    task.steps.push({ t: text, kind, at: Date.now() });
    if (task.steps.length > 40) task.steps.shift();
  };

  const emit = (event, data) => {
    // Stream to the initiating browser.
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    // Mirror to the dashboard.
    if (event === 'text' && data.delta) task.step = 'thinking…';
    else if (event === 'tool') pushStep(`${data.name} ${dashToolArg(data.input)}`.trim(), 'tool');
    else if (event === 'edited') { task.editedFiles.push(data.file); pushStep(`edited ${data.file}`, 'edit'); }
    else if (event === 'tool_error') pushStep(`error: ${data.name}`, 'err');
    else if (event === 'compacted') pushStep('context auto-compacted', 'compact');
    else if (event === 'usage') task.usage = data;
    dashBroadcast('task:update', task);
  };

  const startedAt = new Date().toISOString();
  emit('start', { startedAt, project: project.id });

  try {
    const { summary, editedFiles, sessionId: newSession, usage } = await runTask(
      { prompt, context, projectRoot: project.root, sessionId },
      emit
    );

    appendTask({
      time: startedAt,
      project: project.id,
      prompt,
      selector: context?.selector || null,
      file: context?.file || null,
      editedFiles,
      summary,
    });

    // Nudge this project's browsers to reload even if the watcher missed it.
    if (editedFiles.length) hot.notify(project.id, editedFiles[0]);

    emit('done', { summary, editedFiles, sessionId: newSession, usage });

    // Update dashboard task + cumulative stats.
    task.status = 'done';
    task.endedAt = Date.now();
    task.summary = summary;
    stats.tasks += 1;
    stats.edits += editedFiles.length;
    if (usage) { stats.tokensIn += usage.contextTokens || 0; stats.tokensOut += usage.outputTokens || 0; if (usage.costUsd) stats.costUsd += usage.costUsd; }
    stats.activity.push(task.endedAt);
    dashBroadcast('task:end', task);
  } catch (err) {
    console.error(`[task:${project.id}] error:`, err);
    emit('error', { message: err.message });
    task.status = 'error';
    task.endedAt = Date.now();
    task.error = err.message;
    stats.errors += 1;
    stats.activity.push(task.endedAt);
    dashBroadcast('task:end', task);
  } finally {
    res.end();
    // Keep finished tasks visible briefly, then drop from the active list.
    setTimeout(() => {
      activeTasks.delete(taskId);
      dashBroadcast('task:remove', { id: taskId });
    }, 10000);
  }
});

function dashToolArg(input) {
  if (!input) return '';
  const f = input.file_path || input.path || input.pattern || '';
  return f ? `(${f})` : '';
}

/**
 * GET /events — live dashboard feed (SSE). Sends an initial snapshot, then
 * task:start / task:update / task:end / task:remove / reload / project events.
 */
app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  res.write(`event: hello\ndata: ${JSON.stringify({
    activeTasks: [...activeTasks.values()],
    projects: [...projects.values()].map((p) => ({ id: p.id, root: p.root })),
    stats: publicStats(),
    server: { model: process.env.CLAUDE_MODEL || 'sonnet', wsPort: WS_PORT, serverPort: SERVER_PORT },
  })}\n\n`);

  dashboardClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 25000);
  req.on('close', () => { clearInterval(ping); dashboardClients.delete(res); });
});

// Optional dashboard.
app.use('/', express.static(CLIENT_DIR));

app.listen(SERVER_PORT, () => {
  console.log(`\n  AI Visual Editor`);
  console.log(`  ▸ server   http://localhost:${SERVER_PORT}`);
  if (projects.size === 0) {
    console.log(`  ▸ projects (none yet) — new ones auto-register on first use`);
  } else {
    for (const { id, root } of projects.values()) {
      console.log(`  ▸ project  [${id}]  →  ${root}`);
    }
  }
  console.log(`  ▸ workspace ${getWorkspaceRoots().join(', ')} (auto-discovery)`);
  console.log(`  ▸ shortcut  Ctrl+Shift+E to toggle the overlay\n`);
});
