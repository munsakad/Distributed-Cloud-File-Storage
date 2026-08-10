const API = '/api/files';

const el = (id) => document.getElementById(id);
const table = el('table');
const emptyState = el('emptyState');
const rowTpl = el('rowTemplate');
const versionTpl = el('versionRowTemplate');

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = -1;
  do { v /= 1024; u += 1; } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(1)} ${units[u]}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function showToast(msg, kind) {
  const toast = el('toast');
  toast.textContent = msg;
  toast.hidden = false;
  toast.className = `toast toast--${kind}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.hidden = true; }, 5000);
}

async function checkHealth() {
  const dot = el('statusDot');
  const text = el('statusText');
  const wrap = el('status');
  try {
    const res = await fetch('/healthz');
    if (!res.ok) throw new Error('bad status');
    wrap.className = 'status status--ok';
    text.textContent = 'gateway online';
  } catch {
    wrap.className = 'status status--err';
    text.textContent = 'gateway unreachable';
  }
}

async function loadFiles() {
  const res = await fetch(API);
  const files = await res.json();
  el('fileCount').textContent = files.length ? `(${files.length})` : '';
  table.innerHTML = '';
  if (!files.length) {
    table.appendChild(emptyState);
    return;
  }
  files
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .forEach((f) => table.appendChild(buildRow(f)));
}

function buildRow(file) {
  const node = rowTpl.content.cloneNode(true);
  const article = node.querySelector('.object');
  article.dataset.fileId = file.fileId;

  node.querySelector('.object__name').textContent = file.filename;
  node.querySelector('.badge--version').textContent = `v${file.latestVersion}`;
  node.querySelector('.object__size').textContent = fmtSize(file.size);
  node.querySelector('.object__updated').textContent = fmtDate(file.updatedAt);
  node.querySelector('.object__id').textContent = file.fileId;

  const toggle = node.querySelector('.object__toggle');
  const detail = node.querySelector('.object__detail');
  let loaded = false;

  toggle.addEventListener('click', async () => {
    const open = article.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
    detail.hidden = !open;
    if (open && !loaded) {
      loaded = true;
      await loadVersions(file.fileId, detail);
    }
  });

  node.querySelector('.btn--download').addEventListener('click', (e) => {
    e.stopPropagation();
    window.location.href = `${API}/${file.fileId}/download`;
  });

  const versionInput = node.querySelector('.object__version-input');
  node.querySelector('.btn--new-version').addEventListener('click', (e) => {
    e.stopPropagation();
    versionInput.click();
  });
  versionInput.addEventListener('click', (e) => e.stopPropagation());
  versionInput.addEventListener('change', () => {
    if (versionInput.files[0]) uploadFile(versionInput.files[0], file.fileId);
    versionInput.value = '';
  });

  node.querySelector('.btn--delete').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${file.filename}" and all its versions? This cannot be undone.`)) return;
    const res = await fetch(`${API}/${file.fileId}`, { method: 'DELETE' });
    if (res.ok) { showToast(`deleted ${file.filename}`, 'ok'); loadFiles(); }
    else showToast('delete failed', 'err');
  });

  return node;
}

async function loadVersions(fileId, detailEl) {
  try {
    const res = await fetch(`${API}/${fileId}/versions`);
    const versions = await res.json();
    detailEl.innerHTML = '';
    versions
      .sort((a, b) => b.version - a.version)
      .forEach((v) => detailEl.appendChild(buildVersionRow(fileId, v)));
  } catch {
    detailEl.innerHTML = '<div class="detail__loading">failed to load versions</div>';
  }
}

function buildVersionRow(fileId, v) {
  const node = versionTpl.content.cloneNode(true);
  node.querySelector('.badge--version').textContent = `v${v.version}`;
  node.querySelector('.version__checksum').textContent = `sha256:${v.checksum.slice(0, 16)}…`;
  node.querySelector('.version__size').textContent = fmtSize(v.size);
  node.querySelector('.version__date').textContent = fmtDate(v.createdAt);

  const ledger = node.querySelector('.version__ledger');
  const MAX_SQUARES = 40;
  const shown = Math.min(v.chunkCount, MAX_SQUARES);
  for (let i = 0; i < shown; i += 1) {
    const sq = document.createElement('span');
    sq.className = 'ledger__chunk';
    ledger.appendChild(sq);
  }
  if (v.chunkCount > MAX_SQUARES) {
    const more = document.createElement('span');
    more.className = 'ledger__more';
    more.textContent = `+${v.chunkCount - MAX_SQUARES} more chunks`;
    ledger.appendChild(more);
  } else if (v.chunkCount === 0) {
    const empty = document.createElement('span');
    empty.className = 'ledger__more';
    empty.textContent = 'empty file — 0 chunks';
    ledger.appendChild(empty);
  }

  node.querySelector('.btn--download-version').addEventListener('click', () => {
    window.location.href = `${API}/${fileId}/download?version=${v.version}`;
  });

  node.querySelector('.btn--rollback').addEventListener('click', async () => {
    const res = await fetch(`${API}/${fileId}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: v.version }),
    });
    if (res.ok) { showToast(`current version set to v${v.version}`, 'ok'); loadFiles(); }
    else showToast('rollback failed', 'err');
  });

  return node;
}

function uploadFile(file, fileId) {
  const progressWrap = el('progressWrap');
  const progressFill = el('progressFill');
  const progressPct = el('progressPct');
  el('progressName').textContent = file.name;
  progressWrap.hidden = false;
  progressFill.style.width = '0%';
  progressPct.textContent = '0%';

  const formData = new FormData();
  formData.append('file', file);
  if (fileId) formData.append('fileId', fileId);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${API}/upload`);
  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    progressFill.style.width = `${pct}%`;
    progressPct.textContent = `${pct}%`;
  });
  xhr.addEventListener('load', () => {
    progressWrap.hidden = true;
    if (xhr.status >= 200 && xhr.status < 300) {
      const body = JSON.parse(xhr.responseText);
      showToast(`stored "${file.name}" as version ${body.version} (${fmtSize(body.size)})`, 'ok');
      loadFiles();
    } else {
      showToast(`upload failed: ${xhr.responseText}`, 'err');
    }
  });
  xhr.addEventListener('error', () => {
    progressWrap.hidden = true;
    showToast('upload failed: network error', 'err');
  });
  xhr.send(formData);
}

function initDropzone() {
  const dz = el('dropzone');
  const input = el('fileInput');

  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    if (input.files[0]) uploadFile(input.files[0]);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.add('is-dragover'); }),
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dz.addEventListener(evt, (e) => { e.preventDefault(); dz.classList.remove('is-dragover'); }),
  );
  dz.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  });
}

checkHealth();
initDropzone();
loadFiles();
setInterval(checkHealth, 15000);
