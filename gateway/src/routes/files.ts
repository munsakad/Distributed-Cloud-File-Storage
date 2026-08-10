import { Router } from 'express';
import multer from 'multer';
import { grpcClient } from '../grpcClient';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
export const filesRouter = Router();

const UPLOAD_STREAM_CHUNK = 256 * 1024; // bytes per gRPC message (independent of the 1 MiB storage chunk size)

filesRouter.post('/upload', upload.single('file'), (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'multipart field "file" is required' });
    return;
  }
  const fileId = (req.body.fileId as string) || '';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = grpcClient.uploadFile((err: any, response: any) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ fileId: response.file_id, version: response.version, checksum: response.checksum, size: response.size });
  });

  call.write({ metadata: { filename: file.originalname, owner: req.body.owner || 'anonymous', file_id: fileId } });
  for (let offset = 0; offset < file.buffer.length; offset += UPLOAD_STREAM_CHUNK) {
    call.write({ content: file.buffer.subarray(offset, offset + UPLOAD_STREAM_CHUNK) });
  }
  call.end();
});

filesRouter.get('/', (_req, res) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  grpcClient.listFiles({}, (err: any, response: any) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.json(
      response.files.map((f: any) => ({
        fileId: f.file_id,
        filename: f.filename,
        latestVersion: f.latest_version,
        size: Number(f.size),
        updatedAt: f.updated_at,
      })),
    );
  });
});

filesRouter.get('/:id/versions', (req, res) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  grpcClient.listVersions({ file_id: req.params.id }, (err: any, response: any) => {
    if (err) {
      res.status(404).json({ error: err.message });
      return;
    }
    res.json(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response.versions.map((v: any) => ({
        version: v.version,
        size: Number(v.size),
        checksum: v.checksum,
        createdAt: v.created_at,
        chunkCount: v.chunk_count,
      })),
    );
  });
});

filesRouter.get('/:id/download', (req, res) => {
  const version = req.query.version ? Number(req.query.version) : 0;
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}-v${version || 'latest'}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  const call = grpcClient.downloadFile({ file_id: req.params.id, version });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call.on('data', (msg: any) => res.write(msg.content));
  call.on('end', () => res.end());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call.on('error', (err: any) => {
    if (!res.headersSent) res.status(404);
    res.end(`error: ${err.message}`);
  });
});

filesRouter.post('/:id/rollback', (req, res) => {
  grpcClient.rollback(
    { file_id: req.params.id, version: Number(req.body.version) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (err: any, response: any) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.json({ success: response.success, currentVersion: response.current_version });
    },
  );
});

filesRouter.delete('/:id', (req, res) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  grpcClient.deleteFile({ file_id: req.params.id }, (err: any, response: any) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ success: response.success });
  });
});
