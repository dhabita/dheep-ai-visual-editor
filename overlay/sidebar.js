/* ===== sidebar.js — vibe-coding chat panel =====
   Concatenated into the overlay bundle (before overlay.js). Renders a docked
   sidebar with a chat area that talks to the editor server's /task SSE endpoint
   and keeps the Claude session going across messages. */

let aveSb = null;          // root sidebar element
let aveFab = null;         // floating toggle button
let aveSbSession = null;   // CLI session id → continues the conversation
let aveSbAttached = null;  // element context attached to the next message
let aveSbBusy = false;

function aveSbCfg() { return window.__AVE_CONFIG__ || {}; }

function aveInitSidebar() {
  if (document.getElementById('ave-sidebar')) return;
  const cfg = aveSbCfg();

  aveFab = document.createElement('button');
  aveFab.id = 'ave-fab';
  aveFab.title = 'AI Visual Editor';
  aveFab.textContent = '✦';
  aveFab.onclick = () => aveToggleSidebar(true);
  document.body.appendChild(aveFab);

  aveSb = document.createElement('aside');
  aveSb.id = 'ave-sidebar';
  aveSb.innerHTML = `
    <div class="ave-sb-head">
      <span class="ave-sb-dot"></span>
      <span class="ave-sb-title">AI Editor</span>
      <span class="ave-sb-project">${cfg.projectId ? aveSbEsc(cfg.projectId) : ''}</span>
      <button class="ave-sb-min" title="Minimize">—</button>
    </div>
    <div class="ave-sb-msgs"></div>
    <div class="ave-sb-foot">
      <div class="ave-sb-chip" hidden></div>
      <div class="ave-sb-inputrow">
        <button class="ave-sb-pick" title="Pick an element (Ctrl+Shift+E)">◎</button>
        <textarea class="ave-sb-input" rows="1" placeholder="Describe a change…"></textarea>
        <button class="ave-sb-send" title="Send (Enter)">↑</button>
      </div>
      <div class="ave-sb-status"></div>
    </div>`;
  document.body.appendChild(aveSb);

  aveSb.querySelector('.ave-sb-min').onclick = () => aveToggleSidebar(false);
  aveSb.querySelector('.ave-sb-send').onclick = aveSbSend;
  aveSb.querySelector('.ave-sb-pick').onclick = aveSbTogglePick;

  const input = aveSb.querySelector('.ave-sb-input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aveSbSend(); }
  });

  aveSbHint('Pick an element or just describe what you want to change.');
  aveCheckServer();
  aveToggleSidebar(true); // show on load when the script is served (server online)
}

function aveToggleSidebar(open) {
  if (!aveSb) return;
  aveSb.classList.toggle('open', open);
  aveFab.classList.toggle('hide', open);
  // Push the page left instead of covering it.
  document.documentElement.classList.add('ave-push-anim');
  document.documentElement.classList.toggle('ave-pushed', open);
  if (open) setTimeout(() => aveSb.querySelector('.ave-sb-input')?.focus(), 180);
}

/** Toggle the element picker from the sidebar button (delegates to overlay.js). */
function aveSbTogglePick() {
  const willActivate = !aveActive; // aveActive lives in overlay.js
  aveSetActive(willActivate);      // overlay.js
  aveSb.querySelector('.ave-sb-pick').classList.toggle('active', willActivate);
  aveSbStatus(willActivate ? 'Pick an element on the page…' : '');
}

/** Called by overlay.js when an element is clicked in picker mode. */
function aveAttachElement(ctx) {
  aveSbAttached = ctx;
  const chip = aveSb.querySelector('.ave-sb-chip');
  chip.hidden = false;
  chip.innerHTML = `<span class="chip-sel" title="${aveSbEsc(ctx.selector)}">◳ ${aveSbEsc(ctx.selector)}</span><button title="Detach">✕</button>`;
  chip.querySelector('button').onclick = () => { aveSbAttached = null; chip.hidden = true; };

  aveSetActive(false); // turn picker off so the page is usable
  aveSb.querySelector('.ave-sb-pick').classList.remove('active');
  aveToggleSidebar(true);
  aveSbStatus('Element attached — describe the change.');
}

async function aveCheckServer() {
  const dot = aveSb.querySelector('.ave-sb-dot');
  try {
    const r = await fetch((aveSbCfg().serverUrl || '') + '/status');
    const s = await r.json();
    dot.className = 'ave-sb-dot ' + (s.cliAvailable ? 'ok' : 'bad');
    aveSbStatus(s.cliAvailable ? 'Ready' : 'Claude CLI not found on the server', s.cliAvailable ? 'ok' : 'err');
  } catch {
    dot.className = 'ave-sb-dot bad';
    aveSbStatus('Editor server offline', 'err');
  }
}

async function aveSbSend() {
  if (aveSbBusy) return;
  const input = aveSb.querySelector('.ave-sb-input');
  const prompt = input.value.trim();
  if (!prompt) { input.focus(); return; }

  const cfg = aveSbCfg();
  const ctx = aveSbAttached;
  aveSbAddUser(prompt, ctx);
  input.value = '';
  input.style.height = 'auto';

  // Clear the attachment chip.
  aveSbAttached = null;
  aveSb.querySelector('.ave-sb-chip').hidden = true;

  const bubble = aveSbAddAssistant();
  aveSbBusy = true;
  aveSbSetBusy(true);
  aveSbStatus('Claude is working…');

  let res;
  try {
    res = await fetch((cfg.serverUrl || '') + '/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        context: ctx || undefined,
        projectId: cfg.projectId || null,
        sessionId: aveSbSession || undefined,
      }),
    });
  } catch {
    aveSbTrace(bubble, '✗ editor server offline', 't-err');
    aveSbStatus('Server offline', 'err');
    aveSbBusy = false; aveSbSetBusy(false);
    return;
  }

  if (!res.ok || !res.body) {
    let msg = 'Request failed (' + res.status + ')';
    try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
    aveSbTrace(bubble, '✗ ' + msg, 't-err');
    aveSbStatus(msg, 'err');
    aveSbBusy = false; aveSbSetBusy(false);
    return;
  }

  await aveSbConsume(res.body, bubble);
  aveSbBusy = false;
  aveSbSetBusy(false);
}

/** Parse the SSE stream into the assistant bubble. */
async function aveSbConsume(body, bubble) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const md = bubble.querySelector('.ave-md');
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evm = chunk.match(/^event: (.+)$/m);
      const dm = chunk.match(/^data: (.+)$/m);
      if (!dm) continue;
      const event = evm ? evm[1].trim() : 'message';
      let data = {};
      try { data = JSON.parse(dm[1]); } catch {}

      if (event === 'text' && data.delta) {
        md.textContent += data.delta;
      } else if (event === 'tool') {
        aveSbTrace(bubble, `› ${data.name} ${aveSbToolArg(data.input)}`, 't-tool');
      } else if (event === 'edited') {
        aveSbTrace(bubble, `✎ edited ${data.file}`, 't-edit');
      } else if (event === 'tool_error') {
        aveSbTrace(bubble, `✗ ${data.name}: ${data.error}`, 't-err');
      } else if (event === 'done') {
        if (data.sessionId) aveSbSession = data.sessionId;
        if (!md.textContent.trim() && data.summary) md.textContent = data.summary;
        aveSbStatus(data.editedFiles && data.editedFiles.length
          ? `Done ✓ — edited ${data.editedFiles.join(', ')}` : 'Done ✓', 'ok');
      } else if (event === 'error') {
        aveSbTrace(bubble, '✗ ' + (data.message || 'error'), 't-err');
        aveSbStatus('Error', 'err');
      }
      aveSbScroll();
    }
  }
}

/* ---- small render helpers ---- */
function aveSbMsgs() { return aveSb.querySelector('.ave-sb-msgs'); }
function aveSbScroll() { const m = aveSbMsgs(); m.scrollTop = m.scrollHeight; }

function aveSbAddUser(text, ctx) {
  const el = document.createElement('div');
  el.className = 'ave-msg user';
  el.innerHTML = (ctx ? `<div class="ave-ctxnote">◳ ${aveSbEsc(ctx.selector)}</div>` : '') + aveSbEsc(text);
  aveSbMsgs().appendChild(el);
  aveSbScroll();
}

function aveSbAddAssistant() {
  const el = document.createElement('div');
  el.className = 'ave-msg assistant';
  el.innerHTML = `<div class="ave-md"></div><div class="ave-trace"></div>`;
  aveSbMsgs().appendChild(el);
  aveSbScroll();
  return el;
}

function aveSbTrace(bubble, text, cls) {
  const trace = bubble.querySelector('.ave-trace');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  trace.appendChild(line);
}

function aveSbHint(text) {
  const el = document.createElement('div');
  el.className = 'ave-hint';
  el.textContent = text;
  aveSbMsgs().appendChild(el);
}

function aveSbStatus(text, cls) {
  const el = aveSb.querySelector('.ave-sb-status');
  el.className = 'ave-sb-status' + (cls ? ' ' + cls : '');
  el.textContent = text || '';
}

function aveSbSetBusy(busy) {
  aveSb.querySelector('.ave-sb-send').disabled = busy;
}

function aveSbToolArg(input) {
  if (!input) return '';
  const f = input.file_path || input.path || input.pattern || '';
  return f ? `(${f})` : '';
}

function aveSbEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Build the sidebar as soon as this bundle runs (script is at end of <body>).
aveInitSidebar();
