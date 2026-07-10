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
