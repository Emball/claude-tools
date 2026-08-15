const API_BASE = 'https://claude.ai/api';
const BULK_DELAY_MS = 500;
const OFFSCREEN_URL = chrome.runtime.getURL('ocr_offscreen.html');

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Run Tesseract OCR WASM outside host page CSP',
    });
    console.log('[bg] offscreen document created');
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[bg] Claudette installed');
  chrome.tabs.query({ url: 'https://claude.ai/*' }, (tabs) => {
    tabs.forEach(tab => {
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      }).catch(err => console.warn('[bg] Could not inject into tab', tab.id, err));
    });
  });
});

async function apiFetch(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Accept': 'application/json' }
  });
  if (!response.ok) throw new Error(`API ${response.status}: ${path}`);
  return response.json();
}

async function detectOrgId() {
  const orgs = await apiFetch('/organizations');
  if (!Array.isArray(orgs) || orgs.length === 0) throw new Error('No organizations found');
  const chatOrg = orgs.find(o => o.capabilities && o.capabilities.includes('chat'));
  return (chatOrg || orgs[0]).uuid;
}

async function fetchConversation(orgId, convId) {
  return apiFetch(`/organizations/${orgId}/chat_conversations/${convId}?tree=True&rendering_mode=messages&render_all_tools=true`);
}

async function fetchAllConversations(orgId) {
  return apiFetch(`/organizations/${orgId}/chat_conversations`);
}

async function fetchProjects(orgId) {
  return apiFetch(`/organizations/${orgId}/projects`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[bg] message:', request.action);

  if (request.action === 'ocr') {
    (async () => {
      try {
        await ensureOffscreen();
        // Send to offscreen and wait for it to reply via a separate sendMessage back
        const result = await new Promise((resolve, reject) => {
          const id = Math.random().toString(36).slice(2);
          const timer = setTimeout(() => {
            chrome.runtime.onMessage.removeListener(listener);
            reject(new Error('OCR timeout'));
          }, 30000);
          function listener(msg) {
            if (msg.action === 'ocr_result' && msg.id === id) {
              clearTimeout(timer);
              chrome.runtime.onMessage.removeListener(listener);
              resolve(msg.result);
              return true;
            }
          }
          chrome.runtime.onMessage.addListener(listener);
          chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'ocr',
            id,
            dataUrl: request.dataUrl,
          });
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'detectOrgId') {
    detectOrgId()
      .then(orgId => sendResponse({ success: true, orgId }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'fetchConversation') {
    fetchConversation(request.orgId, request.convId)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'fetchAllConversations') {
    fetchAllConversations(request.orgId)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'fetchProjects') {
    fetchProjects(request.orgId)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'selectedExport') {
    (async () => {
      try {
        const { orgId, convIds } = request;
        console.log(`[bg] selected export: ${convIds.length} conversations`);
        const results = [];
        for (let i = 0; i < convIds.length; i++) {
          const convId = convIds[i];
          try {
            const full = await fetchConversation(orgId, convId);
            results.push({ success: true, data: full });
            console.log(`[bg] fetched ${i + 1}/${convIds.length}: ${convId}`);
          } catch (err) {
            console.error(`[bg] failed to fetch ${convId}:`, err.message);
            results.push({ success: false, uuid: convId, error: err.message });
          }
          if (i < convIds.length - 1) await delay(BULK_DELAY_MS);
        }
        sendResponse({ success: true, results });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (request.action === 'bulkExport') {
    (async () => {
      try {
        const conversations = await fetchAllConversations(request.orgId);
        console.log(`[bg] bulk export: ${conversations.length} conversations`);
        const results = [];
        for (let i = 0; i < conversations.length; i++) {
          const conv = conversations[i];
          try {
            const full = await fetchConversation(request.orgId, conv.uuid);
            results.push({ success: true, data: full });
            console.log(`[bg] fetched ${i + 1}/${conversations.length}: ${conv.uuid}`);
          } catch (err) {
            console.error(`[bg] failed to fetch ${conv.uuid}:`, err.message);
            results.push({ success: false, uuid: conv.uuid, error: err.message });
          }
          if (i < conversations.length - 1) await delay(BULK_DELAY_MS);
        }
        sendResponse({ success: true, results });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});
