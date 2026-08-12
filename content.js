// content.js — injects export button into claude.ai /chats selection bar

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

// ── Find the Cancel button using span text content ───────────────────────────

function findCancelButton() {
  return Array.from(document.querySelectorAll('button[data-cds="Button"]')).find(btn => {
    const span = btn.querySelector('span.inline-flex');
    return span && span.textContent.trim() === 'Cancel';
  });
}

// ── Collect selected conversation IDs ────────────────────────────────────────

function getSelectedConvIds() {
  const ids = [];

  // Selected rows have a checkbox input that is checked
  document.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
    // Walk up to find the row, then find its anchor
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

// ── Export selected chats ────────────────────────────────────────────────────

async function exportSelected() {
  const ids = getSelectedConvIds();
  if (ids.length === 0) {
    console.warn('[cce] no selected conversations found');
    return;
  }
  console.log(`[cce] exporting ${ids.length} selected chats`);

  const btn = document.querySelector('[data-cce="sel-export"]');
  if (btn) {
    btn.style.opacity = '0.5';
    btn.style.pointerEvents = 'none';
  }

  try {
    const format = await getFormat();
    const orgId = await getOrgId();
    const res = await sendToBackground('selectedExport', { orgId, convIds: ids });
    await exportBulk(res.results, format);
  } catch (err) {
    console.error('[cce] exportSelected failed:', err.message);
  } finally {
    if (btn) {
      btn.style.opacity = '1';
      btn.style.pointerEvents = '';
    }
  }
}

// ── Inject download button into the selection header ─────────────────────────

function injectSelectionBarButton() {
  if (document.querySelector('[data-cce="sel-export"]')) return;

  const cancelBtn = findCancelButton();
  if (!cancelBtn) return;

  // The cancel button's parent div holds all the action buttons
  const buttonRow = cancelBtn.parentElement;
  if (!buttonRow) return;

  const btn = document.createElement('button');
  btn.setAttribute('data-cce', 'sel-export');
  btn.setAttribute('title', 'Export selected chats');
  // Match the same data-cds attribute so it inherits Claude's button base styles
  btn.setAttribute('data-cds', 'Button');
  btn.innerHTML = `<span class="inline-flex min-w-0 items-center gap-1">${ICON_SVG}<span>Export</span></span>`;

  // Copy classes from Cancel button so it blends in perfectly
  btn.className = cancelBtn.className;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    exportSelected();
  });

  // Insert before Cancel
  buttonRow.insertBefore(btn, cancelBtn);
  console.log('[cce] selection bar export button injected');
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

// ── MutationObserver ─────────────────────────────────────────────────────────

let injectTimer = null;

function scheduleInject() {
  clearTimeout(injectTimer);
  injectTimer = setTimeout(() => {
    injectSelectionBarButton();
  }, 200);
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
