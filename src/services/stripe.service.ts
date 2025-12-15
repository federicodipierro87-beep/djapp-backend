import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20'
});

export class StripeService {
  async createPaymentIntent(amount: number, currency: string = 'eur') {
    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100),
        currency,
        capture_method: 'manual',
        automatic_payment_methods: {
          enabled: true,
        },
        metadata: {
          service: 'dj-request'
        }
      });

      return paymentIntent;
    } catch (error) {
      console.error('Stripe payment intent creation failed:', error);
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

  async constructEvent(body: string, signature: string) {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
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