// image_classifier.js — content script side
// Bridges to page context via postMessage since content scripts cannot access
// window.Tesseract set by an injected <script> tag (separate JS worlds).

let pageScriptReady = null;
let pendingRequests = {};
let requestId = 0;

function injectPageScript() {
  if (pageScriptReady) return pageScriptReady;

  pageScriptReady = new Promise((resolve, reject) => {
    // Listen for the ready signal and OCR results from page context
    window.addEventListener('message', function handler(e) {
      if (e.source !== window) return;
      if (e.data && e.data.__cce_ocr_ready) {
        console.log('[classifier] page script ready');
        resolve();
        return;
      }
      if (e.data && e.data.__cce_ocr_result !== undefined) {
        const { id, result } = e.data.__cce_ocr_result;
        if (pendingRequests[id]) {
          pendingRequests[id](result);
          delete pendingRequests[id];
        }
      }
    });

    // Inject the tesseract.min.js library
    const lib = document.createElement('script');
    lib.src = chrome.runtime.getURL('tesseract.min.js');
    lib.onload = () => {
      // Now inject the page-context worker script inline
      const workerPath = chrome.runtime.getURL('worker.min.js');
      const corePath   = chrome.runtime.getURL('');
      const langPath   = chrome.runtime.getURL('');

      const inline = document.createElement('script');
      inline.textContent = `
(async function() {
  let _worker = null;

  async function getWorker() {
    if (_worker) return _worker;
    _worker = await Tesseract.createWorker('eng', 1, {
      workerPath: ${JSON.stringify(workerPath)},
      corePath:   ${JSON.stringify(corePath)},
      langPath:   ${JSON.stringify(langPath)},
      workerBlobURL: true,
      cacheMethod: 'none',
      logger: () => {},
    });
    return _worker;
  }

  window.addEventListener('message', async function(e) {
    if (!e.data || !e.data.__cce_ocr_request) return;
    const { id, dataUrl } = e.data.__cce_ocr_request;
    try {
      const w = await getWorker();
      const { data } = await w.recognize(dataUrl);
      window.postMessage({ __cce_ocr_result: { id, result: { text: data.text.trim(), confidence: data.confidence } } }, '*');
    } catch(err) {
      window.postMessage({ __cce_ocr_result: { id, result: { error: err.message } } }, '*');
    }
  });

  window.postMessage({ __cce_ocr_ready: true }, '*');
})();
      `;
      (document.head || document.documentElement).appendChild(inline);
    };
    lib.onerror = reject;
    (document.head || document.documentElement).appendChild(lib);
  });

  return pageScriptReady;
}

async function ocrDataUrl(dataUrl) {
  await injectPageScript();
  return new Promise((resolve) => {
    const id = ++requestId;
    pendingRequests[id] = resolve;
    window.postMessage({ __cce_ocr_request: { id, dataUrl } }, '*');
  });
}

async function classifyFromUrl(url, index) {
  let blob;
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
    blob = await resp.blob();
  } catch (err) {
    console.error('[classifier] fetch error:', err);
    return { tier: 3, blob: null };
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  try {
    const result = await ocrDataUrl(dataUrl);
    if (result.error) throw new Error(result.error);

    const { text, confidence } = result;
    console.log(`[classifier] image ${index}: confidence=${confidence}, chars=${text.length}`);

    if (confidence >= 60 && text.length >= 10) {
      return { tier: 1, text };
    } else {
      return { tier: 2 };
    }
  } catch (err) {
    console.error('[classifier] OCR error, falling back to tier 3:', err);
    return { tier: 3, blob };
  }
}

const ImageClassifier = {
  async classify(previewUrl, width, height, index) {
    return await classifyFromUrl(previewUrl, index);
  },
  async terminate() {
    // Worker lives in page context — no direct handle to terminate
    console.log('[classifier] terminate called (worker lives in page context)');
  },
};
