// ocr_page.js — runs in PAGE context (injected via <script src>)
// Blob workers have null origin and cannot importScripts() chrome-extension:// URLs.
// Fix: fetch all extension files in page context, re-serve as blob: URLs.
// Blob→blob importScripts is same-origin (null→null) and works fine.

(async function () {
  let _worker = null;

  async function fetchAsBlob(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url} failed: ${resp.status}`);
    return resp.blob();
  }

  async function getWorker() {
    if (_worker) return _worker;

    const script    = document.getElementById('cce-ocr-page');
    const workerUrl = script.dataset.workerPath; // chrome-extension://.../worker.min.js
    const coreUrl   = script.dataset.corePath;   // chrome-extension://.../ (root)
    const tdUrl     = script.dataset.tdUrl;      // chrome-extension://.../eng.traineddata

    // Fetch everything in page context (can access chrome-extension:// URLs)
    const [workerBlob, coreBlob, tdBuf] = await Promise.all([
      fetchAsBlob(workerUrl),
      fetchAsBlob(coreUrl + 'tesseract-core-lstm.wasm.js'),
      fetch(tdUrl).then(r => r.arrayBuffer()),
    ]);

    // Patch worker.min.js: replace all tesseract-core importScripts calls
    // with a blob: URL of our pre-fetched core. This avoids the null-origin
    // cross-origin block on chrome-extension:// from inside the blob worker.
    const coreBlobUrl  = URL.createObjectURL(coreBlob);
    const workerText   = await workerBlob.text();
    const patchedText  = workerText.replace(
      /importScripts\([^)]*tesseract-core[^)]*\)/g,
      `importScripts("${coreBlobUrl}")`
    );
    const patchedUrl = URL.createObjectURL(
      new Blob([patchedText], { type: 'application/javascript' })
    );

    _worker = await Tesseract.createWorker([], 1, {
      workerPath: patchedUrl,
      corePath: coreUrl,   // fallback only; patched worker doesn't use it
      langPath: coreUrl,
      workerBlobURL: true,
      cacheMethod: 'none',
      logger: () => {},
    });

    // Write traineddata into the worker FS, then reinitialize
    await _worker.writeText('eng.traineddata', new Uint8Array(tdBuf));
    await _worker.reinitialize('eng', 1);

    return _worker;
  }

  // Pixel-level invert so Tesseract (dark-on-light trained) reads dark mode screenshots
  function invertImage(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d  = id.data;
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

  window.addEventListener('message', async function (e) {
    if (!e.data || !e.data.__cce_ocr_request) return;
    const { id, dataUrl } = e.data.__cce_ocr_request;
    try {
      const w = await getWorker();
      const inv = await invertImage(dataUrl);
      const { data } = await w.recognize(inv);
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
