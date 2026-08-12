// content.js — injects export controls into claude.ai UI

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

const BTN_STYLE = [
  'display:inline-flex',
  'align-items:center',
  'justify-content:center',
  'width:24px',
  'height:24px',
  'padding:0',
  'border:none',
  'background:transparent',
  'color:var(--text-300,#8b8b8b)',
  'cursor:pointer',
  'border-radius:4px',
  'opacity:0',
  'transition:opacity 0.15s,color 0.15s',
  'flex-shrink:0',
].join(';');

function makeBtn(title, onclick) {
  const btn = document.createElement('button');
  btn.innerHTML = ICON_SVG;
  btn.setAttribute('style', BTN_STYLE);
  btn.setAttribute('title', title);
  btn.setAttribute('data-cce', '1');
  btn.addEventListener('mouseenter', () => { btn.style.color = 'var(--text-100,#e8e8e8)'; });
  btn.addEventListener('mouseleave', () => { btn.style.color = 'var(--text-300,#8b8b8b)'; });
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onclick(); });
  return btn;
}

function showBtn(btn) { btn.style.opacity = '1'; }
function hideBtn(btn) { btn.style.opacity = '0'; }

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

function extractConvIdFromHref(el) {
  const a = el.closest('a') || el.querySelector('a');
  if (!a) return null;
  return extractConvIdFromUrl(a.href);
}

// ── Single chat export (active chat top bar) ──────────────────────────────────

async function exportCurrentChat() {
  console.log('[cce] export current chat');
  try {
    const convId = extractConvIdFromUrl(location.href);
    if (!convId) { console.error('[cce] no conv id in url'); return; }
    const format = await getFormat();
    const orgId = await getOrgId();
    const res = await sendToBackground('fetchConversation', { orgId, convId });
    await exportSingle(res.data, format);
  } catch (err) {
    console.error('[cce] exportCurrentChat failed:', err.message);
  }
}

function injectTopBarButton() {
  if (document.querySelector('[data-cce="topbar"]')) return;

  // Target: the right-side action cluster in the chat header
  const shareBtn = Array.from(document.querySelectorAll('button')).find(
    b => b.textContent.trim() === 'Share'
  );
  if (!shareBtn) return;

  const btn = makeBtn('Export chat', exportCurrentChat);
  btn.setAttribute('data-cce', 'topbar');
  btn.style.opacity = '1';
  btn.style.marginRight = '4px';
  // Match share button sizing
  btn.style.width = '32px';
  btn.style.height = '32px';
  shareBtn.parentElement.insertBefore(btn, shareBtn);
  console.log('[cce] top bar button injected');
}

// ── Sidebar chat list rows ────────────────────────────────────────────────────

async function exportConvById(convId) {
  try {
    const format = await getFormat();
    const orgId = await getOrgId();
    const res = await sendToBackground('fetchConversation', { orgId, convId });
    await exportSingle(res.data, format);
  } catch (err) {
    console.error('[cce] exportConvById failed:', err.message);
  }
}

function injectSidebarRowButton(row) {
  if (row.querySelector('[data-cce="row"]')) return;
  const convId = extractConvIdFromHref(row);
  if (!convId) return;

  const btn = makeBtn('Export chat', () => exportConvById(convId));
  btn.setAttribute('data-cce', 'row');
  btn.style.marginLeft = '4px';

  // Find the ⋮ menu button if present, insert before it; else append
  const menuBtn = row.querySelector('button');
  if (menuBtn) {
    menuBtn.parentElement.insertBefore(btn, menuBtn);
  } else {
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.appendChild(btn);
  }

  row.addEventListener('mouseenter', () => showBtn(btn));
  row.addEventListener('mouseleave', () => hideBtn(btn));
}

function injectSidebarRows() {
  // Sidebar nav links for individual chats
  const rows = document.querySelectorAll('nav a[href*="/chat/"]');
  rows.forEach(injectSidebarRowButton);
}

// ── Chats page full list ──────────────────────────────────────────────────────

function injectChatsPageRows() {
  // Main chats list — each row is typically a div/li containing an anchor
  const rows = document.querySelectorAll('main a[href*="/chat/"]');
  rows.forEach(row => {
    if (row.querySelector('[data-cce="row"]')) return;
    const convId = extractConvIdFromUrl(row.href);
    if (!convId) return;

    const btn = makeBtn('Export chat', () => exportConvById(convId));
    btn.setAttribute('data-cce', 'row');
    btn.style.marginLeft = 'auto';
    btn.style.paddingLeft = '8px';

    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.appendChild(btn);

    row.addEventListener('mouseenter', () => showBtn(btn));
    row.addEventListener('mouseleave', () => hideBtn(btn));
  });
}

// ── Bulk export button (next to "Recents" header) ─────────────────────────────

async function runBulkExport() {
  console.log('[cce] bulk export triggered');
  try {
    const format = await getFormat();
    const orgId = await getOrgId();
    const res = await sendToBackground('bulkExport', { orgId });
    await exportBulk(res.results, format);
  } catch (err) {
    console.error('[cce] bulk export failed:', err.message);
  }
}

function injectBulkButton() {
  if (document.querySelector('[data-cce="bulk"]')) return;

  // "Recents" label + the filter icon sit in the same flex row
  const recentsLabel = Array.from(document.querySelectorAll('*')).find(
    el => el.childNodes.length === 1 &&
          el.childNodes[0].nodeType === Node.TEXT_NODE &&
          el.textContent.trim() === 'Recents'
  );
  if (!recentsLabel) return;

  const container = recentsLabel.parentElement;
  if (!container) return;

  const btn = makeBtn('Export all chats', runBulkExport);
  btn.setAttribute('data-cce', 'bulk');
  btn.style.opacity = '1';
  container.appendChild(btn);
  console.log('[cce] bulk export button injected');
}

// ── JSZip injection ───────────────────────────────────────────────────────────

function loadJSZip() {
  return new Promise((resolve, reject) => {
    if (window.JSZip) return resolve();
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('jszip.min.js');
    s.onload = resolve;
    s.onerror = () => reject(new Error('JSZip failed to load'));
    document.head.appendChild(s);
  });
}

function loadExporter() {
  return new Promise((resolve, reject) => {
    if (window._cceExporterLoaded) return resolve();
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('exporter.js');
    s.onload = () => { window._cceExporterLoaded = true; resolve(); };
    s.onerror = () => reject(new Error('exporter.js failed to load'));
    document.head.appendChild(s);
  });
}

// ── MutationObserver — react to navigation and DOM changes ───────────────────

let injectTimer = null;

function scheduleInject() {
  clearTimeout(injectTimer);
  injectTimer = setTimeout(runInject, 300);
}

function runInject() {
  injectTopBarButton();
  injectSidebarRows();
  injectChatsPageRows();
  injectBulkButton();
}

async function init() {
  try {
    await loadJSZip();
    await loadExporter();
    console.log('[cce] scripts loaded, starting observer');
  } catch (err) {
    console.error('[cce] init load error:', err.message);
    return;
  }

  runInject();

  const observer = new MutationObserver(scheduleInject);
  observer.observe(document.body, { childList: true, subtree: true });
}

init();
