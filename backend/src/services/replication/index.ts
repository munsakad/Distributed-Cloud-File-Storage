import path from "path";
import { ReplicaTarget } from "./types";
import { LocalReplica } from "./localReplica";
import { S3Replica } from "./s3Replica";

export { ReplicaTarget };

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "../../../data");

/**
 * Two local replicas always exist. If S3_BUCKET is set, S3 becomes a third,
 * real-cloud replica — this is the "AWS" leg of the replication story:
 * chunks are durable even if every local node is lost.
 */
export function buildReplicaSet(): ReplicaTarget[] {
  const replicas: ReplicaTarget[] = [
    new LocalReplica("replica-a", path.join(DATA_DIR, "replica-a")),
    new LocalReplica("replica-b", path.join(DATA_DIR, "replica-b")),
  ];
  if (process.env.S3_BUCKET) {
    replicas.push(new S3Replica(process.env.S3_BUCKET));
  }
  return replicas;
}

export class ReplicationManager {
  private readonly replicas: ReplicaTarget[];

  constructor(replicas: ReplicaTarget[] = buildReplicaSet()) {
    this.replicas = replicas;
  }

  /** Best-effort fan-out write. Succeeds as long as at least one replica accepts the chunk. */
  async writeChunk(
    chunkId: string,
    data: Buffer,
  ): Promise<{ replicatedTo: string[]; failed: string[] }> {
    const results = await Promise.allSettled(
      this.replicas.map((r) => r.write(chunkId, data)),
    );
    const replicatedTo: string[] = [];
    const failed: string[] = [];
    results.forEach((res, i) => {
      if (res.status === "fulfilled")
        replicatedTo.push(this.replicas[i].getName());
      else failed.push(this.replicas[i].getName());
    });
    if (replicatedTo.length === 0) {
      throw new Error(`failed to replicate chunk ${chunkId} to any target`);
    }
    return { replicatedTo, failed };
  }

  /** Reads from the first healthy replica, transparently failing over to the next. */
  async readChunk(
    chunkId: string,
    authenticate: (data: Buffer) => Buffer = (data) => data,
  ): Promise<Buffer> {
    let lastError: unknown;
    for (const replica of this.replicas) {
      try {
        return authenticate(await replica.read(chunkId));
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(
      `chunk ${chunkId} unreadable from all replicas: ${lastError}`,
    );
  }

  async deleteChunk(chunkId: string): Promise<void> {
    await Promise.allSettled(this.replicas.map((r) => r.delete(chunkId)));
  }

  replicaNames(): string[] {
    return this.replicas.map((r) => r.getName());
  }
}
