import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import pino from 'pino';
import pinoHttp from 'pino-http';

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

const app = express();
app.set('trust proxy', 1); // correct client IPs behind Render/most PaaS

app.use(helmet());
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
