// Splits an incoming byte stream into fixed-size chunks. Fixed-size (rather
// than content-defined) chunking keeps the demo simple and predictable;
// swap this for a rolling-hash (Rabin/CDC) chunker if you want dedup across
// similar files later.
export const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1 MiB

export class ChunkAssembler {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly chunkSize: number;

  constructor(chunkSize: number = DEFAULT_CHUNK_SIZE) {
    this.chunkSize = chunkSize;
  }

  /** Feed newly-arrived bytes; returns any full-size chunks now available. */
  push(data: Buffer): Buffer[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    const chunks: Buffer[] = [];
    while (this.buffer.length >= this.chunkSize) {
      chunks.push(this.buffer.subarray(0, this.chunkSize));
      this.buffer = this.buffer.subarray(this.chunkSize);
    }
    return chunks;
  }

  /** Call once the stream has ended to flush the trailing partial chunk. */
  flush(): Buffer | null {
    if (this.buffer.length === 0) return null;
    const remainder = this.buffer;
    this.buffer = Buffer.alloc(0);
    return remainder;
  }
}
