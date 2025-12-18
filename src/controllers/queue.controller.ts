import { Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/database';
import { AuthenticatedRequest } from '../middlewares/auth.middleware';

const reorderSchema = z.object({
  queueItemIds: z.array(z.string())
});

export const getPublicQueue = async (req: Request, res: Response) => {
  try {
    const { eventCode } = req.params;

    const dj = await prisma.dJ.findUnique({
      where: { eventCode }
    });

    if (!dj) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const queueItems = await prisma.queueItem.findMany({
      where: { djId: dj.id },
      include: {
        request: {
          select: {
            songTitle: true,
            artistName: true,
            requesterName: true
          }
        }
      },
      orderBy: { position: 'asc' }
    });

    const publicQueue = queueItems.map((item, index) => ({
      id: item.id,
      position: item.position,
      songTitle: item.request.songTitle,
      artistName: item.request.artistName,
      requesterName: item.request.requesterName,
      status: item.status,
      addedAt: item.addedAt,
      playedAt: item.playedAt,
      isNowPlaying: item.status === 'NOW_PLAYING'
    }));

    res.json(publicQueue);
  } catch (error) {
    throw error;
  }
};

export const getDJQueue = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const queueItems = await prisma.queueItem.findMany({
      where: { djId: req.dj!.djId },
      include: {
        request: {
          select: {
            songTitle: true,
            artistName: true,
            requesterName: true,
            requesterEmail: true,
            donationAmount: true,
            paymentMethod: true
          }
        }
      },
      orderBy: { position: 'asc' }
    });

    const djQueue = queueItems.map(item => ({
      id: item.id,
      position: item.position,
      songTitle: item.request.songTitle,
      artistName: item.request.artistName,
      requesterName: item.request.requesterName,
      requesterEmail: item.request.requesterEmail,
      donationAmount: item.request.donationAmount,
      paymentMethod: item.request.paymentMethod,
      status: item.status,
      addedAt: item.addedAt,
      playedAt: item.playedAt,
      isNowPlaying: item.status === 'NOW_PLAYING'
    }));

    // Calcola guadagni solo dalle canzoni PLAYED, non quelle SKIPPED
    const totalEarnings = queueItems.reduce((total, item) => {
      if (item.status === 'PLAYED') {
        return total + item.request.donationAmount.toNumber();
      }
      return total;
    }, 0);

    res.json({
      queue: djQueue,
      totalEarnings
    });
  } catch (error) {
    throw error;
  }
};

export const reorderQueue = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { queueItemIds } = reorderSchema.parse(req.body);

    const updatePromises = queueItemIds.map((id, index) => 
      prisma.queueItem.update({
        where: { 
          id,
          djId: req.dj!.djId
        },
        data: { position: index + 1 }
      })
    );

    await Promise.all(updatePromises);

    res.json({ message: 'Queue reordered successfully' });
  } catch (error) {
    throw error;
  }
};

export const setNowPlaying = async (req: AuthenticatedRequest, res: Response) => {
  try {
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

    res.json({ message: 'Song set as now playing' });
  } catch (error) {
    throw error;
  }
};

export const markAsPlayed = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    await prisma.queueItem.update({
      where: { 
        id,
        djId: req.dj!.djId
      },
      data: { 
        status: 'PLAYED',
        playedAt: new Date()
      }
    });

    res.json({ message: 'Song marked as played' });
  } catch (error) {
    throw error;
  }
};

export const skipSong = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;

    await prisma.queueItem.update({
      where: { 
        id,
        djId: req.dj!.djId
      },
      data: { 
        status: 'SKIPPED'
      }
    });

    res.json({ message: 'Song skipped' });
  } catch (error) {
    throw error;
  }
};