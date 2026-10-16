const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
test("real Node storage round-trips three files, serializes versions and fails over after tampering", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "vault-regression-"));
  process.env.DATA_DIR = temporary;
  process.env.MASTER_KEY = randomBytes(32).toString("hex");
  delete process.env.S3_BUCKET;
  const { FileService } = require("../backend/dist/services/fileService");
  const service = new FileService();
  const stream = async function* (bytes) {
    for (let i = 0; i < bytes.length; i += 262144)
      yield bytes.subarray(i, i + 262144);
  };
  const download = async (id, v) => {
    const chunks = [];
    for await (const chunk of service.downloadFile(id, v)) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  try {
    const values = [
      Buffer.from("%PDF-1.7 real bytes"),
      Buffer.alloc(2621440, 5),
      Buffer.from([0, 255, 128, 2]),
    ];
    await Promise.all(
      values.map((bytes, i) =>
        service.uploadFile("f" + i, "file" + i + ".bin", "test", stream(bytes)),
      ),
    );
    assert.equal(service.listFiles().length, 3);
    for (let i = 0; i < 3; i++)
      assert.deepEqual(await download("f" + i), values[i]);
    assert.equal(service.listVersions("f1")[0].chunkCount, 3);
    const next = await Promise.all([
      service.uploadFile(
        "f0",
        "first.pdf",
        "test",
        stream(Buffer.from("version2")),
      ),
      service.uploadFile(
        "f0",
        "first.pdf",
        "test",
        stream(Buffer.from("version3")),
      ),
    ]);
    assert.deepEqual(
      next.map((x) => x.version),
      [2, 3],
    );
    await service.rollback("f0", 1);
    assert.equal(
      (
        await service.uploadFile(
          "f0",
          "first.pdf",
          "test",
          stream(Buffer.from("version4")),
        )
      ).version,
      4,
    );
    assert.deepEqual(await download("f0", 1), values[0]);
    fs.writeFileSync(
      path.join(temporary, "replica-a", "f1_v1_0.chunk"),
      Buffer.from("tampered"),
    );
    assert.deepEqual(await download("f1"), values[1]);
  } finally {
    assert.equal(
      path.dirname(path.resolve(temporary)),
      path.resolve(os.tmpdir()),
    );
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
