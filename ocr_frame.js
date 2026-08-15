// ocr_frame.js — runs inside ocr_frame.html (extension page context)
// Extension pages can freely access chrome-extension:// URLs, so Tesseract
// worker init works with workerBlobURL:false and local corePath/langPath.
// langPath points to tessdata CDN — fetched once, cached by Tesseract's
// built-in IndexedDB caching (cacheMethod: 'write').

let worker = null;
let ready = false;

async function initWorker() {
  const base = chrome.runtime.getURL('');
  worker = await Tesseract.createWorker('eng', 1, {
    workerBlobURL: false,
    workerPath:    base + 'worker.min.js',
    corePath:      base + 'tesseract-core-simd-lstm.wasm.js',
    langPath:      'https://tessdata.projectnaptha.com/4.0.0',
    cacheMethod:   'write',   // download once, cache in IndexedDB
    logger:        () => {},
  });
  ready = true;
  console.log('[ocr_frame] worker ready');
}

// Invert dark-themed screenshots so Tesseract (trained on light bg) can read them
function invertDataUrl(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = id.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i]     = 255 - d[i];
        d[i + 1] = 255 - d[i + 1];
        d[i + 2] = 255 - d[i + 2];
      }
      ctx.putImageData(id, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.src = dataUrl;
  });
}

// Listen for OCR requests from the parent content script
window.addEventListener('message', async e => {
  if (!e.data || !e.data.__cce_ocr_request) return;
  const { id, dataUrl } = e.data.__cce_ocr_request;

  try {
    if (!ready) await initWorker();
    const inv = await invertDataUrl(dataUrl);
    const { data } = await worker.recognize(inv);
    parent.postMessage({
      __cce_ocr_result: { id, result: { text: data.text.trim(), confidence: data.confidence } }
    }, '*');
  } catch (err) {
    console.error('[ocr_frame] error:', err);
    parent.postMessage({
      __cce_ocr_result: { id, result: { error: err.message } }
    }, '*');
  }
});

// Signal to parent that the frame is alive and ready to receive requests
parent.postMessage({ __cce_ocr_ready: true }, '*');

// Pre-init the worker immediately so first OCR request doesn't wait
initWorker().catch(err => console.error('[ocr_frame] pre-init failed:', err));
