import express from 'express';
import { 
  createStripeIntent, 
  createPayPalOrder, 
  createSatispayPayment,
  stripeWebhook,
  paypalWebhook 
} from '../controllers/payment.controller';

const router = express.Router();

router.post('/stripe/create-intent', createStripeIntent);
router.post('/paypal/create-order', createPayPalOrder);
router.post('/satispay/create', createSatispayPayment);

router.post('/webhook/stripe', express.raw({ type: 'application/json' }), stripeWebhook);
router.post('/webhook/paypal', paypalWebhook);

export default router;