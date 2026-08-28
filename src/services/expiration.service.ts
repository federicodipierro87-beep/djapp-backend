import cron from 'node-cron';
import { Prisma } from '@prisma/client';
import prisma from '../utils/database';
import { stripeService } from './stripe.service';
import { paypalService } from './paypal.service';
import { satispayService } from './satispay.service';
import { AWAITING_PAYMENT_TIMEOUT_MS } from '../config/payments';

export const EXPIRATION_MINUTES = 180;
export const EXPIRATION_MS = EXPIRATION_MINUTES * 60 * 1000;

// Only the columns this service actually reads. Widening it later is a compile
// error rather than a silent `any` access.
type ExpirableRequest = Prisma.RequestGetPayload<{
  select: {
    id: true;
    songTitle: true;
    paymentMethod: true;
    paymentIntentId: true;
  };
}>;

export class ExpirationService {
  private task: cron.ScheduledTask | null = null;

  start() {
    this.task = cron.schedule('* * * * *', async () => {
      try {
        await this.expireOldRequests();
        await this.expireAbandonedDrafts();
      } catch (error) {
        console.error('Error in expiration service:', error);
      }
    });

    console.log('Expiration service started - checking every minute');
  }

  stop() {
    this.task?.stop();
    this.task = null;
  }

  private async expireOldRequests() {
    const expirationTime = new Date(Date.now() - EXPIRATION_MS);

    const candidates = await prisma.request.findMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: expirationTime }
      },
      select: {
        id: true,
        songTitle: true,
        paymentMethod: true,
        paymentIntentId: true
      }
    });

    if (candidates.length === 0) return;

    console.log(`Found ${candidates.length} candidate requests to expire`);

    for (const request of candidates) {
      try {
        // Claim the row first. If the DJ accepted it in the meantime the status
        // is no longer PENDING, no row is updated, and we must not touch the
        // authorisation the queue still depends on.
        const claimed = await prisma.request.updateMany({
          where: { id: request.id, status: 'PENDING' },
          data: { status: 'EXPIRED', paymentStatus: 'CANCELED' }
        });

        if (claimed.count !== 1) {
          continue;
        }

        await this.cancelPaymentByMethod(request);

        console.log(`Expired request ${request.id} for song "${request.songTitle}"`);
      } catch (error) {
        console.error(`Failed to expire request ${request.id}:`, error);
      }
    }
  }

  // A guest who closes the tab mid-payment leaves a request nobody can confirm
  // and, if their bank did put the money on hold, a card authorisation that
  // would otherwise sit there for days.
  private async expireAbandonedDrafts() {
    const cutoff = new Date(Date.now() - AWAITING_PAYMENT_TIMEOUT_MS);

    const candidates = await prisma.request.findMany({
      where: {
        status: 'AWAITING_PAYMENT',
        createdAt: { lt: cutoff }
      },
      select: {
        id: true,
        songTitle: true,
        paymentMethod: true,
        paymentIntentId: true
      }
    });

    for (const request of candidates) {
      try {
        // Same claim-first rule as above: the confirmation may have landed
        // between the read and the write.
        const claimed = await prisma.request.updateMany({
          where: { id: request.id, status: 'AWAITING_PAYMENT' },
          data: { status: 'EXPIRED', paymentStatus: 'CANCELED' }
        });

        if (claimed.count !== 1) {
          continue;
        }

        await this.cancelPaymentByMethod(request);
      } catch (error) {
        console.error(`Failed to discard unpaid request ${request.id}:`, error);
      }
    }
  }

  private async cancelPaymentByMethod(request: ExpirableRequest) {
    if (!request.paymentIntentId) {
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
        await paypalService.voidOrder(request.paymentIntentId);
        console.log(`Voided PayPal authorization for order ${request.paymentIntentId}`);
        break;

      case 'SATISPAY':
        await satispayService.cancelPayment(request.paymentIntentId);
        console.log(`Cancelled Satispay payment ${request.paymentIntentId}`);
        break;

      default:
        console.warn(`Unknown payment method: ${request.paymentMethod}`);
    }
  }

  expiresAt(createdAt: Date): Date {
    return new Date(createdAt.getTime() + EXPIRATION_MS);
  }

  async getTimeRemaining(createdAt: Date): Promise<number> {
    return Math.max(0, this.expiresAt(createdAt).getTime() - Date.now());
  }

  async isExpired(createdAt: Date): Promise<boolean> {
    const timeRemaining = await this.getTimeRemaining(createdAt);
    return timeRemaining <= 0;
  }
}

export const expirationService = new ExpirationService();
