// content.js — injects export controls into claude.ai /chats page

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

// ── Collect selected conversation IDs from the chats page ────────────────────

function getSelectedConvIds() {
  // Selected rows have a checked checkbox; each row links to /chat/{uuid}
  const ids = [];

  // Strategy 1: checked checkboxes inside list rows
  document.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
    const row = cb.closest('[href*="/chat/"]') || cb.closest('li,div[role="row"],tr');
    if (!row) return;
    const anchor = row.querySelector('a[href*="/chat/"]') || row.closest('a[href*="/chat/"]');
    if (anchor) {
      const id = extractConvIdFromUrl(anchor.href);
      if (id && !ids.includes(id)) ids.push(id);
    }
  });

  // Strategy 2: rows with aria-selected="true"
  if (ids.length === 0) {
    document.querySelectorAll('[aria-selected="true"]').forEach(row => {
      const anchor = row.querySelector('a[href*="/chat/"]') || row.closest('a[href*="/chat/"]');
      if (anchor) {
        const id = extractConvIdFromUrl(anchor.href);
        if (id && !ids.includes(id)) ids.push(id);
      }
    });
  }

  // Strategy 3: any selected/active state class on rows
  if (ids.length === 0) {
    document.querySelectorAll('a[href*="/chat/"]').forEach(anchor => {
      const row = anchor.closest('li,div[role="row"],tr,[class*="selected"],[class*="checked"]');
      if (row && (row.getAttribute('aria-selected') === 'true' || row.classList.toString().match(/selected|checked/i))) {
        const id = extractConvIdFromUrl(anchor.href);
        if (id && !ids.includes(id)) ids.push(id);
      }
    });
  }

  console.log('[cce] selected conv ids:', ids);
  return ids;
}

// ── Export selected chats ────────────────────────────────────────────────────

async function exportSelected() {
  const ids = getSelectedConvIds();
  if (ids.length === 0) {
    console.warn('[cce] no selected conversations found');
    return;
  }
  console.log(`[cce] exporting ${ids.length} selected chats`);
  try {
    const format = await getFormat();
    const orgId = await getOrgId();
    const res = await sendToBackground('selectedExport', { orgId, convIds: ids });
    await exportBulk(res.results, format);
  } catch (err) {
    console.error('[cce] exportSelected failed:', err.message);
  }
}

// ── Inject download button into the selection action bar ─────────────────────

function injectSelectionBarButton() {
  if (document.querySelector('[data-cce="sel-export"]')) return;

  // The action bar appears when items are selected; it contains buttons like
  // "Select all", "Move to project", "Delete", "Cancel"
  const cancelBtn = Array.from(document.querySelectorAll('button')).find(
    b => b.textContent.trim() === 'Cancel'
  );
  if (!cancelBtn) return;

  const bar = cancelBtn.closest('div,nav,section,header,[role="toolbar"]');
  if (!bar) return;

  const btn = document.createElement('button');
  btn.innerHTML = ICON_SVG;
  btn.setAttribute('data-cce', 'sel-export');
  btn.setAttribute('title', 'Export selected chats');
  btn.style.cssText = [
    'display:inline-flex',
    'align-items:center',
    'justify-content:center',
    'gap:6px',
    'padding:6px 12px',
    'border:none',
    'border-radius:6px',
    'background:transparent',
    'color:var(--text-300,#8b8b8b)',
    'cursor:pointer',
    'font-size:13px',
    'transition:color 0.15s',
  ].join(';');

  btn.addEventListener('mouseenter', () => { btn.style.color = 'var(--text-100,#e8e8e8)'; });
  btn.addEventListener('mouseleave', () => { btn.style.color = 'var(--text-300,#8b8b8b)'; });
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); exportSelected(); });

  // Insert before Cancel so it sits naturally in the bar
  cancelBtn.parentElement.insertBefore(btn, cancelBtn);
  console.log('[cce] selection bar export button injected');
}

// ── JSZip + exporter loader ──────────────────────────────────────────────────

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

// ── MutationObserver ─────────────────────────────────────────────────────────

let injectTimer = null;

function scheduleInject() {
  clearTimeout(injectTimer);
  injectTimer = setTimeout(() => {
    if (location.pathname === '/chats' || location.pathname.startsWith('/chats')) {
      injectSelectionBarButton();
    }
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
