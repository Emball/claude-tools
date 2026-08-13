// image_classifier.js — scores images and routes to correct export tier
// Tier 1: screenshot with text  → [screenshot: "extracted text"]
// Tier 2: screenshot, no text  → [screenshot: no extractable text]
// Tier 3: photo / large file   → saved to images/, triggers ZIP

const ImageClassifier = (() => {
  let tesseractWorker = null;
  let workerReady = false;
  let workerLoading = false;
  let workerQueue = [];

  async function getWorker() {
    if (workerReady) return tesseractWorker;

    if (workerLoading) {
      return new Promise((res, rej) => workerQueue.push({ res, rej }));
    }

    workerLoading = true;
    console.log('[classifier] loading Tesseract worker');

    try {
      const workerUrl = typeof chrome !== 'undefined' && chrome.runtime
        ? chrome.runtime.getURL('worker.min.js')
        : 'worker.min.js';
      const worker = await Tesseract.createWorker('eng', 1, {
        workerPath: workerUrl,
        logger: () => {},
      });
      tesseractWorker = worker;
      workerReady = true;
      workerQueue.forEach(({ res }) => res(worker));
      workerQueue = [];
      console.log('[classifier] Tesseract worker ready');
      return worker;
    } catch (err) {
      workerLoading = false;
      workerQueue.forEach(({ rej }) => rej(err));
      workerQueue = [];
      throw err;
    }
  }

  function scoreImage(base64Data, mediaType, width, height) {
    let score = 0; // positive = photo, negative = screenshot

    // Aspect ratio check — known camera ratios
    if (width && height) {
      const ratio = width / height;
      const cameraRatios = [4 / 3, 3 / 2, 16 / 9, 1, 3 / 4, 2 / 3];
      const nearCamera = cameraRatios.some(r => Math.abs(ratio - r) / r < 0.02);
      if (nearCamera) score += 2;

      // Portrait = likely photo
      if (height > width) score += 1;

      // Standard desktop screenshot dimensions → screenshot signal
      const commonScreenWidths = [1920, 1440, 1366, 1280, 2560, 3840];
      if (commonScreenWidths.includes(width)) score -= 2;
    }

    // Size estimate from base64 length (~75% efficiency)
    const byteSize = (base64Data.length * 3) / 4;
    if (byteSize > 1_000_000) score += 2;  // >1MB = likely photo
    if (byteSize > 4_000_000) score += 2;  // >4MB = almost certainly photo

    return score;
  }

  function base64ToImageData(base64Data, mediaType) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve({ canvas, width: img.width, height: img.height });
      };
      img.onerror = reject;
      img.src = `data:${mediaType};base64,${base64Data}`;
    });
  }

  async function runOCR(canvas) {
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas);
    return data;
  }

  // Main classification entry point
  // Returns { tier, text?, filename?, data?, mediaType? }
  async function classify(base64Data, mediaType, existingIndex) {
    const ext = (mediaType || 'image/png').split('/')[1] || 'png';

    let width, height, canvas;
    try {
      const imgData = await base64ToImageData(base64Data, mediaType);
      width = imgData.width;
      height = imgData.height;
      canvas = imgData.canvas;
    } catch (err) {
      console.warn('[classifier] failed to decode image, defaulting to tier 3:', err);
      return {
        tier: 3,
        filename: `image_${existingIndex + 1}.${ext}`,
        data: base64Data,
        mediaType,
      };
    }

    const photoScore = scoreImage(base64Data, mediaType, width, height);
    console.log(`[classifier] image ${existingIndex + 1}: ${width}x${height}, score=${photoScore}`);

    // High photo score — skip OCR, save as file
    if (photoScore >= 3) {
      console.log('[classifier] tier 3 (photo, high score)');
      return {
        tier: 3,
        filename: `image_${existingIndex + 1}.${ext}`,
        data: base64Data,
        mediaType,
      };
    }

    // Ambiguous or screenshot-leaning — run OCR
    try {
      const ocrData = await runOCR(canvas);
      const words = ocrData.words || [];
      const confidentWords = words.filter(w => w.confidence > 60);
      const extractedText = confidentWords.map(w => w.text).join(' ').trim();

      console.log(`[classifier] OCR: ${confidentWords.length} confident words, confidence avg=${
        confidentWords.length ? Math.round(confidentWords.reduce((s, w) => s + w.confidence, 0) / confidentWords.length) : 0
      }`);

      if (extractedText.length > 10) {
        console.log('[classifier] tier 1 (screenshot with text)');
        return { tier: 1, text: extractedText };
      } else {
        // OCR found nothing useful — but if photo score is positive, save as file
        if (photoScore > 0) {
          console.log('[classifier] tier 3 (photo, low OCR)');
          return {
            tier: 3,
            filename: `image_${existingIndex + 1}.${ext}`,
            data: base64Data,
            mediaType,
          };
        }
        console.log('[classifier] tier 2 (screenshot, no text)');
        return { tier: 2 };
      }
    } catch (err) {
      console.warn('[classifier] OCR failed, defaulting to tier 3:', err);
      return {
        tier: 3,
        filename: `image_${existingIndex + 1}.${ext}`,
        data: base64Data,
        mediaType,
      };
    }
  }

  return { classify };
})();
