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

const router = express.Router();

router.get('/:eventCode', getPublicQueue);

router.get('/dj/all', authMiddleware, getDJQueue);
router.patch('/dj/reorder', authMiddleware, reorderQueue);
router.patch('/dj/:id/now-playing', authMiddleware, setNowPlaying);
router.patch('/dj/:id/played', authMiddleware, markAsPlayed);
router.patch('/dj/:id/skip', authMiddleware, skipSong);

export default router;