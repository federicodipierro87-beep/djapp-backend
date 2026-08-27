import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

import authRoutes from './routes/auth.routes';
import requestRoutes from './routes/request.routes';
import queueRoutes from './routes/queue.routes';
import settingsRoutes from './routes/settings.routes';
import paymentRoutes from './routes/payment.routes';
import adminRoutes from './routes/admin.routes';
import subscriptionRoutes from './routes/subscription.routes';
import eventRoutes from './routes/event.routes';
import spotifyRoutes from './routes/spotify.routes';
import { handleWebhook } from './controllers/subscription.controller';
import { stripeWebhook, stripeConnectWebhook } from './controllers/payment.controller';

import { errorMiddleware } from './middlewares/error.middleware';
import { expirationService } from './services/expiration.service';
import { initializeSocket } from './socket/socket';
import prisma from './utils/database';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;

// Railway terminates TLS on a single proxy hop; without this every client
// shares the proxy IP and the rate limiters throttle all traffic at once.
app.set('trust proxy', 1);

// Every guest at a venue shares one public IP through the wifi NAT, and an open
// DJ panel polls several queries on a timer, so this budget is per-crowd rather
// than per-person. Brute force and search abuse have dedicated limiters below,
// which is what keeps this one free to be generous.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests from this IP, please try again later.' },
  // Song search is throttled separately so it cannot exhaust the budget
  // shared by requests and payments (clients at a venue share one IP).
  // Provider webhooks are exempt entirely: they all arrive from a handful of
  // provider IPs, and a throttled webhook is a payment we never hear about.
  skip: (req) =>
    req.path.startsWith('/api/spotify') || req.path.includes('/webhook')
});

const spotifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many searches from this IP, please try again later.' }
});

app.use(helmet());

// Origins live in the environment so a new frontend deployment does not need a
// code change; the current hosts stay as the fallback.
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://djapp-frontend.netlify.app'
];

const allowedOrigins = Array.from(new Set([
  ...(process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS),
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : [])
]));

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200
}));

// Webhook routes MUST be before express.json() to receive raw body, and before
// the rate limiter: Stripe retries a throttled webhook only for a limited
// window, and a dropped event leaves a DJ locked out or a paid request
// invisible. Mounting them on a router below would not work - body-parser marks
// the request as already read and the raw parser silently does nothing, which
// is why signature verification never succeeded here.
app.post('/api/subscriptions/webhook', express.raw({ type: 'application/json' }), handleWebhook);
app.post('/api/payments/webhook/stripe', express.raw({ type: 'application/json' }), stripeWebhook);
app.post('/api/payments/webhook/stripe/connect', express.raw({ type: 'application/json' }), stripeConnectWebhook);

app.use(limiter);

// No endpoint accepts anything close to this; the previous 10mb ceiling just
// let a single request tie up memory and parsing time for free.
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));

// Railway sets these; falling back to 'unknown' keeps local runs quiet.
const RELEASE_COMMIT =
  process.env.RAILWAY_GIT_COMMIT_SHA || process.env.COMMIT_SHA || 'unknown';

app.get('/health', async (req, res) => {
  let database: 'up' | 'down' = 'up';

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    database = 'down';
    console.error('Health check database probe failed:', error);
  }

  // A process that cannot reach its database is not healthy, and reporting OK
  // just makes the platform keep routing traffic to it.
  res.status(database === 'up' ? 200 : 503).json({
    status: database === 'up' ? 'OK' : 'DEGRADED',
    commit: RELEASE_COMMIT,
    database,
    timestamp: new Date().toISOString()
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/dj', settingsRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/spotify', spotifyLimiter, spotifyRoutes);

app.use(errorMiddleware);

// Initialize Socket.io
const io = initializeSocket(httpServer, allowedOrigins);

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (commit ${RELEASE_COMMIT})`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Socket.io enabled`);

  expirationService.start();
});

let shuttingDown = false;

async function shutdown(reason: string, exitCode: number) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Shutting down (${reason})...`);

  // Stop taking new work first, then let the in-flight requests drain, then
  // release the pool. Killing the process outright used to abandon payment
  // calls half-made against Stripe.
  expirationService.stop();

  const forceExit = setTimeout(() => {
    console.error('Shutdown timed out, forcing exit');
    process.exit(exitCode || 1);
  }, 10000);
  forceExit.unref();

  try {
    await io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await prisma.$disconnect();
  } catch (error) {
    console.error('Error during shutdown:', error);
  }

  clearTimeout(forceExit);
  process.exit(exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('SIGINT', () => void shutdown('SIGINT', 0));

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  void shutdown('uncaughtException', 1);
});

// A rejected promise is almost never a reason to drop every connected guest.
// Log it, keep serving, and let the platform's health check decide.
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});