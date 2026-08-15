// ocr_offscreen.js — runs in chrome.offscreen document (extension context, no host CSP)
// Receives OCR requests from background.js via chrome.runtime.onMessage,
// runs Tesseract, returns results.

let worker = null;

async function getWorker() {
  if (worker) return worker;
  const base = chrome.runtime.getURL('');
  worker = await Tesseract.createWorker('eng', 1, {
    workerBlobURL: false,
    workerPath:    base + 'worker.min.js',
    corePath:      base + 'tesseract-core-simd-lstm.wasm.js',
    langPath:      'https://tessdata.projectnaptha.com/4.0.0',
    cacheMethod:   'write',
    logger:        () => {},
  });
  console.log('[ocr_offscreen] worker ready');
  return worker;
}

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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen' || msg.action !== 'ocr') return false;

  (async () => {
    try {
      const w = await getWorker();
      const inv = await invertDataUrl(msg.dataUrl);
      const { data } = await w.recognize(inv);
      sendResponse({ text: data.text.trim(), confidence: data.confidence });
    } catch (err) {
      console.error('[ocr_offscreen] error:', err);
      sendResponse({ error: err.message });
    }
  })();

  return true; // keep channel open for async sendResponse
});
