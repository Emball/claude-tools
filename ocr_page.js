// ocr_page.js — runs in PAGE context (injected via <script src>)
// Initializes Tesseract worker and handles OCR requests from content script via postMessage.

(async function () {
  let _worker = null;

  async function getWorker() {
    if (_worker) return _worker;
    // These URLs are baked in at inject time via data attributes on the script tag
    const script = document.getElementById('cce-ocr-page');
    const workerPath = script.dataset.workerPath;
    const corePath   = script.dataset.corePath;
    const langPath   = script.dataset.langPath;

    _worker = await Tesseract.createWorker('eng', 1, {
      workerPath,
      corePath,
      langPath,
      workerBlobURL: true,
      cacheMethod: 'none',
      logger: () => {},
    });
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
