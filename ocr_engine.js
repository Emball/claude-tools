// ocr_engine.js — injected as an iframe via chrome.scripting.executeScript (background)
// Runs in extension-origin context: WASM compiles freely, no host CSP interference.
// Receives dataUrl via postMessage, runs Tesseract, posts result back to parent.

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
    const worker = await Tesseract.createWorker('eng', 1, {
      workerBlobURL: false,
      workerPath:    'worker-overwrites.js',
      corePath:      'tesseract-core-simd-lstm.wasm.js',
      cacheMethod:   'none',
      langPath:      'https://tessdata.projectnaptha.com/4.0.0',
      logger:        () => {},
    });

    const inv = await invertDataUrl(dataUrl);
    const { data } = await worker.recognize(inv);
    await worker.terminate();

    parent.postMessage({ __cce_engine_result: { id, result: { text: data.text.trim(), confidence: data.confidence } } }, '*');
  } catch (err) {
    console.error('[ocr_engine] error:', err);
    parent.postMessage({ __cce_engine_result: { id, result: { error: err.message } } }, '*');
  }
});
