// image_classifier.js
// Three-tier image classification using Tesseract.js, fully local.
// Tier 1: screenshot with text  → { tier: 1, text: "..." }
// Tier 2: screenshot, no text  → { tier: 2 }
// Tier 3: photo/image          → { tier: 3, blob }

let worker = null;

async function getWorker() {
  if (worker) return worker;

  console.log('[classifier] initializing Tesseract worker');

  // Chrome blocks spawning a Worker from a chrome-extension:// URL when called
  // from a content script running on claude.ai. Fix: fetch the worker script
  // and re-serve it as a same-origin blob URL — that's what workerBlobURL does
  // internally, but it needs the fetch to succeed first.
  const workerExtUrl = chrome.runtime.getURL('worker.min.js');
  const workerScript = await fetch(workerExtUrl).then(r => r.text());
  const workerBlob   = new Blob([workerScript], { type: 'application/javascript' });
  const workerPath   = URL.createObjectURL(workerBlob);

  const langPath = chrome.runtime.getURL('');  // folder — Tesseract appends "eng.traineddata"
  const corePath = chrome.runtime.getURL('tesseract-core-lstm.wasm.js');

  worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
    workerPath,
    langPath,
    corePath,
    workerBlobURL: false,  // we already made the blob URL ourselves
    cacheMethod: 'none',
    logger: () => {},
  });

  console.log('[classifier] Tesseract worker ready');
  return worker;
}

// Classify an image from a URL (preview_url from the API).
// Returns: { tier: 1, text } | { tier: 2 } | { tier: 3, blob }
async function classifyFromUrl(url, index) {
  // Fetch the image as a blob first (needed for both OCR and tier-3 saving)
  let blob;
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
    blob = await resp.blob();
  } catch (err) {
    console.error('[classifier] fetch error:', err);
    return { tier: 3, blob: null };
  }

  // Convert blob to data URL for Tesseract
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

// Namespace that exporter.js expects
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
