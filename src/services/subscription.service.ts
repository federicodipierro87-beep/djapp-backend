import Stripe from 'stripe';
import prisma from '../utils/database';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16'
});

export class SubscriptionService {
  private readonly TRIAL_DAYS = 7;

  async createCustomer(djId: string, email: string, name: string): Promise<string> {
    try {
      const customer = await stripe.customers.create({
        email,
        name,
        metadata: {
          djId
        }
      });

      await prisma.dJ.update({
        where: { id: djId },
        data: { stripeCustomerId: customer.id }
      });

      return customer.id;
    } catch (error) {
      console.error('Failed to create Stripe customer:', error);
      throw error;
    }
  }

  async createCheckoutSession(
    djId: string,
    customerId: string,
    plan: 'MONTHLY' | 'ANNUAL',
    successUrl: string,
    cancelUrl: string
  ): Promise<{ sessionId: string; url: string }> {
    try {
      const priceId = plan === 'MONTHLY'
        ? process.env.STRIPE_MONTHLY_PRICE_ID
        : process.env.STRIPE_ANNUAL_PRICE_ID;

      if (!priceId) {
        throw new Error(`Price ID not configured for plan: ${plan}`);
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [
          {
            price: priceId,
            quantity: 1
          }
        ],
        subscription_data: {
          trial_period_days: this.TRIAL_DAYS,
          metadata: {
            djId,
            plan
          }
        },
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          djId,
          plan
        }
      });

      return {
        sessionId: session.id,
        url: session.url!
      };
    } catch (error) {
      console.error('Failed to create checkout session:', error);
      throw error;
    }
  }

  async createCustomerPortalSession(customerId: string, returnUrl: string): Promise<string> {
    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl
      });

      return session.url;
    } catch (error) {
      console.error('Failed to create customer portal session:', error);
      throw error;
    }
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    try {
      await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true
      });

      await prisma.subscription.update({
        where: { stripeSubscriptionId: subscriptionId },
        data: { cancelAtPeriodEnd: true }
      });
    } catch (error) {
      console.error('Failed to cancel subscription:', error);
      throw error;
    }
  }

  async reactivateSubscription(subscriptionId: string): Promise<void> {
    try {
      await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: false
      });

      await prisma.subscription.update({
        where: { stripeSubscriptionId: subscriptionId },
        data: { cancelAtPeriodEnd: false }
      });
    } catch (error) {
      console.error('Failed to reactivate subscription:', error);
      throw error;
    }
  }

  async getSubscriptionStatus(djId: string): Promise<{
    hasSubscription: boolean;
    subscription: any | null;
    requiresSubscription: boolean;
  }> {
    const dj = await prisma.dJ.findUnique({
      where: { id: djId },
      include: { subscription: true }
    });

    if (!dj) {
      throw new Error('DJ not found');
    }

    // Admin users don't need subscription
    if (dj.isAdmin) {
      return {
        hasSubscription: true,
        subscription: null,
        requiresSubscription: false
      };
    }

    const subscription = dj.subscription;

    if (!subscription) {
      return {
        hasSubscription: false,
        subscription: null,
        requiresSubscription: true
      };
    }

    const isActive = ['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(subscription.status);

    return {
      hasSubscription: isActive,
      subscription: {
        id: subscription.id,
        status: subscription.status,
        plan: subscription.plan,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        trialEnd: subscription.trialEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd
      },
      requiresSubscription: !isActive
    };
  }

  // Webhook handlers
  async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const djId = session.metadata?.djId;
    const plan = session.metadata?.plan as 'MONTHLY' | 'ANNUAL';
    const subscriptionId = session.subscription as string;

    if (!djId || !subscriptionId) {
      console.error('Missing djId or subscriptionId in checkout session');
      return;
    }

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    await prisma.subscription.upsert({
      where: { djId },
      create: {
        djId,
        stripeSubscriptionId: subscriptionId,
        stripePriceId: subscription.items.data[0].price.id,
        status: this.mapStripeStatus(subscription.status),
        plan,
        currentPeriodStart: new Date(subscription.current_period_start * 1000),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end
      },
      update: {
        stripeSubscriptionId: subscriptionId,
        stripePriceId: subscription.items.data[0].price.id,
        status: this.mapStripeStatus(subscription.status),
        plan,
        currentPeriodStart: new Date(subscription.current_period_start * 1000),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end
      }
    });
  }

  async handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
    const existingSubscription = await prisma.subscription.findUnique({
      where: { stripeSubscriptionId: subscription.id }
    });

    if (!existingSubscription) {
      console.log('Subscription not found in database, skipping update');
      return;
    }

    // Determine plan from price ID
    const priceId = subscription.items.data[0].price.id;
    let plan = existingSubscription.plan;

    if (priceId === process.env.STRIPE_MONTHLY_PRICE_ID) {
      plan = 'MONTHLY';
    } else if (priceId === process.env.STRIPE_ANNUAL_PRICE_ID) {
      plan = 'ANNUAL';
    }

    await prisma.subscription.update({
      where: { stripeSubscriptionId: subscription.id },
      data: {
        stripePriceId: priceId,
        status: this.mapStripeStatus(subscription.status),
        plan,
        currentPeriodStart: new Date(subscription.current_period_start * 1000),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end
      }
    });
  }

  async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    await prisma.subscription.updateMany({
      where: { stripeSubscriptionId: subscription.id },
      data: {
        status: 'CANCELED'
      }
    });
  }

  async handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const subscriptionId = invoice.subscription as string;

    if (!subscriptionId) return;

    await prisma.subscription.updateMany({
      where: { stripeSubscriptionId: subscriptionId },
      data: {
        status: 'PAST_DUE'
      }
    });
  }

  constructWebhookEvent(body: string, signature: string): Stripe.Event {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET_SUBSCRIPTIONS;
    if (!webhookSecret) {
      throw new Error('Stripe subscription webhook secret not configured');
    }

    return stripe.webhooks.constructEvent(body, signature, webhookSecret);
  }

  private mapStripeStatus(status: Stripe.Subscription.Status): 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'UNPAID' {
    switch (status) {
      case 'trialing':
        return 'TRIALING';
      case 'active':
        return 'ACTIVE';
      case 'past_due':
        return 'PAST_DUE';
      case 'canceled':
      case 'incomplete_expired':
        return 'CANCELED';
      case 'unpaid':
      case 'incomplete':
        return 'UNPAID';
      default:
        return 'CANCELED';
    }
  }
}

export const subscriptionService = new SubscriptionService();
