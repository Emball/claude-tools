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
    if (workerLoading) return new Promise((res, rej) => workerQueue.push({ res, rej }));

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

  function scoreImage(width, height) {
    let score = 0;
    if (width && height) {
      const ratio = width / height;
      const cameraRatios = [4/3, 3/2, 16/9, 1, 3/4, 2/3];
      if (cameraRatios.some(r => Math.abs(ratio - r) / r < 0.02)) score += 2;
      if (height > width) score += 1;
      const commonScreenWidths = [1920, 1440, 1366, 1280, 2560, 3840];
      if (commonScreenWidths.includes(width)) score -= 2;
    }
    return score;
  }

  // Fetch as blob → object URL → canvas (avoids CORS taint on getImageData)
  async function fetchToCanvas(url) {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`fetch ${resp.status}`);
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(objUrl);
        resolve({ canvas, blob });
      };
      img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error('img load failed')); };
      img.src = objUrl;
    });
  }

  async function runOCR(canvas) {
    const worker = await getWorker();
    const { data } = await worker.recognize(canvas);
    const confidentWords = (data.words || []).filter(w => w.confidence > 60);
    return confidentWords.map(w => w.text).join(' ').trim();
  }

  async function classify(url, width, height, index) {
    const score = scoreImage(width, height);
    console.log(`[classifier] image ${index + 1}: ${width}x${height}, score=${score}`);

    if (score >= 3) {
      console.log('[classifier] tier 3 (photo by dimensions)');
      // Still need the blob for ZIP packaging
      try {
        const resp = await fetch(url, { credentials: 'include' });
        const blob = await resp.blob();
        return { tier: 3, blob };
      } catch (err) {
        console.warn('[classifier] fetch failed for tier 3:', err);
        return { tier: 3, blob: null };
      }
    }

    try {
      const { canvas, blob } = await fetchToCanvas(url);
      const text = await runOCR(canvas);
      console.log(`[classifier] OCR extracted ${text.length} chars`);

      if (text.length > 10) {
        console.log('[classifier] tier 1 (screenshot with text)');
        return { tier: 1, text };
      } else if (score > 0) {
        console.log('[classifier] tier 3 (photo, low OCR)');
        return { tier: 3, blob };
      } else {
        console.log('[classifier] tier 2 (screenshot, no text)');
        return { tier: 2 };
      }
    } catch (err) {
      console.warn('[classifier] failed, defaulting to tier 3:', err);
      try {
        const resp = await fetch(url, { credentials: 'include' });
        const blob = await resp.blob();
        return { tier: 3, blob };
      } catch {
        return { tier: 3, blob: null };
      }
    }
  }

  return { classify };
})();
