import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth.middleware';
import { adminRequired } from '../middlewares/admin.middleware';
import { getPendingDJs, getAllDJs, approveDJ, rejectDJ } from '../controllers/admin.controller';

const router = Router();

// All admin routes require authentication and admin privileges
router.use(authenticateToken);
router.use(adminRequired);

// Get pending DJ registrations
router.get('/djs/pending', getPendingDJs);

// Get all DJs
router.get('/djs', getAllDJs);

// Approve a DJ
router.patch('/djs/:djId/approve', approveDJ);

// Reject a DJ
router.patch('/djs/:djId/reject', rejectDJ);

export default router;