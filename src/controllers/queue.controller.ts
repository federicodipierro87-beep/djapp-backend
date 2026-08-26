import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, QueueStatus } from '@prisma/client';
import prisma from '../utils/database';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { stripeService } from '../services/stripe.service';
import { paypalService } from '../services/paypal.service';
import { satispayService } from '../services/satispay.service';
import { emitQueueUpdated, emitNowPlayingChanged } from '../socket/socket';
import { asyncHandler } from '../utils/asyncHandler';

const reorderSchema = z.object({
  queueItemIds: z.array(z.string().uuid()).max(500)
});

export const getPublicQueue = asyncHandler(async (req: Request, res: Response) => {
  const { eventCode } = req.params;

  // First try to find in events table (new system)
  const event = await prisma.event.findUnique({
    where: { eventCode },
    include: { dj: true }
  });

  let djId: string;

  if (event) {
    // Found in events table - use this event's DJ
    djId = event.djId;
  } else {
    // Fallback: try to find in djs table (legacy system)
    const dj = await prisma.dJ.findUnique({
      where: { eventCode }
    });

    if (!dj) {
      return res.status(404).json({ error: 'Event not found' });
    }
    djId = dj.id;
  }

  // Get queue items - filter by eventId if it's a new event, otherwise by djId only
  const whereClause: Prisma.QueueItemWhereInput = event
    ? { eventId: event.id }
    : { djId };

  const queueItems = await prisma.queueItem.findMany({
    where: whereClause,
    include: {
      request: {
        select: {
          songTitle: true,
          artistName: true,
          albumCover: true,
          requesterName: true
        }
      }
    },
    orderBy: { position: 'asc' }
  });

  const publicQueue = queueItems.map((item) => ({
    id: item.id,
    position: item.position,
    songTitle: item.request.songTitle,
    artistName: item.request.artistName,
    albumCover: item.request.albumCover,
    requesterName: item.request.requesterName,
    status: item.status,
    addedAt: item.addedAt,
    playedAt: item.playedAt,
    isNowPlaying: item.status === 'NOW_PLAYING'
  }));

  res.json(publicQueue);
});

export const getDJQueue = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const queueItems = await prisma.queueItem.findMany({
    where: { djId: req.dj!.djId },
    include: {
      request: {
        select: {
          songTitle: true,
          artistName: true,
          spotifyTrackId: true,
          albumCover: true,
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
    spotifyTrackId: item.request.spotifyTrackId,
    albumCover: item.request.albumCover,
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
});

export const reorderQueue = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { queueItemIds } = reorderSchema.parse(req.body);

  // All or nothing: a partial reorder leaves the queue with duplicate or
  // missing positions, which the public view renders in arbitrary order.
  await prisma.$transaction(
    queueItemIds.map((id, index) =>
      prisma.queueItem.update({
        where: {
          id,
          djId: req.dj!.djId
        },
        data: { position: index + 1 }
      })
    )
  );

  // Get DJ's eventCode for socket emission
  const dj = await prisma.dJ.findUnique({
    where: { id: req.dj!.djId },
    select: { eventCode: true }
  });
  if (dj) {
    emitQueueUpdated(dj.eventCode);
  }

  res.json({ message: 'Queue reordered successfully' });
});

export const setNowPlaying = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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

  // Get queue item with DJ info for socket emission
  const queueItem = await prisma.queueItem.findUnique({
    where: { id },
    include: {
      request: { select: { songTitle: true, artistName: true } },
      dj: { select: { eventCode: true } }
    }
  });

  if (queueItem) {
    emitNowPlayingChanged(queueItem.dj.eventCode, {
      songTitle: queueItem.request.songTitle,
      artistName: queueItem.request.artistName
    });
    emitQueueUpdated(queueItem.dj.eventCode);
  }

  res.json({ message: 'Song set as now playing' });
});

export const markAsPlayed = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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

  // Claim the item before touching the money. Two taps on the same button used
  // to capture the authorisation twice; a tap after a skip used to capture a
  // payment that had already been voided.
  const claimed = await prisma.queueItem.updateMany({
    where: {
      id,
      djId: req.dj!.djId,
      status: { in: [QueueStatus.WAITING, QueueStatus.NOW_PLAYING] }
    },
    data: {
      status: QueueStatus.PLAYED,
      playedAt: new Date()
    }
  });

  if (claimed.count !== 1) {
    return res.status(409).json({ error: 'Song has already been played or skipped' });
  }

  const request = queueItem.request;
  let captureResult;
  let captureError: string | null = null;

  // Cattura il pagamento ora che la canzone viene effettivamente suonata
  try {
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
  } catch (error) {
    // The song really was played, so the queue state stays PLAYED. Surface the
    // failure instead of letting an uncollected donation disappear silently.
    console.error(`Payment capture failed for request ${request.id}:`, error);
    captureError = error instanceof Error ? error.message : 'Payment capture failed';
  }

  // Get DJ's eventCode for socket emission
  const dj = await prisma.dJ.findUnique({
    where: { id: req.dj!.djId },
    select: { eventCode: true }
  });
  if (dj) {
    emitQueueUpdated(dj.eventCode);
  }

  res.json({
    message: captureError
      ? 'Song marked as played but the payment could not be captured'
      : 'Song marked as played and payment captured',
    captureResult,
    captureError
  });
});

export const skipSong = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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

  // Same claim-first rule as markAsPlayed: never release an authorisation that
  // a concurrent capture may already have taken.
  const claimed = await prisma.queueItem.updateMany({
    where: {
      id,
      djId: req.dj!.djId,
      status: { in: [QueueStatus.WAITING, QueueStatus.NOW_PLAYING] }
    },
    data: {
      status: QueueStatus.SKIPPED
    }
  });

  if (claimed.count !== 1) {
    return res.status(409).json({ error: 'Song has already been played or skipped' });
  }

  const request = queueItem.request;
  let cancelResult;
  let cancelError: string | null = null;

  // Cancella il pagamento dato che la canzone viene skippata
  try {
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
  } catch (error) {
    // The authorisation expires on its own at the provider, so a failure here
    // costs the guest nothing, but it must not be swallowed.
    console.error(`Payment cancellation failed for request ${request.id}:`, error);
    cancelError = error instanceof Error ? error.message : 'Payment cancellation failed';
  }

  // Get DJ's eventCode for socket emission
  const dj = await prisma.dJ.findUnique({
    where: { id: req.dj!.djId },
    select: { eventCode: true }
  });
  if (dj) {
    emitQueueUpdated(dj.eventCode);
  }

  res.json({
    message: cancelError
      ? 'Song skipped but the authorisation could not be released'
      : 'Song skipped and payment cancelled - no charge to customer',
    cancelResult,
    cancelError
  });
});