// ocr_frame.js — runs inside ocr_frame.html (extension page, loaded via helper.js pattern)
// For each OCR request, spawns a child iframe pointing at ocr_engine.html?id=...
// The child iframe runs Tesseract WASM in a clean extension-origin context,
// completely isolated from claude.ai's CSP. Results postMessage back up the chain.

const pending = {};

window.addEventListener('message', async e => {
  if (!e.data) return;

  // Result bubbling up from a child engine iframe
  if (e.data.__cce_engine_result) {
    const { id, result } = e.data.__cce_engine_result;
    if (pending[id]) {
      pending[id](result);
      delete pending[id];
    }
    return;
  }

  // OCR request from the content script (grandparent)
  if (e.data.__cce_ocr_request) {
    const { id, dataUrl } = e.data.__cce_ocr_request;

    const frame = document.createElement('iframe');
    frame.style.cssText = 'display:none;width:0;height:0;border:0;';
    frame.src = chrome.runtime.getURL('ocr_engine.html') + '?id=' + id;

    pending[id] = result => {
      frame.remove();
      // Forward result back to content script (grandparent window)
      parent.postMessage({ __cce_ocr_result: { id, result } }, '*');
    };

    frame.onload = () => {
      frame.contentWindow.postMessage({ __cce_engine_run: { id, dataUrl } }, '*');
    };

    document.body.appendChild(frame);
  }
});

// Signal to content script that this frame is alive
parent.postMessage({ __cce_ocr_ready: true }, '*');
