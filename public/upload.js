/* Upload page logic. All real authentication happens server-side in
   /api/upload; this file only collects input and renders the result. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const form = $('uploadForm');
  const fileInput = $('file');
  const dropzone = $('dropzone');
  const preview = $('preview');
  const previewImg = $('previewImg');
  const previewName = $('previewName');
  const previewSize = $('previewSize');
  const submitBtn = $('submitBtn');
  const msg = $('msg');
  const result = $('result');
  const toast = $('toast');

  let currentFile = null;
  let objectUrl = null;

  function showMessage(text, type) {
    msg.textContent = text;
    msg.className = 'msg show ' + (type || 'info');
    msg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideMessage() {
    msg.className = 'msg';
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
    return value.toFixed(value >= 100 ? 0 : 1) + ' ' + units[i];
  }

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1600);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      showToast('Copied to clipboard');
    } catch (err) {
      showToast('Copy failed - select and copy manually');
    }
  }

  function setFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      showMessage('That file is not an image. Supported: JPG, PNG, GIF, WebP, BMP, AVIF.', 'error');
      return;
    }
    currentFile = file;

    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    previewImg.src = objectUrl;
    previewName.textContent = file.name;
    previewSize.textContent = formatBytes(file.size);
    preview.style.display = 'block';
    hideMessage();
  }

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });

  fileInput.addEventListener('change', () => setFile(fileInput.files[0]));

  ['dragenter', 'dragover'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); })
  );
  dropzone.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) {
      // Assign through the input so the FormData picks it up.
      fileInput.files = files;
      setFile(files[0]);
    }
  });

  // Prevent the browser from navigating away when a file is dropped outside the zone.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  $('code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMessage();

    if (!currentFile) { showMessage('Please choose an image first.', 'error'); return; }

    const fd = new FormData();
    fd.append('code', $('code').value.trim());
    fd.append('image', currentFile, currentFile.name);
    const slug = $('slug').value.trim();
    if (slug) fd.append('slug', slug);

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span>Uploading…';

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok) {
        throw new Error(data.message || 'Upload failed (HTTP ' + res.status + ').');
      }

      $('outUrl').value = data.url;
      $('outMd').value = data.markdown;
      $('outHtml').value = data.html;
      $('openBtn').onclick = () => window.open(data.url, '_blank', 'noopener');

      result.classList.add('show');
      result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      copyText(data.url);
    } catch (err) {
      showMessage(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Upload';
    }
  });

  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => copyText($(btn.getAttribute('data-copy')).value));
  });

  $('copyBtn').addEventListener('click', () => copyText($('outUrl').value));

  $('againBtn').addEventListener('click', () => {
    result.classList.remove('show');
    form.reset();
    currentFile = null;
    preview.style.display = 'none';
    $('slug').value = '';
    $('code').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();
