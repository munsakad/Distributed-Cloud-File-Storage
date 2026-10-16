const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { IDBFactory } = require("fake-indexeddb");
const { webcrypto } = require("node:crypto");
const code = fs.readFileSync("gateway/demo/sw.js", "utf8");
function setup(indexedDB = new IDBFactory()) {
  const context = vm.createContext({
    indexedDB,
    crypto: webcrypto,
    Blob,
    Response,
    Request,
    URL,
    Uint8Array,
    ArrayBuffer,
    console,
    self: { addEventListener: () => {}, navigator: {} },
  });
  vm.runInContext(code, context);
  vm.runInContext("globalThis.idb = idb", context);
  const request = async (path, method = "GET", body) => {
    const url = new URL("https://example.test/api/files" + path);
    const req = new Request(url, { method, ...(body ? { body } : {}) });
    return context.handleFiles(req, path.split("?")[0], url);
  };
  const upload = async (name, bytes, id) => {
    const form = new FormData();
    form.append("file", new Blob([bytes]), name);
    if (id) form.append("fileId", id);
    const response = await request("/upload", "POST", form);
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  return { context, indexedDB, request, upload };
}
test("three distinct concurrent files persist and round-trip after worker restart", async () => {
  const app = setup();
  const values = [
    Buffer.from("%PDF-1.7\nreal bytes"),
    Buffer.from([0, 255, 1, 128, 0]),
    Buffer.alloc(2621440, 0x57),
  ];
  const uploads = await Promise.all(
    values.map((v, i) =>
      app.upload(["resume.pdf", "image.png", "archive.zip"][i], v),
    ),
  );
  assert.equal(new Set(uploads.map((x) => x.fileId)).size, 3);
  const restarted = setup(app.indexedDB);
  assert.equal((await (await restarted.request("")).json()).length, 3);
  for (let i = 0; i < uploads.length; i++) {
    const response = await restarted.request(
      "/" + uploads[i].fileId + "/download",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), values[i]);
    assert.match(
      response.headers.get("Content-Disposition"),
      /filename\*=UTF-8''/,
    );
    assert.equal(response.headers.get("X-Integrity-Verified"), "sha256");
  }
  const versions = await (
    await restarted.request("/" + uploads[2].fileId + "/versions")
  ).json();
  assert.equal(versions[0].chunkCount, 3);
});
test("parallel new versions and upload after rollback preserve all history", async () => {
  const app = setup();
  const first = await app.upload("notes.txt", "v1");
  const next = await Promise.all([
    app.upload("notes.txt", "v2", first.fileId),
    app.upload("notes.txt", "v3", first.fileId),
  ]);
  assert.deepEqual(
    next.map((x) => x.version),
    [2, 3],
  );
  await app.request(
    "/" + first.fileId + "/rollback",
    "POST",
    JSON.stringify({ version: 1 }),
  );
  assert.equal((await app.upload("notes.txt", "v4", first.fileId)).version, 4);
  for (let v = 1; v <= 4; v++)
    assert.equal(
      await (
        await app.request("/" + first.fileId + "/download?version=" + v)
      ).text(),
      "v" + v,
    );
});
test("offline and corrupt replica failover authenticate bytes; all-offline returns JSON error", async () => {
  const app = setup();
  const bytes = Buffer.alloc(2621440, 12);
  const file = await app.upload("backup.bin", bytes);
  await app.context.idb.put("config", "offline", ["replica-a"]);
  let response = await app.request("/" + file.fileId + "/download");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Served-From"), "replica-b");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await app.context.idb.put("config", "offline", []);
  const chunks = (
    await (await app.request("/" + file.fileId + "/versions")).json()
  )[0].chunks;
  await app.context.idb.put(
    "replica-a",
    chunks[0].chunkId,
    new Uint8Array([7, 8, 9]),
  );
  response = await app.request("/" + file.fileId + "/download");
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await app.context.idb.put("config", "offline", ["replica-a", "replica-b"]);
  response = await app.request("/" + file.fileId + "/download");
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /unreadable/);
  assert.equal(response.headers.get("Content-Disposition"), null);
  const form = new FormData();
  form.append("file", new Blob(["bad write"]), "bad.txt");
  response = await app.request("/upload", "POST", form);
  assert.equal(response.status, 500);
  assert.equal((await (await app.request("")).json()).length, 1);
});
test("metadata commit failure cleans uncommitted chunks and preserves existing data", async () => {
  const app = setup();
  const file = await app.upload("keep.txt", "keep");
  const original = app.context.idb.put;
  app.context.idb.put = (store, key, value) =>
    store === "meta"
      ? Promise.reject(new Error("quota exceeded"))
      : original(store, key, value);
  const form = new FormData();
  form.append("file", new Blob(["new version"]), "keep.txt");
  form.append("fileId", file.fileId);
  assert.equal((await app.request("/upload", "POST", form)).status, 500);
  app.context.idb.put = original;
  assert.equal(
    await (await app.request("/" + file.fileId + "/download")).text(),
    "keep",
  );
  assert.equal(await app.context.idb.count("replica-a"), 1);
});
