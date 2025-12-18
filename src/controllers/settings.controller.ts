import { Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/database';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

const updateSettingsSchema = z.object({
  name: z.string().min(2).optional(),
  minDonation: z.number().min(0.01).max(1000).optional(),
  stripeAccountId: z.string().optional(),
  paypalEmail: z.string().email().optional(),
  satispayId: z.string().optional()
});

const generateEventCode = (): string => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

export const getSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const dj = await prisma.dJ.findUnique({
      where: { id: req.dj!.djId }
    });

    if (!dj) {
      return res.status(404).json({ error: 'DJ not found' });
    }

    res.json({
      id: dj.id,
      email: dj.email,
      name: dj.name,
      eventCode: dj.eventCode,
      minDonation: dj.minDonation,
      stripeAccountId: dj.stripeAccountId,
      paypalEmail: dj.paypalEmail,
      satispayId: dj.satispayId,
      createdAt: dj.createdAt,
      updatedAt: dj.updatedAt
    });
  } catch (error) {
    throw error;
  }
};

export const updateSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const updateData = updateSettingsSchema.parse(req.body);

    const updatedDj = await prisma.dJ.update({
      where: { id: req.dj!.djId },
      data: updateData
    });

    res.json({
      message: 'Settings updated successfully',
      dj: {
        id: updatedDj.id,
        email: updatedDj.email,
        name: updatedDj.name,
        eventCode: updatedDj.eventCode,
        minDonation: updatedDj.minDonation,
        stripeAccountId: updatedDj.stripeAccountId,
        paypalEmail: updatedDj.paypalEmail,
        satispayId: updatedDj.satispayId
      }
    });
  } catch (error) {
    throw error;
  }
};

const createEventSummary = async (djId: string, eventCode: string) => {
  const [
    totalRequests,
    acceptedRequests,
    rejectedRequests,
    expiredRequests,
    queueStats,
    djInfo
  ] = await Promise.all([
    prisma.request.count({
      where: { djId }
    }),
    prisma.request.count({
      where: { djId, status: 'ACCEPTED' }
    }),
    prisma.request.count({
      where: { djId, status: 'REJECTED' }
    }),
    prisma.request.count({
      where: { djId, status: 'EXPIRED' }
    }),
    prisma.queueItem.findMany({
      where: { djId },
      include: { request: true }
    }),
    prisma.dJ.findUnique({
      where: { id: djId },
      select: { createdAt: true }
    })
  ]);

  const playedSongs = queueStats.filter(item => item.status === 'PLAYED').length;
  const skippedSongs = queueStats.filter(item => item.status === 'SKIPPED').length;
  const totalEarnings = queueStats
    .filter(item => item.status === 'PLAYED')
    .reduce((sum, item) => sum + item.request.donationAmount.toNumber(), 0);

  return await prisma.eventSummary.create({
    data: {
      djId,
      eventCode,
      totalRequests,
      acceptedRequests,
      rejectedRequests,
      expiredRequests,
      playedSongs,
      skippedSongs,
      totalEarnings,
      startedAt: djInfo?.createdAt || new Date()
    }
  });
};

export const endCurrentEvent = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const dj = await prisma.dJ.findUnique({
      where: { id: req.dj!.djId }
    });

    if (!dj) {
      return res.status(404).json({ error: 'DJ not found' });
    }

    const eventSummary = await createEventSummary(req.dj!.djId, dj.eventCode);

    await prisma.$transaction([
      prisma.queueItem.deleteMany({
        where: { djId: req.dj!.djId }
      }),
      prisma.request.updateMany({
        where: { 
          djId: req.dj!.djId,
          status: 'PENDING'
        },
        data: { status: 'EXPIRED' }
      }),
      prisma.request.updateMany({
        where: { 
          djId: req.dj!.djId,
          status: 'ACCEPTED'
        },
        data: { status: 'EXPIRED' }
      })
    ]);

    res.json({
      message: 'Event ended successfully',
      summary: eventSummary
    });
  } catch (error) {
    throw error;
  }
};

export const generateNewEventCode = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const dj = await prisma.dJ.findUnique({
      where: { id: req.dj!.djId }
    });

    if (!dj) {
      return res.status(404).json({ error: 'DJ not found' });
    }

    const eventSummary = await createEventSummary(req.dj!.djId, dj.eventCode);

    let eventCode: string;
    let isUnique = false;
    
    while (!isUnique) {
      eventCode = generateEventCode();
      const existing = await prisma.dJ.findUnique({
        where: { eventCode }
      });
      if (!existing) isUnique = true;
    }

    const updatedDj = await prisma.dJ.update({
      where: { id: req.dj!.djId },
      data: { eventCode: eventCode! }
    });

    await prisma.$transaction([
      prisma.queueItem.deleteMany({
        where: { djId: req.dj!.djId }
      }),
      prisma.request.updateMany({
        where: { 
          djId: req.dj!.djId,
          status: 'PENDING'
        },
        data: { status: 'EXPIRED' }
      }),
      prisma.request.updateMany({
        where: { 
          djId: req.dj!.djId,
          status: 'ACCEPTED'
        },
        data: { status: 'EXPIRED' }
      })
    ]);

    res.json({
      message: 'New event started successfully',
      eventCode: updatedDj.eventCode,
      eventUrl: `${process.env.FRONTEND_URL}/event/${updatedDj.eventCode}`,
      previousEventSummary: eventSummary
    });
  } catch (error) {
    throw error;
  }
};

export const getEventSummaries = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const summaries = await prisma.eventSummary.findMany({
      where: { djId: req.dj!.djId },
      orderBy: { endedAt: 'desc' }
    });

    res.json(summaries);
  } catch (error) {
    throw error;
  }
};

export const getEventStats = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [
      totalRequests,
      pendingRequests,
      acceptedRequests,
      queueLength,
      totalEarnings
    ] = await Promise.all([
      prisma.request.count({
        where: { djId: req.dj!.djId }
      }),
      prisma.request.count({
        where: { 
          djId: req.dj!.djId,
          status: 'PENDING'
        }
      }),
      prisma.request.count({
        where: { 
          djId: req.dj!.djId,
          status: 'ACCEPTED'
        }
      }),
      prisma.queueItem.count({
        where: { djId: req.dj!.djId }
      }),
      // Calcola i guadagni solo dalle canzoni PLAYED, non quelle SKIPPED
      prisma.queueItem.findMany({
        where: { 
          djId: req.dj!.djId,
          status: 'PLAYED'
        },
        include: {
          request: true
        }
      })
    ]);

    // Calcola i guadagni sommando le donazioni delle canzoni PLAYED
    const calculatedEarnings = totalEarnings.reduce((sum, queueItem) => {
      return sum + queueItem.request.donationAmount.toNumber();
    }, 0);

    res.json({
      totalRequests,
      pendingRequests,
      acceptedRequests,
      rejectedRequests: totalRequests - pendingRequests - acceptedRequests,
      queueLength,
      totalEarnings: calculatedEarnings
    });
  } catch (error) {
    throw error;
  }
};