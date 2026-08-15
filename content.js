// content.js — injects export buttons into claude.ai

// no-op — no custom icon, buttons use plain text matching Share button style
function setIconFill() {}

// ── CSS injected once ────────────────────────────────────────────────────────

function injectStyles() {
  if (document.getElementById('cce-styles')) return;
  const s = document.createElement('style');
  s.id = 'cce-styles';
  s.textContent = `
    [data-cce="chat-export"],
    [data-cce="sel-export"] {
      background: #2e2e2e !important;
      border-radius: 8px !important;
    }
    [data-cce="chat-export"] {
      position: relative;
      right: 1.5px;
    }
    [data-cce="chat-export"]:hover,
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
let _progressBars = []; // array of {wrap, fill, label} to update

function _updateAllBars() {
  for (const b of _progressBars) {
    if (!b || !b.fill) continue;
    b.fill.style.width = (_progressPct * 100).toFixed(1) + '%';
    if (b.label) b.label.textContent = _progressLabel;
  }
  // Mirror to popup via storage
  try {
    chrome.storage.local.set({ cce_progress: { pct: _progressPct, label: _progressLabel } });
  } catch(e) {}
}

// Installed by content.js, called by exporter.js
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

  // Also update download button icons
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

  // Anchor must be position:relative for absolute child to work
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

function findCancelButton() {
  return Array.from(document.querySelectorAll('button[data-cds="Button"]')).find(btn => {
    const span = btn.querySelector('span.inline-flex');
    return span && span.textContent.trim() === 'Cancel';
  });
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

  // Reset icon fill
  setIconFill(btn, 0);
  _progressPct = 0;
  _progressLabel = 'Starting…';

  // Attach progress bar to the button's parent (the action row)
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
    // Remove progress bar after 8s (gives time to read final state)
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
  if (document.querySelector('[data-cce="chat-export"]')) return;
  if (!getCurrentChatId()) return;

  const shareBtn = Array.from(document.querySelectorAll('button')).find(btn =>
    btn.textContent.trim() === 'Share' || btn.textContent.trim().includes('Share')
  );
  if (!shareBtn) return;

  const btn = document.createElement('button');
  btn.setAttribute('data-cce', 'chat-export');
  btn.setAttribute('title', 'Export this chat');
  btn.setAttribute('aria-pressed', 'false');
  btn.className = shareBtn.className;
  btn.innerHTML = `<span aria-hidden="true" class="absolute -z-[1] rounded-[inherit] inset-0 cds-btn-squish"></span><span class="inline-flex min-w-0 items-center gap-1 ">Export</span>`;
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); exportCurrentChat(); });
  shareBtn.parentElement.insertBefore(btn, shareBtn);
  console.log('[cce] chat top bar export button injected');
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

// ── MutationObserver ──────────────────────────────────────────────────────────

let injectTimer = null;
let lastUrl = location.href;

function scheduleInject() {
  const urlChanged = location.href !== lastUrl;
  const missingSelectionBtn = !document.querySelector('[data-cce="sel-export"]');
  const missingChatBtn = !document.querySelector('[data-cce="chat-export"]');
  if (!urlChanged && !missingSelectionBtn && !missingChatBtn) return;
  lastUrl = location.href;
  clearTimeout(injectTimer);
  injectTimer = setTimeout(() => {
    injectSelectionBarButton();
    injectChatTopBarButton();
  }, 400);
}

async function init() {
  injectStyles();
  scheduleInject();
  const observer = new MutationObserver(scheduleInject);
  observer.observe(document.body, { childList: true, subtree: true });
  const root = document.getElementById('__next') || document.querySelector('[data-reactroot]') || document.body;
  // subtree:true on body covers everything — no need for a second observer
  console.log('[cce] initialized');
}

init();
