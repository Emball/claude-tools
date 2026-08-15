// image_classifier.js — scores images and routes to correct export tier
// Tier 1: screenshot with text  → [screenshot: "extracted text"]
// Tier 2: screenshot, no text  → [screenshot: no extractable text]
// Tier 3: photo                → saved to images/, triggers ZIP

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
      // Fetch traineddata while we still have chrome-extension:// access (content script context)
      const tdUrl = chrome.runtime.getURL('eng.traineddata');
      const tdResp = await fetch(tdUrl);
      const tdBuf = new Uint8Array(await tdResp.arrayBuffer());
      console.log(`[classifier] traineddata fetched: ${tdBuf.byteLength} bytes`);

      // Wrap as a blob URL — blob URLs ARE accessible from Web Workers
      const tdBlob = new Blob([tdBuf], { type: 'application/octet-stream' });
      const tdBlobUrl = URL.createObjectURL(tdBlob);

      // Tesseract fetches: ${langPath}/eng.traineddata
      // We create a fake "directory" blob URL by serving from a known base path.
      // The trick: set langPath to a blob URL that strips the filename we know it will append.
      // Since we can't make a blob URL directory, instead we serve the worker from a modified
      // worker script that has the traineddata embedded and skips the fetch entirely.

      // Actually: use the FS.writeFile approach AFTER the worker loads but BEFORE loadLanguage.
      // createWorker's internal sequence: load() → loadLanguage() → initialize()
      // We intercept by creating the worker with a langPath pointing to our blob.
      // Tesseract will request: blobUrl + '/eng.traineddata'
      // Blob URLs can't have paths appended — so we need the URL to end exactly as requested.

      // Final approach: serve from a mini service-worker-free intercept using a
      // modified langPath that IS the blob URL itself, and trick Tesseract by making
      // the blob URL end with '/eng.traineddata' by embedding it in a parent blob URL.

      // Create a blob that when fetched AT blobBaseUrl/eng.traineddata returns our data.
      // We can't do directories with blob URLs. But we CAN use the worker's writeText method.
      // The sequence: createWorker resolves AFTER loadLanguage+initialize. 
      // But writeText is available on the worker object immediately after the promise resolves.
      // So: let createWorker fail on loadLanguage, catch it, then write + reinitialize.

      const workerUrl = chrome.runtime.getURL('worker.min.js');

      // Use a dummy langPath that will 404 quickly. We catch the error, then use
      // writeText + reinitialize to load from our pre-fetched buffer.
      let worker;
      try {
        worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
          workerPath: workerUrl,
          langPath: 'https://example.invalid', // will 404/fail fast
          cacheMethod: 'none',
          gzip: false,
          logger: () => {},
          errorHandler: () => {}, // suppress error handler
        });
      } catch (initErr) {
        // Expected — langPath fetch failed, but the worker process is still alive.
        // Unfortunately createWorker doesn't expose the worker on failure.
        // We need a different approach.
        console.log('[classifier] expected init failure, using writeText approach');
      }

      // Since createWorker wraps everything and we can't get the worker on failure,
      // we need to use a real langPath. Use the blob URL directly as langPath
      // and name the blob to match what Tesseract will request.
      // Tesseract requests: langPath.replace(/\/$/, '') + '/' + lang + '.traineddata'
      // So if langPath = 'blob:https://claude.ai/xxx', it requests 'blob:.../xxx/eng.traineddata'
      // That's an invalid URL. But if langPath has no trailing slash and we strip it...
      // The blob URL itself IS the file if we make langPath = blobUrl without the filename.

      // REAL fix: create the worker with langPath set to a string where
      // langPath + '/eng.traineddata' resolves to a URL we can serve.
      // Use a fake https: URL and intercept in the SERVICE WORKER... which we don't have.

      // SIMPLEST WORKING APPROACH: 
      // Patch the worker's importScripts to include our data inline.
      // OR: just use langPath = tdBlobUrl and rename the blob URL trick.
      // The fetch URL will be: tdBlobUrl + '/eng.traineddata' which is invalid.
      
      // WHAT ACTUALLY WORKS: Pass the blob URL as langPath where Tesseract
      // strips the last path component expecting a directory.
      // If blobUrl = 'blob:https://claude.ai/uuid', then langPath/eng.traineddata 
      // = 'blob:https://claude.ai/uuid/eng.traineddata' — invalid.
      
      // BUT: if we use a regular https URL that we control... we don't have one.
      
      // ACTUAL SOLUTION: Use createWorker without a language, get the bare worker,
      // then use writeText + reinitialize.
      // The createWorker source shows it calls U().then(W(r)).then(z(r,e,c))
      // U = load WASM, W = loadLanguage, z = initialize
      // If we pass r = [] (empty array), W skips and z runs with empty langs.
      // Then we writeText + reinitialize.

      worker = await Tesseract.createWorker([], Tesseract.OEM.LSTM_ONLY, {
        workerPath: workerUrl,
        cacheMethod: 'none',
        gzip: false,
        logger: () => {},
      });

      console.log('[classifier] worker loaded, writing traineddata to FS...');
      // Write the traineddata directly into the worker's virtual FS
      await worker.writeText('eng.traineddata', tdBuf);
      console.log('[classifier] traineddata written, reinitializing...');
      await worker.reinitialize('eng', Tesseract.OEM.LSTM_ONLY);
      URL.revokeObjectURL(tdBlobUrl);

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
