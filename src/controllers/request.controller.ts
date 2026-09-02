import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, RequestStatus } from '@prisma/client';
import prisma from '../utils/database';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { satispayCredentialsFor } from '../services/satispay.service';
import { expirationService } from '../services/expiration.service';
import {
  recordReleaseOutcome,
  releaseAuthorization
} from '../services/paymentRelease.service';
import {
  confirmRequestPayment,
  createAuthorization,
  ensureAuthorization,
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
  // amount is what gets authorised on the payment provider. Zero is allowed by
  // the schema and refused further down unless the event's minimum is zero too.
  donationAmount: z.number().min(0).max(1000),
  // Only needed when there is something to charge. Sent anyway alongside a zero
  // by every tab loaded before this deploy, so it is ignored rather than
  // refused: a 400 there would break pages nobody can reload for them.
  paymentMethod: z.enum(['CARD', 'APPLE_PAY', 'GOOGLE_PAY', 'PAYPAL', 'SATISPAY']).optional()
}).refine((data) => data.donationAmount === 0 || data.paymentMethod !== undefined, {
  message: 'A payment method is required for a donation',
  path: ['paymentMethod']
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
      // The night's own minimum. It falls back to the DJ's only when the event
      // has none, which is every event created before that column existed.
      minDonation: (event.minDonation ?? event.dj.minDonation).toNumber(),
      isActive: event.status === 'ACTIVE',
      ...payoutDestination(event.dj)
    };
  }

  const dj = await prisma.dJ.findUnique({ where: { eventCode } });
  if (!dj) return null;

  return {
    djId: dj.id,
    eventId: null,
    minDonation: dj.minDonation.toNumber(),
    isActive: true,
    ...payoutDestination(dj)
  };
}

// Where this DJ's donations are meant to land, one field per provider. Having
// an account is not the same as being allowed to charge into it: Stripe only
// sets chargesEnabled once it has verified the DJ's identity, and a transfer to
// an unverified account is refused.
function payoutDestination(dj: {
  stripeAccountId: string | null;
  chargesEnabled: boolean;
  paypalMerchantId: string | null;
  paypalEmail: string | null;
  satispayKeyId: string | null;
  satispayPrivateKey: string | null;
}) {
  // Decrypting can fail if the encryption key has been rotated or is missing.
  // That is a misconfiguration on our side, and it must read as "this DJ cannot
  // take Satispay" rather than taking down every request for them.
  let satispay = null;
  try {
    satispay = satispayCredentialsFor(dj);
  } catch (error) {
    console.error(`Could not read the Satispay credentials of DJ: ${String(error)}`);
  }

  return {
    destination: {
      stripeAccountId: dj.stripeAccountId,
      paypalMerchantId: dj.paypalMerchantId,
      paypalEmail: dj.paypalEmail,
      satispay
    },
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

  // Nothing to charge means nothing to charge it to. A method sent alongside a
  // zero is dropped rather than refused: tabs loaded before this deploy always
  // send one, and rejecting them would break pages nobody can reload for them.
  const paymentMethod = data.donationAmount > 0 ? data.paymentMethod : undefined;

  if (paymentMethod && !isPaymentMethodEnabled(paymentMethod)) {
    return res.status(400).json({ error: 'This payment method is not available' });
  }

  const target = await resolveEventCode(data.eventCode);

  if (!target) {
    return res.status(404).json({ error: 'Event not found' });
  }

  if (!target.isActive) {
    return res.status(400).json({ error: 'Event is not active' });
  }

  // The only gate on a free request: a zero passes here exactly when the DJ set
  // this event's minimum to zero. No second permission is needed.
  if (data.donationAmount < target.minDonation) {
    return res.status(400).json({
      error: `Minimum donation is €${target.minDonation}`,
      minDonation: target.minDonation
    });
  }

  if (!paymentMethod) {
    return createFreeRequest(res, data, target);
  }

  const provider = providerFor(paymentMethod);

  // With Connect on, this donation is settled into the DJ's own account, so
  // there has to be one and Stripe has to have cleared it. Saying so plainly
  // beats authorising a card for money that could never be transferred.
  if (provider === 'STRIPE' && stripeConnectEnabled && !target.canReceiveStripe) {
    return res.status(409).json({
      error: 'Questo DJ non ha ancora completato la configurazione dei pagamenti'
    });
  }

  // Satispay has no platform account to fall back to: a payment is created
  // inside the DJ's own business account or not at all. The public event info
  // leaves the method out for DJs who have not connected one, so reaching here
  // means the guest is working from a stale page.
  if (provider === 'SATISPAY' && !target.destination.satispay) {
    return res.status(409).json({
      error: 'Questo DJ non accetta pagamenti con Satispay'
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
    paymentMethod,
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
    payment = await createAuthorization(provider, request.id, data.donationAmount, {
      ...target.destination,
      // With Connect off the donation still lands on the platform account, as
      // it always has. PayPal has no equivalent switch: an order names a payee
      // or it does not, and a DJ who has told us neither a merchant id nor a
      // PayPal address simply falls back to the platform the same way.
      stripeAccountId: stripeConnectEnabled ? target.destination.stripeAccountId : null
    });
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

/**
 * No provider, no authorisation, no waiting: the request goes straight in front
 * of the DJ.
 *
 * The payment columns say so plainly. NOT_REQUIRED rather than the PENDING
 * default, because PENDING means "a payment is expected and has not arrived" -
 * and the three paths that touch real money (the twelve-hour expiry, the hold
 * reconciliation, closing a night) all find their rows by paymentStatus. A free
 * request has to be invisible to them by construction, not by luck.
 */
async function createFreeRequest(
  res: Response,
  data: z.infer<typeof createRequestSchema>,
  target: { djId: string; eventId: string | null }
) {
  const request = await prisma.request.create({
    data: {
      songTitle: data.songTitle,
      artistName: data.artistName,
      spotifyTrackId: data.spotifyTrackId,
      albumCover: data.albumCover,
      requesterName: data.requesterName,
      requesterEmail: data.requesterEmail,
      donationAmount: 0,
      paymentMethod: null,
      paymentProvider: null,
      paymentIntentId: null,
      djId: target.djId,
      eventId: target.eventId,
      status: 'PENDING',
      paymentStatus: 'NOT_REQUIRED'
    }
  });

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

  return res.status(201).json({
    requestId: request.id,
    status: 'PENDING',
    payment: null,
    expiresAt: expirationService.expiresAt(request.createdAt),
    createdAt: request.createdAt
  });
}

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

  const authorization = await ensureAuthorization('STRIPE', paymentIntentId).catch(() => null);

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

  // The rejection is already recorded, so a provider being down is not the DJ's
  // problem and must not come back as a 500. The row stays AUTHORIZED and the
  // reconciliation sweep retries it.
  const outcome = await releaseAuthorization(request);
  await recordReleaseOutcome(request.id, outcome);

  // Emit socket event for rejected request
  const code = broadcastCode(request);
  if (code) {
    emitRequestRejected(code, request.id);
  }

  res.json({ message: 'Request rejected' });
});