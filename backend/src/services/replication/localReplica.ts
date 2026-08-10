import fs from 'fs';
import path from 'path';
import { ReplicaTarget } from './types';

// A "replica" here is just a directory. Running two of these on the same
// disk still proves out the replication/failover logic; in a real
// deployment each LocalReplica's rootDir would be a distinct PVC mounted
// into a distinct storage-node pod (see k8s/backend-pvc.yaml).
export class LocalReplica implements ReplicaTarget {
  constructor(private readonly name: string, private readonly rootDir: string) {
    fs.mkdirSync(rootDir, { recursive: true });
  }

  getName(): string {
    return this.name;
  }

  private chunkPath(chunkId: string): string {
    return path.join(this.rootDir, `${chunkId}.chunk`);
  }

  async write(chunkId: string, data: Buffer): Promise<void> {
    fs.writeFileSync(this.chunkPath(chunkId), data);
  }

  async read(chunkId: string): Promise<Buffer> {
    return fs.readFileSync(this.chunkPath(chunkId));
  }

  async delete(chunkId: string): Promise<void> {
    const p = this.chunkPath(chunkId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  async exists(chunkId: string): Promise<boolean> {
    return fs.existsSync(this.chunkPath(chunkId));
  }
}
