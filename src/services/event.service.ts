import { EventStatus } from '@prisma/client';
// The shared client, not a second `new PrismaClient()`. Two pools in one process
// is the small problem; the large one is that a test mocking the shared module
// never reached this service at all.
import prisma from '../utils/database';
import { closeOutstandingRequests, releaseInBackground } from './paymentRelease.service';

interface GeocodingResult {
  lat: string;
  lon: string;
  display_name: string;
}

interface CreateEventData {
  djId: string;
  name: string;
  description?: string;
  address: string;
  dateTime: Date;
  endDateTime?: Date | null;
  /** Undefined leaves the column null, which reads as "inherit from the DJ". */
  minDonation?: number;
}

interface UpdateEventData {
  name?: string;
  description?: string;
  address?: string;
  dateTime?: Date;
  /** null clears the stored end date; undefined leaves it untouched. */
  endDateTime?: Date | null;
  minDonation?: number;
}

// Money, so two decimals. A slider that hands back 5.000000000000001 must not
// become a minimum no round donation can ever match.
const toMoney = (value: number | undefined) =>
  value === undefined ? undefined : Math.round(value * 100) / 100;

function generateEventCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

const KM_PER_DEGREE_LATITUDE = 111.32;

// A square that certainly contains the circle. It is what the database can
// filter on with an index; the exact distance is applied to what comes back.
export function boundingBox(lat: number, lng: number, radiusKm: number) {
  const latDelta = radiusKm / KM_PER_DEGREE_LATITUDE;

  // Meridians converge towards the poles. Close enough to one, the box would
  // have to span every longitude anyway, so stop dividing by almost zero.
  const shrink = Math.cos(toRad(lat));
  const lngDelta = shrink > 0.01 ? radiusKm / (KM_PER_DEGREE_LATITUDE * shrink) : 180;

  return {
    latMin: lat - latDelta,
    latMax: lat + latDelta,
    lngMin: lng - lngDelta,
    lngMax: lng + lngDelta,
    // Around the antimeridian the box is two ranges, not one. Rare enough that
    // dropping the longitude bound and letting the distance check do the work
    // beats getting the split wrong.
    lngWraps: lngDelta >= 180 || lng - lngDelta < -180 || lng + lngDelta > 180
  };
}

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

export class EventService {
  async geocodeAddress(address: string): Promise<{ latitude: number; longitude: number; city: string }> {
    const encodedAddress = encodeURIComponent(address);
    const url = `https://nominatim.openstreetmap.org/search?q=${encodedAddress}&format=json&limit=1&addressdetails=1`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'DJ-Request-App/1.0'
      }
    });

    if (!response.ok) {
      throw new Error('Geocoding service unavailable');
    }

    const results = await response.json() as GeocodingResult[];

    if (results.length === 0) {
      throw new Error('Address not found');
    }

    const result = results[0];
    const displayParts = result.display_name.split(', ');
    const city = displayParts.length > 2 ? displayParts[displayParts.length - 4] || displayParts[1] : displayParts[0];

    return {
      latitude: parseFloat(result.lat),
      longitude: parseFloat(result.lon),
      city
    };
  }

  async createEvent(data: CreateEventData) {
    const { latitude, longitude, city } = await this.geocodeAddress(data.address);

    let eventCode = generateEventCode();
    let attempts = 0;
    while (attempts < 10) {
      const existing = await prisma.event.findUnique({ where: { eventCode } });
      if (!existing) break;
      eventCode = generateEventCode();
      attempts++;
    }

    if (attempts >= 10) {
      throw new Error('Failed to generate unique event code');
    }

    const event = await prisma.event.create({
      data: {
        djId: data.djId,
        name: data.name,
        eventCode,
        description: data.description,
        address: data.address,
        city,
        latitude,
        longitude,
        dateTime: data.dateTime,
        endDateTime: data.endDateTime,
        minDonation: toMoney(data.minDonation),
        status: 'SCHEDULED'
      },
      include: {
        dj: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      }
    });

    return event;
  }

  async getEventsByDj(djId: string) {
    const events = await prisma.event.findMany({
      where: { djId },
      orderBy: { dateTime: 'desc' },
      include: {
        _count: {
          select: {
            requests: true,
            queueItems: true
          }
        }
      }
    });

    return events;
  }

  async getEventByCode(eventCode: string) {
    const event = await prisma.event.findUnique({
      where: { eventCode },
      include: {
        dj: {
          select: {
            id: true,
            name: true,
            minDonation: true,
            // Satispay is offered to a DJ's guests only if that DJ has
            // connected their own business account.
            satispayKeyId: true,
            satispayPrivateKey: true
          }
        }
      }
    });

    return event;
  }

  async getEventById(id: string) {
    const event = await prisma.event.findUnique({
      where: { id },
      include: {
        dj: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    return event;
  }

  async getNearbyEvents(
    lat: number,
    lng: number,
    radiusKm: number = 10,
    status: EventStatus = 'ACTIVE'
  ) {
    const box = boundingBox(lat, lng, radiusKm);

    const events = await prisma.event.findMany({
      where: {
        status,
        dateTime: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
        },
        // Every event in the country used to be loaded and measured in Node to
        // return the handful within a few kilometres.
        latitude: { gte: box.latMin, lte: box.latMax },
        ...(box.lngWraps ? {} : { longitude: { gte: box.lngMin, lte: box.lngMax } })
      },
      include: {
        dj: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    const nearbyEvents = events
      .map(event => {
        const distance = haversineDistance(lat, lng, event.latitude, event.longitude);
        return { ...event, distance };
      })
      .filter(event => event.distance <= radiusKm)
      .sort((a, b) => a.distance - b.distance);

    return nearbyEvents;
  }

  async updateEvent(id: string, djId: string, data: UpdateEventData) {
    const event = await prisma.event.findUnique({ where: { id } });

    if (!event) {
      throw new Error('Event not found');
    }

    if (event.djId !== djId) {
      throw new Error('Not authorized to update this event');
    }

    if (event.status === 'ENDED' || event.status === 'CANCELLED') {
      throw new Error('Cannot update ended or cancelled event');
    }

    let updateData: any = { ...data, minDonation: toMoney(data.minDonation) };

    if (data.address && data.address !== event.address) {
      const { latitude, longitude, city } = await this.geocodeAddress(data.address);
      updateData = { ...updateData, latitude, longitude, city };
    }

    const updated = await prisma.event.update({
      where: { id },
      data: updateData,
      include: {
        dj: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    return updated;
  }

  async activateEvent(id: string, djId: string) {
    const event = await prisma.event.findUnique({ where: { id } });

    if (!event) {
      throw new Error('Event not found');
    }

    if (event.djId !== djId) {
      throw new Error('Not authorized to activate this event');
    }

    if (event.status !== 'SCHEDULED') {
      throw new Error('Only scheduled events can be activated');
    }

    const updated = await prisma.event.update({
      where: { id },
      data: { status: 'ACTIVE' }
    });

    return updated;
  }

  async endEvent(id: string, djId: string) {
    const event = await prisma.event.findUnique({ where: { id } });

    if (!event) {
      throw new Error('Event not found');
    }

    if (event.djId !== djId) {
      throw new Error('Not authorized to end this event');
    }

    if (event.status !== 'ACTIVE') {
      throw new Error('Only active events can be ended');
    }

    // Scoped by eventId and never by djId: a DJ can be running a second event,
    // and ending this one must not close the requests of that one.
    //
    // Before the event row is flipped, so that a failure here leaves the event
    // ACTIVE and the DJ able to try again, rather than ended with the guests'
    // cards still blocked.
    const holds = await closeOutstandingRequests({ eventId: id });

    const updated = await prisma.event.update({
      where: { id },
      data: {
        status: 'ENDED',
        endDateTime: new Date()
      }
    });

    releaseInBackground(holds);

    return updated;
  }

  async cancelEvent(id: string, djId: string) {
    const event = await prisma.event.findUnique({ where: { id } });

    if (!event) {
      throw new Error('Event not found');
    }

    if (event.djId !== djId) {
      throw new Error('Not authorized to cancel this event');
    }

    if (event.status === 'ENDED') {
      throw new Error('Cannot cancel ended event');
    }

    // A SCHEDULED event has no requests yet, so this is an innocuous no-op
    // there; an ACTIVE one being called off owes its guests their money back.
    const holds = await closeOutstandingRequests({ eventId: id });

    const updated = await prisma.event.update({
      where: { id },
      data: { status: 'CANCELLED' }
    });

    releaseInBackground(holds);

    return updated;
  }

  async deleteEvent(id: string, djId: string) {
    const event = await prisma.event.findUnique({ where: { id } });

    if (!event) {
      throw new Error('Event not found');
    }

    if (event.djId !== djId) {
      throw new Error('Not authorized to delete this event');
    }

    const requestCount = await prisma.request.count({
      // An abandoned draft is not a reason to keep an event around.
      where: { eventId: id, status: { not: 'AWAITING_PAYMENT' } }
    });

    if (requestCount > 0) {
      throw new Error('Cannot delete event with existing requests');
    }

    await prisma.event.delete({ where: { id } });

    return { success: true };
  }
}

export const eventService = new EventService();
