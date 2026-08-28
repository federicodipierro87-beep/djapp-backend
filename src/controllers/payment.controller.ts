import { Request, Response } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { stripeService } from '../services/stripe.service';
import { paypalService } from '../services/paypal.service';
import { confirmRequestPayment } from '../services/requestPayment.service';
import { stripeConnectEnabled } from '../config/payments';
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
  // An authorisation created here belongs to no DJ, so it cannot name one as
  // its destination: the money would settle on the platform account. Once
  // Connect is on that is the wrong answer, and the old tabs this exists for
  // are long gone by then.
  if (stripeConnectEnabled) {
    return res.status(410).json({ error: 'Ricarica la pagina per continuare' });
  }

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

// Connect events arrive on their own endpoint, with their own signing secret.
// Without this the DJ's onboarding state would only ever be refreshed when they
// happened to open the settings page.
export const stripeConnectWebhook = asyncHandler(async (req: Request, res: Response) => {
  let event: Stripe.Event;

  try {
    const signature = req.headers['stripe-signature'] as string;
    event = await stripeService.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_CONNECT_WEBHOOK_SECRET
    );
  } catch (error) {
    console.error('Stripe Connect webhook verification failed:', error);
    return res.status(400).json({ error: 'Invalid webhook' });
  }

  res.json({ received: true });

  try {
    if (event.type === 'account.updated') {
      const account = event.data.object;

      // Matched on the account id rather than the djId in the metadata: the
      // column is unique and it is the one the charges are actually sent to.
      await prisma.dJ.updateMany({
        where: { stripeAccountId: account.id },
        data: {
          chargesEnabled: account.charges_enabled,
          payoutsEnabled: account.payouts_enabled
        }
      });
    }
  } catch (error) {
    console.error(`Failed to handle Stripe Connect event ${event.id} (${event.type}):`, error);
  }
});

async function findRequestIdForIntent(paymentIntentId: string): Promise<string | null> {
  const request = await prisma.request.findUnique({
    where: { paymentIntentId },
    select: { id: true }
  });

  return request?.id ?? null;
}

// Only the parts of a PayPal notification this server acts on. The rest of the
// payload is large, versioned by PayPal and none of our business.
interface PayPalWebhookEvent {
  event_type?: string;
  resource?: {
    id?: string;
    custom_id?: string;
    supplementary_data?: { related_ids?: { order_id?: string } };
  };
}

// Approval and authorisation both mean the guest has done their part. The first
// arrives before any money is held - confirming is what places the hold - and
// the second after. Captures and voids are driven from here, so hearing about
// them again tells us nothing.
const CONFIRMING_EVENTS = new Set(['CHECKOUT.ORDER.APPROVED', 'PAYMENT.AUTHORIZATION.CREATED']);

// The counterpart of the Stripe webhook: the path that still works when the
// guest's browser never comes back from paypal.com.
export const paypalWebhook = asyncHandler(async (req: Request, res: Response) => {
  const event = req.body as PayPalWebhookEvent;

  // Unverified, this endpoint would let anyone promote a request to PENDING by
  // posting a made-up event. Only PayPal can check its own signature.
  let verified = false;
  try {
    verified = await paypalService.verifyWebhookSignature(req.headers, event);
  } catch (error) {
    console.error('PayPal webhook verification failed:', error);
  }

  if (!verified) {
    return res.status(400).json({ error: 'Invalid webhook' });
  }

  // Answer first, as with Stripe: PayPal retries a slow endpoint, and a retry
  // storm is worse than a promotion that lands a moment late.
  res.json({ received: true });

  try {
    if (!CONFIRMING_EVENTS.has(event.event_type ?? '')) return;

    const requestId = await findRequestIdForPayPalEvent(event);

    if (!requestId) {
      console.warn(`PayPal event ${event.event_type} names no request we know of`);
      return;
    }

    // Re-reads the order from PayPal and checks the amount and currency itself,
    // so nothing in the payload above is taken on trust.
    await confirmRequestPayment(requestId);
  } catch (error) {
    console.error(`Failed to handle PayPal event ${event.event_type}:`, error);
  }
});

async function findRequestIdForPayPalEvent(event: PayPalWebhookEvent): Promise<string | null> {
  // The order id is what the request row stores. An order event names it
  // directly; a payment event is about an authorisation and carries it off to
  // one side.
  const orderId =
    event.event_type === 'CHECKOUT.ORDER.APPROVED'
      ? event.resource?.id
      : event.resource?.supplementary_data?.related_ids?.order_id;

  if (orderId) {
    const request = await prisma.request.findUnique({
      where: { paymentIntentId: orderId },
      select: { id: true }
    });

    if (request) return request.id;
  }

  // Set as the purchase unit's custom id when the order was created, and echoed
  // back on everything that comes out of it. The fallback for an order whose id
  // we somehow failed to store.
  return event.resource?.custom_id ?? null;
}