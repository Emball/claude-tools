// popup.js — settings + progress mirror

const DEFAULTS = {
  format:    'md',
  thinking:  false,
  tools:     true,
  images:    true,
  ocr:       false,
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
const progLabel   = document.getElementById('prog-label');
const progFill    = document.getElementById('prog-fill');

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
}

chrome.storage.sync.get(DEFAULTS, applySettings);

btnMd.addEventListener('click', () => {
  chrome.storage.sync.set({ format: 'md' }, () => {
    btnMd.classList.add('active');
    btnTxt.classList.remove('active');
    flash('Saved');
  });
});
btnTxt.addEventListener('click', () => {
  chrome.storage.sync.set({ format: 'txt' }, () => {
    btnTxt.classList.add('active');
    btnMd.classList.remove('active');
    flash('Saved');
  });
});

function makeToggle(el, key, onChange) {
  el.addEventListener('change', () => {
    const val = el.checked;
    chrome.storage.sync.set({ [key]: val }, () => {
      flash('Saved');
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

// ── Progress mirror ───────────────────────────────────────────────────────────
// Polls chrome.storage.local for cce_progress written by content.js

function updateProgress(data) {
  if (!data || !data.cce_progress) return;
  const { pct, label } = data.cce_progress;
  progFill.style.width  = ((pct || 0) * 100).toFixed(1) + '%';
  progLabel.textContent = label || 'Idle';
}

// Poll every 300ms while popup is open
chrome.storage.local.get(['cce_progress'], updateProgress);
const pollTimer = setInterval(() => {
  chrome.storage.local.get(['cce_progress'], updateProgress);
}, 300);

window.addEventListener('unload', () => clearInterval(pollTimer));
