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

import { errorMiddleware } from './middlewares/error.middleware';
import { expirationService } from './services/expiration.service';
import { initializeSocket } from './socket/socket';

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
  skip: (req) => req.path.startsWith('/api/spotify')
});

const spotifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many searches from this IP, please try again later.' }
});

app.use(helmet());
const allowedOrigins = [
  'http://localhost:5173',
  'https://djapp-frontend.netlify.app'
];

if (process.env.FRONTEND_URL) {
  allowedOrigins.push(process.env.FRONTEND_URL);
}


app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200
}));
app.use(limiter);

// Webhook route MUST be before express.json() to receive raw body
app.post('/api/subscriptions/webhook', express.raw({ type: 'application/json' }), handleWebhook);

// No endpoint accepts anything close to this; the previous 10mb ceiling just
// let a single request tie up memory and parsing time for free.
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
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
initializeSocket(httpServer, allowedOrigins);

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Socket.io enabled`);

  expirationService.start();
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});