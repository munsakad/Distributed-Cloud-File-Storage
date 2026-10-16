const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { JSDOM } = require("jsdom");
const { webcrypto } = require("node:crypto");
const code = fs.readFileSync("gateway/public/app.js", "utf8");
const html = fs.readFileSync("gateway/public/index.html", "utf8");
const bytes = Buffer.from("%PDF-1.7\nactual original bytes");
const hash = async () =>
  Buffer.from(await webcrypto.subtle.digest("SHA-256", bytes)).toString("hex");
async function setup(fetcher) {
  const dom = new JSDOM(html, {
    url: "https://example.test/project/",
    runScripts: "outside-only",
  });
  const w = dom.window;
  Object.defineProperty(w, "crypto", { value: webcrypto });
  w.STORAGE_DEMO = true;
  w.fetch =
    fetcher ||
    (async (path) =>
      new Response(
        JSON.stringify(path === "healthz" ? { backend: "service-worker" } : []),
      ));
  w.URL.createObjectURL = () => "blob:unit-test";
  w.URL.revokeObjectURL = () => {};
  w.eval(code);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return dom;
}
test("downloads preserve the original PDF name and do not save HTTP errors or wrong bytes", async () => {
  const dom = await setup();
  const w = dom.window;
  let saved = [];
  w.HTMLAnchorElement.prototype.click = function () {
    saved.push(this.download);
  };
  const file = { fileId: "id", filename: "résumé.pdf", latestVersion: 1 };
  const version = { version: 1, size: bytes.length, checksum: await hash() };
  w.fetch = async () =>
    new Response(bytes, {
      headers: {
        "Content-Disposition":
          "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
        "X-Served-From": "replica-b",
      },
    });
  await w.download(file, version);
  assert.deepEqual(saved, ["résumé.pdf"]);
  assert.match(
    w.document.getElementById("toast").textContent,
    /SHA-256 verified/,
  );
  w.fetch = async () =>
    new Response(JSON.stringify({ error: "both replicas offline" }), {
      status: 503,
    });
  await assert.rejects(w.download(file, version), /both replicas offline/);
  assert.equal(saved.length, 1);
  w.fetch = async () => new Response("error text pretending to be a file");
  await assert.rejects(w.download(file, version), /SHA-256 does not match/);
  assert.equal(saved.length, 1);
  dom.window.close();
});
test("late two-file response cannot replace a newer three-file list; failed refresh keeps files", async () => {
  const dom = await setup();
  const w = dom.window;
  let resolveOld;
  const files = [1, 2, 3].map((i) => ({
    fileId: String(i),
    filename: "file" + i + ".txt",
    size: 1,
    latestVersion: 1,
    updatedAt: new Date().toISOString(),
  }));
  let calls = 0;
  w.fetch = async (path) => {
    if (path === "api/files") {
      calls++;
      if (calls === 1)
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      return new Response(JSON.stringify(files));
    }
    return new Response("[]");
  };
  const old = w.loadFiles();
  await w.loadFiles();
  resolveOld(new Response(JSON.stringify(files.slice(0, 2))));
  await old;
  assert.equal(w.document.querySelectorAll(".object").length, 3);
  assert.equal(w.document.getElementById("statFiles").textContent, "3");
  w.fetch = async () =>
    new Response(JSON.stringify({ error: "temporary unavailable" }), {
      status: 503,
    });
  await w.loadFiles();
  assert.equal(w.document.querySelectorAll(".object").length, 3);
  dom.window.close();
});
test("version history uses safe text and displays actual IV, tag and replica metadata", async () => {
  const dom = await setup();
  const w = dom.window;
  const file = {
    filename: "<script>bad</script>.txt",
    fileId: "id",
    latestVersion: 1,
    size: 1,
    updatedAt: new Date().toISOString(),
  };
  w.document.getElementById("table").append(w.buildRow(file));
  assert.equal(
    w.document.querySelector(".object__name").textContent,
    file.filename,
  );
  assert.equal(w.document.querySelector(".object__name script"), null);
  const version = {
    version: 1,
    size: 1,
    checksum: "abcd",
    createdAt: new Date().toISOString(),
    chunkCount: 1,
    chunks: [
      {
        size: 1,
        iv: "00".repeat(12),
        authTag: "11".repeat(16),
        replicatedTo: ["replica-a", "replica-b"],
      },
    ],
  };
  w.document.getElementById("table").append(w.buildVersion(file, version));
  assert.equal(w.document.querySelectorAll(".ledger__chunk").length, 1);
  assert.match(
    w.document.querySelector(".chunk-data").textContent,
    /replica-a, replica-b/,
  );
  assert.match(
    w.document.querySelector(".chunk-data").textContent,
    /000000000000000000000000/,
  );
  dom.window.close();
});
