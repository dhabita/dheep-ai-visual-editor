/* ===== overlay.js — main controller =====
   Toggle with Ctrl+Shift+E. Concatenated last in the bundle, so the helpers
   from highlight.js and popup.js are already defined. */

let aveActive = false;
let aveHoverEl = null;

/** Build a reasonably unique CSS selector for an element. */
function aveGetSelector(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id) return `#${CSS.escape(el.id)}`;

  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body && parts.length < 4) {
    let part = node.tagName.toLowerCase();
    const cls = Array.from(node.classList)
      .filter((c) => !c.startsWith('ave-'))
      .slice(0, 2);
    if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');

    // Disambiguate among same-type siblings with :nth-of-type.
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter(
        (c) => c.tagName === node.tagName
      );
      if (sameTag.length > 1) {
        part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
    }
    parts.unshift(part);
    if (node.id) {
      parts[0] = `#${CSS.escape(node.id)}`;
      break;
    }
    node = node.parentElement;
  }
  return parts.join(' > ');
}

/** Pull the 10 most relevant computed styles. */
function aveCollectCss(el) {
  const cs = window.getComputedStyle(el);
  const keys = [
    'display', 'position', 'color', 'background-color', 'background',
    'font-size', 'font-weight', 'padding', 'margin', 'border-radius',
  ];
  const out = {};
  for (const k of keys) {
    const v = cs.getPropertyValue(k);
    if (v) out[k] = v.trim();
  }
  return out;
}

/** Guess which source file owns this element. */
function aveGuessFile(el) {
  // 1. explicit hint
  const withAttr = el.closest('[data-file]');
  if (withAttr) return withAttr.getAttribute('data-file');
  // 2. fall back to the current page path.
  let p = window.location.pathname;
  if (!p || p === '/' || p.endsWith('/')) p += 'index.html';
  return p.replace(/^\//, '');
}

/** Distinctive element text — the strongest search signal. */
function aveCollectText(el) {
  const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, 200);
}

/** Compact ancestor chain, e.g. "main.content > section.hero". */
function aveParentChain(el, levels = 3) {
  const parts = [];
  let node = el.parentElement;
  while (node && node !== document.body && parts.length < levels) {
    let part = node.tagName.toLowerCase();
    const cls = Array.from(node.classList)
      .filter((c) => !c.startsWith('ave-'))
      .slice(0, 2);
    if (cls.length) part += '.' + cls.join('.');
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

/** Notable attributes that help locate the source. */
function aveCollectAttrs(el) {
  const out = {};
  for (const name of ['href', 'src', 'alt', 'aria-label', 'title', 'placeholder', 'type', 'name']) {
    const v = el.getAttribute && el.getAttribute(name);
    if (v) out[name] = String(v).slice(0, 120);
  }
  for (const a of el.attributes || []) {
    if (a.name.startsWith('data-') && a.name !== 'data-file' && Object.keys(out).length < 12) {
      out[a.name] = String(a.value).slice(0, 120);
    }
  }
  return out;
}

/** Best-effort source file/line from framework dev-mode metadata. */
function aveSourceHint(el) {
  try {
    // React (dev builds): walk the fiber tree for _debugSource.
    for (const key of Object.keys(el)) {
      if (!key.startsWith('__reactFiber$')) continue;
      let fiber = el[key];
      for (let i = 0; fiber && i < 10; i++) {
        const src = fiber._debugSource;
        if (src && src.fileName) return { file: String(src.fileName), line: src.lineNumber || null };
        fiber = fiber.return;
      }
    }
  } catch { /* ignore */ }
  try {
    // Svelte (dev builds)
    const meta = el.__svelte_meta;
    if (meta && meta.loc && meta.loc.file) return { file: String(meta.loc.file), line: meta.loc.line || null };
  } catch { /* ignore */ }
  try {
    // Vue (dev builds)
    const comp = el.__vueParentComponent;
    const file = comp && comp.type && comp.type.__file;
    if (file) return { file: String(file), line: null };
  } catch { /* ignore */ }
  return null;
}

/** Which framework rendered this page (best effort). */
function aveDetectFramework(el) {
  try {
    if (window.__NEXT_DATA__ || window.next) return 'next';
    if (window.__NUXT__ || window.useNuxtApp) return 'nuxt';
    if (document.querySelector('[data-sveltekit-preload-data]')) return 'sveltekit';
    if (document.querySelector('astro-island, [data-astro-cid]')) return 'astro';
    if (el && Object.keys(el).some((k) => k.startsWith('__reactFiber$'))) return 'react';
    if (el && el.__vueParentComponent) return 'vue';
  } catch { /* ignore */ }
  return null;
}

/** Collect everything Claude needs about the clicked element. */
function aveCollectContext(el) {
  let html = el.outerHTML || '';
  if (html.length > 2000) html = html.slice(0, 2000) + '…(truncated)';
  return {
    selector: aveGetSelector(el),
    classList: Array.from(el.classList).filter((c) => !c.startsWith('ave-')),
    html,
    css: aveCollectCss(el),
    file: aveGuessFile(el),
    text: aveCollectText(el),
    parents: aveParentChain(el),
    attrs: aveCollectAttrs(el),
    sourceHint: aveSourceHint(el),
    framework: aveDetectFramework(el),
  };
}

// ---- Event handlers ----
function aveOnMove(e) {
  if (!aveActive) return;
  const el = e.target;
  if (aveIsIgnored(el)) {
    aveHideHighlight();
    aveHoverEl = null;
    return;
  }
  aveHoverEl = el;
  aveShowHighlight(el);
}

function aveOnClick(e) {
  if (!aveActive) return;
  const el = e.target;
  if (aveIsIgnored(el)) return; // let clicks inside the popup work
  e.preventDefault();
  e.stopPropagation();
  const ctx = aveCollectContext(el);
  aveAttachElement(ctx); // hand off to the chat sidebar (sidebar.js)
}

function aveOnScrollResize() {
  if (aveActive && aveHoverEl) aveShowHighlight(aveHoverEl);
}

function aveSetActive(on) {
  aveActive = on;
  document.documentElement.style.cursor = on ? 'crosshair' : '';
  if (!on) aveHideHighlight();
  // Keep the sidebar's pick button in sync (sidebar.js owns the button).
  const pick = document.querySelector('#ave-sidebar .ave-sb-pick');
  if (pick) pick.classList.toggle('active', on);
  console.log(`[AVE] overlay ${on ? 'ON' : 'OFF'}`);
}

// ---- Wiring ----
document.addEventListener('mousemove', aveOnMove, true);
document.addEventListener('click', aveOnClick, true);
window.addEventListener('scroll', aveOnScrollResize, true);
window.addEventListener('resize', aveOnScrollResize, true);

document.addEventListener('keydown', (e) => {
  // Ctrl+Shift+E toggles the overlay.
  if (e.ctrlKey && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
    e.preventDefault();
    aveSetActive(!aveActive);
  }
  // Esc turns the picker off (the sidebar stays; minimize it with its — button).
  if (e.key === 'Escape' && aveActive) {
    aveSetActive(false);
  }
});

// ---- Hot reload client ----
(function aveConnectHotReload() {
  const cfg = window.__AVE_CONFIG__ || {};
  if (!cfg.wsUrl) return;
  try {
    const ws = new WebSocket(cfg.wsUrl);
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === 'reload') {
          // Defer reload while a chat task is streaming, so we don't drop the
          // rest of the stream (final summary + session id) and can persist it.
          if (typeof aveSbBusy !== 'undefined' && aveSbBusy) {
            avePendingReload = true;
            console.log('[AVE] change during task — reload deferred until done');
            return;
          }
          console.log('[AVE] reloading after change:', data.file);
          location.reload();
        }
      } catch { /* ignore */ }
    };
    ws.onclose = () => setTimeout(aveConnectHotReload, 1500); // auto-reconnect
  } catch (err) {
    console.warn('[AVE] hot-reload socket failed:', err.message);
  }
})();

// ---- 500 reporter — nudge the editor to auto-recover a broken dev server ----
(function aveWatchErrors() {
  const cfg = window.__AVE_CONFIG__ || {};
  if (!cfg.serverUrl || !cfg.projectId) return;
  let lastReport = 0;
  function report(url, status) {
    const now = Date.now();
    if (now - lastReport < 10000) return; // throttle client-side too
    lastReport = now;
    try {
      fetch(cfg.serverUrl + '/report-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: cfg.projectId, url: String(url), status }),
        keepalive: true,
      }).catch(() => {});
    } catch { /* ignore */ }
  }
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    return origFetch.apply(this, args).then((res) => {
      try {
        const u = new URL(res.url, location.href);
        if (u.origin === location.origin && res.status >= 500) report(res.url, res.status);
      } catch { /* ignore */ }
      return res;
    });
  };
})();

console.log('%c[AVE] AI Visual Editor loaded — press Ctrl+Shift+E to start', 'color:#3b82f6;font-weight:bold');
