// image_classifier.js — content script
// Injects tesseract.min.js + ocr_page.js into the page context (separate JS world).
// Communicates via postMessage bridge since content scripts can't access page-world globals.

let pageScriptReady = null;
let pendingRequests = {};
let requestId = 0;

function injectPageScript() {
  if (pageScriptReady) return pageScriptReady;

  pageScriptReady = new Promise((resolve, reject) => {
    window.addEventListener('message', function handler(e) {
      if (e.source !== window) return;
      if (e.data && e.data.__cce_ocr_ready) {
        console.log('[classifier] page OCR script ready');
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

    // Step 1: inject tesseract.min.js
    const lib = document.createElement('script');
    lib.id = 'cce-tesseract';
    lib.src = chrome.runtime.getURL('tesseract.min.js');
    lib.onload = () => {
      // Step 2: inject ocr_page.js with paths as data attributes (avoids inline scripts)
      const page = document.createElement('script');
      page.id = 'cce-ocr-page';
      page.src = chrome.runtime.getURL('ocr_page.js');
      page.dataset.workerPath = chrome.runtime.getURL('worker.min.js');
      page.dataset.corePath   = chrome.runtime.getURL('');
      page.dataset.langPath   = chrome.runtime.getURL('');
      page.dataset.tdUrl      = chrome.runtime.getURL('eng.traineddata');
      page.onerror = reject;
      (document.head || document.documentElement).appendChild(page);
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

// Known photo aspect ratios (width:height) produced by cameras and phones.
// Screenshots are arbitrary crops and almost never land on these exactly.
// Tolerance of 0.02 allows for minor rounding in thumbnails.
const PHOTO_RATIOS = [
  4/3, 3/4,   // classic camera
  3/2, 2/3,   // DSLR / 35mm
  16/9, 9/16, // widescreen / portrait video
  1/1,        // square
  5/4, 4/5,
  5/3, 3/5,
  7/5, 5/7,
  16/10, 10/16,
];
const RATIO_TOLERANCE = 0.02;

function looksLikePhoto(width, height) {
  if (!width || !height) return false;
  const ratio = width / height;
  return PHOTO_RATIOS.some(r => Math.abs(ratio - r) <= RATIO_TOLERANCE);
}

async function classifyFromUrl(url, width, height, index) {
  let blob;
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
    blob = await resp.blob();
  } catch (err) {
    console.error('[classifier] fetch error:', err);
    return { tier: 3, blob: null };
  }

  // Photos go straight to tier 3 — no point running OCR on them
  if (looksLikePhoto(width, height)) {
    console.log(`[classifier] image ${index}: photo ratio (${width}x${height}) → tier 3`);
    return { tier: 3, blob };
  }

  // Non-photo dimensions = screenshot candidate → run OCR
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
    console.log(`[classifier] image ${index}: confidence=${confidence}, chars=${text.length}, dims=${width}x${height}`);

    if (confidence >= 60 && text.length >= 10) return { tier: 1, text };
    return { tier: 2 };

  } catch (err) {
    console.error('[classifier] OCR error, falling back to tier 2:', err);
    return { tier: 2 };
  }
}

const ImageClassifier = {
  async classify(previewUrl, width, height, index) {
    return await classifyFromUrl(previewUrl, width, height, index);
  },
  async terminate() {
    console.log('[classifier] terminate called (worker lives in page context)');
  },
};
