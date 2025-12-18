import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/database';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { stripeService } from '../services/stripe.service';
import { paypalService } from '../services/paypal.service';
import { satispayService } from '../services/satispay.service';
import { expirationService } from '../services/expiration.service';

const createRequestSchema = z.object({
  eventCode: z.string(),
  songTitle: z.string().min(1),
  artistName: z.string().min(1),
  requesterName: z.string().min(1),
  requesterEmail: z.string().email().optional(),
  donationAmount: z.number().min(0.01),
  paymentMethod: z.enum(['CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'PAYPAL', 'SATISPAY']),
  paymentIntentId: z.string().optional()
});

export const createRequest = async (req: Request, res: Response) => {
  try {
    const data = createRequestSchema.parse(req.body);

    const dj = await prisma.dJ.findUnique({
      where: { eventCode: data.eventCode }
    });

    if (!dj) {
      return res.status(404).json({ error: 'Event not found' });
    }

    if (data.donationAmount < dj.minDonation.toNumber()) {
      return res.status(400).json({
        error: `Minimum donation is €${dj.minDonation}`,
        minDonation: dj.minDonation.toNumber()
      });
    }

    // Use provided paymentIntentId if available (payment already completed)
    let paymentIntentId: string | null = data.paymentIntentId || null;
    let clientSecret: string | null = null;

    // Only create new payment intent if not provided
    if (!paymentIntentId) {
      switch (data.paymentMethod) {
        case 'CARD':
        case 'APPLE_PAY':
        case 'GOOGLE_PAY':
          const paymentIntent = await stripeService.createPaymentIntent(data.donationAmount);
          paymentIntentId = paymentIntent.id;
          clientSecret = paymentIntent.client_secret;
          break;
        
        case 'PAYPAL':
          const order = await paypalService.createOrder(data.donationAmount);
          paymentIntentId = order.id;
          break;
        
        case 'SATISPAY':
          const payment = await satispayService.createPayment(data.donationAmount);
          paymentIntentId = payment.id;
          break;
      }
    }

    const request = await prisma.request.create({
      data: {
        songTitle: data.songTitle,
        artistName: data.artistName,
        requesterName: data.requesterName,
        requesterEmail: data.requesterEmail,
        donationAmount: data.donationAmount,
        paymentMethod: data.paymentMethod,
        paymentIntentId,
        djId: dj.id
      }
    });

    const timeRemaining = await expirationService.getTimeRemaining(request.createdAt);

    res.status(201).json({
      id: request.id,
      songTitle: request.songTitle,
      artistName: request.artistName,
      requesterName: request.requesterName,
      donationAmount: request.donationAmount,
      status: request.status,
      paymentIntentId,
      clientSecret,
      timeRemaining,
      expiresAt: new Date(request.createdAt.getTime() + 180 * 60 * 1000),
      createdAt: request.createdAt
    });
  } catch (error) {
    throw error;
  }
};

export const getRequestsByEvent = async (req: Request, res: Response) => {
  try {
    const { eventCode } = req.params;

    const dj = await prisma.dJ.findUnique({
      where: { eventCode }
    });

    if (!dj) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const requests = await prisma.request.findMany({
      where: { djId: dj.id },
      orderBy: { createdAt: 'desc' },
      take: 20
    });

    const requestsWithTimeRemaining = await Promise.all(
      requests.map(async (request) => {
        const timeRemaining = await expirationService.getTimeRemaining(request.createdAt);
        return {
          id: request.id,
          songTitle: request.songTitle,
          artistName: request.artistName,
          requesterName: request.requesterName,
          status: request.status,
          timeRemaining,
          expiresAt: new Date(request.createdAt.getTime() + 180 * 60 * 1000),
          createdAt: request.createdAt
        };
      })
    );

    res.json(requestsWithTimeRemaining);
  } catch (error) {
    throw error;
  }
};

export const getDJRequests = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const requests = await prisma.request.findMany({
      where: { djId: req.dj!.djId },
      orderBy: { createdAt: 'desc' }
    });

    const requestsWithTimeRemaining = await Promise.all(
      requests.map(async (request) => {
        const timeRemaining = await expirationService.getTimeRemaining(request.createdAt);
        return {
          id: request.id,
          songTitle: request.songTitle,
          artistName: request.artistName,
          requesterName: request.requesterName,
          requesterEmail: request.requesterEmail,
          donationAmount: request.donationAmount,
          paymentMethod: request.paymentMethod,
          status: request.status,
          timeRemaining,
          expiresAt: new Date(request.createdAt.getTime() + 180 * 60 * 1000),
          createdAt: request.createdAt
        };
      })
    );

    res.json(requestsWithTimeRemaining);
  } catch (error) {
    throw error;
  }
};

export const acceptRequest = async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log('Accept request called for ID:', req.params.id);
    const { id } = req.params;

    const request = await prisma.request.findUnique({
      where: { id },
      include: { dj: true }
    });

    if (!request || request.djId !== req.dj!.djId) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (request.status !== 'PENDING') {
      return res.status(400).json({ error: 'Request cannot be accepted' });
    }

    const isExpired = await expirationService.isExpired(request.createdAt);
    if (isExpired) {
      return res.status(400).json({ error: 'Request has expired' });
    }

    // Pagamento non viene più catturato qui, ma solo quando la canzone viene effettivamente suonata

    const nextPosition = await prisma.queueItem.count({
      where: { djId: req.dj!.djId }
    }) + 1;

    await prisma.$transaction([
      prisma.request.update({
        where: { id },
        data: { status: 'ACCEPTED' }
      }),
      prisma.queueItem.create({
        data: {
          requestId: id,
          djId: req.dj!.djId,
          position: nextPosition
        }
      })
    ]);

    res.json({
      message: 'Request accepted and added to queue - payment will be captured when song is played'
    });
  } catch (error) {
    throw error;
  }
};

export const rejectRequest = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const request = await prisma.request.findUnique({
      where: { id }
    });

    if (!request || request.djId !== req.dj!.djId) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (request.status !== 'PENDING') {
      return res.status(400).json({ error: 'Request cannot be rejected' });
    }

    switch (request.paymentMethod) {
      case 'CARD':
      case 'APPLE_PAY':
      case 'GOOGLE_PAY':
        if (request.paymentIntentId) {
          await stripeService.cancelPaymentIntent(request.paymentIntentId);
        }
        break;
      
      case 'PAYPAL':
        if (request.paymentIntentId) {
          const order = await paypalService.getOrder(request.paymentIntentId);
          if (order.purchase_units[0].payments?.authorizations) {
            const authId = order.purchase_units[0].payments.authorizations[0].id;
            await paypalService.voidAuthorization(authId);
          }
        }
        break;
      
      case 'SATISPAY':
        if (request.paymentIntentId) {
          await satispayService.cancelPayment(request.paymentIntentId);
        }
        break;
    }

    await prisma.request.update({
      where: { id },
      data: { status: 'REJECTED' }
    });

    res.json({ message: 'Request rejected' });
  } catch (error) {
    throw error;
  }
};