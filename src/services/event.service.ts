import { PrismaClient, EventStatus } from '@prisma/client';

const prisma = new PrismaClient();

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
}

interface UpdateEventData {
  name?: string;
  description?: string;
  address?: string;
  dateTime?: Date;
  /** null clears the stored end date; undefined leaves it untouched. */
  endDateTime?: Date | null;
}

function generateEventCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
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
            minDonation: true
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
    const events = await prisma.event.findMany({
      where: {
        status,
        dateTime: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
        }
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

    let updateData: any = { ...data };

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

    const updated = await prisma.event.update({
      where: { id },
      data: {
        status: 'ENDED',
        endDateTime: new Date()
      }
    });

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

    const updated = await prisma.event.update({
      where: { id },
      data: { status: 'CANCELLED' }
    });

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
      where: { eventId: id }
    });

    if (requestCount > 0) {
      throw new Error('Cannot delete event with existing requests');
    }

    await prisma.event.delete({ where: { id } });

    return { success: true };
  }
}

export const eventService = new EventService();
