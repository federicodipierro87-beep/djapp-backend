import { Request, Response } from 'express';
import { z } from 'zod';
import { PaymentMethod } from '@prisma/client';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { eventService } from '../services/event.service';
import { canReceiveSatispay } from './satispay.controller';
import { enabledPaymentMethods } from '../config/payments';
import { asyncHandler } from '../utils/asyncHandler';
import prisma from '../utils/database';

const HAS_UTC_OFFSET = /([Zz]|[+-]\d{2}:?\d{2})$/;

/**
 * A timestamp only denotes a moment if it says which zone it is in. Given a bare
 * wall clock, new Date() resolves it against the server's zone - UTC in
 * production - so a DJ's 21:00 would be stored as 21:00 UTC and read back to
 * them as 23:00. Rejecting the ambiguous form is what keeps that from silently
 * coming back.
 */
const toInstant = (value: string, ctx: z.RefinementCtx): Date => {
  const trimmed = value.trim();

  if (!HAS_UTC_OFFSET.test(trimmed)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Timestamp must carry a UTC offset, e.g. 2026-08-10T19:00:00.000Z'
    });
    return z.NEVER;
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Timestamp is not a valid date' });
    return z.NEVER;
  }

  return date;
};

const optionalInstant = z
  .string()
  .optional()
  .transform((str, ctx) => (str ? toInstant(str, ctx) : undefined));

/**
 * An end date is the one timestamp a DJ can take back, so absent and empty have
 * to mean different things: a PATCH that simply omits the field must leave it
 * alone, while an explicit null or blank is a request to clear it. Prisma skips
 * undefined, so only the null actually reaches the column.
 */
const clearableInstant = z
  .string()
  .nullish()
  .transform((value, ctx) => {
    if (value === undefined) return undefined;
    return value ? toInstant(value, ctx) : null;
  });

export const createEventSchema = z.object({
  name: z.string().trim().min(1, 'Event name is required').max(120),
  description: z.string().trim().max(1000).optional(),
  address: z.string().trim().min(1, 'Address is required').max(250),
  dateTime: z.string().transform(toInstant),
  endDateTime: clearableInstant
});

export const updateEventSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  address: z.string().trim().min(1).max(250).optional(),
  dateTime: optionalInstant,
  endDateTime: clearableInstant
});

const nearbyQuerySchema = z.object({
  lat: z.string().transform(str => parseFloat(str)),
  lng: z.string().transform(str => parseFloat(str)),
  radius: z.string().optional().transform(str => str ? parseFloat(str) : 10),
  status: z.enum(['ACTIVE', 'SCHEDULED']).optional().default('ACTIVE')
});

export const createEvent = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = createEventSchema.parse(req.body);
    const djId = req.dj!.djId;

    const event = await eventService.createEvent({
      djId,
      name: data.name,
      description: data.description,
      address: data.address,
      dateTime: data.dateTime,
      endDateTime: data.endDateTime
    });

    res.status(201).json(event);
  } catch (error: any) {
    if (error.message === 'Address not found') {
      return res.status(400).json({ error: 'Could not find the specified address. Please check and try again.' });
    }
    if (error.message === 'Geocoding service unavailable') {
      return res.status(503).json({ error: 'Geocoding service temporarily unavailable. Please try again later.' });
    }
    throw error;
  }
});

export const getMyEvents = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const djId = req.dj!.djId;
  const events = await eventService.getEventsByDj(djId);
  res.json(events);
});

export const getNearbyEvents = asyncHandler(async (req: Request, res: Response) => {
  const query = nearbyQuerySchema.parse(req.query);

  if (isNaN(query.lat) || isNaN(query.lng)) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  if (query.radius < 1 || query.radius > 500) {
    return res.status(400).json({ error: 'Radius must be between 1 and 500 km' });
  }

  const events = await eventService.getNearbyEvents(
    query.lat,
    query.lng,
    query.radius,
    query.status
  );

  res.json(events);
});

export const getEventByCode = asyncHandler(async (req: Request, res: Response) => {
  const { eventCode } = req.params;
  const event = await eventService.getEventByCode(eventCode);

  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }

  res.json(event);
});

// Everything a guest needs before filing a request, for both the new Event
// codes and the legacy per-DJ codes. Deliberately narrow: it is unauthenticated
// and reachable by anyone holding a code.
export const getPublicEventInfo = asyncHandler(async (req: Request, res: Response) => {
  const { eventCode } = req.params;

  const event = await eventService.getEventByCode(eventCode);

  if (event) {
    return res.json({
      eventCode: event.eventCode,
      eventName: event.name,
      djName: event.dj.name,
      minDonation: event.dj.minDonation.toNumber(),
      paymentMethods: availableMethods(event.dj),
      isAcceptingRequests: event.status === 'ACTIVE'
    });
  }

  const dj = await prisma.dJ.findUnique({
    where: { eventCode },
    select: {
      name: true,
      eventCode: true,
      minDonation: true,
      satispayKeyId: true,
      satispayPrivateKey: true
    }
  });

  if (!dj) {
    return res.status(404).json({ error: 'Event not found' });
  }

  res.json({
    eventCode: dj.eventCode,
    eventName: null,
    djName: dj.name,
    minDonation: dj.minDonation.toNumber(),
    paymentMethods: availableMethods(dj),
    isAcceptingRequests: true
  });
});

// What this DJ's guests may actually pay with. The platform switch decides
// which integrations are live at all; Satispay narrows that further, because it
// runs on the DJ's own account and not every DJ has connected one.
function availableMethods(dj: {
  satispayKeyId: string | null;
  satispayPrivateKey: string | null;
}): PaymentMethod[] {
  return enabledPaymentMethods.filter(
    (method) => method !== PaymentMethod.SATISPAY || canReceiveSatispay(dj)
  );
}

export const updateEvent = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const djId = req.dj!.djId;
    const data = updateEventSchema.parse(req.body);

    const event = await eventService.updateEvent(id, djId, data);
    res.json(event);
  } catch (error: any) {
    if (error.message === 'Event not found') {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (error.message === 'Not authorized to update this event') {
      return res.status(403).json({ error: 'Not authorized to update this event' });
    }
    if (error.message === 'Cannot update ended or cancelled event') {
      return res.status(400).json({ error: 'Cannot update ended or cancelled event' });
    }
    if (error.message === 'Address not found') {
      return res.status(400).json({ error: 'Could not find the specified address' });
    }
    throw error;
  }
});

export const activateEvent = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const djId = req.dj!.djId;

    const event = await eventService.activateEvent(id, djId);
    res.json(event);
  } catch (error: any) {
    if (error.message === 'Event not found') {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (error.message === 'Not authorized to activate this event') {
      return res.status(403).json({ error: 'Not authorized to activate this event' });
    }
    if (error.message === 'Only scheduled events can be activated') {
      return res.status(400).json({ error: 'Only scheduled events can be activated' });
    }
    throw error;
  }
});

export const endEvent = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const djId = req.dj!.djId;

    const event = await eventService.endEvent(id, djId);
    res.json(event);
  } catch (error: any) {
    if (error.message === 'Event not found') {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (error.message === 'Not authorized to end this event') {
      return res.status(403).json({ error: 'Not authorized to end this event' });
    }
    if (error.message === 'Only active events can be ended') {
      return res.status(400).json({ error: 'Only active events can be ended' });
    }
    throw error;
  }
});

export const cancelEvent = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const djId = req.dj!.djId;

    const event = await eventService.cancelEvent(id, djId);
    res.json(event);
  } catch (error: any) {
    if (error.message === 'Event not found') {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (error.message === 'Not authorized to cancel this event') {
      return res.status(403).json({ error: 'Not authorized to cancel this event' });
    }
    if (error.message === 'Cannot cancel ended event') {
      return res.status(400).json({ error: 'Cannot cancel ended event' });
    }
    throw error;
  }
});

export const deleteEvent = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const djId = req.dj!.djId;

    await eventService.deleteEvent(id, djId);
    res.json({ message: 'Event deleted successfully' });
  } catch (error: any) {
    if (error.message === 'Event not found') {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (error.message === 'Not authorized to delete this event') {
      return res.status(403).json({ error: 'Not authorized to delete this event' });
    }
    if (error.message === 'Cannot delete event with existing requests') {
      return res.status(400).json({ error: 'Cannot delete event with existing requests' });
    }
    throw error;
  }
});
