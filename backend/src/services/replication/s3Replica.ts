import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ReplicaTarget } from './types';

// Real cloud replica: encrypted chunks land in S3 alongside the two local
// replicas. Credentials come from the standard AWS SDK chain (env vars,
// shared config file, or an IAM role when running in EKS) — never hardcode
// keys here.
export class S3Replica implements ReplicaTarget {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(bucket: string, prefix = 'chunks/', region = process.env.AWS_REGION || 'us-east-1') {
    this.client = new S3Client({ region });
    this.bucket = bucket;
    this.prefix = prefix;
  }

  getName(): string {
    return `s3:${this.bucket}`;
  }

  private key(chunkId: string): string {
    return `${this.prefix}${chunkId}.chunk`;
  }

  async write(chunkId: string, data: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(chunkId), Body: data }));
  }

  async read(chunkId: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(chunkId) }));
    const stream = res.Body as NodeJS.ReadableStream;
    const parts: Buffer[] = [];
    for await (const part of stream) parts.push(Buffer.from(part));
    return Buffer.concat(parts);
  }

  async delete(chunkId: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(chunkId) }));
  }

  async exists(chunkId: string): Promise<boolean> {
    try {
      await this.read(chunkId);
      return true;
    } catch {
      return false;
    }
  }
}
