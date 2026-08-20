// content.js — injects export buttons into claude.ai

function setIconFill() {}

// ── CSS injected once ────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('cce-styles')) return;
  const s = document.createElement('style');
  s.id = 'cce-styles';
  s.textContent = `
    [data-cce="chat-export"],
    [data-cce="chat-copy"],
    [data-cce="sel-export"] {
      background: #2e2e2e !important;
      border-radius: 8px !important;
    }
    [data-cce="chat-export"] {
      position: relative;
      right: 1.5px;
    }
    [data-cce="chat-copy"] {
      position: relative;
      right: 3px;
    }
    [data-cce="chat-export"]:hover,
    [data-cce="chat-copy"]:hover,
    [data-cce="sel-export"]:hover {
      background: #383838 !important;
    }

    .cce-progress-bar-wrap {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      top: calc(100% + 6px);
      z-index: 9999;
      background: #1e1e1e;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 8px 10px 6px;
      width: 220px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      transition: opacity 0.2s;
    }
    .cce-progress-label {
      font-size: 10px;
      color: #aaa;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      margin-bottom: 5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .cce-progress-track {
      width: 100%;
      height: 3px;
      background: #2e2e2e;
      border-radius: 2px;
      overflow: hidden;
    }
    .cce-progress-fill {
      height: 100%;
      background: #7a9a7a;
      border-radius: 2px;
      width: 0%;
      transition: width 0.3s ease;
    }
  `;
  document.head.appendChild(s);
}

// ── Global progress state ────────────────────────────────────────────────────

let _progressPct = 0;
let _progressLabel = '';
let _progressBars = [];

function _updateAllBars() {
  for (const b of _progressBars) {
    if (!b || !b.fill) continue;
    b.fill.style.width = (_progressPct * 100).toFixed(1) + '%';
    if (b.label) b.label.textContent = _progressLabel;
  }
  try {
    chrome.storage.local.set({ cce_progress: { pct: _progressPct, label: _progressLabel } });
  } catch(e) {}
}

window.cceProgress = function(phase, current, total, label) {
  const pct = total > 0 ? Math.min(current / total, 1) : 0;
  _progressPct = pct;

  if (phase === 'image') {
    _progressLabel = `OCR: ${label} (${current + 1}/${total})`;
  } else if (phase === 'message') {
    _progressLabel = `Processing messages… (${current + 1}/${total})`;
  } else if (phase === 'conv') {
    _progressLabel = `Chat ${current + 1}/${total}: ${label}`;
  } else if (phase === 'zipping') {
    _progressLabel = label;
  } else if (phase === 'done') {
    _progressLabel = 'Done';
    _progressPct = 1;
  } else if (phase === 'start') {
    _progressLabel = `Starting: ${label}`;
    _progressPct = 0;
  }

  document.querySelectorAll('[data-cce]').forEach(btn => setIconFill(btn, _progressPct));
  _updateAllBars();
};

// ── Progress bar factory ─────────────────────────────────────────────────────

function createProgressBar(anchorEl) {
  const wrap  = document.createElement('div');
  wrap.className = 'cce-progress-bar-wrap';

  const lbl   = document.createElement('div');
  lbl.className = 'cce-progress-label';
  lbl.textContent = 'Starting…';

  const track = document.createElement('div');
  track.className = 'cce-progress-track';

  const fill  = document.createElement('div');
  fill.className = 'cce-progress-fill';

  track.appendChild(fill);
  wrap.appendChild(lbl);
  wrap.appendChild(track);

  const bar = { wrap, fill, label: lbl };
  _progressBars.push(bar);

  anchorEl.style.position = 'relative';
  anchorEl.appendChild(wrap);

  return bar;
}

function removeProgressBar(bar) {
  _progressBars = _progressBars.filter(b => b !== bar);
  bar.wrap?.remove();
}

// ── Settings ─────────────────────────────────────────────────────────────────

const CONTENT_DEFAULTS = {
  format:   'md',
  thinking: false,
  tools:    true,
  images:   true,
  ocr:      false,
  zip:      true,
  zipFiles: true,
};

function loadContentSettings() {
  return new Promise(resolve =>
    chrome.storage.sync.get(CONTENT_DEFAULTS, resolve)
  );
}

function sendToBackground(action, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...extra }, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res || !res.success) return reject(new Error(res?.error || 'unknown error'));
      resolve(res);
    });
  });
}

async function getOrgId() {
  const res = await sendToBackground('detectOrgId');
  return res.orgId;
}

function extractConvIdFromUrl(url) {
  const m = url.match(/\/chat\/([a-f0-9-]{36})/i);
  return m ? m[1] : null;
}

function getCurrentChatId() {
  return extractConvIdFromUrl(window.location.href);
}

// ── Cancel button detection — scoped to /chats selection bar only ────────────
// The selection bar Cancel only appears when conversations are checked.
// The message-edit Cancel appears when editing a human message in a chat.
// Definitive discriminator: if no checkboxes are checked, whatever Cancel
// button exists on screen is NOT the selection bar — don't touch it.

function findCancelButton() {
  const hasChecked = document.querySelector('input[type="checkbox"]:checked');
  if (!hasChecked) return null;

  return Array.from(document.querySelectorAll('button[data-cds="Button"]')).find(btn => {
    const span = btn.querySelector('span.inline-flex');
    return span && span.textContent.trim() === 'Cancel';
  }) || null;
}

function getSelectedConvIds() {
  const ids = [];
  document.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
    let el = cb.parentElement;
    while (el && el !== document.body) {
      const anchor = el.querySelector('a[href*="/chat/"]');
      if (anchor) {
        const id = extractConvIdFromUrl(anchor.href);
        if (id && !ids.includes(id)) ids.push(id);
        break;
      }
      el = el.parentElement;
    }
  });
  console.log('[cce] selected conv ids:', ids);
  return ids;
}

// ── Export runners ────────────────────────────────────────────────────────────

async function runExport(btn, exportFn) {
  if (btn) { btn.style.opacity = '0.5'; btn.style.pointerEvents = 'none'; }

  setIconFill(btn, 0);
  _progressPct = 0;
  _progressLabel = 'Starting…';

  const anchor = btn?.parentElement || btn;
  const bar = anchor ? createProgressBar(anchor) : null;

  try {
    await ensureLibs();
    await exportFn();
  } catch (err) {
    console.error('[cce] export failed:', err.message);
    if (bar) { bar.label.textContent = 'Error: ' + err.message; }
  } finally {
    if (btn) { btn.style.opacity = '1'; btn.style.pointerEvents = ''; }
    setIconFill(btn, 1);
    if (bar) setTimeout(() => removeProgressBar(bar), 8000);
  }
}

async function exportSelected() {
  const ids = getSelectedConvIds();
  if (ids.length === 0) { console.warn('[cce] no selected conversations found'); return; }
  const btn = document.querySelector('[data-cce="sel-export"]');
  await runExport(btn, async () => {
    const settings = await loadContentSettings();
    const orgId    = await getOrgId();
    const res      = await sendToBackground('selectedExport', { orgId, convIds: ids });
    await exportBulk(res.results, settings);
  });
}

async function exportCurrentChat() {
  const convId = getCurrentChatId();
  if (!convId) { console.warn('[cce] could not get current chat ID from URL'); return; }
  const btn = document.querySelector('[data-cce="chat-export"]');
  await runExport(btn, async () => {
    const settings = await loadContentSettings();
    const orgId    = await getOrgId();
    const res      = await sendToBackground('fetchConversation', { orgId, convId });
    await exportSingle(res.data, settings);
  });
}

async function copyCurrentChat() {
  const convId = getCurrentChatId();
  if (!convId) { console.warn('[cce] could not get current chat ID from URL'); return; }
  const btn = document.querySelector('[data-cce="chat-copy"]');
  await runExport(btn, async () => {
    const settings = await loadContentSettings();
    const orgId    = await getOrgId();
    const res      = await sendToBackground('fetchConversation', { orgId, convId });
    // copyChatText lives in exporter.js — falls back to exportSingle text if not defined
    if (typeof window.copyChatText === 'function') {
      await window.copyChatText(res.data, settings);
    } else {
      // Inline fallback: use conversationToText and write to clipboard
      await ensureLibs();
      const { text } = await window._cceConversationToText(res.data, settings);
      await navigator.clipboard.writeText(text);
    }
  });
}

// ── Button injection ──────────────────────────────────────────────────────────

function injectSelectionBarButton() {
  if (document.querySelector('[data-cce="sel-export"]')) return;
  const cancelBtn = findCancelButton();
  if (!cancelBtn) return;
  const buttonRow = cancelBtn.parentElement;
  if (!buttonRow) return;

  const btn = document.createElement('button');
  btn.setAttribute('data-cce', 'sel-export');
  btn.setAttribute('title', 'Export selected chats');
  btn.setAttribute('data-cds', 'Button');
  btn.setAttribute('aria-pressed', 'false');
  btn.innerHTML = `<span aria-hidden="true" class="absolute -z-[1] rounded-[inherit] inset-0 cds-btn-squish"></span><span class="inline-flex min-w-0 items-center gap-1 ">Export</span>`;
  btn.className = cancelBtn.className;
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); exportSelected(); });
  buttonRow.insertBefore(btn, cancelBtn);
  console.log('[cce] selection bar export button injected');
}

function injectChatTopBarButton() {
  // Already have both buttons — nothing to do
  const hasExport = !!document.querySelector('[data-cce="chat-export"]');
  const hasCopy   = !!document.querySelector('[data-cce="chat-copy"]');
  if (hasExport && hasCopy) return;
  if (!getCurrentChatId()) return;

  const shareBtn = Array.from(document.querySelectorAll('button')).find(btn =>
    btn.textContent.trim() === 'Share' || btn.textContent.trim().includes('Share')
  );
  if (!shareBtn) return;

  // Build Copy button (inserted first, appears leftmost)
  if (!hasCopy) {
    const copyBtn = document.createElement('button');
    copyBtn.setAttribute('data-cce', 'chat-copy');
    copyBtn.setAttribute('title', 'Copy this chat to clipboard');
    copyBtn.setAttribute('aria-pressed', 'false');
    copyBtn.className = shareBtn.className;
    copyBtn.innerHTML = `<span aria-hidden="true" class="absolute -z-[1] rounded-[inherit] inset-0 cds-btn-squish"></span><span class="inline-flex min-w-0 items-center gap-1 ">Copy</span>`;
    copyBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); copyCurrentChat(); });
    shareBtn.parentElement.insertBefore(copyBtn, shareBtn);
    console.log('[cce] chat top bar copy button injected');
  }

  // Build Export button (inserted after Copy, before Share)
  if (!hasExport) {
    const exportBtn = document.createElement('button');
    exportBtn.setAttribute('data-cce', 'chat-export');
    exportBtn.setAttribute('title', 'Export this chat');
    exportBtn.setAttribute('aria-pressed', 'false');
    exportBtn.className = shareBtn.className;
    exportBtn.innerHTML = `<span aria-hidden="true" class="absolute -z-[1] rounded-[inherit] inset-0 cds-btn-squish"></span><span class="inline-flex min-w-0 items-center gap-1 ">Export</span>`;
    exportBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); exportCurrentChat(); });
    shareBtn.parentElement.insertBefore(exportBtn, shareBtn);
    console.log('[cce] chat top bar export button injected');
  }
}

// ── Script loader ─────────────────────────────────────────────────────────────

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load: ${url}`));
    document.head.appendChild(s);
  });
}

let libsReady = null;
async function ensureLibs() {
  if (libsReady) return libsReady;
  libsReady = (async () => {
    if (!window.JSZip) await loadScript(chrome.runtime.getURL('jszip.min.js'));
    if (!window._cceExporterLoaded) {
      await loadScript(chrome.runtime.getURL('exporter.js'));
      window._cceExporterLoaded = true;
    }
    if (!window._cceClassifierLoaded) {
      await loadScript(chrome.runtime.getURL('image_classifier.js'));
      window._cceClassifierLoaded = true;
    }
  })();
  return libsReady;
}

// ── Injection orchestration ───────────────────────────────────────────────────
// Two separate concerns:
//   1. Chat top bar buttons (Export + Copy) — injected on /chat/* pages
//   2. Selection bar button — injected on /chats page when Cancel button exists
//
// Problems solved:
//   - React re-renders nuke our buttons; we must re-inject after every mutation
//     that could affect the top bar.
//   - We can't just check "is the button missing?" because React may remove and
//     re-add the parent in the same microtask, making the button appear present
//     during the mutation callback even though it's about to be detached.
//   - Solution: track the Share button's DOM node identity. If it changes, our
//     buttons are gone and we need to re-inject. If it's the same node, our
//     buttons are still valid.
//   - For first-load latency: start a fast polling loop (50ms) that retries
//     until the Share button is found, rather than waiting for mutations.

let _lastShareBtn = null;
let _lastCancelBtn = null;
let _injectTimer = null;
let _lastUrl = location.href;
let _pollTimer = null;

function tryInject() {
  const urlChanged = location.href !== _lastUrl;
  if (urlChanged) {
    _lastUrl = location.href;
    _lastShareBtn = null;
    _lastCancelBtn = null;
    // Remove stale buttons that belonged to the previous page
    document.querySelectorAll('[data-cce]').forEach(el => el.remove());
  }

  // Chat top bar: detect Share button identity change
  const shareBtn = Array.from(document.querySelectorAll('button')).find(btn =>
    btn.textContent.trim() === 'Share' || btn.textContent.trim().includes('Share')
  );

  if (shareBtn && (shareBtn !== _lastShareBtn || !document.querySelector('[data-cce="chat-export"]'))) {
    _lastShareBtn = shareBtn;
    // Remove any stale cce buttons that may be orphaned
    document.querySelectorAll('[data-cce="chat-export"], [data-cce="chat-copy"]').forEach(el => el.remove());
    injectChatTopBarButton();
  }

  // Selection bar: detect Cancel button identity change
  const cancelBtn = findCancelButton();
  if (cancelBtn && (cancelBtn !== _lastCancelBtn || !document.querySelector('[data-cce="sel-export"]'))) {
    _lastCancelBtn = cancelBtn;
    document.querySelectorAll('[data-cce="sel-export"]').forEach(el => el.remove());
    injectSelectionBarButton();
  }
  if (!cancelBtn) {
    _lastCancelBtn = null;
  }
}

function schedulePoll() {
  // Fast poll: 50ms intervals until we've injected successfully, then slow down
  clearTimeout(_pollTimer);
  _pollTimer = setTimeout(() => {
    tryInject();
    const hasChatBtn   = !!document.querySelector('[data-cce="chat-export"]');
    const needsChatBtn = !!getCurrentChatId();
    // Keep polling fast if we still need to inject something
    const stillWaiting = needsChatBtn && !hasChatBtn;
    _pollTimer = setTimeout(schedulePoll, stillWaiting ? 50 : 2000);
  }, 50);
}

function scheduleInject() {
  clearTimeout(_injectTimer);
  _injectTimer = setTimeout(tryInject, 150);
}

async function init() {
  injectStyles();
  // Immediate attempt
  tryInject();
  // Fast polling loop for first-load
  schedulePoll();
  // MutationObserver for React re-renders
  const observer = new MutationObserver(scheduleInject);
  observer.observe(document.body, { childList: true, subtree: true });
  console.log('[cce] initialized');
}

init();
