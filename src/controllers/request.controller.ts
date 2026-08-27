import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, RequestStatus } from '@prisma/client';
import prisma from '../utils/database';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { stripeService } from '../services/stripe.service';
import { paypalService } from '../services/paypal.service';
import { satispayService } from '../services/satispay.service';
import { expirationService } from '../services/expiration.service';
import {
  confirmRequestPayment,
  createAuthorization,
  readAuthorization,
  toCents
} from '../services/requestPayment.service';
import {
  CURRENCY,
  isPaymentMethodEnabled,
  providerFor,
  stripeConnectEnabled
} from '../config/payments';
import { emitNewRequest, emitRequestAccepted, emitRequestRejected, emitQueueUpdated } from '../socket/socket';
import { broadcastCode } from '../socket/broadcastCode';
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

// The panel polls this endpoint every few seconds and used to be handed the
// DJ's entire history each time, which only ever gets slower. Callers ask for
// the statuses they render and page backwards from there.
const djRequestsQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((value) => value?.split(',').map((s) => s.trim().toUpperCase()))
    .pipe(z.array(z.nativeEnum(RequestStatus)).nonempty().optional()),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().uuid().optional()
});

// An event code can belong to the Event table or, for older accounts, straight
// to the DJ. Every public entry point has to resolve both.
async function resolveEventCode(eventCode: string) {
  const event = await prisma.event.findUnique({
    where: { eventCode },
    include: { dj: true }
  });

  if (event) {
    return {
      djId: event.djId,
      // Never taken from the body: a guest who knows one event code could
      // otherwise file the request against another DJ's night.
      eventId: event.id as string | null,
      minDonation: event.dj.minDonation.toNumber(),
      isActive: event.status === 'ACTIVE',
      ...stripeDestination(event.dj)
    };
  }

  const dj = await prisma.dJ.findUnique({ where: { eventCode } });
  if (!dj) return null;

  return {
    djId: dj.id,
    eventId: null,
    minDonation: dj.minDonation.toNumber(),
    isActive: true,
    ...stripeDestination(dj)
  };
}

// Having an account is not the same as being allowed to charge with it: Stripe
// only sets chargesEnabled once it has verified the DJ's identity, and a
// transfer to an unverified account is refused.
function stripeDestination(dj: { stripeAccountId: string | null; chargesEnabled: boolean }) {
  return {
    stripeAccountId: dj.stripeAccountId,
    canReceiveStripe: Boolean(dj.stripeAccountId && dj.chargesEnabled)
  };
}

export const createRequest = asyncHandler(async (req: Request, res: Response) => {
  const data = createRequestSchema.parse(req.body);

  // Transition shim. Clients loaded before this deploy pay first and then post
  // the authorisation they made themselves. The id is still not trusted - it is
  // checked against Stripe below - but honouring it keeps those tabs working
  // instead of double-authorising the guest's card. Delete once they are gone.
  const legacyPaymentIntentId =
    typeof req.body?.paymentIntentId === 'string' ? req.body.paymentIntentId : undefined;

  if (!isPaymentMethodEnabled(data.paymentMethod)) {
    return res.status(400).json({ error: 'This payment method is not available' });
  }

  const target = await resolveEventCode(data.eventCode);

  if (!target) {
    return res.status(404).json({ error: 'Event not found' });
  }

  if (!target.isActive) {
    return res.status(400).json({ error: 'Event is not active' });
  }

  if (data.donationAmount < target.minDonation) {
    return res.status(400).json({
      error: `Minimum donation is €${target.minDonation}`,
      minDonation: target.minDonation
    });
  }

  const provider = providerFor(data.paymentMethod);

  // With Connect on, this donation is settled into the DJ's own account, so
  // there has to be one and Stripe has to have cleared it. Saying so plainly
  // beats authorising a card for money that could never be transferred.
  if (provider === 'STRIPE' && stripeConnectEnabled && !target.canReceiveStripe) {
    return res.status(409).json({
      error: 'Questo DJ non ha ancora completato la configurazione dei pagamenti'
    });
  }

  const common = {
    songTitle: data.songTitle,
    artistName: data.artistName,
    spotifyTrackId: data.spotifyTrackId,
    albumCover: data.albumCover,
    requesterName: data.requesterName,
    requesterEmail: data.requesterEmail,
    donationAmount: data.donationAmount,
    paymentMethod: data.paymentMethod,
    paymentProvider: provider,
    djId: target.djId,
    eventId: target.eventId
  };

  // The same reasoning as createStripeIntent: an authorisation the client made
  // for itself has no connected account behind it, so adopting one would put
  // the guest's money on the platform account instead of the DJ's.
  if (legacyPaymentIntentId && !stripeConnectEnabled) {
    return createRequestFromExistingAuthorization(res, common, legacyPaymentIntentId);
  }

  // The request comes first and stays invisible to the DJ until the provider
  // says the money is really on hold.
  const request = await prisma.request.create({
    data: { ...common, status: 'AWAITING_PAYMENT', paymentStatus: 'PENDING' }
  });

  let payment;
  try {
    payment = await createAuthorization(
      provider,
      request.id,
      data.donationAmount,
      stripeConnectEnabled ? target.stripeAccountId : null
    );
  } catch (error) {
    // A request with no way to pay for it is litter: nobody can confirm it and
    // the DJ will never see it.
    await prisma.request.delete({ where: { id: request.id } }).catch(() => undefined);
    throw error;
  }

  await prisma.request.update({
    where: { id: request.id },
    data: { paymentIntentId: payment.paymentIntentId }
  });

  res.status(201).json({
    requestId: request.id,
    status: 'AWAITING_PAYMENT',
    payment: {
      provider: payment.provider,
      clientSecret: payment.clientSecret ?? null,
      approvalUrl: payment.approvalUrl ?? null,
      redirectUrl: payment.redirectUrl ?? null
    },
    expiresAt: expirationService.expiresAt(request.createdAt),
    createdAt: request.createdAt
  });
});

// Transition shim, see createRequest. Verifies with Stripe that the id names a
// real, authorised, correctly priced hold before adopting it.
async function createRequestFromExistingAuthorization(
  res: Response,
  common: Omit<Prisma.RequestUncheckedCreateInput, 'id'>,
  paymentIntentId: string
) {
  if (common.paymentProvider !== 'STRIPE') {
    return res.status(400).json({ error: 'Unsupported payment' });
  }

  const authorization = await readAuthorization('STRIPE', paymentIntentId).catch(() => null);

  if (
    !authorization ||
    !authorization.authorized ||
    authorization.currency.toLowerCase() !== CURRENCY ||
    authorization.amountInCents < toCents(Number(common.donationAmount))
  ) {
    return res.status(400).json({ error: 'The payment has not been authorised' });
  }

  // The unique index on paymentIntentId is what stops one hold from being spent
  // on several songs; a replay lands here.
  const request = await prisma.request
    .create({
      data: {
        ...common,
        paymentIntentId,
        status: 'PENDING',
        paymentStatus: 'AUTHORIZED',
        authorizedAt: new Date()
      }
    })
    .catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return null;
      }
      throw error;
    });

  if (!request) {
    return res.status(409).json({ error: 'This payment has already been used' });
  }

  emitNewRequest(request.djId, {
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
    requestId: request.id,
    songTitle: request.songTitle,
    artistName: request.artistName,
    spotifyTrackId: request.spotifyTrackId,
    albumCover: request.albumCover,
    requesterName: request.requesterName,
    donationAmount: request.donationAmount,
    status: request.status,
    paymentIntentId,
    clientSecret: null,
    timeRemaining: await expirationService.getTimeRemaining(request.createdAt),
    expiresAt: expirationService.expiresAt(request.createdAt),
    createdAt: request.createdAt
  });
}

// Called by the guest once their browser has finished with the provider. The
// server checks the authorisation itself; the body carries nothing we trust.
export const confirmRequest = asyncHandler(async (req: Request, res: Response) => {
  const result = await confirmRequestPayment(req.params.id);

  switch (result.outcome) {
    case 'not_found':
      return res.status(404).json({ error: 'Request not found' });

    case 'no_longer_available':
      return res.status(410).json({ error: 'This request is no longer available' });

    case 'not_authorized':
      return res.status(402).json({ error: result.detail });

    // Confirming twice is normal: the provider webhook races the browser.
    case 'confirmed':
    case 'already_confirmed':
      return res.json({ requestId: req.params.id, status: 'PENDING' });
  }
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
    // A request nobody has paid for yet is not part of the night.
    where: { ...whereClause, status: { not: 'AWAITING_PAYMENT' } },
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
  const { status, limit, cursor } = djRequestsQuerySchema.parse(req.query);

  // Unpaid drafts never reach the DJ's screen, whatever was asked for.
  const statusFilter: Prisma.RequestWhereInput = status
    ? { status: { in: status.filter((s) => s !== RequestStatus.AWAITING_PAYMENT) } }
    : { status: { not: RequestStatus.AWAITING_PAYMENT } };

  const requests = await prisma.request.findMany({
    where: { djId: req.dj!.djId, ...statusFilter },
    // createdAt alone can tie, and a cursor that lands on a tie skips rows.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
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
    include: { dj: true, event: { select: { eventCode: true } } }
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

  // Emit socket events on the code the guests actually scanned.
  const code = broadcastCode(request);
  if (code) {
    emitRequestAccepted(code, {
      id: request.id,
      songTitle: request.songTitle,
      artistName: request.artistName,
      requesterName: request.requesterName
    });
    emitQueueUpdated(code);
  }

  res.json({
    message: 'Request accepted and added to queue - payment will be captured when song is played'
  });
});

export const rejectRequest = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { id } = req.params;

  const request = await prisma.request.findUnique({
    where: { id },
    include: { dj: true, event: { select: { eventCode: true } } }
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

  await prisma.request.update({
    where: { id },
    data: { paymentStatus: 'CANCELED' }
  });

  // Emit socket event for rejected request
  const code = broadcastCode(request);
  if (code) {
    emitRequestRejected(code, request.id);
  }

  res.json({ message: 'Request rejected' });
});