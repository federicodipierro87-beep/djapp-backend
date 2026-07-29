import { Request, Response } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { eventService } from '../services/event.service';

const createEventSchema = z.object({
  name: z.string().min(1, 'Event name is required'),
  description: z.string().optional(),
  address: z.string().min(1, 'Address is required'),
  dateTime: z.string().transform(str => new Date(str)),
  endDateTime: z.string().optional().transform(str => str ? new Date(str) : undefined)
});

const updateEventSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  address: z.string().min(1).optional(),
  dateTime: z.string().optional().transform(str => str ? new Date(str) : undefined),
  endDateTime: z.string().optional().transform(str => str ? new Date(str) : undefined)
});

const nearbyQuerySchema = z.object({
  lat: z.string().transform(str => parseFloat(str)),
  lng: z.string().transform(str => parseFloat(str)),
  radius: z.string().optional().transform(str => str ? parseFloat(str) : 10),
  status: z.enum(['ACTIVE', 'SCHEDULED']).optional().default('ACTIVE')
});

export const createEvent = async (req: AuthenticatedRequest, res: Response) => {
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
};

export const getMyEvents = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const djId = req.dj!.djId;
    const events = await eventService.getEventsByDj(djId);
    res.json(events);
  } catch (error) {
    throw error;
  }
};

export const getNearbyEvents = async (req: Request, res: Response) => {
  try {
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
  } catch (error) {
    throw error;
  }
};

export const getEventByCode = async (req: Request, res: Response) => {
  try {
    const { eventCode } = req.params;
    const event = await eventService.getEventByCode(eventCode);

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    res.json(event);
  } catch (error) {
    throw error;
  }
};

export const updateEvent = async (req: AuthenticatedRequest, res: Response) => {
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
};

export const activateEvent = async (req: AuthenticatedRequest, res: Response) => {
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
};

export const endEvent = async (req: AuthenticatedRequest, res: Response) => {
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
};

export const cancelEvent = async (req: AuthenticatedRequest, res: Response) => {
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
};

export const deleteEvent = async (req: AuthenticatedRequest, res: Response) => {
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
};
