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

    // Create worker without loading any language (empty string skips CDN fetch)
    _worker = await Tesseract.createWorker([], 1, {
      workerPath,
      corePath,
      langPath,
      workerBlobURL: true,
      cacheMethod: 'none',
      logger: () => {},
    });

    // Write traineddata directly into the worker's virtual filesystem
    await _worker.writeText('eng.traineddata', new Uint8Array(tdBuf));

    // Now reinitialize with eng — reads from FS instead of fetching
    await _worker.reinitialize('eng', 1);

    return _worker;
  }

  window.addEventListener('message', async function (e) {
    if (!e.data || !e.data.__cce_ocr_request) return;
    const { id, dataUrl } = e.data.__cce_ocr_request;
    try {
      const w = await getWorker();
      const { data } = await w.recognize(dataUrl);
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
