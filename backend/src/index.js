import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import pino from 'pino';
import pinoHttp from 'pino-http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import assessmentRoutes from './routes/assessments.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'change-me-to-a-long-random-string') {
  if (process.env.NODE_ENV === 'production') {
    logger.fatal('SESSION_SECRET is not set. Refusing to start.');
    process.exit(1);
  }
  logger.warn('SESSION_SECRET is weak or unset — fine for local dev only.');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.set('trust proxy', 1); // correct client IPs behind Coolify/Traefik

// This one service serves BOTH the RAMS frontend and the API, so the strict
// default CSP/COEP would block the frontend's inline scripts, Google Fonts and
// the jsPDF CDN. Relax those two; keep the rest of helmet's hardening.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(pinoHttp({
  logger,
  // Don't log request bodies (could contain passwords/secrets).
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: req.url }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  redact: ['req.headers.cookie', 'req.headers.authorization'],
}));

const frontendOrigin = process.env.FRONTEND_ORIGIN;
if (!frontendOrigin) {
  logger.warn('FRONTEND_ORIGIN not set; CORS will reject browser requests.');
}
app.use(cors({
  origin: frontendOrigin ? [frontendOrigin] : false,
  credentials: true,
}));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Serve the RAMS frontend (index.html login shell, oprams.html app, assets).
// `extensions:['html']` lets /oprams resolve to oprams.html.
app.use(express.static(publicDir, { extensions: ['html'] }));

app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/assessments', assessmentRoutes);

// 404
app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }));

// Error handler
app.use((err, req, res, _next) => {
  req.log?.error({ err }, 'unhandled');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => logger.info({ port }, 'listening'));

export default app;
