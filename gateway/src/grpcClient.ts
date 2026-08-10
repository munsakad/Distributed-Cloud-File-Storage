import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

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

// In-cluster this resolves to the backend Service's DNS name
// (mini-dropbox-backend:50051 — see k8s/backend-service.yaml).
const BACKEND_ADDR = process.env.BACKEND_ADDR || 'localhost:50051';

export const grpcClient = new proto.filestorage.FileStorageService(
  BACKEND_ADDR,
  grpc.credentials.createInsecure(),
);
