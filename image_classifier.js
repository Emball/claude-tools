// image_classifier.js — content script
// Spawns a hidden iframe pointing at ocr_frame.html (extension page context).
// Extension pages can load Tesseract without any blob-worker origin restrictions.
// Communicates via postMessage bridge.

let frameReady = null;
let pendingRequests = {};
let requestId = 0;

function getFrame() {
  if (frameReady) return frameReady;

  frameReady = new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('ocr_frame.html');
    frame.style.cssText = 'display:none!important;width:0;height:0;border:0;position:absolute;';
    frame.id = 'cce-ocr-frame';

    window.addEventListener('message', function handler(e) {
      if (e.source !== frame.contentWindow) return;

      if (e.data && e.data.__cce_ocr_ready) {
        console.log('[classifier] OCR frame ready');
        resolve(frame);
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

    frame.onerror = reject;
    (document.body || document.documentElement).appendChild(frame);
  });

  return frameReady;
}

async function ocrDataUrl(dataUrl) {
  const frame = await getFrame();
  return new Promise(resolve => {
    const id = ++requestId;
    pendingRequests[id] = resolve;
    frame.contentWindow.postMessage({ __cce_ocr_request: { id, dataUrl } }, '*');
  });
}

// Known photo aspect ratios (width:height). Screenshots rarely land on these exactly.
const PHOTO_RATIOS = [
  4/3, 3/4, 3/2, 2/3, 16/9, 9/16, 1/1,
  5/4, 4/5, 5/3, 3/5, 7/5, 5/7, 16/10, 10/16,
];
const RATIO_TOLERANCE = 0.02;

function looksLikePhoto(width, height) {
  if (!width || !height) return false;
  const ratio = width / height;
  // Portrait orientation on desktop = almost certainly a photo
  if (height > width) return true;
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

  // Photos → tier 3 immediately, no OCR needed
  if (looksLikePhoto(width, height)) {
    console.log(`[classifier] image ${index}: photo (${width}x${height}) → tier 3`);
    return { tier: 3, blob };
  }

  // Screenshot candidate → OCR
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
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
    const el = document.getElementById('cce-ocr-frame');
    if (el) el.remove();
    frameReady = null;
    console.log('[classifier] OCR frame removed');
  },
};
