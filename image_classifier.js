// image_classifier.js — content script
// Three-tier image classification using a multi-signal fingerprint.
// Tier 1: screenshot with extractable text → [screenshot: "text"]
// Tier 2: screenshot with no extractable text → [screenshot: no extractable text]
// Tier 3: photo → saved as image file in ZIP

// --- Photo fingerprint signals ---

// Standard camera/sensor aspect ratios. Tolerance: ±1px on either dimension.
const CAMERA_RATIOS = [
  [4, 3], [3, 4],   // classic camera
  [3, 2], [2, 3],   // 35mm film / DSLR
  [16, 9], [9, 16], // widescreen / phone video
  [1, 1],           // square (Instagram etc.)
  [5, 4], [4, 5],
  [5, 3], [3, 5],
  [7, 5], [5, 7],
  [16, 10], [10, 16],
];

function matchesCameraRatio(w, h) {
  for (const [rw, rh] of CAMERA_RATIOS) {
    // Check if w/h == rw/rh within ±1px on either side
    // w * rh == h * rw → cross multiply to avoid floats
    const diff = Math.abs(w * rh - h * rw);
    // Allow ±1px: perturb each dimension by 1 and recheck
    if (diff === 0) return true;
    if (Math.abs((w-1) * rh - h * rw) === 0) return true;
    if (Math.abs((w+1) * rh - h * rw) === 0) return true;
    if (Math.abs(w * rh - (h-1) * rw) === 0) return true;
    if (Math.abs(w * rh - (h+1) * rw) === 0) return true;
  }
  return false;
}

// Score an image as photo (positive) or screenshot (negative).
// Returns a score: >= 2 → photo (tier 3), < 2 → run OCR.
function photoScore(width, height, fileSize, mimeType) {
  let score = 0;
  const mp = (width || 0) * (height || 0);

  // Megapixels: real photos are 12MP+, screens cap at ~8MP (4K)
  if (mp >= 12_000_000) score += 3;       // very strong photo signal
  else if (mp >= 9_000_000) score += 2;   // strong photo signal
  else if (mp < 4_000_000) score -= 1;    // screenshot signal (below 4K)

  // Aspect ratio: must match a camera ratio at ±1px tolerance
  if (width && height && matchesCameraRatio(width, height)) score += 2;
  else score -= 1; // arbitrary dims = screenshot signal

  // File type: PNG = screenshot signal; JPEG = mild photo signal
  if (mimeType === 'image/png') score -= 2;
  else if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') score += 1;

  // File size: photos are large (>500KB raw), screenshots are small
  if (fileSize >= 500_000) score += 1;
  else if (fileSize < 100_000) score -= 1;

  return score;
}

// --- OCR bridge ---

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

// --- Main classifier ---

async function classifyFromUrl(url, width, height, index) {
  let blob, mimeType, fileSize;
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
    blob = await resp.blob();
    mimeType = blob.type;
    fileSize = blob.size;
  } catch (err) {
    console.error('[classifier] fetch error:', err);
    return { tier: 2 };
  }

  const score = photoScore(width, height, fileSize, mimeType);
  console.log(`[classifier] image ${index}: ${width}x${height}, ${(fileSize/1024).toFixed(0)}KB, ${mimeType}, score=${score}`);

  if (score >= 2) {
    console.log(`[classifier] image ${index}: classified as photo → tier 3`);
    return { tier: 3, blob };
  }

  // Screenshot candidate → run OCR
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  try {
    const result = await ocrDataUrl(dataUrl);
    const { text, confidence } = result;
    console.log(`[classifier] image ${index}: OCR confidence=${confidence}, chars=${text.length}`);
    if (confidence >= 35 && text.length >= 20) return { tier: 1, text };
    return { tier: 2 };
  } catch (err) {
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
