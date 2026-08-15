// image_classifier.js — content script
// Routes OCR requests through background.js → ocr_engine.html (extension context).
// All images go through OCR. Tier 1 = text extracted, Tier 2 = no text found,
// Tier 3 = saved as image file (only on OCR error/timeout fallback).

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

async function classifyFromUrl(url, width, height, index) {
  let blob;
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
    blob = await resp.blob();
  } catch (err) {
    console.error('[classifier] fetch error:', err);
    return { tier: 2 };
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
    if (confidence >= 35 && text.length >= 20) return { tier: 1, text };
    return { tier: 2 };
  } catch (err) {
    // OCR failed — save as image file so data isn't lost
    console.error(`[classifier] image ${index}: OCR error, saving as file:`, err.message);
    return { tier: 3, blob };
  }
}

const ImageClassifier = {
  async classify(previewUrl, width, height, index) {
    return await classifyFromUrl(previewUrl, width, height, index);
  },
  async terminate() {
    console.log('[classifier] terminate');
  },
};
