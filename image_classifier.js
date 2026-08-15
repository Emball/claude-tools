// image_classifier.js — content script
// Routes OCR requests through background.js → chrome.offscreen document.
// The offscreen document runs Tesseract WASM in a pure extension context,
// completely isolated from claude.ai's CSP.

async function ocrDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'ocr', dataUrl }, result => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!result) return reject(new Error('no response from background'));
      if (result.error) return reject(new Error(result.error));
      resolve(result);
    });
  });
}

const PHOTO_RATIOS = [
  4/3, 3/4, 3/2, 2/3, 16/9, 9/16, 1/1,
  5/4, 4/5, 5/3, 3/5, 7/5, 5/7, 16/10, 10/16,
];
const RATIO_TOLERANCE = 0.02;

function looksLikePhoto(width, height) {
  if (!width || !height) return false;
  if (height > width) return true; // portrait = almost certainly a photo on desktop
  const ratio = width / height;
  return PHOTO_RATIOS.some(r => Math.abs(ratio - r) <= RATIO_TOLERANCE);
}

async function classifyFromUrl(url, width, height, index) {
  let blob;
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
    blob = await resp.blob();
  } catch (err) {
    console.error('[classifier] fetch error:', err);
    return { tier: 3, blob: null };
  }

  if (looksLikePhoto(width, height)) {
    console.log(`[classifier] image ${index}: photo (${width}x${height}) → tier 3`);
    return { tier: 3, blob };
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  try {
    const result = await ocrDataUrl(dataUrl);
    const { text, confidence } = result;
    console.log(`[classifier] image ${index}: confidence=${confidence}, chars=${text.length}, dims=${width}x${height}`);
    if (confidence >= 60 && text.length >= 10) return { tier: 1, text };
    return { tier: 2 };
  } catch (err) {
    console.error('[classifier] OCR error, falling back to tier 2:', err);
    return { tier: 2 };
  }
}

const ImageClassifier = {
  async classify(previewUrl, width, height, index) {
    return await classifyFromUrl(previewUrl, width, height, index);
  },
  async terminate() {
    console.log('[classifier] terminate (offscreen managed by background)');
  },
};
