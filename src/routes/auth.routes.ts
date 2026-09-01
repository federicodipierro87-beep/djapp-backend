import express from 'express';
import rateLimit from 'express-rate-limit';
import { register, login, me, forgotPassword, resetPassword } from '../controllers/auth.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = express.Router();

// Successful logins are not counted, so an active DJ is never locked out while
// a password guesser still runs out of attempts. The global limiter is too
// permissive here: 100 attempts per window is a viable brute force budget.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again in 15 minutes.' }
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this IP, please try again later.' }
});

// Anyone can name any address here and an email leaves for it, so without a
// limit the endpoint is a way to flood someone else's inbox. Same budget as
// registration, which is the other thing here that sends mail on demand.
//
// Only on the request side: /reset-password is reached from a link that was
// already earned, and capping it would mean a DJ who mistypes the confirmation
// a few times cannot finish resetting. Guessing a token there is not a threat
// this would address - there are 32 random bytes to get right.
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many password reset requests, please try again later.' }
});

router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);
router.post('/forgot-password', resetLimiter, forgotPassword);
router.post('/reset-password', resetPassword);
router.get('/me', authMiddleware, me);

export default router;