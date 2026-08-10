export interface ReplicaTarget {
  getName(): string;
  write(chunkId: string, data: Buffer): Promise<void>;
  read(chunkId: string): Promise<Buffer>;
  delete(chunkId: string): Promise<void>;
  exists(chunkId: string): Promise<boolean>;
}
