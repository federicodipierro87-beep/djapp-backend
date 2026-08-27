import Stripe from 'stripe';
import { platformFeeInCents, stripeConnectCountry } from '../config/payments';

// Pinned to the version this SDK's typings describe. It moves when the SDK
// does, which is its own upgrade rather than something to slip in here.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2023-10-16'
});

export class StripeService {
  async createPaymentIntent(
    amount: number,
    currency: string = 'eur',
    // The request this authorisation belongs to. Stripe echoes it back on every
    // webhook, which is how an event that arrives without the guest's browser
    // still finds its way to the right row.
    metadata: Record<string, string> = {},
    // The DJ's connected account, when Connect is on. Null keeps the money on
    // the platform account, which is how it worked before Connect existed.
    connectedAccountId?: string | null
  ) {
    const amountInCents = Math.round(amount * 100);

    const params: Stripe.PaymentIntentCreateParams = {
      amount: amountInCents,
      currency,
      capture_method: 'manual',
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        service: 'dj-request',
        ...metadata
      }
    };

    if (connectedAccountId) {
      // A destination charge, not a direct one. The intent is still created on
      // the platform account, so capture, cancellation, retrieval and the
      // existing webhook all keep working untouched; Stripe moves the money to
      // the DJ when it is captured, minus our fee. A direct charge would live
      // on the DJ's account instead and every one of those paths would need to
      // be told which account to look in.
      params.transfer_data = { destination: connectedAccountId };
      // Makes the DJ the merchant of record: their statement descriptor, their
      // country's rules for the card fees.
      params.on_behalf_of = connectedAccountId;

      const fee = platformFeeInCents(amountInCents);
      if (fee > 0) {
        params.application_fee_amount = fee;
      }
    }

    try {
      const paymentIntent = await stripe.paymentIntents.create(params);

      return paymentIntent;
    } catch (error) {
      console.error('Stripe payment intent creation failed:', error);
      throw error;
    }
  }

  // Express accounts: Stripe hosts the onboarding form and the dashboard, so
  // none of the identity documents or bank details ever touch this server.
  async createConnectAccount(djId: string, email: string) {
    try {
      return await stripe.accounts.create({
        type: 'express',
        country: stripeConnectCountry,
        email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        },
        metadata: { djId }
      });
    } catch (error) {
      console.error('Stripe Connect account creation failed:', error);
      throw error;
    }
  }

  // Single use and short lived, so it is generated on demand rather than stored:
  // a DJ who abandons onboarding halfway just asks for another one.
  async createAccountLink(accountId: string, refreshUrl: string, returnUrl: string) {
    try {
      return await stripe.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: 'account_onboarding'
      });
    } catch (error) {
      console.error('Stripe Connect account link creation failed:', error);
      throw error;
    }
  }

  async getConnectAccount(accountId: string) {
    try {
      return await stripe.accounts.retrieve(accountId);
    } catch (error) {
      console.error('Stripe Connect account retrieval failed:', error);
      throw error;
    }
  }

  async capturePaymentIntent(paymentIntentId: string) {
    try {
      const paymentIntent = await stripe.paymentIntents.capture(paymentIntentId);
      return paymentIntent;
    } catch (error) {
      console.error('Stripe payment capture failed:', error);
      throw error;
    }
  }

  async cancelPaymentIntent(paymentIntentId: string) {
    try {
      const paymentIntent = await stripe.paymentIntents.cancel(paymentIntentId);
      return paymentIntent;
    } catch (error) {
      console.error('Stripe payment cancellation failed:', error);
      throw error;
    }
  }

  async getPaymentIntent(paymentIntentId: string) {
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      return paymentIntent;
    } catch (error) {
      console.error('Stripe payment retrieval failed:', error);
      throw error;
    }
  }

  async confirmPaymentIntent(paymentIntentId: string, paymentMethodId?: string) {
    try {
      const confirmData: any = {
        payment_method: paymentMethodId,
        capture_method: 'manual'
      };

      const paymentIntent = await stripe.paymentIntents.confirm(
        paymentIntentId,
        confirmData
      );

      return paymentIntent;
    } catch (error) {
      console.error('Stripe payment confirmation failed:', error);
      throw error;
    }
  }

  // The Connect endpoint is a second endpoint in the Stripe dashboard and so has
  // its own signing secret; verifying its events against the account endpoint's
  // secret would reject every one of them.
  async constructEvent(
    body: string,
    signature: string,
    webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  ) {
    if (!webhookSecret) {
      throw new Error('Stripe webhook secret not configured');
    }

    try {
      return stripe.webhooks.constructEvent(body, signature, webhookSecret);
    } catch (error) {
      console.error('Stripe webhook verification failed:', error);
      throw error;
    }
  }
}

export const stripeService = new StripeService();