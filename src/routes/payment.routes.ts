import express from 'express';
import {
  createStripeIntent,
  paypalWebhook,
  satispayCallback
} from '../controllers/payment.controller';

const router = express.Router();

// Transition shim for clients loaded before the flow was inverted, see
// createStripeIntent. New clients get their authorisation from POST /requests.
router.post('/stripe/create-intent', createStripeIntent);

// The Stripe webhook is mounted in index.ts: it needs the raw body, and by the
// time a request reaches this router express.json() has already consumed it.
router.post('/webhook/paypal', paypalWebhook);

// A GET, because that is what Satispay sends. The URL is baked into each
// payment when it is created, so it cannot move without breaking the callbacks
// of every payment already outstanding.
router.get('/webhook/satispay', satispayCallback);

export default router;