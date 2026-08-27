import express from 'express';
import { createStripeIntent, paypalWebhook } from '../controllers/payment.controller';

const router = express.Router();

// Transition shim for clients loaded before the flow was inverted, see
// createStripeIntent. New clients get their authorisation from POST /requests.
router.post('/stripe/create-intent', createStripeIntent);

// The Stripe webhook is mounted in index.ts: it needs the raw body, and by the
// time a request reaches this router express.json() has already consumed it.
router.post('/webhook/paypal', paypalWebhook);

export default router;