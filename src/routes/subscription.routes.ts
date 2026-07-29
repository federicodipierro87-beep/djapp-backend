import express from 'express';
import {
  createCheckoutSession,
  getSubscriptionStatus,
  createPortalSession,
  cancelSubscription,
  reactivateSubscription,
  handleWebhook
} from '../controllers/subscription.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = express.Router();

// Webhook endpoint - must be before body parser, uses raw body
router.post('/webhook', express.raw({ type: 'application/json' }), handleWebhook);

// Authenticated endpoints
router.post('/checkout', authMiddleware, createCheckoutSession);
router.get('/status', authMiddleware, getSubscriptionStatus);
router.post('/portal', authMiddleware, createPortalSession);
router.post('/cancel', authMiddleware, cancelSubscription);
router.post('/reactivate', authMiddleware, reactivateSubscription);

export default router;
