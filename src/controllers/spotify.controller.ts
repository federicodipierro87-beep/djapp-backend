import { Request, Response } from 'express';
import { z } from 'zod';
import { spotifyService } from '../services/spotify.service';

const searchSchema = z.object({
  q: z.string().min(1, 'Search query is required'),
  limit: z.string().optional().transform(val => val ? parseInt(val, 10) : 10),
  offset: z.string().optional().transform(val => val ? parseInt(val, 10) : 0),
});

export const searchTracks = async (req: Request, res: Response) => {
  try {
    const { q, limit, offset } = searchSchema.parse(req.query);

    const results = await spotifyService.searchTracks(q, limit, offset);

    res.json(results);
  } catch (error: any) {
    if (error.message === 'Failed to authenticate with Spotify') {
      return res.status(503).json({ error: 'Spotify service temporarily unavailable' });
    }
    if (error.message === 'Failed to search Spotify') {
      return res.status(502).json({ error: 'Failed to search Spotify' });
    }
    throw error;
  }
};

export const getTrack = async (req: Request, res: Response) => {
  try {
    const { trackId } = req.params;

    if (!trackId) {
      return res.status(400).json({ error: 'Track ID is required' });
    }

    const track = await spotifyService.getTrack(trackId);

    res.json(track);
  } catch (error: any) {
    if (error.message === 'Failed to get track from Spotify') {
      return res.status(404).json({ error: 'Track not found' });
    }
    throw error;
  }
};
