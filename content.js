// content.js — injects export buttons into claude.ai

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

function getFormat() {
  return new Promise(resolve => {
    chrome.storage.sync.get({ format: 'md' }, d => resolve(d.format));
  });
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

// ── Get current chat UUID from URL (for single-chat button) ──────────────────

function getCurrentChatId() {
  return extractConvIdFromUrl(window.location.href);
}

// ── Find the Cancel button (chats page selection bar) ────────────────────────

function findCancelButton() {
  return Array.from(document.querySelectorAll('button[data-cds="Button"]')).find(btn => {
    const span = btn.querySelector('span.inline-flex');
    return span && span.textContent.trim() === 'Cancel';
  });
}

// ── Collect selected conversation IDs ────────────────────────────────────────

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

// ── Export selected chats (chats page) ───────────────────────────────────────

async function exportSelected() {
  const ids = getSelectedConvIds();
  if (ids.length === 0) {
    console.warn('[cce] no selected conversations found');
    return;
  }
  console.log(`[cce] exporting ${ids.length} selected chats`);

  const btn = document.querySelector('[data-cce="sel-export"]');
  if (btn) { btn.style.opacity = '0.5'; btn.style.pointerEvents = 'none'; }

  try {
    const format = await getFormat();
    const orgId = await getOrgId();
    const res = await sendToBackground('selectedExport', { orgId, convIds: ids });
    // exportBulk routes single results through exportSingle automatically
    await exportBulk(res.results, format);
  } catch (err) {
    console.error('[cce] exportSelected failed:', err.message);
  } finally {
    if (btn) { btn.style.opacity = '1'; btn.style.pointerEvents = ''; }
  }
}

// ── Export current open chat (single-chat button) ────────────────────────────

async function exportCurrentChat() {
  const convId = getCurrentChatId();
  if (!convId) {
    console.warn('[cce] could not get current chat ID from URL');
    return;
  }

  const btn = document.querySelector('[data-cce="chat-export"]');
  if (btn) { btn.style.opacity = '0.5'; btn.style.pointerEvents = 'none'; }

  try {
    const format = await getFormat();
    const orgId = await getOrgId();
    const res = await sendToBackground('fetchConversation', { orgId, convId });
    await exportSingle(res.data, format);
  } catch (err) {
    console.error('[cce] exportCurrentChat failed:', err.message);
  } finally {
    if (btn) { btn.style.opacity = '1'; btn.style.pointerEvents = ''; }
  }
}

// ── Inject export button into chats page selection bar ───────────────────────

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
  btn.innerHTML = `<span class="inline-flex min-w-0 items-center gap-1">${ICON_SVG}<span>Export</span></span>`;
  btn.className = cancelBtn.className;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    exportSelected();
  });

  buttonRow.insertBefore(btn, cancelBtn);
  console.log('[cce] selection bar export button injected');
}

// ── Inject download button into active chat top bar ──────────────────────────
// Targets the top-right action area where the Save and Share buttons live.
// Uses Share button as anchor since it's the most stable reference point.

function injectChatTopBarButton() {
  if (document.querySelector('[data-cce="chat-export"]')) return;

  // Not on a chat page — bail
  if (!getCurrentChatId()) return;

  // Find the Share button (has "Share" text in a span child)
  const shareBtn = Array.from(document.querySelectorAll('button')).find(btn => {
    const text = btn.textContent.trim();
    return text === 'Share' || text.includes('Share');
  });

  if (!shareBtn) return;

  const btn = document.createElement('button');
  btn.setAttribute('data-cce', 'chat-export');
  btn.setAttribute('title', 'Export this chat');

  // Match Share button's classes so it sits naturally in the same row
  btn.className = shareBtn.className;

  // Icon only — no text label, keeps it compact like surrounding controls
  btn.innerHTML = ICON_SVG;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    exportCurrentChat();
  });

  // Insert immediately before the Share button
  shareBtn.parentElement.insertBefore(btn, shareBtn);
  console.log('[cce] chat top bar export button injected');
}

// ── Script loader ────────────────────────────────────────────────────────────

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load: ${url}`));
    document.head.appendChild(s);
  });
}

async function ensureLibs() {
  if (!window.JSZip) await loadScript(chrome.runtime.getURL('jszip.min.js'));
  if (!window._cceExporterLoaded) {
    await loadScript(chrome.runtime.getURL('exporter.js'));
    window._cceExporterLoaded = true;
  }
}

// ── MutationObserver + route-aware injection ─────────────────────────────────

let injectTimer = null;

function scheduleInject() {
  clearTimeout(injectTimer);
  injectTimer = setTimeout(() => {
    injectSelectionBarButton();  // chats page selection bar
    injectChatTopBarButton();    // active chat top bar
  }, 300);
}

async function init() {
  try {
    await ensureLibs();
    console.log('[cce] libs loaded');
  } catch (err) {
    console.error('[cce] init error:', err.message);
    return;
  }

  scheduleInject();
  const observer = new MutationObserver(scheduleInject);
  observer.observe(document.body, { childList: true, subtree: true });
}

init();
