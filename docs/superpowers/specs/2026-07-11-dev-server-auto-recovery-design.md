# Dev Server Auto-Recovery — Design

**Date:** 2026-07-11
**Component:** dheep-ai-visual-editor (server + overlay + dashboard)

## Problem

When the editor edits a project's source (via Claude), the project's Next.js dev
server sometimes ends up serving `500 (Internal Server Error)` — e.g.
`GET http://localhost:3002/dashboard/profile 500`. Most of the time this is a
wedged dev server or a stale `.next` compile cache after an update, not a real
code defect. Today the editor does nothing about it: the user has to notice the
500 and restart the dev server by hand.

Goal: the editor should be **smart** — detect the 500, recover automatically by
restarting the dev server on the project's port, and only if that fails, capture
the error and ask Claude to fix the code, then restart again.

## Non-Goals

- Managing production servers or deploys. Development only.
- Supporting non-`.next` cache clearing for arbitrary stacks. `.next` clearing is
  Next.js-specific; other stacks get restart-only.
- Infinite retry / self-healing loops. Recovery is bounded (see State Machine).

## Decisions (from brainstorming)

1. **Meaning of "fix":** restart first; escalate to Claude only if a clean
   restart doesn't clear the 500.
2. **Dev-server ownership:** the editor **owns** each project's dev-server
   process (spawns it as a tracked child), so it can kill+restart cleanly and
   capture error output. Users no longer launch dev manually for managed projects.
3. **Recovery trigger:** two complementary paths — overlay reports 500s from the
   browser, AND the server auto-probes the project URL after each edit task.

## Architecture

### New module: `server/devservers.js`

Single responsibility: run, monitor, and restart each project's dev server as a
child process, and drive the recovery state machine.

State: in-memory `Map<projectId, DevServer>` alongside the existing `projects`
Map in `server/index.js`.

`DevServer` record:
- `child` — the spawned dev process (or null when stopped)
- `port` — the port the dev server was launched on
- `command` / `args` / `cwd` — how to (re)spawn
- `stack` — detected stack (`next` | `vite` | `other`)
- `logRing` — ring buffer of the last ~200 lines of stdout/stderr (for error capture)
- `status` — `stopped | starting | running | recovering | failed`
- `lastError` — last captured error summary
- `recoveryLock` — guards against concurrent/looping recovery
- `cooldownUntil` — timestamp; recovery for this project is suppressed until then

Command detection:
- Package manager from lockfile: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn,
  else npm.
- Dev script from `package.json` `scripts.dev`.
- Stack from deps/config (`next` dependency or `next.config.*` → `next`; `vite`
  → `vite`; else `other`).
- For Next.js, the port is forced explicitly (`next dev -p <port>`) so the editor
  always knows it and it stays consistent with the project `origin`.
- Port selection: reuse the port from the known `origin` if present; otherwise
  allocate a free port and adopt it as the origin.

### Recovery state machine: `recoverProject(projectId)`

Concurrency: a `recoveryLock` per project ensures one recovery at a time; new
triggers while recovering are ignored. After a recovery completes, a short
`cooldown` suppresses immediate re-triggers.

Steps:

1. **Probe** the project `origin`. If healthy (not 5xx) → stop, no action.
2. **Clean restart:** kill `child` + anything still listening on the port →
   remove `.next` (Next.js only; skipped for other stacks) → re-spawn dev server
   → wait for the port to be ready (poll `probePort`, timeout ~60s).
3. **Re-probe** the URL that returned 500.
   - Healthy → done, report `recovered by restart`.
   - Still 5xx → step 4.
4. **Escalate to Claude (once):** pull the error from the dev server log ring
   (+ 500 response body if available), build a fix prompt, run `runTask` on the
   project (reusing `lastSession`), then **restart again** and probe.
   - Healthy → done, report `recovered by fix`.
   - Still 5xx → **stop**, mark `recovery:failed`, surface the error to the
     dashboard + reporting overlay. No further automatic retries.

Bound: **max 1 fix cycle** per trigger; the per-project cooldown gates the next
cycle.

All transitions broadcast to the dashboard via `dashBroadcast` as new events
(`recovery:start` / `recovery:step` / `recovery:end`) and are returned to the
overlay that reported the error.

## Triggers

1. **Auto after edit** — in `server/index.js`, in `POST /task`, after a task
   succeeds (`emit('done')`), if the project has an `origin`, schedule a short
   probe (~1.5s delay so HMR can compile). If 5xx → `recoverProject(project.id)`.

2. **Overlay report** — new endpoint `POST /report-error { projectId, url, status }`.
   The overlay bundle installs a lightweight catcher: a `window`
   `error` listener for resources plus a patched `fetch`/navigation hook that
   reports responses with status ≥ 500 on the project origin (throttled). The
   server calls `recoverProject`.

## Endpoints

- `POST /report-error` — `{ projectId, url, status }`; throttled; triggers recovery.
- `POST /dev/:id/start` · `POST /dev/:id/restart` · `POST /dev/:id/stop` —
  manual dev-server control (used by the dashboard).
- `GET /projects/status` (existing) extended to include
  `dev: { managed, running, port, lastError }`.

## Overlay changes (`overlay/`)

Add a small error catcher to the bundle: patch `fetch` and listen for resource
`error`/navigation failures; when a response on the project origin is ≥ 500,
`POST /report-error` (throttled, deduped by url+status within a window).

## Dashboard changes (`client/`)

- Start/Restart/Stop buttons per project.
- Live recovery status indicator driven by the `recovery:*` broadcast events.

## Error handling

- Dev command not detectable → skip management for that project, report clearly,
  don't crash.
- Spawn failure / port not ready within timeout → mark `failed`, never hang.
- Total recovery failure → one notification, then stop (no loop).

## Testing

- **Unit:** package-manager/command detection + port parsing; `recoverProject`
  state machine with `probePort`/spawn mocked across scenarios
  (healthy-immediately / healthy-after-restart / needs-fix / total-failure);
  `/report-error` throttle.
- **Manual:** a real Next.js project on port 3002, inject an error, observe the
  automatic restart and (if needed) Claude fix.
