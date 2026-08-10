import 'dotenv/config';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { filesRouter } from './routes/files';

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api/files', filesRouter);
app.use(express.static(path.join(__dirname, '../public')));

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, () => {
  console.log(`[gateway] REST API + UI on http://localhost:${PORT}`);
  console.log(`[gateway] proxying gRPC calls to ${process.env.BACKEND_ADDR || 'localhost:50051'}`);
});
