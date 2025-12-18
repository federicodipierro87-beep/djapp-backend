import cron from 'node-cron';
import prisma from '../utils/database';
import { stripeService } from './stripe.service';
import { paypalService } from './paypal.service';
import { satispayService } from './satispay.service';

const EXPIRATION_MINUTES = 180;

export class ExpirationService {
  start() {
    cron.schedule('* * * * *', async () => {
      try {
        await this.expireOldRequests();
      } catch (error) {
        console.error('Error in expiration service:', error);
      }
    });

    console.log('Expiration service started - checking every minute');
  }

  private async expireOldRequests() {
    const expirationTime = new Date(Date.now() - EXPIRATION_MINUTES * 60 * 1000);
    
    const expiredRequests = await prisma.request.findMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: expirationTime }
      }
    });

    console.log(`Found ${expiredRequests.length} expired requests`);

    for (const request of expiredRequests) {
      try {
        await this.cancelPaymentByMethod(request);
        
        await prisma.request.update({
          where: { id: request.id },
          data: { status: 'EXPIRED' }
        });

        console.log(`Expired request ${request.id} for song "${request.songTitle}"`);
      } catch (error) {
        console.error(`Failed to expire request ${request.id}:`, error);
      }
    }
  }

  private async cancelPaymentByMethod(request: any) {
    if (!request.paymentIntentId) {
      console.log(`No payment intent ID for request ${request.id}`);
      return;
    }

    switch (request.paymentMethod) {
      case 'CARD':
      case 'APPLE_PAY':
      case 'GOOGLE_PAY':
        await stripeService.cancelPaymentIntent(request.paymentIntentId);
        console.log(`Cancelled Stripe payment ${request.paymentIntentId}`);
        break;
      
      case 'PAYPAL':
        await paypalService.voidAuthorization(request.paymentIntentId);
        console.log(`Voided PayPal authorization ${request.paymentIntentId}`);
        break;
      
      case 'SATISPAY':
        await satispayService.cancelPayment(request.paymentIntentId);
        console.log(`Cancelled Satispay payment ${request.paymentIntentId}`);
        break;
      
      default:
        console.warn(`Unknown payment method: ${request.paymentMethod}`);
    }
  }

  async getTimeRemaining(createdAt: Date): Promise<number> {
    const expiry = new Date(createdAt.getTime() + EXPIRATION_MINUTES * 60 * 1000);
    return Math.max(0, expiry.getTime() - Date.now());
  }

  async isExpired(createdAt: Date): Promise<boolean> {
    const timeRemaining = await this.getTimeRemaining(createdAt);
    return timeRemaining <= 0;
  }
}

export const expirationService = new ExpirationService();