import fs from 'fs';
import path from 'path';

export interface ChunkRef {
  chunkId: string;
  iv: string;
  authTag: string;
  size: number;
}

export interface FileVersionMeta {
  version: number;
  size: number;
  checksum: string;
  createdAt: string;
  chunks: ChunkRef[];
}

export interface FileMeta {
  fileId: string;
  filename: string;
  owner: string;
  currentVersion: number;
  versions: Record<number, FileVersionMeta>;
  createdAt: string;
  updatedAt: string;
}

interface DB {
  files: Record<string, FileMeta>;
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'metadata.json');

function load(): DB {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const empty: DB = { files: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function save(db: DB): void {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// This is a demo-grade metadata store: a single JSON file, with writes
// serialized through an in-process promise queue so concurrent gRPC calls
// can't interleave and corrupt it. Swap this module for a real database
// (Postgres, DynamoDB, etcd) before this goes anywhere near production —
// the FileService above only depends on this file's exported interface.
let writeQueue: Promise<void> = Promise.resolve();

function mutate<T>(fn: (db: DB) => T): Promise<T> {
  const result = writeQueue.then(() => {
    const db = load();
    const value = fn(db);
    save(db);
    return value;
  });
  writeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export const metadataStore = {
  getFile(fileId: string): FileMeta | undefined {
    return load().files[fileId];
  },

  listFiles(): FileMeta[] {
    return Object.values(load().files);
  },

  async saveVersion(fileId: string, filename: string, owner: string, versionMeta: FileVersionMeta): Promise<FileMeta> {
    return mutate((db) => {
      const now = new Date().toISOString();
      const existing = db.files[fileId];
      const file: FileMeta = existing ?? {
        fileId,
        filename,
        owner,
        currentVersion: 0,
        versions: {},
        createdAt: now,
        updatedAt: now,
      };
      file.versions[versionMeta.version] = versionMeta;
      file.currentVersion = versionMeta.version;
      file.filename = filename || file.filename;
      file.updatedAt = now;
      db.files[fileId] = file;
      return file;
    });
  },

  async setCurrentVersion(fileId: string, version: number): Promise<FileMeta> {
    return mutate((db) => {
      const file = db.files[fileId];
      if (!file) throw new Error(`file ${fileId} not found`);
      if (!file.versions[version]) throw new Error(`version ${version} not found for file ${fileId}`);
      file.currentVersion = version;
      file.updatedAt = new Date().toISOString();
      return file;
    });
  },

  async deleteFile(fileId: string): Promise<FileMeta | undefined> {
    return mutate((db) => {
      const file = db.files[fileId];
      delete db.files[fileId];
      return file;
    });
  },
};
