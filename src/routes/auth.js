const express = require('express');
const { body } = require('express-validator');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { log } = require('../utils/activityLogger');

const router = express.Router();

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

// POST /api/auth/register
router.post(
  '/register',
  [
    body('fullName').trim().notEmpty().withMessage('Full name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role')
      .optional()
      .isIn(['admin', 'inventory_clerk', 'accountant'])
      .withMessage('Invalid role'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { fullName, email, password, role } = req.body;
      const user = await User.create({ fullName, email, password, role });
      const token = signToken(user._id);
      await log(user._id, 'register', 'user', user._id, { email });
      res.status(201).json({ token, user });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/auth/login
router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { email, password } = req.body;
      const user = await User.findOne({ email }).select('+password');
      if (!user || !(await user.comparePassword(password))) {
        return res.status(401).json({ message: 'Invalid email or password' });
      }
      if (!user.isActive) {
        return res.status(403).json({ message: 'Account is deactivated' });
      }
      const token = signToken(user._id);
      await log(user._id, 'login', 'user', user._id, { email });
      const userObj = user.toJSON();
      res.json({ token, user: userObj });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// PUT /api/auth/me
router.put(
  '/me',
  authenticate,
  [
    body('fullName').optional().trim().notEmpty(),
    body('email').optional().isEmail().normalizeEmail(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { fullName, email } = req.body;
      const updates = {};
      if (fullName) updates.fullName = fullName;
      if (email) updates.email = email;

      const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true });
      await log(req.user._id, 'update_profile', 'user', req.user._id, updates);
      res.json({ user });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/auth/change-password
router.put(
  '/change-password',
  authenticate,
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body;
      const user = await User.findById(req.user._id).select('+password');
      if (!(await user.comparePassword(currentPassword))) {
        return res.status(401).json({ message: 'Current password is incorrect' });
      }
      user.password = newPassword;
      await user.save();
      await log(req.user._id, 'change_password', 'user', req.user._id);
      res.json({ message: 'Password changed successfully' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
