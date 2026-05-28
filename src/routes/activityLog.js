const express = require('express');
const ActivityLog = require('../models/ActivityLog');
const { authenticate, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/activity-log  — admins see all, others see own
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 50, entityType, action, userId } = req.query;
    const isAdmin = req.user.role === 'admin';

    const filter = {};
    if (!isAdmin) filter.user = req.user._id;
    if (isAdmin && userId) filter.user = userId;
    if (entityType) filter.entityType = entityType;
    if (action) filter.action = { $regex: action, $options: 'i' };

    const skip = (Number(page) - 1) * Number(limit);
    const [logs, total] = await Promise.all([
      ActivityLog.find(filter)
        .populate('user', 'fullName email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      ActivityLog.countDocuments(filter),
    ]);

    res.json({ logs, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/activity-log  — admin only, clear old logs
router.delete('/', authorize('admin'), async (req, res, next) => {
  try {
    const { olderThanDays = 90 } = req.query;
    const cutoff = new Date(Date.now() - Number(olderThanDays) * 24 * 60 * 60 * 1000);
    const result = await ActivityLog.deleteMany({ createdAt: { $lt: cutoff } });
    res.json({ message: `Deleted ${result.deletedCount} log entries older than ${olderThanDays} days` });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
