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
