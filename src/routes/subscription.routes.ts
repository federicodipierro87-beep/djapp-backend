import express from 'express';
import {
  createCheckoutSession,
  getSubscriptionStatus,
  createPortalSession,
  cancelSubscription,
  reactivateSubscription
} from '../controllers/subscription.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = express.Router();

// Note: webhook is handled in index.ts before JSON parser

// Authenticated endpoints
router.post('/checkout', authMiddleware, createCheckoutSession);
router.get('/status', authMiddleware, getSubscriptionStatus);
router.post('/portal', authMiddleware, createPortalSession);
router.post('/cancel', authMiddleware, cancelSubscription);
router.post('/reactivate', authMiddleware, reactivateSubscription);

export default router;
