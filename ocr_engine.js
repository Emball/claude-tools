// ocr_engine.js — runs inside ocr_engine.html (grandchild extension iframe)
// Fully isolated from claude.ai's CSP. Tesseract WASM compiles freely here.
// workerBlobURL:false + local corePath = no cross-origin issues at all.

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

window.addEventListener('message', async e => {
  if (!e.data || !e.data.__cce_engine_run) return;
  const { id, dataUrl } = e.data.__cce_engine_run;

  try {
    const base = chrome.runtime.getURL('');
    const worker = await Tesseract.createWorker('eng', 1, {
      workerBlobURL: false,
      workerPath:    base + 'worker.min.js',
      corePath:      base + 'tesseract-core-simd-lstm.wasm.js',
      langPath:      'https://tessdata.projectnaptha.com/4.0.0',
      cacheMethod:   'write',
      logger:        () => {},
    });

    const inv = await invertDataUrl(dataUrl);
    const { data } = await worker.recognize(inv);
    await worker.terminate();

    parent.postMessage({
      __cce_engine_result: { id, result: { text: data.text.trim(), confidence: data.confidence } }
    }, '*');

  } catch (err) {
    console.error('[ocr_engine] error:', err);
    parent.postMessage({
      __cce_engine_result: { id, result: { error: err.message } }
    }, '*');
  }
});
