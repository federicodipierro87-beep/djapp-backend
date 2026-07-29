import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/database';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { subscriptionService } from '../services/subscription.service';

const checkoutSchema = z.object({
  plan: z.enum(['MONTHLY', 'ANNUAL']),
  successUrl: z.string().url(),
  cancelUrl: z.string().url()
});

const portalSchema = z.object({
  returnUrl: z.string().url()
});

export const createCheckoutSession = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { plan, successUrl, cancelUrl } = checkoutSchema.parse(req.body);
    const djId = req.dj!.djId;

    const dj = await prisma.dJ.findUnique({
      where: { id: djId },
      include: { subscription: true }
    });

    if (!dj) {
      return res.status(404).json({ error: 'DJ non trovato' });
    }

    // Check if DJ already has an active subscription
    if (dj.subscription) {
      const activeStatuses = ['TRIALING', 'ACTIVE', 'PAST_DUE'];
      if (activeStatuses.includes(dj.subscription.status)) {
        return res.status(400).json({
          error: 'Hai già un abbonamento attivo. Usa il portale clienti per gestirlo.'
        });
      }
    }

    // Create Stripe customer if not exists
    let customerId = dj.stripeCustomerId;
    if (!customerId) {
      customerId = await subscriptionService.createCustomer(djId, dj.email, dj.name);
    }

    const session = await subscriptionService.createCheckoutSession(
      djId,
      customerId,
      plan,
      successUrl,
      cancelUrl
    );

    res.json({
      sessionId: session.sessionId,
      url: session.url
    });
  } catch (error) {
    console.error('Error creating checkout session:', error);
    throw error;
  }
};

export const getSubscriptionStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const djId = req.dj!.djId;
    const status = await subscriptionService.getSubscriptionStatus(djId);
    res.json(status);
  } catch (error) {
    console.error('Error getting subscription status:', error);
    throw error;
  }
};

export const createPortalSession = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { returnUrl } = portalSchema.parse(req.body);
    const djId = req.dj!.djId;

    const dj = await prisma.dJ.findUnique({
      where: { id: djId }
    });

    if (!dj) {
      return res.status(404).json({ error: 'DJ non trovato' });
    }

    if (!dj.stripeCustomerId) {
      return res.status(400).json({ error: 'Nessun account di fatturazione associato' });
    }

    const url = await subscriptionService.createCustomerPortalSession(
      dj.stripeCustomerId,
      returnUrl
    );

    res.json({ url });
  } catch (error) {
    console.error('Error creating portal session:', error);
    throw error;
  }
};

export const cancelSubscription = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const djId = req.dj!.djId;

    const dj = await prisma.dJ.findUnique({
      where: { id: djId },
      include: { subscription: true }
    });

    if (!dj) {
      return res.status(404).json({ error: 'DJ non trovato' });
    }

    if (!dj.subscription) {
      return res.status(400).json({ error: 'Nessun abbonamento attivo' });
    }

    await subscriptionService.cancelSubscription(dj.subscription.stripeSubscriptionId);

    res.json({
      message: 'Abbonamento cancellato. Rimarrà attivo fino alla fine del periodo corrente.',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: dj.subscription.currentPeriodEnd
    });
  } catch (error) {
    console.error('Error canceling subscription:', error);
    throw error;
  }
};

export const reactivateSubscription = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const djId = req.dj!.djId;

    const dj = await prisma.dJ.findUnique({
      where: { id: djId },
      include: { subscription: true }
    });

    if (!dj) {
      return res.status(404).json({ error: 'DJ non trovato' });
    }

    if (!dj.subscription) {
      return res.status(400).json({ error: 'Nessun abbonamento da riattivare' });
    }

    if (!dj.subscription.cancelAtPeriodEnd) {
      return res.status(400).json({ error: 'L\'abbonamento non è in fase di cancellazione' });
    }

    await subscriptionService.reactivateSubscription(dj.subscription.stripeSubscriptionId);

    res.json({
      message: 'Abbonamento riattivato con successo!',
      cancelAtPeriodEnd: false
    });
  } catch (error) {
    console.error('Error reactivating subscription:', error);
    throw error;
  }
};

export const handleWebhook = async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'] as string;

  if (!signature) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  try {
    const event = subscriptionService.constructWebhookEvent(
      req.body.toString(),
      signature
    );

    switch (event.type) {
      case 'checkout.session.completed':
        await subscriptionService.handleCheckoutCompleted(
          event.data.object as any
        );
        break;

      case 'customer.subscription.updated':
        await subscriptionService.handleSubscriptionUpdated(
          event.data.object as any
        );
        break;

      case 'customer.subscription.deleted':
        await subscriptionService.handleSubscriptionDeleted(
          event.data.object as any
        );
        break;

      case 'invoice.payment_failed':
        await subscriptionService.handleInvoicePaymentFailed(
          event.data.object as any
        );
        break;

      default:
        console.log(`Unhandled subscription event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error: any) {
    console.error('Webhook error:', error.message);
    return res.status(400).json({ error: `Webhook Error: ${error.message}` });
  }
};
