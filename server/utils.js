import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

/**
 * Resolve PROJECT_ROOT from the environment into an absolute path.
 * Everything Claude is allowed to touch lives under this folder.
 */
export function getProjectRoot() {
  const raw = process.env.PROJECT_ROOT || '../my-website';
  return path.resolve(process.cwd(), raw);
}

/**
 * Resolve a (possibly relative) file path and guarantee it stays inside
 * PROJECT_ROOT. Throws if the path tries to escape the sandbox.
 */
export function safeResolve(projectRoot, relPath) {
  if (!relPath) throw new Error('No file path provided.');
  // Accept both absolute paths that are already inside the root and relative ones.
  const candidate = path.isAbsolute(relPath)
    ? path.resolve(relPath)
    : path.resolve(projectRoot, relPath);

  const root = path.resolve(projectRoot);
  const rel = path.relative(root, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes PROJECT_ROOT sandbox: ${relPath}`);
  }
  return candidate;
}

/**
 * List files in the project (relative paths), skipping noise folders.
 * Used both for the list_files tool and to help Claude guess the target file.
 */
export async function listProjectFiles(projectRoot, { maxEntries = 400 } = {}) {
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache']);
  const out = [];

  async function walk(dir) {
    if (out.length >= maxEntries) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        out.push(path.relative(projectRoot, full));
      }
    }
  }

  await walk(projectRoot);
  return out.sort();
}

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

/**
 * Append a record to tasks.json (created next to the server).
 */
const TASKS_FILE = path.resolve(process.cwd(), 'tasks.json');

export function readTasks() {
  try {
    if (!fs.existsSync(TASKS_FILE)) return [];
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

export function appendTask(task) {
  const tasks = readTasks();
  tasks.unshift(task); // newest first
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks.slice(0, 200), null, 2));
  } catch (err) {
    console.error('Could not write tasks.json:', err.message);
  }
  return task;
}
