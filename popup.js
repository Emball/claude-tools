// popup.js — settings logic

const DEFAULTS = {
  format:    'md',
  thinking:  false,
  tools:     true,
  images:    true,
  ocr:       true,
  zip:       true,
  zipFiles:  true,
};

const btnMd       = document.getElementById('btn-md');
const btnTxt      = document.getElementById('btn-txt');
const togThink    = document.getElementById('tog-thinking');
const togTools    = document.getElementById('tog-tools');
const togImages   = document.getElementById('tog-images');
const togOcr      = document.getElementById('tog-ocr');
const togZip      = document.getElementById('tog-zip');
const togZipFiles = document.getElementById('tog-zip-files');
const subOcr      = document.getElementById('sub-ocr');
const subZip      = document.getElementById('sub-zip');
const status      = document.getElementById('status');

function flash(msg) {
  status.textContent = msg;
  setTimeout(() => { status.textContent = ''; }, 1000);
}

function updateSubRows(imagesOn) {
  subOcr.classList.toggle('disabled', !imagesOn);
  subZip.classList.toggle('disabled', !imagesOn);
}

function applySettings(s) {
  btnMd.classList.toggle('active', s.format === 'md');
  btnTxt.classList.toggle('active', s.format === 'txt');
  togThink.checked    = s.thinking;
  togTools.checked    = s.tools;
  togImages.checked   = s.images;
  togOcr.checked      = s.ocr;
  togZip.checked      = s.zip;
  togZipFiles.checked = s.zipFiles;
  updateSubRows(s.images);
  console.log('[popup] settings loaded:', s);
}

chrome.storage.sync.get(DEFAULTS, applySettings);

btnMd.addEventListener('click', () => {
  chrome.storage.sync.set({ format: 'md' }, () => {
    btnMd.classList.add('active');
    btnTxt.classList.remove('active');
    flash('Saved');
    console.log('[popup] format → md');
  });
});
btnTxt.addEventListener('click', () => {
  chrome.storage.sync.set({ format: 'txt' }, () => {
    btnTxt.classList.add('active');
    btnMd.classList.remove('active');
    flash('Saved');
    console.log('[popup] format → txt');
  });
});

function makeToggle(el, key, onChange) {
  el.addEventListener('change', () => {
    const val = el.checked;
    chrome.storage.sync.set({ [key]: val }, () => {
      flash('Saved');
      console.log(`[popup] ${key} → ${val}`);
      if (onChange) onChange(val);
    });
  });
}

makeToggle(togThink,    'thinking');
makeToggle(togTools,    'tools');
makeToggle(togImages,   'images', updateSubRows);
makeToggle(togOcr,      'ocr');
makeToggle(togZip,      'zip');
makeToggle(togZipFiles, 'zipFiles');
