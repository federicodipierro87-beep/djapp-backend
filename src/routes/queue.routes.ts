import express from 'express';
import {
  getPublicQueue,
  getDJQueue,
  reorderQueue,
  setNowPlaying,
  markAsPlayed,
  skipSong
} from '../controllers/queue.controller';
import { authMiddleware } from '../middlewares/auth.middleware';
import { subscriptionMiddleware } from '../middlewares/subscription.middleware';

const router = express.Router();

router.get('/:eventCode', getPublicQueue);

router.get('/dj/all', authMiddleware, subscriptionMiddleware, getDJQueue);
router.patch('/dj/reorder', authMiddleware, subscriptionMiddleware, reorderQueue);
router.patch('/dj/:id/now-playing', authMiddleware, subscriptionMiddleware, setNowPlaying);
router.patch('/dj/:id/played', authMiddleware, subscriptionMiddleware, markAsPlayed);
router.patch('/dj/:id/skip', authMiddleware, subscriptionMiddleware, skipSong);

export default router;