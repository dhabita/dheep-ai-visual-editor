import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';

const WATCH_EXT = /\.(html?|css|js|jsx|ts|tsx|vue|svelte)$/i;

/**
 * Start one WebSocket server that serves every project, plus a chokidar watcher
 * per project root. Each browser connects with ?project=<id>; a file change in
 * a project only reloads the browsers tied to that project.
 *
 * @param {number} port
 * @param {Map<string,{id:string,root:string}>} projects
 * @param {(projectId:string, file:string)=>void} [onChange] notified on each change
 * @param {(projectId:string, origin:string)=>void} [onClient] notified when a project page connects (with its origin/port)
 */
export function startHotReload(port, projects, onChange, onClient) {
  const wss = new WebSocketServer({ port });

  // Tag each socket with the project id from its connection URL, and report the
  // page's origin (e.g. http://localhost:3006) so we know the project's dev port.
  wss.on('connection', (ws, req) => {
    let projectId = null;
    try {
      const url = new URL(req.url, 'http://localhost');
      projectId = url.searchParams.get('project');
    } catch { /* ignore */ }
    ws.aveProject = projectId;
    const origin = req.headers.origin || null;
    if (projectId && origin && typeof onClient === 'function') {
      try { onClient(projectId, origin); } catch { /* ignore */ }
    }
  });

  function broadcast(projectId, payload) {
    const msg = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState !== 1 /* OPEN */) continue;
      // Send to clients of this project (or untagged clients, for single-project setups).
      if (!client.aveProject || client.aveProject === projectId) client.send(msg);
    }
  }

  const watchers = new Map(); // id → watcher

  /** Start watching a project root; safe to call again (no-op if already watched). */
  function watch(id, root) {
    if (watchers.has(id)) return;
    const watcher = chokidar.watch(root, {
      ignored: (p) => /node_modules|\.git|dist|build|\.next/.test(p),
      ignoreInitial: true,
      persistent: true,
    });

    let debounce = null;
    const onChange = (filePath) => {
      if (!WATCH_EXT.test(filePath)) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        console.log(`[hotreload] (${id}) change: ${filePath} → reload`);
        broadcast(id, { type: 'reload', project: id, file: filePath });
        if (typeof onChange === 'function') {
          try { onChange(id, filePath); } catch { /* ignore */ }
        }
      }, 120);
    };

    watcher.on('change', onChange).on('add', onChange);
    watchers.set(id, watcher);
    console.log(`[hotreload] watching [${id}] ${root}`);
  }

  for (const { id, root } of projects.values()) watch(id, root);

  console.log(`[hotreload] WebSocket on ws://localhost:${port} (${projects.size} project(s))`);

  return {
    notify: (projectId, file) => broadcast(projectId, { type: 'reload', project: projectId, file }),
    watch,
    close: () => {
      watchers.forEach((w) => w.close());
      wss.close();
    },
  };
}
