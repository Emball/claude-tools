// image_classifier.js
// Injected as a content script. Injects tesseract.min.js into the PAGE context
// (via <script> tag) to bypass the content script sandbox restrictions that
// block Worker creation from chrome-extension:// URLs.

let worker = null;
let tesseractReady = null;

// Inject tesseract.min.js into the page DOM so it runs in page context,
// not the content script sandbox. Returns a promise that resolves when loaded.
function injectTesseract() {
  if (tesseractReady) return tesseractReady;

  tesseractReady = new Promise((resolve, reject) => {
    if (document.getElementById('cce-tesseract')) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.id = 'cce-tesseract';
    script.src = chrome.runtime.getURL('tesseract.min.js');
    script.onload = () => {
      console.log('[classifier] tesseract.min.js injected into page context');
      resolve();
    };
    script.onerror = (e) => reject(new Error('Failed to inject tesseract.min.js: ' + e));
    (document.head || document.documentElement).appendChild(script);
  });

  return tesseractReady;
}

async function getWorker() {
  if (worker) return worker;

  await injectTesseract();

  console.log('[classifier] initializing Tesseract worker');

  // All paths must be folders or exact files as chrome-extension:// URLs.
  // corePath = folder containing tesseract-core-lstm.wasm.js (Tesseract appends filename)
  // langPath = folder containing eng.traineddata
  // workerPath = exact path to worker.min.js
  const workerPath = chrome.runtime.getURL('worker.min.js');
  const corePath   = chrome.runtime.getURL('');  // root folder
  const langPath   = chrome.runtime.getURL('');  // root folder

  // window.Tesseract is set by the injected page-context script
  worker = await window.Tesseract.createWorker('eng', 1, {
    workerPath,
    corePath,
    langPath,
    workerBlobURL: true,
    cacheMethod: 'none',
    logger: () => {},
  });

  console.log('[classifier] Tesseract worker ready');
  return worker;
}

// Classify an image from a URL (preview_url from the API).
// Returns: { tier: 1, text } | { tier: 2 } | { tier: 3, blob }
async function classifyFromUrl(url, index) {
  let blob;
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
    blob = await resp.blob();
  } catch (err) {
    console.error('[classifier] fetch error:', err);
    return { tier: 3, blob: null };
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  try {
    const w = await getWorker();
    const { data } = await w.recognize(dataUrl);
    const text = data.text.trim();
    const confidence = data.confidence;

    console.log(`[classifier] image ${index}: confidence=${confidence}, chars=${text.length}`);

    if (confidence >= 60 && text.length >= 10) {
      return { tier: 1, text };
    } else {
      return { tier: 2 };
    }
  } catch (err) {
    console.error('[classifier] OCR error, falling back to tier 3:', err);
    return { tier: 3, blob };
  }
}

const ImageClassifier = {
  async classify(previewUrl, width, height, index) {
    return await classifyFromUrl(previewUrl, index);
  },
  async terminate() {
    if (worker) {
      await worker.terminate();
      worker = null;
      console.log('[classifier] worker terminated');
    }
  },
};
