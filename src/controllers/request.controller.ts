import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../utils/database';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { stripeService } from '../services/stripe.service';
import { paypalService } from '../services/paypal.service';
import { satispayService } from '../services/satispay.service';
import { expirationService } from '../services/expiration.service';
import { emitNewRequest, emitRequestAccepted, emitRequestRejected, emitQueueUpdated } from '../socket/socket';
import { asyncHandler } from '../utils/asyncHandler';

export const createRequestSchema = z.object({
  eventCode: z.string().trim().min(1).max(20),
  songTitle: z.string().trim().min(1).max(200),
  artistName: z.string().trim().min(1).max(200),
  spotifyTrackId: z.string().regex(/^[A-Za-z0-9]{22}$/).optional(),
  albumCover: z.string().url().startsWith('https://i.scdn.co/').max(300).optional(),
  requesterName: z.string().trim().min(1).max(60),
  requesterEmail: z.string().trim().email().max(254).optional(),
  // The cap is enforced here too: the browser check can be bypassed and this
  // amount is what gets authorised on the payment provider.
  donationAmount: z.number().min(0.01).max(1000),
  paymentMethod: z.enum(['CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'PAYPAL', 'SATISPAY'])
});

export const createRequest = asyncHandler(async (req: Request, res: Response) => {
  const data = createRequestSchema.parse(req.body);

  let djId: string;
  // Never taken from the body: a guest who knows one event code could otherwise
  // file the request against a different event belonging to another DJ.
  let eventId: string | null = null;
  let minDonation: number;

  // First try to find in events table (new system)
  const event = await prisma.event.findUnique({
    where: { eventCode: data.eventCode },
    include: { dj: true }
  });

  if (event) {
    // Found in events table
    if (event.status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Event is not active' });
    }
    djId = event.djId;
    eventId = event.id;
    minDonation = event.dj.minDonation.toNumber();
  } else {
    // Fallback: try to find in djs table (legacy system)
    const dj = await prisma.dJ.findUnique({
      where: { eventCode: data.eventCode }
    });

    if (!dj) {
      return res.status(404).json({ error: 'Event not found' });
    }
    djId = dj.id;
    minDonation = dj.minDonation.toNumber();
  }

  if (data.donationAmount < minDonation) {
    return res.status(400).json({
      error: `Minimum donation is €${minDonation}`,
      minDonation
    });
  }

  // The authorisation is always created here, for the amount the server just
  // validated. A caller cannot hand us an id of a payment we never made.
  let paymentIntentId: string | null = null;
  let clientSecret: string | null = null;

  switch (data.paymentMethod) {
    case 'CARD':
    case 'APPLE_PAY':
    case 'GOOGLE_PAY': {
      const paymentIntent = await stripeService.createPaymentIntent(data.donationAmount);
      paymentIntentId = paymentIntent.id;
      clientSecret = paymentIntent.client_secret;
      break;
    }

    case 'PAYPAL': {
      const order = await paypalService.createOrder(data.donationAmount);
      paymentIntentId = order.id;
      break;
    }

    case 'SATISPAY': {
      const payment = await satispayService.createPayment(data.donationAmount);
      paymentIntentId = payment.id;
      break;
    }
  }

  const request = await prisma.request.create({
    data: {
      songTitle: data.songTitle,
      artistName: data.artistName,
      spotifyTrackId: data.spotifyTrackId,
      albumCover: data.albumCover,
      requesterName: data.requesterName,
      requesterEmail: data.requesterEmail,
      donationAmount: data.donationAmount,
      paymentMethod: data.paymentMethod,
      paymentIntentId,
      djId,
      eventId
    }
  });

  const timeRemaining = await expirationService.getTimeRemaining(request.createdAt);

  // Emit socket event for new request
  emitNewRequest(djId, {
    id: request.id,
    songTitle: request.songTitle,
    artistName: request.artistName,
    albumCover: request.albumCover,
    requesterName: request.requesterName,
    donationAmount: request.donationAmount,
    status: request.status,
    createdAt: request.createdAt
  });

  res.status(201).json({
    id: request.id,
    songTitle: request.songTitle,
    artistName: request.artistName,
    spotifyTrackId: request.spotifyTrackId,
    albumCover: request.albumCover,
    requesterName: request.requesterName,
    donationAmount: request.donationAmount,
    status: request.status,
    paymentIntentId,
    clientSecret,
    timeRemaining,
    expiresAt: expirationService.expiresAt(request.createdAt),
    createdAt: request.createdAt
  });
});

export const getRequestsByEvent = asyncHandler(async (req: Request, res: Response) => {
  const { eventCode } = req.params;

  // First try to find in events table (new system)
  const event = await prisma.event.findUnique({
    where: { eventCode },
    include: { dj: true }
  });

  let whereClause: Prisma.RequestWhereInput;

  if (event) {
    // Found in events table - filter by eventId
    whereClause = { eventId: event.id };
  } else {
    // Fallback: try to find in djs table (legacy system)
    const dj = await prisma.dJ.findUnique({
      where: { eventCode }
    });

    if (!dj) {
      return res.status(404).json({ error: 'Event not found' });
    }
    whereClause = { djId: dj.id };
  }

  const requests = await prisma.request.findMany({
    where: whereClause,
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
        albumCover: request.albumCover,
        requesterName: request.requesterName,
        status: request.status,
        timeRemaining,
        expiresAt: expirationService.expiresAt(request.createdAt),
        createdAt: request.createdAt
      };
    })
  );

  res.json(requestsWithTimeRemaining);
});

export const getDJRequests = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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
        spotifyTrackId: request.spotifyTrackId,
        albumCover: request.albumCover,
        requesterName: request.requesterName,
        requesterEmail: request.requesterEmail,
        donationAmount: request.donationAmount,
        paymentMethod: request.paymentMethod,
        status: request.status,
        timeRemaining,
        expiresAt: expirationService.expiresAt(request.createdAt),
        createdAt: request.createdAt
      };
    })
  );

  res.json(requestsWithTimeRemaining);
});

export const acceptRequest = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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

  // Scoped to this event, not to the DJ's whole history: otherwise every past
  // night keeps inflating the position of tonight's first song. Taking the max
  // rather than a count keeps positions unique even once songs have been played.
  const queueScope: Prisma.QueueItemWhereInput = request.eventId
    ? { eventId: request.eventId }
    : { djId: req.dj!.djId, eventId: null };

  const highestPosition = await prisma.queueItem.aggregate({
    where: queueScope,
    _max: { position: true }
  });

  const nextPosition = (highestPosition._max.position ?? 0) + 1;

  await prisma.$transaction([
    prisma.request.update({
      where: { id },
      data: { status: 'ACCEPTED' }
    }),
    prisma.queueItem.create({
      data: {
        requestId: id,
        djId: req.dj!.djId,
        eventId: request.eventId,
        position: nextPosition
      }
    })
  ]);

  // Emit socket events
  emitRequestAccepted(request.dj.eventCode, {
    id: request.id,
    songTitle: request.songTitle,
    artistName: request.artistName,
    requesterName: request.requesterName
  });
  emitQueueUpdated(request.dj.eventCode);

  res.json({
    message: 'Request accepted and added to queue - payment will be captured when song is played'
  });
});

export const rejectRequest = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  const request = await prisma.request.findUnique({
    where: { id },
    include: { dj: true }
  });

  if (!request || request.djId !== req.dj!.djId) {
    return res.status(404).json({ error: 'Request not found' });
  }

  // Claim the row before releasing the authorisation, so a rejection racing the
  // expiry cron or a second click cannot void the same payment twice.
  const claimed = await prisma.request.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'REJECTED' }
  });

  if (claimed.count !== 1) {
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

  // Emit socket event for rejected request
  emitRequestRejected(request.dj.eventCode, request.id);

  res.json({ message: 'Request rejected' });
});