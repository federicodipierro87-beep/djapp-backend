import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import {
  spotifyService,
  SpotifyNotFoundError,
  SpotifyRateLimitError,
  SpotifyUnavailableError,
} from '../services/spotify.service';

const searchSchema = z.object({
  q: z.string().trim().min(1, 'Search query is required').max(200),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).max(1000).default(0),
});

const trackIdSchema = z.string().regex(/^[A-Za-z0-9]{22}$/, 'Invalid Spotify track ID');

const handleSpotifyError = (error: unknown, res: Response, next: NextFunction) => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ error: 'Invalid parameters', details: error.issues });
  }
  if (error instanceof SpotifyRateLimitError) {
    return res.status(429).json({ error: 'Too many searches, please slow down' });
  }
  if (error instanceof SpotifyNotFoundError) {
    return res.status(404).json({ error: 'Track not found' });
  }
  if (error instanceof SpotifyUnavailableError) {
    return res.status(503).json({ error: 'Spotify service temporarily unavailable' });
  }
  return next(error);
};

export const searchTracks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, limit, offset } = searchSchema.parse(req.query);

    const results = await spotifyService.searchTracks(q, limit, offset);

    res.json(results);
  } catch (error) {
    handleSpotifyError(error, res, next);
  }
};

export const getTrack = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const trackId = trackIdSchema.parse(req.params.trackId);

    const track = await spotifyService.getTrack(trackId);

    res.json(track);
  } catch (error) {
    handleSpotifyError(error, res, next);
  }
};
