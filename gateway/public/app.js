const API = "api/files";
const el = (id) => document.getElementById(id);
const state = { files: [], ticket: 0, queue: Promise.resolve(), waiting: 0 };
const fmtSize = (bytes) => {
  if (bytes < 1024) return bytes + " B";
  const units = ["KiB", "MiB", "GiB"];
  let i = -1;
  do {
    bytes /= 1024;
    i++;
  } while (bytes >= 1024 && i < 2);
  return bytes.toFixed(1) + " " + units[i];
};
const fmtDate = (iso) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
function showToast(message, kind = "ok") {
  el("toast").textContent = message;
  el("toast").className = "toast toast--" + kind;
  el("toast").hidden = false;
}
async function jsonRequest(path, init) {
  const response = await fetch(path, init);
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(data?.error || "Request failed: HTTP " + response.status);
  if (data === null)
    throw new Error(
      "Storage returned an invalid response. Refresh the page and try again.",
    );
  return data;
}
async function checkHealth() {
  try {
    const res = await jsonRequest("healthz");
    el("status").className = "status status--ok";
    el("statusText").textContent =
      res.backend === "service-worker"
        ? "Browser storage ready"
        : "Gateway online";
  } catch (e) {
    el("status").className = "status status--err";
    el("statusText").textContent = "Storage unavailable";
  }
}
async function loadFiles() {
  const ticket = ++state.ticket;
  try {
    const files = await jsonRequest(API);
    if (!Array.isArray(files)) throw new Error("Invalid file list");
    if (ticket !== state.ticket) return;
    state.files = files.sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
    );
    renderFiles();
    el("statFiles").textContent = files.length;
    el("statBytes").textContent = fmtSize(
      files.reduce((sum, f) => sum + f.size, 0),
    );
    const histories = await Promise.all(
      files.map((f) =>
        jsonRequest(API + "/" + encodeURIComponent(f.fileId) + "/versions"),
      ),
    );
    if (ticket !== state.ticket) return;
    el("statVersions").textContent = histories.reduce(
      (sum, v) => sum + v.length,
      0,
    );
    el("statChunks").textContent = histories
      .flat()
      .reduce((sum, v) => sum + v.chunkCount, 0);
    await window.refreshStorageNodes?.();
    if (navigator.storage?.estimate) {
      const s = await navigator.storage.estimate();
      el("storageUsage").textContent =
        "Browser usage: " +
        fmtSize(s.usage || 0) +
        (s.quota ? " / " + fmtSize(s.quota) : "");
    }
  } catch (e) {
    showToast("Could not refresh files: " + e.message, "err");
  }
}
function renderFiles() {
  const search = el("fileSearch").value.trim().toLowerCase();
  const files = state.files.filter((f) =>
    f.filename.toLowerCase().includes(search),
  );
  el("fileCount").textContent = "(" + state.files.length + ")";
  const table = el("table");
  table.replaceChildren();
  if (!files.length) {
    const box = document.createElement("div");
    box.className = "empty-state";
    const h = document.createElement("h3");
    h.textContent = search ? "No matching files" : "Your workspace is ready";
    const p = document.createElement("p");
    p.textContent = search
      ? "Try a different search."
      : "Upload your first file. Each file has a separate identity and version history.";
    box.append(h, p);
    table.append(box);
    return;
  }
  files.forEach((f) => table.append(buildRow(f)));
}
function action(button, fn) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await fn();
    } catch (e) {
      showToast(e.message, "err");
    } finally {
      button.disabled = false;
    }
  });
}
function buildRow(file) {
  const node = el("rowTemplate").content.cloneNode(true),
    article = node.querySelector(".object");
  article.dataset.fileId = file.fileId;
  node.querySelector(".object__name").textContent = file.filename;
  node.querySelector(".object__size").textContent = fmtSize(file.size);
  node.querySelector(".object__updated").textContent = fmtDate(file.updatedAt);
  node.querySelector(".badge--version").textContent = "v" + file.latestVersion;
  node.querySelector(".object__id").textContent = "ID " + file.fileId;
  const toggle = node.querySelector(".object__toggle"),
    detail = node.querySelector(".object__detail");
  action(toggle, async () => {
    const open = detail.hidden;
    detail.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      detail.textContent = "Loading history?";
      const versions = await jsonRequest(
        API + "/" + encodeURIComponent(file.fileId) + "/versions",
      );
      detail.replaceChildren();
      versions
        .sort((a, b) => b.version - a.version)
        .forEach((v) => detail.append(buildVersion(file, v)));
    }
  });
  action(node.querySelector(".btn--download"), () => download(file));
  const input = node.querySelector(".object__version-input");
  node.querySelector(".btn--new-version").onclick = () => input.click();
  input.onchange = () => {
    if (input.files[0]) enqueue(input.files[0], file.fileId).catch(() => {});
    input.value = "";
  };
  action(node.querySelector(".btn--delete"), async () => {
    if (
      !confirm(
        'Delete "' +
          file.filename +
          '" and all of its versions? This cannot be undone.',
      )
    )
      return;
    await jsonRequest(API + "/" + encodeURIComponent(file.fileId), {
      method: "DELETE",
    });
    showToast("Deleted " + file.filename);
    await loadFiles();
  });
  return node;
}
function buildVersion(file, v) {
  const node = el("versionRowTemplate").content.cloneNode(true);
  node.querySelector(".badge--version").textContent = "v" + v.version;
  node.querySelector(".version__size").textContent = fmtSize(v.size);
  node.querySelector(".version__date").textContent = fmtDate(v.createdAt);
  node.querySelector(".version__current").textContent =
    v.version === file.latestVersion ? "Current version" : "";
  node.querySelector(".version__checksum").textContent =
    "SHA-256 " + v.checksum;
  const ledger = node.querySelector(".version__ledger");
  for (let i = 0; i < Math.min(v.chunkCount, 64); i++) {
    const chunk = v.chunks?.[i],
      square = document.createElement("span");
    square.className = "ledger__chunk";
    square.title =
      "Chunk " +
      (i + 1) +
      (chunk
        ? " ? " +
          fmtSize(chunk.size) +
          " ? stored on " +
          (chunk.replicatedTo || ["replica-a", "replica-b"]).join(", ")
        : "");
    ledger.append(square);
  }
  node.querySelector(".ledger-caption").textContent =
    v.chunkCount +
    " encrypted chunk" +
    (v.chunkCount === 1 ? "" : "s") +
    " ? up to 1 MiB each" +
    (v.chunkCount > 64 ? " ? first 64 shown" : "");
  const details = node.querySelector(".chunk-details");
  if (v.chunks?.length) {
    const table = document.createElement("table");
    const tr = document.createElement("tr");
    for (const label of [
      "Chunk",
      "Bytes",
      "12-byte IV",
      "16-byte GCM tag",
      "Stored replicas",
    ]) {
      const th = document.createElement("th");
      th.textContent = label;
      tr.append(th);
    }
    table.append(tr);
    for (const [i, c] of v.chunks.slice(0, 64).entries()) {
      const row = document.createElement("tr");
      for (const value of [
        i + 1,
        c.size,
        c.iv,
        c.authTag,
        (c.replicatedTo || []).join(", ") ||
          "Not recorded for this older upload",
      ]) {
        const td = document.createElement("td");
        td.textContent = value;
        row.append(td);
      }
      table.append(row);
    }
    node.querySelector(".chunk-data").append(table);
  } else details.hidden = true;
  action(node.querySelector(".btn--download-version"), () => download(file, v));
  const rollback = node.querySelector(".btn--rollback");
  if (v.version === file.latestVersion) {
    rollback.disabled = true;
    rollback.textContent = "Current";
  } else
    action(rollback, async () => {
      await jsonRequest(
        API + "/" + encodeURIComponent(file.fileId) + "/rollback",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: v.version }),
        },
      );
      showToast(
        "Restored v" + v.version + ". Your other versions are retained.",
      );
      await loadFiles();
    });
  return node;
}
async function readVerified(file, version) {
  const histories = version
    ? [version]
    : await jsonRequest(
        API + "/" + encodeURIComponent(file.fileId) + "/versions",
      );
  const expected =
    version || histories.find((v) => v.version === file.latestVersion);
  if (!expected)
    throw new Error("The current version changed. Refresh before downloading.");
  const response = await fetch(
    API +
      "/" +
      encodeURIComponent(file.fileId) +
      "/download?version=" +
      expected.version,
  );
  if (!response.ok) {
    const message = await response.json().catch(() => null);
    throw new Error(
      "Download blocked: " + (message?.error || "HTTP " + response.status),
    );
  }
  const blob = await response.blob();
  const actual = hex(
    await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
  );
  if (blob.size !== expected.size || actual !== expected.checksum)
    throw new Error(
      "Download blocked: file size or SHA-256 does not match the saved version.",
    );
  let filename = expected.filename || file.filename;
  const header = response.headers.get("Content-Disposition") || "";
  const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    try {
      filename = decodeURIComponent(utf8[1]);
    } catch {}
  }
  return {
    blob,
    filename,
    checksum: actual,
    replicas: response.headers.get("X-Served-From"),
  };
}
async function download(file, version) {
  showToast("Verifying " + file.filename + "?");
  const result = await readVerified(file, version);
  const url = URL.createObjectURL(result.blob),
    a = document.createElement("a");
  a.href = url;
  a.download = result.filename;
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  showToast(
    "Downloaded " +
      result.filename +
      " ? SHA-256 verified" +
      (result.replicas ? " ? read from " + result.replicas : ""),
  );
}
function upload(file, id) {
  return new Promise((resolve, reject) => {
    el("progressWrap").hidden = false;
    el("progressName").textContent = file.name;
    el("progressFill").style.width = "0%";
    el("progressPct").textContent = "0%";
    el("progressStage").textContent = "Sending file to storage?";
    el("queueStatus").textContent =
      state.waiting + " file(s) in the upload queue";
    const form = new FormData();
    form.append("file", file);
    if (id) form.append("fileId", id);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", API + "/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        el("progressFill").style.width = pct + "%";
        el("progressPct").textContent = pct + "%";
        if (pct === 100)
          el("progressStage").textContent =
            "Encrypting chunks and committing the saved version?";
      }
    };
    xhr.onload = () => {
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        return reject(
          new Error("Storage returned an invalid upload response."),
        );
      }
      if (xhr.status < 200 || xhr.status >= 300)
        return reject(
          new Error(data.error || "Upload failed: HTTP " + xhr.status),
        );
      resolve(data);
    };
    xhr.onerror = () =>
      reject(
        new Error("Upload failed. Check your connection and storage status."),
      );
    xhr.onabort = () => reject(new Error("Upload cancelled."));
    xhr.send(form);
  });
}
function enqueue(file, id) {
  state.waiting++;
  const result = state.queue.then(async () => {
    state.waiting--;
    try {
      const stored = await upload(file, id);
      showToast(
        "Saved " +
          file.name +
          " as v" +
          stored.version +
          " ? " +
          fmtSize(stored.size),
      );
      await loadFiles();
      return stored;
    } catch (e) {
      showToast("Could not save " + file.name + ": " + e.message, "err");
      throw e;
    } finally {
      el("progressWrap").hidden = true;
    }
  });
  state.queue = result.catch(() => {});
  return result;
}
function initDropzone() {
  const dz = el("dropzone"),
    input = el("fileInput");
  const add = (files) =>
    Array.from(files).forEach((file) => enqueue(file).catch(() => {}));
  dz.onclick = () => input.click();
  dz.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  };
  input.onchange = () => {
    add(input.files);
    input.value = "";
  };
  for (const name of ["dragenter", "dragover"])
    dz.addEventListener(name, (e) => {
      e.preventDefault();
      dz.classList.add("is-dragover");
    });
  for (const name of ["dragleave", "drop"])
    dz.addEventListener(name, (e) => {
      e.preventDefault();
      dz.classList.remove("is-dragover");
    });
  dz.addEventListener("drop", (e) => add(e.dataTransfer.files));
}
async function verification() {
  if (!window.STORAGE_DEMO)
    throw new Error(
      "Use the GitHub Pages demo to run the replica-offline check.",
    );
  const nodes = await jsonRequest("api/_demo/replicas");
  if (nodes.nodes.some((n) => !n.online))
    throw new Error("Bring both replicas online before running the check.");
  const report = el("verificationReport");
  report.textContent =
    "Creating 2.5 MiB sample and storing 3 encrypted chunks?";
  const bytes = new Uint8Array(2621440);
  for (let offset = 0; offset < bytes.length; offset += 65536)
    crypto.getRandomValues(
      bytes.subarray(offset, Math.min(offset + 65536, bytes.length)),
    );
  const stored = await enqueue(
    new File([bytes], "verification-" + Date.now() + ".bin", {
      type: "application/octet-stream",
    }),
  );
  const file = state.files.find((f) => f.fileId === stored.fileId);
  try {
    await jsonRequest("api/_demo/replicas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offline: ["replica-a"] }),
    });
    await window.refreshStorageNodes?.();
    report.textContent =
      "Replica A is offline. Reading and verifying replica B?";
    const result = await readVerified(file);
    if (result.replicas !== "replica-b")
      throw new Error("The failover result did not identify replica B.");
    report.textContent =
      "? 2.5 MiB stored across 3 encrypted chunks\n? Replica A offline: read served by replica B\n? Original size and SHA-256 match\n\nSample saved in your file list. Open History to inspect its IVs, tags, and checksum.";
  } catch (e) {
    report.textContent = "Check failed: " + e.message;
    throw e;
  } finally {
    await jsonRequest("api/_demo/replicas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offline: [] }),
    });
    await window.refreshStorageNodes?.();
  }
}
el("fileSearch").oninput = renderFiles;
action(el("refreshFiles"), loadFiles);
action(el("runVerification"), verification);
initDropzone();
checkHealth();
loadFiles();
setInterval(checkHealth, 15000);
if (!window.STORAGE_DEMO) {
  el("modeLabel").textContent = "Express + gRPC";
  el("storageMode").textContent =
    "Server-backed storage. Replica health controls are available in the browser demo.";
  el("nodesPanel").textContent = "Two disk replicas ? optional S3";
  el("runVerification").disabled = true;
}
