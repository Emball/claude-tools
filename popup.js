// popup.js — settings toggle logic

const btnMd = document.getElementById('btn-md');
const btnTxt = document.getElementById('btn-txt');
const status = document.getElementById('status');

function setActive(format) {
  btnMd.classList.toggle('active', format === 'md');
  btnTxt.classList.toggle('active', format === 'txt');
}

function flash(msg) {
  status.textContent = msg;
  setTimeout(() => { status.textContent = ''; }, 1200);
}

chrome.storage.sync.get({ format: 'md' }, ({ format }) => {
  setActive(format);
  console.log('[popup] loaded format:', format);
});

btnMd.addEventListener('click', () => {
  chrome.storage.sync.set({ format: 'md' }, () => {
    setActive('md');
    flash('Saved');
    console.log('[popup] format set to md');
  });
});

btnTxt.addEventListener('click', () => {
  chrome.storage.sync.set({ format: 'txt' }, () => {
    setActive('txt');
    flash('Saved');
    console.log('[popup] format set to txt');
  });
});
