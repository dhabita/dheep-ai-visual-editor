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
 * Build the full prompt Claude receives, combining the user's task with the
 * collected element context. Kept deliberately explicit and readable.
 */
export function buildPrompt({ prompt, context = {} }, projectRoot) {
  const { selector, html, css, file, classList } = context;
  const lines = [];

  lines.push('You are editing a live website project.');
  lines.push(`Project root: ${projectRoot}`);
  if (file) {
    lines.push(`Best guess for the file to edit: ${file}`);
    lines.push('(If this guess is wrong, use list_files / read_file to find the right one.)');
  }
  lines.push('');
  lines.push('--- Clicked element context ---');
  if (selector) lines.push(`CSS selector: ${selector}`);
  if (classList && classList.length) lines.push(`classList: ${classList.join(', ')}`);
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
  lines.push(`TASK: ${prompt}`);
  lines.push('');
  lines.push('Find the relevant source, make the edit directly, and save the file now.');

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
