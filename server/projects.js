import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REGISTRY_FILE = path.join(ROOT, 'projects.json');

/**
 * Load the project registry.
 *
 * Source of truth is projects.json at the repo root, e.g.:
 *   { "nimbus": "./example-site", "shop": "../my-shop" }
 * (an array of paths also works — the basename becomes the id).
 *
 * If projects.json is absent, we fall back to the single PROJECT_ROOT env var
 * under the id "default", so the old single-project setup keeps working.
 *
 * Returns a Map<id, { id, root }> with absolute, de-duplicated roots.
 */
export function loadProjects() {
  const map = new Map();
  const add = (id, rawPath) => {
    const root = path.resolve(ROOT, rawPath);
    const safeId = String(id).trim();
    if (safeId) map.set(safeId, { id: safeId, root });
  };

  if (fs.existsSync(REGISTRY_FILE)) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    } catch (err) {
      console.error(`[projects] could not parse projects.json: ${err.message}`);
      data = null;
    }
    if (Array.isArray(data)) {
      for (const p of data) add(path.basename(p), p);
    } else if (data && typeof data === 'object') {
      for (const [id, p] of Object.entries(data)) add(id, p);
    }
  }

  // Fallback / always-available default from env.
  if (map.size === 0 && process.env.PROJECT_ROOT) {
    add('default', process.env.PROJECT_ROOT);
  }

  return map;
}

/** Resolve a projectId to its absolute root. Throws if unknown. */
export function resolveProject(projects, projectId) {
  // No id given → use the only project if there's exactly one.
  if (!projectId) {
    if (projects.size === 1) return [...projects.values()][0];
    throw new Error(
      `Missing "projectId" — known projects: ${[...projects.keys()].join(', ') || '(none)'}`
    );
  }
  const found = projects.get(projectId);
  if (!found) {
    throw new Error(
      `Unknown projectId "${projectId}" — known projects: ${[...projects.keys()].join(', ') || '(none)'}`
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Zero-config auto-discovery: find a project folder by id under "workspace
// roots", so a new project just works with ?project=<folder-name> — no manual
// projects.json edit and no server restart.
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache', '.turbo',
  '.vercel', 'coverage', 'out', '.svelte-kit', '.nuxt',
]);

/**
 * Base directories searched by discoverProject().
 * Configure with WORKSPACE_ROOTS (comma/colon-separated); defaults to the
 * folder that contains this editor repo (e.g. ~/Documents/GitHub).
 */
export function getWorkspaceRoots() {
  const env = process.env.WORKSPACE_ROOTS;
  if (env) {
    return env
      .split(/[,:]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => path.resolve(ROOT, s));
  }
  return [path.dirname(ROOT)];
}

/**
 * Search the workspace roots for a directory whose name === id (depth-limited,
 * skipping heavy/build dirs). Returns the absolute path, or null.
 */
export function discoverProject(id, { maxDepth = 4 } = {}) {
  if (!id || /[\\/]/.test(id) || id === '.' || id === '..') return null;
  for (const base of getWorkspaceRoots()) {
    const hit = findDir(base, id, maxDepth);
    if (hit) return hit;
  }
  return null;
}

function findDir(dir, name, depth) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  // Breadth-first: prefer the shallowest match.
  const subdirs = entries.filter(
    (e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')
  );
  for (const e of subdirs) {
    if (e.name === name) return path.join(dir, name);
  }
  for (const e of subdirs) {
    const found = findDir(path.join(dir, e.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

/** Persist the current registry back to projects.json (absolute paths). */
export function persistProjects(projects) {
  try {
    const obj = {};
    for (const { id, root } of projects.values()) obj[id] = root;
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(obj, null, 2) + '\n');
  } catch (err) {
    console.error(`[projects] could not persist projects.json: ${err.message}`);
  }
}

/** Is `root` an existing directory inside one of the allowed base dirs? */
export function isAllowedRoot(root) {
  const abs = path.resolve(root);
  try {
    if (!fs.statSync(abs).isDirectory()) return false;
  } catch {
    return false;
  }
  // ALLOWED_PROJECT_ROOTS overrides; otherwise allow the workspace roots.
  const env = process.env.ALLOWED_PROJECT_ROOTS;
  const bases = env
    ? env.split(/[,:]+/).map((s) => path.resolve(ROOT, s.trim())).filter(Boolean)
    : getWorkspaceRoots();
  return bases.some((base) => {
    const rel = path.relative(base, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}
