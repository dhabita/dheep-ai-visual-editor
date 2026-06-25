import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildPrompt } from './utils.js';

// We drive the local Claude Code CLI in headless mode. It uses your existing
// CLI login (subscription) — no ANTHROPIC_API_KEY required — and edits files
// directly with its own tools inside PROJECT_ROOT (the spawn cwd).

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const MODEL = process.env.CLAUDE_MODEL || 'sonnet'; // alias → latest Sonnet
const PERMISSION_MODE = process.env.PERMISSION_MODE || 'acceptEdits';
const TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS || 240000);

// Tools Claude is allowed to use for an edit. File ops only — no Bash/web.
const ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep'];

const SYSTEM_PROMPT = `You are editing files in a live web project.
- Edit files directly. Never ask for confirmation — just make the change.
- Never delete or rewrite code you were not asked to touch. Make the smallest edit that satisfies the task.
- Read a file before editing it so your changes are precise.
- When done, reply with a 1-2 sentence summary of exactly what you changed.`;

/**
 * Run an edit by spawning the Claude CLI and parsing its stream-json output.
 * `emit(event, data)` forwards progress to the browser over SSE.
 * Returns { summary, editedFiles }.
 */
export function runTask({ prompt, context, projectRoot, sessionId }, emit) {
  if (!projectRoot) throw new Error('runTask requires a projectRoot.');
  const fullPrompt = buildPrompt({ prompt, context }, projectRoot);

  const args = [
    '-p', fullPrompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--model', MODEL,
    '--permission-mode', PERMISSION_MODE,
    '--allowedTools', ...ALLOWED_TOOLS,
    '--append-system-prompt', SYSTEM_PROMPT,
  ];
  // Continue the same chat thread when the browser sends a prior session id.
  if (sessionId) args.push('--resume', sessionId);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(CLAUDE_BIN, args, {
        cwd: projectRoot,
        env: process.env,
      });
    } catch (err) {
      reject(new Error(`Could not launch '${CLAUDE_BIN}': ${err.message}`));
      return;
    }

    const editedFiles = new Set();
    let summary = '';
    let stderr = '';
    let stdoutTail = '';
    let capturedSession = sessionId || null;
    let capturedUsage = null;
    let settled = false;

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, new Error(`Claude CLI timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    // Parse newline-delimited JSON from stdout.
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handleEvent(line);
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => {
      finish(reject, new Error(`Failed to run Claude CLI: ${err.message}`));
    });

    child.on('close', (code) => {
      if (buffer.trim()) handleEvent(buffer.trim());
      if (settled) return;
      if (summary || editedFiles.size || code === 0) {
        finish(resolve, {
          summary: summary.trim(),
          editedFiles: [...editedFiles],
          sessionId: capturedSession,
          usage: capturedUsage,
        });
      } else {
        const msg = (stderr || stdoutTail || `Claude CLI exited with code ${code}`).trim();
        finish(reject, new Error(msg.slice(0, 600)));
      }
    });

    function relFile(p) {
      if (!p) return p;
      const rel = path.relative(projectRoot, path.resolve(projectRoot, p));
      return rel.startsWith('..') ? p : rel;
    }

    function handleEvent(line) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        stdoutTail = line; // non-JSON (rare) — keep for error context
        return;
      }

      // The CLI emits its session id on most events — capture it for resume.
      if (ev.session_id) capturedSession = ev.session_id;

      switch (ev.type) {
        case 'assistant': {
          const blocks = ev.message?.content || [];
          for (const b of blocks) {
            if (b.type === 'text' && b.text) {
              summary = b.text; // last text block is the summary
              emit('text', { delta: b.text });
            } else if (b.type === 'tool_use') {
              const file = b.input?.file_path || b.input?.path || b.input?.notebook_path;
              emit('tool', { name: b.name, input: redact(b.name, b.input) });
              if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name) && file) {
                const rel = relFile(file);
                editedFiles.add(rel);
                emit('edited', { file: rel });
              }
            }
          }
          break;
        }
        case 'result': {
          if (typeof ev.result === 'string' && ev.result.trim()) summary = ev.result;
          capturedUsage = extractUsage(ev);
          if (capturedUsage) emit('usage', capturedUsage);
          if (ev.is_error) {
            finish(reject, new Error(ev.result || ev.subtype || 'Claude CLI reported an error'));
          }
          break;
        }
        case 'system':
          // The CLI emits this when it auto-compacts a large conversation.
          if (ev.subtype && /compact/i.test(ev.subtype)) {
            const meta = ev.compact_metadata || {};
            emit('compacted', { trigger: meta.trigger || null, preTokens: meta.pre_tokens || null });
          }
          break;
        default:
          break;
      }
    }
  });
}

/**
 * Pull context-window usage out of the CLI's `result` event. The total input
 * (uncached + cached) approximates how full the conversation context is.
 */
function extractUsage(ev) {
  const u = ev.usage || {};
  const contextTokens =
    (u.input_tokens || 0) +
    (u.cache_read_input_tokens || 0) +
    (u.cache_creation_input_tokens || 0);
  let contextWindow = 200000;
  const mu = ev.modelUsage && Object.values(ev.modelUsage)[0];
  if (mu && mu.contextWindow) contextWindow = mu.contextWindow;
  if (!contextTokens && !u.output_tokens) return null;
  return {
    contextTokens,
    contextWindow,
    pct: contextWindow ? Math.min(100, Math.round((contextTokens / contextWindow) * 100)) : null,
    outputTokens: u.output_tokens || 0,
    costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
  };
}

/** Keep large tool inputs out of the SSE trace shown in the popup. */
function redact(name, input = {}) {
  const file = input.file_path || input.path;
  if (name === 'Write') return { file_path: file, content: `(${(input.content || '').length} bytes)` };
  if (name === 'Edit' || name === 'MultiEdit') return { file_path: file };
  if (name === 'Read') return { file_path: file };
  return input;
}
