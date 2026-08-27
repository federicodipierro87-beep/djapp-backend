import { Request, Response } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { stripeService } from '../services/stripe.service';
import { confirmRequestPayment } from '../services/requestPayment.service';
import prisma from '../utils/database';
import { asyncHandler } from '../utils/asyncHandler';

// These endpoints are unauthenticated by design (guests never log in), so the
// amount is entirely attacker controlled and needs the same ceiling the request
// schema uses. The currency reaches the payment providers verbatim.
const MAX_AMOUNT = 1000;
const currencySchema = z.string().trim().regex(/^[A-Za-z]{3}$/, 'Invalid currency code');

const createStripeIntentSchema = z.object({
  amount: z.number().min(0.01).max(MAX_AMOUNT),
  currency: currencySchema.default('eur')
});

// Transition shim. This creates an authorisation that belongs to no request,
// which is the shape of the old flow: the guest paid first and told us about it
// afterwards. POST /requests now does both in the right order, and the only
// reason this survives is the browser tabs that were already open at deploy
// time. Delete it once they have gone.
export const createStripeIntent = asyncHandler(async (req: Request, res: Response) => {
  const { amount, currency } = createStripeIntentSchema.parse(req.body);

  const paymentIntent = await stripeService.createPaymentIntent(amount, currency);

  res.json({
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id
  });
});

// The authoritative path. The guest's browser also calls /requests/:id/confirm,
// but a phone that dies after 3-D Secure would otherwise leave a paid request
// nobody ever sees. Whichever arrives first promotes the request; the other is
// a no-op.
export const stripeWebhook = asyncHandler(async (req: Request, res: Response) => {
  let event: Stripe.Event;

  try {
    const signature = req.headers['stripe-signature'] as string;
    event = await stripeService.constructEvent(req.body, signature);
  } catch (error) {
    console.error('Stripe webhook verification failed:', error);
    return res.status(400).json({ error: 'Invalid webhook' });
  }

  // Answer before doing the work: Stripe retries anything slower than 20s, and
  // a retry storm is worse than a late promotion the next event will fix.
  res.json({ received: true });

  try {
    switch (event.type) {
      // A manual-capture intent fires this the moment the hold is in place.
      case 'payment_intent.amount_capturable_updated':
      case 'payment_intent.succeeded': {
        const requestId = await findRequestIdForIntent(event.data.object.id);
        if (requestId) await confirmRequestPayment(requestId);
        break;
      }

      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled': {
        // Only touches drafts. A request the DJ already has in hand is not
        // withdrawn by a late failure event.
        await prisma.request.updateMany({
          where: { paymentIntentId: event.data.object.id, status: 'AWAITING_PAYMENT' },
          data: {
            status: 'EXPIRED',
            paymentStatus: event.type === 'payment_intent.canceled' ? 'CANCELED' : 'FAILED'
          }
        });
        break;
      }

      default:
        break;
    }
  } catch (error) {
    console.error(`Failed to handle Stripe event ${event.id} (${event.type}):`, error);
  }
});

async function findRequestIdForIntent(paymentIntentId: string): Promise<string | null> {
  const request = await prisma.request.findUnique({
    where: { paymentIntentId },
    select: { id: true }
  });

  return request?.id ?? null;
}

export const paypalWebhook = asyncHandler(async (req: Request, res: Response) => {
  try {
    const event = req.body;

    switch (event.event_type) {
      case 'PAYMENT.AUTHORIZATION.CREATED':
        console.log(`PayPal authorization created: ${event.resource.id}`);
        break;
        
      case 'PAYMENT.AUTHORIZATION.VOIDED':
        console.log(`PayPal authorization voided: ${event.resource.id}`);
        break;
        
      case 'PAYMENT.CAPTURE.COMPLETED':
        console.log(`PayPal capture completed: ${event.resource.id}`);
        break;
        
      default:
        console.log(`Unhandled PayPal event: ${event.event_type}`);
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('PayPal webhook error:', error);
    res.status(400).json({ error: 'Invalid webhook' });
  }
});