/* Management page. The code is exchanged for an HttpOnly session cookie by the
   server; every subsequent action is authorised server-side. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const loginView = $('loginView');
  const managerView = $('managerView');
  const grid = $('grid');
  const modal = $('modal');
  const toast = $('toast');

  let images = [];
  let selected = new Set();
  let pendingDelete = [];

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1600);
  }

  function setMsg(el, text, type) {
    el.textContent = text;
    el.className = 'msg show ' + (type || 'info');
  }

  function hideMsg(el) {
    el.className = 'msg';
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

  function formatDate(value) {
    if (!value) return '';
    // MySQL returns "YYYY-MM-DD HH:MM:SS" in UTC.
    const d = new Date(value.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return value;
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }

  function setLoggedIn(state) {
    loginView.style.display = state ? 'none' : '';
    managerView.style.display = state ? '' : 'none';
    $('logoutLink').style.display = state ? '' : 'none';
  }

  async function loadImages() {
    hideMsg($('managerMsg'));
    $('countLabel').textContent = 'Loading…';
    grid.innerHTML = '';

    try {
      const res = await fetch('/api/manage/images', { credentials: 'same-origin' });
      if (res.status === 401) { setLoggedIn(false); return; }
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.message || 'Could not load images.');

      images = data.images;
      selected = new Set();
      render();
    } catch (err) {
      setMsg($('managerMsg'), err.message, 'error');
      $('countLabel').textContent = '';
    }
  }

  function render() {
    grid.innerHTML = '';
    $('empty').style.display = images.length ? 'none' : '';
    $('countLabel').textContent =
      images.length + (images.length === 1 ? ' image' : ' images') +
      (selected.size ? ' · ' + selected.size + ' selected' : '');

    images.forEach((img) => {
      const el = document.createElement('div');
      el.className = 'item' + (selected.has(img.id) ? ' sel' : '');

      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      const im = document.createElement('img');
      im.src = img.url;
      im.alt = img.filename;
      im.loading = 'lazy';
      im.decoding = 'async';
      thumb.appendChild(im);

      const pick = document.createElement('input');
      pick.type = 'checkbox';
      pick.className = 'pick';
      pick.checked = selected.has(img.id);
      pick.title = 'Select';
      pick.addEventListener('change', () => {
        if (pick.checked) selected.add(img.id); else selected.delete(img.id);
        el.classList.toggle('sel', pick.checked);
        $('deleteSelectedBtn').disabled = selected.size === 0;
        $('countLabel').textContent =
          images.length + (images.length === 1 ? ' image' : ' images') +
          (selected.size ? ' · ' + selected.size + ' selected' : '');
      });
      thumb.appendChild(pick);

      const body = document.createElement('div');
      body.className = 'body';

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = img.filename;
      name.title = img.filename;

      const url = document.createElement('a');
      url.className = 'url';
      url.href = img.url;
      url.target = '_blank';
      url.rel = 'noopener noreferrer';
      url.textContent = img.url;
      url.title = 'Open in a new tab';

      const meta = document.createElement('div');
      meta.className = 'meta';
      const m1 = document.createElement('span'); m1.textContent = formatDate(img.uploadedAt);
      const m2 = document.createElement('span'); m2.textContent = img.sizeLabel;
      const m3 = document.createElement('span'); m3.textContent = img.mime.replace('image/', '').toUpperCase();
      meta.append(m1, m2, m3);

      const ops = document.createElement('div');
      ops.className = 'ops';

      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open';
      openBtn.addEventListener('click', () => window.open(img.url, '_blank', 'noopener'));

      const copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy URL';
      copyBtn.addEventListener('click', () => copyText(img.url));

      const delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.className = 'danger';
      delBtn.addEventListener('click', () => askDelete([img.id]));

      ops.append(openBtn, copyBtn, delBtn);
      body.append(name, url, meta, ops);
      el.append(thumb, body);
      grid.appendChild(el);
    });

    $('deleteSelectedBtn').disabled = selected.size === 0;
  }


  /* ---------------- delete with confirmation ---------------- */
  function askDelete(ids) {
    pendingDelete = ids;
    const targets = images.filter((i) => ids.includes(i.id));
    $('modalTitle').textContent =
      ids.length === 1 ? 'Are you sure you want to delete this image?' : `Delete ${ids.length} selected images?`;
    $('modalList').innerHTML = '';
    targets.forEach((t) => {
      const row = document.createElement('div');
      row.textContent = t.filename;
      const u = document.createElement('div');
      u.className = 'u';
      u.textContent = t.url;
      row.appendChild(u);
      $('modalList').appendChild(row);
    });
    modal.classList.add('show');
  }

  function closeModal() {
    modal.classList.remove('show');
    pendingDelete = [];
  }

  $('cancelDelete').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  $('confirmDelete').addEventListener('click', async () => {
    const ids = pendingDelete.slice();
    if (!ids.length) return;
    $('confirmDelete').disabled = true;
    $('confirmDelete').innerHTML = '<span class="spinner"></span>Deleting';

    try {
      const res = await fetch('/api/manage/delete', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 401) { closeModal(); setLoggedIn(false); return; }
      if (!res.ok || !data.ok) throw new Error(data.message || 'Delete failed.');

      closeModal();
      selected = new Set();
      await loadImages();
      let text = data.message;
      if (data.orphanedFiles && data.orphanedFiles.length) text += ' (a missing file was cleaned up)';
      setMsg($('managerMsg'), text, 'success');
    } catch (err) {
      closeModal();
      setMsg($('managerMsg'), err.message, 'error');
    } finally {
      $('confirmDelete').disabled = false;
      $('confirmDelete').textContent = 'Delete';
    }
  });

  $('deleteSelectedBtn').addEventListener('click', () => askDelete([...selected]));

  $('selectAllBtn').addEventListener('click', () => {
    const all = selected.size === images.length && images.length > 0;
    selected = all ? new Set() : new Set(images.map((i) => i.id));
    render();
  });

  /* ---------------- login / logout ---------------- */
  $('mcode').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
  });

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMsg($('loginMsg'));
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Checking';

    try {
      const res = await fetch('/api/manage/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: $('mcode').value.trim() })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.message || 'Login failed.');

      $('mcode').value = '';
      setLoggedIn(true);
      await loadImages();
    } catch (err) {
      setMsg($('loginMsg'), err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Unlock Manager';
    }
  });

  $('logoutLink').addEventListener('click', async (e) => {
    e.preventDefault();
    await fetch('/api/manage/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    images = [];
    selected = new Set();
    grid.innerHTML = '';
    setLoggedIn(false);
  });

  // Restore an existing session on page load.
  (async function init() {
    try {
      const res = await fetch('/api/manage/status', { credentials: 'same-origin' });
      const data = await res.json();
      if (data && data.authenticated) {
        setLoggedIn(true);
        await loadImages();
      } else {
        setLoggedIn(false);
      }
    } catch (err) {
      setLoggedIn(false);
    }
  })();
})();
