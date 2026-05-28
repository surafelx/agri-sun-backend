const express = require('express');
const { body, param } = require('express-validator');
const User = require('../models/User');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { log } = require('../utils/activityLogger');

const router = express.Router();

// All user management routes require admin
router.use(authenticate, authorize('admin'));

// GET /api/users
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, role, isActive, search } = req.query;
    const filter = {};
    if (role) filter.role = role;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (search) filter.$or = [
      { fullName: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];

    const skip = (Number(page) - 1) * Number(limit);
    const [users, total] = await Promise.all([
      User.find(filter).skip(skip).limit(Number(limit)).sort({ createdAt: -1 }),
      User.countDocuments(filter),
    ]);

    res.json({ users, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    next(err);
  }
});

// GET /api/users/:id
router.get(
  '/:id',
  [param('id').isMongoId().withMessage('Invalid user ID')],
  validate,
  async (req, res, next) => {
    try {
      const user = await User.findById(req.params.id);
      if (!user) return res.status(404).json({ message: 'User not found' });
      res.json({ user });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/users
router.post(
  '/',
  [
    body('fullName').trim().notEmpty().withMessage('Full name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role').isIn(['admin', 'inventory_clerk', 'accountant']).withMessage('Invalid role'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { fullName, email, password, role } = req.body;
      const user = await User.create({ fullName, email, password, role });
      await log(req.user._id, 'create_user', 'user', user._id, { email, role });
      res.status(201).json({ user });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/users/:id
router.put(
  '/:id',
  [
    param('id').isMongoId().withMessage('Invalid user ID'),
    body('fullName').optional().trim().notEmpty(),
    body('email').optional().isEmail().normalizeEmail(),
    body('role').optional().isIn(['admin', 'inventory_clerk', 'accountant']),
    body('isActive').optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { fullName, email, role, isActive } = req.body;
      const updates = {};
      if (fullName !== undefined) updates.fullName = fullName;
      if (email !== undefined) updates.email = email;
      if (role !== undefined) updates.role = role;
      if (isActive !== undefined) updates.isActive = isActive;

      const user = await User.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
      if (!user) return res.status(404).json({ message: 'User not found' });

      await log(req.user._id, 'update_user', 'user', user._id, updates);
      res.json({ user });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/users/:id
router.delete(
  '/:id',
  [param('id').isMongoId().withMessage('Invalid user ID')],
  validate,
  async (req, res, next) => {
    try {
      if (req.params.id === req.user._id.toString()) {
        return res.status(400).json({ message: 'Cannot delete your own account' });
      }
      const user = await User.findByIdAndDelete(req.params.id);
      if (!user) return res.status(404).json({ message: 'User not found' });
      await log(req.user._id, 'delete_user', 'user', user._id, { email: user.email });
      res.json({ message: 'User deleted successfully' });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/users/:id/reset-password  (admin resets a user's password)
router.put(
  '/:id/reset-password',
  [
    param('id').isMongoId().withMessage('Invalid user ID'),
    body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const user = await User.findById(req.params.id);
      if (!user) return res.status(404).json({ message: 'User not found' });
      user.password = req.body.newPassword;
      await user.save();
      await log(req.user._id, 'reset_password', 'user', user._id);
      res.json({ message: 'Password reset successfully' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
