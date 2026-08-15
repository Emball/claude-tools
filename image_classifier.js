// image_classifier.js
// Three-tier image classification using Tesseract.js, fully local.
// Tier 1: screenshot with text  → [screenshot: "extracted text"]
// Tier 2: screenshot, no text  → [screenshot: no extractable text]
// Tier 3: photo/image          → saved to images/ folder

let worker = null;

async function getWorker() {
  if (worker) return worker;

  console.log('[classifier] initializing Tesseract worker');

  const workerPath = chrome.runtime.getURL('worker.min.js');
  const langPath   = chrome.runtime.getURL('');   // folder — Tesseract appends "eng.traineddata"
  const corePath   = chrome.runtime.getURL('tesseract.min.js');

  worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
    workerPath,
    langPath,
    corePath,
    workerBlobURL: false,
    cacheMethod: 'none',
    logger: () => {},
  });

  console.log('[classifier] Tesseract worker ready');
  return worker;
}

// Classify a base64 image block.
// Returns: { tier: 1|2|3, text?: string, filename?: string, data?: string }
async function classifyImage(base64Data, mimeType, index) {
  try {
    const w = await getWorker();
    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    const { data } = await w.recognize(dataUrl);
    const text = data.text.trim();
    const confidence = data.confidence;

    console.log(`[classifier] image ${index}: confidence=${confidence}, chars=${text.length}`);

    if (confidence >= 60 && text.length >= 10) {
      // Tier 1: screenshot with readable text
      return { tier: 1, text };
    } else {
      // Tier 2: screenshot-like but no readable text (or low confidence)
      return { tier: 2 };
    }

  } catch (err) {
    console.error('[classifier] OCR error, falling back to tier 3:', err);
    // Tier 3: treat as photo on any error
    const ext = mimeType.split('/')[1] || 'png';
    return { tier: 3, filename: `image_${index}.${ext}`, data: base64Data, mimeType };
  }
}

// Main export: classify and render an image block to markdown text + collect image files.
// imageFiles: array to push { filename, data, mimeType } objects into for ZIP packaging.
async function renderImageBlock(block, index, imageFiles) {
  const { source } = block;
  if (!source || source.type !== 'base64') {
    return '[image: unable to render]';
  }

  const result = await classifyImage(source.data, source.media_type, index);

  if (result.tier === 1) {
    return `[screenshot: "${result.text}"]`;
  } else if (result.tier === 2) {
    return `[screenshot: no extractable text]`;
  } else {
    // Tier 3: save file, return relative link
    imageFiles.push({
      filename: result.filename,
      data: result.data,
      mimeType: result.mimeType,
    });
    return `![image](images/${result.filename})`;
  }
}

// Terminate worker when done (call after bulk export completes)
async function terminateClassifier() {
  if (worker) {
    await worker.terminate();
    worker = null;
    console.log('[classifier] worker terminated');
  }
}
