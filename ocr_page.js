// ocr_page.js — runs in PAGE context (injected via <script src>)
// Pre-fetches eng.traineddata from extension URL (page context can do this),
// writes it into the worker FS directly, bypassing the worker's own fetch.

(async function () {
  let _worker = null;

  async function getWorker() {
    if (_worker) return _worker;

    const script = document.getElementById('cce-ocr-page');
    const workerPath = script.dataset.workerPath;
    const corePath   = script.dataset.corePath;
    const langPath   = script.dataset.langPath;
    const tdUrl      = script.dataset.tdUrl; // full URL to eng.traineddata

    // Pre-fetch traineddata in page context (page can fetch chrome-extension:// URLs
    // when they're in web_accessible_resources)
    const tdResp = await fetch(tdUrl);
    if (!tdResp.ok) throw new Error('Failed to fetch eng.traineddata: ' + tdResp.status);
    const tdBuf = await tdResp.arrayBuffer();

    // Create worker without loading any language (empty array skips CDN lang fetch).
    // workerBlobURL: false is CRITICAL — blob workers lose the extension origin and
    // cannot importScripts() chrome-extension:// WASM files even if they're in
    // web_accessible_resources. With false, the worker runs directly from workerPath
    // (our local worker.min.js) which has the extension origin and can importScripts fine.
    _worker = await Tesseract.createWorker([], 1, {
      workerPath,
      corePath,   // base URL for WASM core files (extension root)
      langPath,   // base URL for traineddata (not used since we write directly)
      workerBlobURL: false,
      cacheMethod: 'none',
      logger: () => {},
    });

    // Write traineddata directly into the worker's virtual filesystem
    await _worker.writeText('eng.traineddata', new Uint8Array(tdBuf));

    // Now reinitialize with eng — reads from FS instead of fetching
    await _worker.reinitialize('eng', 1);

    return _worker;
  }

  // Invert image colors via pixel manipulation so Tesseract sees dark-on-light.
  // Tesseract's LSTM engine is trained on dark text / light background.
  // Dark mode screenshots (light text / dark bg) need inversion before OCR.
  function invertImage(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imageData.data;
        for (let i = 0; i < d.length; i += 4) {
          d[i]     = 255 - d[i];     // R
          d[i + 1] = 255 - d[i + 1]; // G
          d[i + 2] = 255 - d[i + 2]; // B
          // alpha unchanged
        }
        ctx.putImageData(imageData, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = dataUrl;
    });
  }

  window.addEventListener('message', async function (e) {
    if (!e.data || !e.data.__cce_ocr_request) return;
    const { id, dataUrl } = e.data.__cce_ocr_request;
    try {
      const w = await getWorker();
      const invertedUrl = await invertImage(dataUrl);
      const { data } = await w.recognize(invertedUrl);
      window.postMessage({
        __cce_ocr_result: { id, result: { text: data.text.trim(), confidence: data.confidence } }
      }, '*');
    } catch (err) {
      window.postMessage({
        __cce_ocr_result: { id, result: { error: err.message } }
      }, '*');
    }
  });

  window.postMessage({ __cce_ocr_ready: true }, '*');
})();
