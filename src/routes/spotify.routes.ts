import express from 'express';
import { searchTracks, getTrack } from '../controllers/spotify.controller';

const router = express.Router();

// Public routes - no auth required for song search
router.get('/search', searchTracks);
router.get('/track/:trackId', getTrack);

export default router;
