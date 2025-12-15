import express from 'express';
import { getSettings, updateSettings, generateNewEventCode, getEventStats } from '../controllers/settings.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = express.Router();

router.get('/settings', authMiddleware, getSettings);
router.patch('/settings', authMiddleware, updateSettings);
router.post('/event/new', authMiddleware, generateNewEventCode);
router.get('/stats', authMiddleware, getEventStats);

export default router;