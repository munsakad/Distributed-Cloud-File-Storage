// Service worker that stands in for the Express gateway + gRPC storage node
// in the static GitHub Pages build. It answers the same /api/files routes the
// gateway exposes, so gateway/public/app.js runs unchanged, and it ports
// backend/src/services/* to the browser:
//   chunking.ts      -> fixed 1 MiB chunks
//   encryption.ts    -> AES-256-GCM per chunk (WebCrypto), IV + auth tag kept in metadata
//   replication/*    -> two IndexedDB object stores as replica-a / replica-b,
//                       fan-out writes, read failover in replica order
//   metadataStore.ts -> versions + current-version pointer, serialized writes
// The master key is a non-extractable CryptoKey generated in this browser.

const CHUNK_SIZE = 1024 * 1024; // DEFAULT_CHUNK_SIZE
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const REPLICAS = ["replica-a", "replica-b"];
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // browser storage is tighter than the gateway's 500 MB limit

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("message", (event) => {
  if (event.data === "claim") self.clients.claim();
});

// ---- IndexedDB -------------------------------------------------------------------
let dbPromise;
function openDb() {
  dbPromise =
    dbPromise ||
    new Promise((resolve, reject) => {
      const req = indexedDB.open("mini-dropbox-demo", 1);
      req.onupgradeneeded = () => {
        for (const name of [...REPLICAS, "meta", "config"])
          req.result.createObjectStore(name);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const idb = {
  get: (store, key) => run(store, "readonly", (s) => s.get(key)),
  put: (store, key, value) => run(store, "readwrite", (s) => s.put(value, key)),
  del: (store, key) => run(store, "readwrite", (s) => s.delete(key)),
  all: (store) => run(store, "readonly", (s) => s.getAll()),
  count: (store) => run(store, "readonly", (s) => s.count()),
};

// ---- encryption.ts ------------------------------------------------------------------
const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

let keyPromise;
function masterKey() {
  keyPromise =
    keyPromise ||
    (async () => {
      const key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      const db = await openDb();
      // Keep key selection and insertion in one transaction, including when
      // an old and a newly activated worker overlap. Never rotate saved keys.
      return new Promise((resolve, reject) => {
        const tx = db.transaction("config", "readwrite");
        const store = tx.objectStore("config");
        const get = store.get("masterKey");
        let selected;
        get.onsuccess = () => {
          selected = get.result || key;
          if (!get.result) store.put(key, "masterKey");
        };
        tx.oncomplete = () => resolve(selected);
        tx.onerror = tx.onabort = () =>
          reject(tx.error || new Error("Could not save encryption key"));
      });
    })();
  return keyPromise;
}

async function encryptChunk(plain) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await masterKey(),
      plain,
    ),
  );
  // WebCrypto appends the tag; split it off so it lives in metadata like the Node version
  return {
    ciphertext: sealed.slice(0, sealed.length - TAG_LENGTH),
    iv: hex(iv),
    authTag: hex(sealed.slice(sealed.length - TAG_LENGTH)),
  };
}

async function decryptChunk(ciphertext, ivHex, authTagHex) {
  const sealed = new Uint8Array(ciphertext.byteLength + TAG_LENGTH);
  sealed.set(new Uint8Array(ciphertext), 0);
  sealed.set(unhex(authTagHex), ciphertext.byteLength);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unhex(ivHex) },
    await masterKey(),
    sealed,
  );
}

// ---- replication --------------------------------------------------------------------
async function offlineReplicas() {
  return (await idb.get("config", "offline")) || [];
}

async function writeChunk(chunkId, data) {
  const offline = await offlineReplicas();
  const results = await Promise.allSettled(
    REPLICAS.map((name) =>
      offline.includes(name)
        ? Promise.reject(new Error(name + " is offline"))
        : idb.put(name, chunkId, data),
    ),
  );
  const replicatedTo = REPLICAS.filter(
    (_, i) => results[i].status === "fulfilled",
  );
  if (!replicatedTo.length)
    throw new Error("failed to replicate chunk " + chunkId + " to any target");
  return {
    replicatedTo,
    failed: REPLICAS.filter((n) => !replicatedTo.includes(n)),
  };
}

async function readChunk(chunkId, authenticate = (data) => data) {
  const offline = await offlineReplicas();
  let lastError;
  for (const name of REPLICAS) {
    try {
      if (offline.includes(name)) throw new Error(name + " is offline");
      const data = await idb.get(name, chunkId);
      if (!data) throw new Error("ENOENT: " + name + "/" + chunkId + ".chunk");
      return { data: await authenticate(data), replica: name };
    } catch (err) {
      lastError = err; // fail over to the next replica
    }
  }
  throw new Error(
    "chunk " + chunkId + " unreadable from all replicas: " + lastError,
  );
}

async function deleteChunk(chunkId) {
  await Promise.allSettled(REPLICAS.map((n) => idb.del(n, chunkId)));
}

// ---- metadataStore.ts -----------------------------------------------------------------
let writeQueue = Promise.resolve();
function mutate(fn) {
  const result = writeQueue.then(fn);
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const metadata = {
  getFile: (fileId) => idb.get("meta", fileId),
  listFiles: () => idb.all("meta"),
  saveVersion: (fileId, filename, owner, versionMeta) =>
    mutate(async () => {
      const now = new Date().toISOString();
      const file = (await idb.get("meta", fileId)) || {
        fileId,
        filename,
        owner,
        currentVersion: 0,
        versions: {},
        createdAt: now,
        updatedAt: now,
      };
      file.versions[versionMeta.version] = versionMeta;
      file.currentVersion = versionMeta.version;
      file.filename = filename || file.filename;
      file.updatedAt = now;
      await idb.put("meta", fileId, file);
      return file;
    }),
  setCurrentVersion: (fileId, version) =>
    mutate(async () => {
      const file = await idb.get("meta", fileId);
      if (!file) throw new Error("file " + fileId + " not found");
      if (!file.versions[version])
        throw new Error("version " + version + " not found for file " + fileId);
      file.currentVersion = version;
      file.updatedAt = new Date().toISOString();
      await idb.put("meta", fileId, file);
      return file;
    }),
  deleteFile: (fileId) =>
    mutate(async () => {
      const file = await idb.get("meta", fileId);
      await idb.del("meta", fileId);
      return file;
    }),
};

// ---- fileService.ts ------------------------------------------------------------------
async function uploadFile(fileId, filename, owner, blob) {
  const existing = await metadata.getFile(fileId);
  // highest version ever created, so an upload after a rollback never reuses a number
  const highest = existing
    ? Object.values(existing.versions).reduce(
        (m, v) => Math.max(m, v.version),
        0,
      )
    : 0;
  const version = highest + 1;

  const bytes = await blob.arrayBuffer();
  const checksum = hex(await crypto.subtle.digest("SHA-256", bytes));
  const chunks = [];
  try {
    for (
      let offset = 0, index = 0;
      offset < bytes.byteLength;
      offset += CHUNK_SIZE, index++
    ) {
      const plain = bytes.slice(offset, offset + CHUNK_SIZE);
      const { ciphertext, iv, authTag } = await encryptChunk(plain);
      const chunkId = fileId + "_v" + version + "_" + index;
      const replication = await writeChunk(chunkId, ciphertext);
      chunks.push({
        chunkId,
        iv,
        authTag,
        size: plain.byteLength,
        replicatedTo: replication.replicatedTo,
      });
    }

    await metadata.saveVersion(fileId, filename, owner, {
      version,
      size: bytes.byteLength,
      checksum,
      filename,
      mimeType: blob.type || "application/octet-stream",
      createdAt: new Date().toISOString(),
      chunks,
    });
    return { fileId, version, checksum, size: bytes.byteLength };
  } catch (error) {
    await Promise.allSettled(chunks.map((c) => deleteChunk(c.chunkId)));
    throw error;
  }
}

async function downloadFile(fileId, version) {
  const file = await metadata.getFile(fileId);
  if (!file) throw new Error("file " + fileId + " not found");
  const v = version > 0 ? version : file.currentVersion;
  const meta = file.versions[v];
  if (!meta) throw new Error("version " + v + " not found for file " + fileId);
  const parts = [];
  const servedFrom = new Set();
  for (const chunk of meta.chunks) {
    const read = await readChunk(chunk.chunkId, (data) =>
      decryptChunk(data, chunk.iv, chunk.authTag),
    );
    parts.push(read.data);
    servedFrom.add(read.replica);
  }
  const blob = new Blob(parts, {
    type: meta.mimeType || "application/octet-stream",
  });
  const checksum = hex(
    await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
  );
  if (blob.size !== meta.size || checksum !== meta.checksum)
    throw new Error("File integrity check failed. Download was blocked.");
  return {
    blob,
    meta,
    filename: meta.filename || file.filename,
    servedFrom: [...servedFrom],
  };
}

// ---- gateway routes (gateway/src/routes/files.ts) -------------------------------------
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function handleFilesUnsafe(request, path, url) {
  const method = request.method;
  let m;

  if (path === "/upload" && method === "POST") {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string")
      return json({ error: 'multipart field "file" is required' }, 400);
    if (file.size > MAX_UPLOAD_BYTES)
      return json(
        { error: "this in-browser demo accepts files up to 100 MB" },
        413,
      );
    try {
      const fileId = form.get("fileId") || crypto.randomUUID();
      return json(
        await uploadFile(
          fileId,
          file.name,
          form.get("owner") || "anonymous",
          file,
        ),
      );
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  if ((path === "" || path === "/") && method === "GET") {
    const files = await metadata.listFiles();
    return json(
      files.map((f) => ({
        fileId: f.fileId,
        filename: f.filename,
        latestVersion: f.currentVersion,
        size: (f.versions[f.currentVersion] || {}).size || 0,
        updatedAt: f.updatedAt,
        versionCount: Object.keys(f.versions).length,
      })),
    );
  }

  if ((m = path.match(/^\/([^/]+)\/versions$/)) && method === "GET") {
    const file = await metadata.getFile(m[1]);
    if (!file) return json({ error: "file " + m[1] + " not found" }, 404);
    return json(
      Object.values(file.versions)
        .sort((a, b) => a.version - b.version)
        .map((v) => ({
          version: v.version,
          size: v.size,
          checksum: v.checksum,
          createdAt: v.createdAt,
          chunkCount: v.chunks.length,
          current: v.version === file.currentVersion,
          filename: v.filename || file.filename,
          chunks: v.chunks,
        })),
    );
  }

  if ((m = path.match(/^\/([^/]+)\/download$/)) && method === "GET") {
    const version = url.searchParams.get("version")
      ? Number(url.searchParams.get("version"))
      : 0;
    try {
      const { blob, meta, filename, servedFrom } = await downloadFile(
        m[1],
        version,
      );
      const safeName = filename.replace(/[\r\n"\\/]/g, "_");
      return new Response(blob, {
        headers: {
          "Content-Type": meta.mimeType || "application/octet-stream",
          "Content-Disposition":
            "attachment; filename=\"download\"; filename*=UTF-8''" +
            encodeURIComponent(safeName),
          "X-File-Checksum": meta.checksum,
          "X-File-Version": String(meta.version),
          "X-Served-From": servedFrom.join(", ") || "empty file",
          "X-Integrity-Verified": "sha256",
        },
      });
    } catch (err) {
      return json({ error: err.message }, 503);
    }
  }

  if ((m = path.match(/^\/([^/]+)\/rollback$/)) && method === "POST") {
    try {
      const body = await request.json();
      const file = await metadata.setCurrentVersion(m[1], Number(body.version));
      return json({ success: true, currentVersion: file.currentVersion });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }

  if ((m = path.match(/^\/([^/]+)$/)) && method === "DELETE") {
    const file = await metadata.deleteFile(m[1]);
    if (!file) return json({ success: false });
    const ids = Object.values(file.versions).flatMap((v) =>
      v.chunks.map((c) => c.chunkId),
    );
    await Promise.allSettled(ids.map(deleteChunk));
    return json({ success: true });
  }

  return json({ error: "not found" }, 404);
}

let operationQueue = Promise.resolve();
function handleFiles(request, path, url) {
  if (!["POST", "DELETE"].includes(request.method))
    return handleFilesUnsafe(request, path, url);
  // Serialize version allocation, encryption, metadata publication and rollback,
  // not only the final metadata write. Failed operations do not poison the queue.
  const execute = () =>
    self.navigator?.locks
      ? self.navigator.locks.request("mini-dropbox-write", () =>
          handleFilesUnsafe(request, path, url),
        )
      : handleFilesUnsafe(request, path, url);
  const result = operationQueue.then(execute);
  operationQueue = result.catch(() => undefined);
  return result;
}

// demo-only: lets the page take replicas offline to show failover
async function handleReplicas(request) {
  if (request.method === "POST") {
    const { offline } = await request.json();
    await idb.put(
      "config",
      "offline",
      (offline || []).filter((n) => REPLICAS.includes(n)),
    );
  }
  const offline = await offlineReplicas();
  const nodes = await Promise.all(
    REPLICAS.map(async (name) => ({
      name,
      online: !offline.includes(name),
      chunks: await idb.count(name),
    })),
  );
  return json({ nodes });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope).pathname;
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scope))
    return;
  const path = url.pathname.slice(scope.length);

  if (path === "healthz") {
    event.respondWith(json({ status: "ok", backend: "service-worker" }));
  } else if (path === "api/_demo/replicas") {
    event.respondWith(
      handleReplicas(event.request).catch((e) =>
        json({ error: e.message }, 500),
      ),
    );
  } else if (path === "api/files" || path.startsWith("api/files/")) {
    event.respondWith(
      handleFiles(event.request, path.slice("api/files".length), url).catch(
        (e) => json({ error: e.message }, 500),
      ),
    );
  }
});
