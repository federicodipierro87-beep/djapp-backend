import { Request, Response } from 'express';
import { z } from 'zod';
import { stripeService } from '../services/stripe.service';
import { paypalService } from '../services/paypal.service';
import { satispayService } from '../services/satispay.service';
import prisma from '../utils/database';

const createStripeIntentSchema = z.object({
  amount: z.number().min(0.01),
  currency: z.string().default('eur')
});

const createPayPalOrderSchema = z.object({
  amount: z.number().min(0.01),
  currency: z.string().default('EUR')
});

const createSatispayPaymentSchema = z.object({
  amount: z.number().min(0.01),
  currency: z.string().default('EUR'),
  description: z.string().default('DJ Song Request')
});

export const createStripeIntent = async (req: Request, res: Response) => {
  try {
    const { amount, currency } = createStripeIntentSchema.parse(req.body);
    
    const paymentIntent = await stripeService.createPaymentIntent(amount, currency);
    
    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
  } catch (error) {
    throw error;
  }
};

export const createPayPalOrder = async (req: Request, res: Response) => {
  try {
    const { amount, currency } = createPayPalOrderSchema.parse(req.body);
    
    const order = await paypalService.createOrder(amount, currency);
    
    res.json({
      orderId: order.id,
      approvalUrl: order.links?.find((link: any) => link.rel === 'approve')?.href
    });
  } catch (error) {
    throw error;
  }
};

export const createSatispayPayment = async (req: Request, res: Response) => {
  try {
    const { amount, currency, description } = createSatispayPaymentSchema.parse(req.body);
    
    const payment = await satispayService.createPayment(amount, currency, description);
    
    res.json({
      paymentId: payment.id,
      redirectUrl: payment.redirect_url
    });
  } catch (error) {
    throw error;
  }
};

export const stripeWebhook = async (req: Request, res: Response) => {
  try {
    const signature = req.headers['stripe-signature'] as string;
    const event = await stripeService.constructEvent(req.body, signature);

    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object;
        console.log(`Payment succeeded: ${paymentIntent.id}`);
        break;
        
      case 'payment_intent.payment_failed':
        const failedPayment = event.data.object;
        console.log(`Payment failed: ${failedPayment.id}`);
        break;
        
      case 'payment_intent.canceled':
        const canceledPayment = event.data.object;
        console.log(`Payment canceled: ${canceledPayment.id}`);
        break;
        
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook error:', error);
    res.status(400).json({ error: 'Invalid webhook' });
  }
};

export const paypalWebhook = async (req: Request, res: Response) => {
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
};