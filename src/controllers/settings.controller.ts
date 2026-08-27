import { Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import prisma from '../utils/database';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';

const updateSettingsSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().min(1).max(60).optional(),
  address: z.string().trim().min(1).max(250).optional(),
  minDonation: z.number().min(0.01).max(1000).optional(),
  stripeAccountId: z.string().trim().max(255).optional(),
  paypalEmail: z.string().trim().email().max(254).optional(),
  satispayId: z.string().trim().max(255).optional()
});

const generateEventCode = (): string => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

export const getSettings = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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
      firstName: dj.firstName,
      lastName: dj.lastName,
      address: dj.address,
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
});

export const updateSettings = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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
        firstName: updatedDj.firstName,
        lastName: updatedDj.lastName,
        address: updatedDj.address,
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
});

const createEventSummary = async (djId: string, eventCode: string) => {
  // Trova l'ultimo evento per determinare quando è iniziato quello corrente
  const lastEventSummary = await prisma.eventSummary.findFirst({
    where: { djId },
    orderBy: { endedAt: 'desc' }
  });

  // La data di inizio dell'evento corrente è quando è finito l'ultimo evento, 
  // oppure quando è stata fatta la prima richiesta se non ci sono eventi precedenti
  let eventStartTime: Date;
  if (lastEventSummary) {
    eventStartTime = lastEventSummary.endedAt;
  } else {
    // Se è il primo evento, trova la prima richiesta mai fatta
    const firstRequest = await prisma.request.findFirst({
      where: { djId },
      orderBy: { createdAt: 'asc' }
    });
    eventStartTime = firstRequest?.createdAt || new Date();
  }

  const [
    totalRequests,
    acceptedRequests,
    rejectedRequests,
    expiredRequests,
    closedRequests,
    queueStats
  ] = await Promise.all([
    prisma.request.count({
      where: {
        djId,
        // Drafts abandoned mid-payment were never requests as far as the night
        // is concerned, and counting them makes the totals stop adding up.
        status: { not: 'AWAITING_PAYMENT' },
        createdAt: { gte: eventStartTime }
      }
    }),
    prisma.request.count({
      where: { 
        djId, 
        status: 'ACCEPTED',
        createdAt: { gte: eventStartTime }
      }
    }),
    prisma.request.count({
      where: { 
        djId, 
        status: 'REJECTED',
        createdAt: { gte: eventStartTime }
      }
    }),
    prisma.request.count({
      where: { 
        djId, 
        status: 'EXPIRED',
        createdAt: { gte: eventStartTime }
      }
    }),
    prisma.request.count({
      where: { 
        djId, 
        status: 'CLOSED',
        createdAt: { gte: eventStartTime }
      }
    }),
    prisma.queueItem.findMany({
      where: { djId },
      include: { 
        request: true
      }
    })
  ]);

  // Filtra solo i queueItems che hanno richieste dell'evento corrente
  const currentEventQueueStats = queueStats.filter(item => item.request && item.request.createdAt >= eventStartTime);
  
  const playedSongs = currentEventQueueStats.filter(item => item.status === 'PLAYED').length;
  const skippedSongs = currentEventQueueStats.filter(item => item.status === 'SKIPPED').length;
  const totalEarnings = currentEventQueueStats
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
      closedRequests,
      playedSongs,
      skippedSongs,
      totalEarnings,
      startedAt: eventStartTime
    }
  });
};

export const endCurrentEvent = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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
        data: { status: 'CLOSED' }
      })
    ]);

    res.json({
      message: 'Event ended successfully',
      summary: eventSummary
    });
  } catch (error) {
    throw error;
  }
});

export const generateNewEventCode = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
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
        data: { status: 'CLOSED' }
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
});

export const getEventSummaries = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const summaries = await prisma.eventSummary.findMany({
      where: { djId: req.dj!.djId },
      orderBy: { endedAt: 'desc' }
    });

    res.json(summaries);
  } catch (error) {
    throw error;
  }
});

export const deleteEventSummary = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    const eventSummary = await prisma.eventSummary.findUnique({
      where: { id }
    });

    if (!eventSummary || eventSummary.djId !== req.dj!.djId) {
      return res.status(404).json({ error: 'Event summary not found' });
    }

    await prisma.eventSummary.delete({
      where: { id }
    });

    res.json({ message: 'Event summary deleted successfully' });
  } catch (error) {
    throw error;
  }
});

export const getEventStats = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Trova l'ultimo evento terminato per filtrare solo le statistiche dell'evento corrente
    const lastEventSummary = await prisma.eventSummary.findFirst({
      where: { djId: req.dj!.djId },
      orderBy: { endedAt: 'desc' }
    });

    // Se c'è un evento terminato, filtra solo le richieste successive
    const eventStartTime = lastEventSummary ? lastEventSummary.endedAt : new Date(0);

    const [
      totalRequests,
      pendingRequests,
      acceptedRequests,
      queueLength,
      totalEarnings
    ] = await Promise.all([
      prisma.request.count({
        where: {
          djId: req.dj!.djId,
          status: { not: 'AWAITING_PAYMENT' },
          createdAt: { gt: eventStartTime }
        }
      }),
      prisma.request.count({
        where: { 
          djId: req.dj!.djId,
          status: 'PENDING',
          createdAt: { gt: eventStartTime }
        }
      }),
      prisma.request.count({
        where: { 
          djId: req.dj!.djId,
          status: 'ACCEPTED',
          createdAt: { gt: eventStartTime }
        }
      }),
      prisma.queueItem.count({
        where: { djId: req.dj!.djId }
      }),
      // Calcola i guadagni solo dalle canzoni PLAYED dell'evento corrente
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

    // Calcola i guadagni sommando le donazioni delle canzoni PLAYED dell'evento corrente
    const calculatedEarnings = totalEarnings.reduce((sum, queueItem) => {
      // Solo le richieste create dopo l'ultimo evento terminato
      if (queueItem.request.createdAt > eventStartTime) {
        return sum + queueItem.request.donationAmount.toNumber();
      }
      return sum;
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
});

const changePasswordSchema = z.object({
  // Matches the register schema: bcrypt ignores anything past 72 bytes.
  currentPassword: z.string().max(72),
  newPassword: z.string().min(6).max(72)
});

export const changePassword = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);

    const dj = await prisma.dJ.findUnique({
      where: { id: req.dj!.djId }
    });

    if (!dj) {
      return res.status(404).json({ error: 'DJ not found' });
    }

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, dj.password);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ error: 'Password attuale non corretta' });
    }

    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, 12);

    // Update password
    await prisma.dJ.update({
      where: { id: req.dj!.djId },
      data: { password: hashedNewPassword }
    });

    res.json({ message: 'Password aggiornata con successo' });
  } catch (error) {
    throw error;
  }
});

export const generateQRCode = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  try {
    const dj = await prisma.dJ.findUnique({
      where: { id: req.dj!.djId }
    });

    if (!dj) {
      return res.status(404).json({ error: 'DJ not found' });
    }

    const eventUrl = `${process.env.FRONTEND_URL}/event/${dj.eventCode}`;
    
    const qrCodeDataUrl = await QRCode.toDataURL(eventUrl, {
      width: 400,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    res.json({
      qrCode: qrCodeDataUrl,
      eventCode: dj.eventCode,
      eventUrl
    });
  } catch (error) {
    throw error;
  }
});