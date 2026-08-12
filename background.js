const API_BASE = 'https://claude.ai/api';
const BULK_DELAY_MS = 500;

chrome.runtime.onInstalled.addListener(() => {
  console.log('[bg] Claude Chat Exporter installed');
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
