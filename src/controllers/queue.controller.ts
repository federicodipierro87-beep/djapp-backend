import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/database';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { stripeService } from '../services/stripe.service';
import { paypalService } from '../services/paypal.service';
import { satispayService } from '../services/satispay.service';

const reorderSchema = z.object({
  queueItemIds: z.array(z.string())
});

export const getPublicQueue = async (req: Request, res: Response) => {
  try {
    const { eventCode } = req.params;

    const dj = await prisma.dJ.findUnique({
      where: { eventCode }
    });

    if (!dj) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const queueItems = await prisma.queueItem.findMany({
      where: { djId: dj.id },
      include: {
        request: {
          select: {
            songTitle: true,
            artistName: true,
            requesterName: true
          }
        }
      },
      orderBy: { position: 'asc' }
    });

    const publicQueue = queueItems.map((item, index) => ({
      id: item.id,
      position: item.position,
      songTitle: item.request.songTitle,
      artistName: item.request.artistName,
      requesterName: item.request.requesterName,
      status: item.status,
      addedAt: item.addedAt,
      playedAt: item.playedAt,
      isNowPlaying: item.status === 'NOW_PLAYING'
    }));

    res.json(publicQueue);
  } catch (error) {
    throw error;
  }
};

export const getDJQueue = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const queueItems = await prisma.queueItem.findMany({
      where: { djId: req.dj!.djId },
      include: {
        request: {
          select: {
            songTitle: true,
            artistName: true,
            requesterName: true,
            requesterEmail: true,
            donationAmount: true,
            paymentMethod: true
          }
        }
      },
      orderBy: { position: 'asc' }
    });

    const djQueue = queueItems.map(item => ({
      id: item.id,
      position: item.position,
      songTitle: item.request.songTitle,
      artistName: item.request.artistName,
      requesterName: item.request.requesterName,
      requesterEmail: item.request.requesterEmail,
      donationAmount: item.request.donationAmount,
      paymentMethod: item.request.paymentMethod,
      status: item.status,
      addedAt: item.addedAt,
      playedAt: item.playedAt,
      isNowPlaying: item.status === 'NOW_PLAYING'
    }));

    // Calcola guadagni solo dalle canzoni PLAYED, non quelle SKIPPED
    const totalEarnings = queueItems.reduce((total, item) => {
      if (item.status === 'PLAYED') {
        return total + item.request.donationAmount.toNumber();
      }
      return total;
    }, 0);

    res.json({
      queue: djQueue,
      totalEarnings
    });
  } catch (error) {
    throw error;
  }
};

export const reorderQueue = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { queueItemIds } = reorderSchema.parse(req.body);

    const updatePromises = queueItemIds.map((id, index) => 
      prisma.queueItem.update({
        where: { 
          id,
          djId: req.dj!.djId
        },
        data: { position: index + 1 }
      })
    );

    await Promise.all(updatePromises);

    res.json({ message: 'Queue reordered successfully' });
  } catch (error) {
    throw error;
  }
};

export const setNowPlaying = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    await prisma.$transaction([
      prisma.queueItem.updateMany({
        where: { 
          djId: req.dj!.djId,
          status: 'NOW_PLAYING'
        },
        data: { status: 'WAITING' }
      }),
      
      prisma.queueItem.update({
        where: { 
          id,
          djId: req.dj!.djId
        },
        data: { status: 'NOW_PLAYING' }
      })
    ]);

    res.json({ message: 'Song set as now playing' });
  } catch (error) {
    throw error;
  }
};

export const markAsPlayed = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Ottieni informazioni sulla richiesta per il pagamento
    const queueItem = await prisma.queueItem.findUnique({
      where: { 
        id,
        djId: req.dj!.djId
      },
      include: {
        request: true
      }
    });

    if (!queueItem) {
      return res.status(404).json({ error: 'Queue item not found' });
    }

    const request = queueItem.request;
    let captureResult;

    // Cattura il pagamento ora che la canzone viene effettivamente suonata
    switch (request.paymentMethod) {
      case 'CARD':
      case 'APPLE_PAY':
      case 'GOOGLE_PAY':
        if (request.paymentIntentId) {
          captureResult = await stripeService.capturePaymentIntent(request.paymentIntentId);
        }
        break;
      
      case 'PAYPAL':
        if (request.paymentIntentId) {
          const order = await paypalService.getOrder(request.paymentIntentId);
          if (order.purchase_units[0].payments?.authorizations) {
            const authId = order.purchase_units[0].payments.authorizations[0].id;
            captureResult = await paypalService.captureAuthorization(authId);
          }
        }
        break;
      
      case 'SATISPAY':
        if (request.paymentIntentId) {
          captureResult = await satispayService.acceptPayment(request.paymentIntentId);
        }
        break;
    }

    // Aggiorna lo stato della canzone solo se il pagamento è stato catturato con successo
    await prisma.queueItem.update({
      where: { 
        id,
        djId: req.dj!.djId
      },
      data: { 
        status: 'PLAYED',
        playedAt: new Date()
      }
    });

    res.json({ 
      message: 'Song marked as played and payment captured',
      captureResult
    });
  } catch (error) {
    console.error('Error in markAsPlayed:', error);
    throw error;
  }
};

export const skipSong = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Ottieni informazioni sulla richiesta per cancellare il pagamento
    const queueItem = await prisma.queueItem.findUnique({
      where: { 
        id,
        djId: req.dj!.djId
      },
      include: {
        request: true
      }
    });

    if (!queueItem) {
      return res.status(404).json({ error: 'Queue item not found' });
    }

    const request = queueItem.request;
    let cancelResult;

    // Cancella il pagamento dato che la canzone viene skippata
    switch (request.paymentMethod) {
      case 'CARD':
      case 'APPLE_PAY':
      case 'GOOGLE_PAY':
        if (request.paymentIntentId) {
          cancelResult = await stripeService.cancelPaymentIntent(request.paymentIntentId);
        }
        break;
      
      case 'PAYPAL':
        if (request.paymentIntentId) {
          const order = await paypalService.getOrder(request.paymentIntentId);
          if (order.purchase_units[0].payments?.authorizations) {
            const authId = order.purchase_units[0].payments.authorizations[0].id;
            cancelResult = await paypalService.voidAuthorization(authId);
          }
        }
        break;
      
      case 'SATISPAY':
        if (request.paymentIntentId) {
          cancelResult = await satispayService.cancelPayment(request.paymentIntentId);
        }
        break;
    }

    // Aggiorna lo stato della canzone a SKIPPED
    await prisma.queueItem.update({
      where: { 
        id,
        djId: req.dj!.djId
      },
      data: { 
        status: 'SKIPPED'
      }
    });

    res.json({ 
      message: 'Song skipped and payment cancelled - no charge to customer',
      cancelResult
    });
  } catch (error) {
    console.error('Error in skipSong:', error);
    throw error;
  }
};