import express from 'express';
import { createRequest, getRequestsByEvent, getDJRequests, acceptRequest, rejectRequest } from '../controllers/request.controller';
import { authMiddleware } from '../middlewares/auth.middleware';

const router = express.Router();

router.post('/', createRequest);
router.get('/:eventCode', getRequestsByEvent);

router.get('/dj/all', authMiddleware, getDJRequests);
router.patch('/dj/:id/accept', authMiddleware, acceptRequest);
router.patch('/dj/:id/reject', authMiddleware, rejectRequest);

export default router;