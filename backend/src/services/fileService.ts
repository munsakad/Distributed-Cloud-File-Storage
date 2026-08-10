import crypto from 'crypto';
import { ChunkAssembler, DEFAULT_CHUNK_SIZE } from './chunking';
import { encryptChunk, decryptChunk } from './encryption';
import { ReplicationManager } from './replication';
import { metadataStore, FileVersionMeta, ChunkRef } from './metadataStore';

export class FileService {
  private readonly replication = new ReplicationManager();

  /**
   * Consumes an async iterable of plaintext Buffers (the streamed upload
   * body), chunking + encrypting + replicating each chunk as it arrives —
   * nothing is buffered fully in memory. If fileId already exists, this
   * writes a new VERSION rather than a new file.
   */
  async uploadFile(fileId: string, filename: string, owner: string, dataStream: AsyncIterable<Buffer>) {
    const assembler = new ChunkAssembler(DEFAULT_CHUNK_SIZE);
    const chunkRefs: ChunkRef[] = [];
    const hash = crypto.createHash('sha256');
    let totalSize = 0;
    let chunkIndex = 0;

    const existing = metadataStore.getFile(fileId);
    // Base the new version number on the highest version ever created, not
    // on currentVersion — otherwise uploading after a rollback would reuse
    // an existing version number and overwrite that version's chunks on disk.
    const highestVersion = existing
      ? Object.values(existing.versions).reduce((max, v) => Math.max(max, v.version), 0)
      : 0;
    const version = highestVersion + 1;

    const processChunk = async (plain: Buffer) => {
      hash.update(plain);
      totalSize += plain.length;
      const { ciphertext, iv, authTag } = encryptChunk(plain);
      const chunkId = `${fileId}_v${version}_${chunkIndex}`;
      await this.replication.writeChunk(chunkId, ciphertext);
      chunkRefs.push({ chunkId, iv, authTag, size: plain.length });
      chunkIndex += 1;
    };

    for await (const data of dataStream) {
      const fullChunks = assembler.push(data);
      // eslint-disable-next-line no-await-in-loop
      for (const c of fullChunks) await processChunk(c);
    }
    const remainder = assembler.flush();
    if (remainder) await processChunk(remainder);

    if (chunkIndex === 0) {
      // Still record an empty file (0 chunks) rather than erroring.
    }

    const checksum = hash.digest('hex');
    const versionMeta: FileVersionMeta = {
      version,
      size: totalSize,
      checksum,
      createdAt: new Date().toISOString(),
      chunks: chunkRefs,
    };
    await metadataStore.saveVersion(fileId, filename, owner, versionMeta);
    return { fileId, version, checksum, size: totalSize };
  }

  /** Streams the decrypted plaintext of a file version, chunk by chunk, in order. */
  async *downloadFile(fileId: string, version?: number): AsyncGenerator<Buffer> {
    const file = metadataStore.getFile(fileId);
    if (!file) throw new Error(`file ${fileId} not found`);
    const v = version && version > 0 ? version : file.currentVersion;
    const versionMeta = file.versions[v];
    if (!versionMeta) throw new Error(`version ${v} not found for file ${fileId}`);
    for (const chunk of versionMeta.chunks) {
      // eslint-disable-next-line no-await-in-loop
      const ciphertext = await this.replication.readChunk(chunk.chunkId);
      yield decryptChunk(ciphertext, chunk.iv, chunk.authTag);
    }
  }

  listFiles() {
    return metadataStore.listFiles().map((f) => ({
      fileId: f.fileId,
      filename: f.filename,
      latestVersion: f.currentVersion,
      size: f.versions[f.currentVersion]?.size ?? 0,
      updatedAt: f.updatedAt,
    }));
  }

  listVersions(fileId: string) {
    const file = metadataStore.getFile(fileId);
    if (!file) throw new Error(`file ${fileId} not found`);
    return Object.values(file.versions)
      .sort((a, b) => a.version - b.version)
      .map((v) => ({
        version: v.version,
        size: v.size,
        checksum: v.checksum,
        createdAt: v.createdAt,
        chunkCount: v.chunks.length,
      }));
  }

  async rollback(fileId: string, version: number) {
    const file = await metadataStore.setCurrentVersion(fileId, version);
    return { success: true, currentVersion: file.currentVersion };
  }

  async deleteFile(fileId: string) {
    const file = await metadataStore.deleteFile(fileId);
    if (!file) return { success: false };
    const allChunkIds = Object.values(file.versions).flatMap((v) => v.chunks.map((c) => c.chunkId));
    await Promise.allSettled(allChunkIds.map((id) => this.replication.deleteChunk(id)));
    return { success: true };
  }
}
