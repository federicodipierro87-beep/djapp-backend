import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, QueueStatus } from '@prisma/client';
import prisma from '../utils/database';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { stripeService } from '../services/stripe.service';
import { paypalService } from '../services/paypal.service';
import { satispayCredentialsFor, satispayService } from '../services/satispay.service';
import {
  recordReleaseOutcome,
  releaseAuthorization
} from '../services/paymentRelease.service';
import { toCents } from '../services/requestPayment.service';
import { emitQueueUpdated, emitNowPlayingChanged } from '../socket/socket';
import { broadcastCode } from '../socket/broadcastCode';
import { asyncHandler } from '../utils/asyncHandler';

const reorderSchema = z.object({
  queueItemIds: z.array(z.string().uuid()).max(500)
});

const LIVE_STATUSES = [QueueStatus.WAITING, QueueStatus.NOW_PLAYING];
const DONE_STATUSES = [QueueStatus.PLAYED, QueueStatus.SKIPPED];

// Both screens only ever show a short tail of what has already been played - five
// songs in public, ten in the panel - but the endpoints used to return every
// song of the night, and for a DJ on the Event system every song of every night
// they had ever played. Twenty leaves room for the display without the payload
// growing all evening.
// The completed tail is returned oldest-first so that the clients' `slice(-n)`
// still picks the newest ones. It is ordered by when the song entered the queue
// because a skipped song never gets a playedAt, so that column cannot order it.
const RECENT_DONE_LIMIT = 20;

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

  const songSelection = {
    request: {
      select: {
        songTitle: true,
        artistName: true,
        albumCover: true,
        requesterName: true
      }
    }
  };

  const [live, done] = await Promise.all([
    prisma.queueItem.findMany({
      where: { ...whereClause, status: { in: LIVE_STATUSES } },
      include: songSelection,
      orderBy: { position: 'asc' }
    }),
    prisma.queueItem.findMany({
      where: { ...whereClause, status: { in: DONE_STATUSES } },
      include: songSelection,
      orderBy: { addedAt: 'desc' },
      take: RECENT_DONE_LIMIT
    })
  ]);

  const queueItems = [...live, ...done.reverse()];

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
  const djId = req.dj!.djId;

  // Scoping by djId alone was only ever right because the legacy "end event"
  // button deletes the queue. Ending an Event does not, so a DJ on the new
  // system was shown - and credited with - every song of every night they had
  // ever played. While an event is running, that event is the night.
  const activeEvent = await prisma.event.findFirst({
    where: { djId, status: 'ACTIVE' },
    orderBy: { dateTime: 'desc' },
    select: { id: true }
  });

  const scope: Prisma.QueueItemWhereInput = activeEvent ? { eventId: activeEvent.id } : { djId };

  const songSelection = {
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
  };

  const [live, done, played] = await Promise.all([
    prisma.queueItem.findMany({
      where: { ...scope, status: { in: LIVE_STATUSES } },
      include: songSelection,
      orderBy: { position: 'asc' }
    }),
    prisma.queueItem.findMany({
      where: { ...scope, status: { in: DONE_STATUSES } },
      include: songSelection,
      orderBy: { addedAt: 'desc' },
      take: RECENT_DONE_LIMIT
    }),
    // Summed by the database over every played song, not over the page above:
    // the total has to stay right even though the list is now truncated.
    prisma.request.aggregate({
      where: { queueItem: { is: { ...scope, status: QueueStatus.PLAYED } } },
      _sum: { donationAmount: true }
    })
  ]);

  const queueItems = [...live, ...done.reverse()];

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

  // Solo le canzoni PLAYED, non quelle SKIPPED: uno skip non viene addebitato.
  const totalEarnings = played._sum.donationAmount?.toNumber() ?? 0;

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

  // Every reordered item belongs to the same queue, so any one of them names
  // the room to refresh.
  const moved = queueItemIds[0]
    ? await prisma.queueItem.findUnique({
        where: { id: queueItemIds[0] },
        select: {
          dj: { select: { eventCode: true } },
          event: { select: { eventCode: true } }
        }
      })
    : null;

  const code = moved && broadcastCode(moved);
  if (code) {
    emitQueueUpdated(code);
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
      dj: { select: { eventCode: true } },
      event: { select: { eventCode: true } }
    }
  });

  const code = queueItem && broadcastCode(queueItem);
  if (queueItem && code) {
    emitNowPlayingChanged(code, {
      songTitle: queueItem.request.songTitle,
      artistName: queueItem.request.artistName
    });
    emitQueueUpdated(code);
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
      request: true,
      // The Satispay credentials are the DJ's own; capturing or releasing a
      // fund lock is impossible without them.
      dj: { select: { eventCode: true, satispayKeyId: true, satispayPrivateKey: true } },
      event: { select: { eventCode: true } }
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
          captureResult = await paypalService.captureOrder(request.paymentIntentId);
        }
        break;

      case 'SATISPAY': {
        const credentials = satispayCredentialsFor(queueItem.dj);
        if (request.paymentIntentId && credentials) {
          // Satispay needs telling how much of the hold to take. It is the
          // whole donation, but leaving it out is a 400 rather than a default.
          captureResult = await satispayService.acceptPayment(
            credentials,
            request.paymentIntentId,
            toCents(request.donationAmount.toNumber())
          );
        }
        break;
      }
    }
  } catch (error) {
    // The song really was played, so the queue state stays PLAYED. Surface the
    // failure instead of letting an uncollected donation disappear silently.
    console.error(`Payment capture failed for request ${request.id}:`, error);
    captureError = error instanceof Error ? error.message : 'Payment capture failed';
  }

  await prisma.request.update({
    where: { id: request.id },
    data: captureError
      ? { paymentStatus: 'FAILED' }
      : { paymentStatus: 'CAPTURED', capturedAt: new Date() }
  });

  const code = broadcastCode(queueItem);
  if (code) {
    emitQueueUpdated(code);
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
      request: true,
      // The Satispay credentials are the DJ's own; capturing or releasing a
      // fund lock is impossible without them.
      dj: { select: { eventCode: true, satispayKeyId: true, satispayPrivateKey: true } },
      event: { select: { eventCode: true } }
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

  // The song is skipped either way; the money is a separate question. A failure
  // here leaves the row AUTHORIZED for the reconciliation sweep to retry, and is
  // surfaced rather than swallowed.
  const outcome = await releaseAuthorization({ ...request, dj: queueItem.dj });
  await recordReleaseOutcome(request.id, outcome);

  const cancelError = outcome.released ? null : outcome.detail;
  if (cancelError) {
    console.error(`Payment cancellation failed for request ${request.id}: ${cancelError}`);
  }

  const code = broadcastCode(queueItem);
  if (code) {
    emitQueueUpdated(code);
  }

  res.json({
    message: cancelError
      ? 'Song skipped but the authorisation could not be released'
      : 'Song skipped and payment cancelled - no charge to customer',
    cancelError
  });
});