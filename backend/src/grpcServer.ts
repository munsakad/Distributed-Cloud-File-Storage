import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { randomUUID } from 'crypto';
import { FileService } from './services/fileService';

const PROTO_PATH = path.join(__dirname, '../../proto/filestorage.proto');
const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const proto = grpc.loadPackageDefinition(packageDef) as any;

const fileService = new FileService();

/** Bridges a gRPC readable stream (push, event-based) into an async iterable (pull-based). */
class PullQueue implements AsyncIterable<Buffer> {
  private items: Buffer[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(item: Buffer): void {
    this.items.push(item);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift() as Buffer;
      } else if (this.closed) {
        return;
      } else {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((res) => {
          this.waiter = res;
        });
      }
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function uploadFile(call: grpc.ServerReadableStream<any, any>, callback: grpc.sendUnaryData<any>) {
  const queue = new PullQueue();
  let started = false;
  let uploadPromise: ReturnType<FileService['uploadFile']> | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call.on('data', (msg: any) => {
    if (msg.metadata && !started) {
      started = true;
      const fileId: string = msg.metadata.file_id || randomUUID();
      const filename: string = msg.metadata.filename;
      const owner: string = msg.metadata.owner || 'anonymous';
      uploadPromise = fileService.uploadFile(fileId, filename, owner, queue);
    } else if (msg.content && msg.content.length) {
      queue.push(Buffer.from(msg.content));
    }
  });

  call.on('end', async () => {
    queue.close();
    if (!uploadPromise) {
      callback({ code: grpc.status.INVALID_ARGUMENT, message: 'no metadata message received' });
      return;
    }
    try {
      const result = await uploadPromise;
      callback(null, {
        file_id: result.fileId,
        version: result.version,
        checksum: result.checksum,
        size: result.size,
      });
    } catch (err) {
      callback({ code: grpc.status.INTERNAL, message: (err as Error).message });
    }
  });

  call.on('error', (err) => console.error('upload stream error:', err));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function downloadFile(call: grpc.ServerWritableStream<any, any>) {
  try {
    const { file_id: fileId, version } = call.request;
    for await (const chunk of fileService.downloadFile(fileId, version)) {
      call.write({ content: chunk });
    }
    call.end();
  } catch (err) {
    call.destroy(err as Error);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function listFiles(_call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
  try {
    const files = fileService.listFiles().map((f) => ({
      file_id: f.fileId,
      filename: f.filename,
      latest_version: f.latestVersion,
      size: f.size,
      updated_at: f.updatedAt,
    }));
    callback(null, { files });
  } catch (err) {
    callback({ code: grpc.status.INTERNAL, message: (err as Error).message });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function listVersions(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
  try {
    const versions = fileService.listVersions(call.request.file_id).map((v) => ({
      version: v.version,
      size: v.size,
      checksum: v.checksum,
      created_at: v.createdAt,
      chunk_count: v.chunkCount,
    }));
    callback(null, { versions });
  } catch (err) {
    callback({ code: grpc.status.NOT_FOUND, message: (err as Error).message });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rollback(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
  try {
    const result = await fileService.rollback(call.request.file_id, call.request.version);
    callback(null, { success: result.success, current_version: result.currentVersion });
  } catch (err) {
    callback({ code: grpc.status.INTERNAL, message: (err as Error).message });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function deleteFile(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
  try {
    const result = await fileService.deleteFile(call.request.file_id);
    callback(null, { success: result.success });
  } catch (err) {
    callback({ code: grpc.status.INTERNAL, message: (err as Error).message });
  }
}

export function startGrpcServer(port = Number(process.env.GRPC_PORT) || 50051): grpc.Server {
  const server = new grpc.Server();
  server.addService(proto.filestorage.FileStorageService.service, {
    uploadFile,
    downloadFile,
    listFiles,
    listVersions,
    rollback,
    deleteFile,
  });
  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
    if (err) {
      console.error('Failed to bind gRPC server:', err);
      return;
    }
    console.log(`[backend] gRPC FileStorageService listening on :${boundPort}`);
  });
  return server;
}
