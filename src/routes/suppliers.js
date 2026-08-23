const express = require('express');
const { body, param } = require('express-validator');
const Supplier = require('../models/Supplier');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { log } = require('../utils/activityLogger');

const router = express.Router();
router.use(authenticate);

// GET /api/suppliers
router.get('/', async (req, res, next) => {
  try {
    const { page = 1, limit = 50, search } = req.query;
    const filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { tinNo: { $regex: search, $options: 'i' } },
        { contact: { $regex: search, $options: 'i' } },
      ];
    }
    const skip = (Number(page) - 1) * Number(limit);
    const [suppliers, total] = await Promise.all([
      Supplier.find(filter).sort({ name: 1 }).skip(skip).limit(Number(limit)),
      Supplier.countDocuments(filter),
    ]);
    res.json({ suppliers, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    next(err);
  }
});

// GET /api/suppliers/:id
router.get(
  '/:id',
  [param('id').isMongoId()],
  validate,
  async (req, res, next) => {
    try {
      const supplier = await Supplier.findById(req.params.id);
      if (!supplier) return res.status(404).json({ message: 'Supplier not found' });
      res.json({ supplier });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/suppliers
router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('tinNo').optional().trim(),
    body('contact').optional().trim(),
    body('address').optional().trim(),
    body('notes').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { name, tinNo, contact, address, notes } = req.body;
      const supplier = await Supplier.create({
        name, tinNo, contact, address, notes, createdBy: req.user._id,
      });
      await log(req.user._id, 'create_supplier', 'supplier', supplier._id, { name });
      res.status(201).json({ supplier });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/suppliers/:id
router.put(
  '/:id',
  [
    param('id').isMongoId(),
    body('name').optional().trim().notEmpty(),
    body('tinNo').optional().trim(),
    body('contact').optional().trim(),
    body('address').optional().trim(),
    body('notes').optional().trim(),
    body('isActive').optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { name, tinNo, contact, address, notes, isActive } = req.body;
      const updates = {};
      if (name !== undefined) updates.name = name;
      if (tinNo !== undefined) updates.tinNo = tinNo;
      if (contact !== undefined) updates.contact = contact;
      if (address !== undefined) updates.address = address;
      if (notes !== undefined) updates.notes = notes;
      if (isActive !== undefined) updates.isActive = isActive;

      const supplier = await Supplier.findByIdAndUpdate(req.params.id, updates, { new: true });
      if (!supplier) return res.status(404).json({ message: 'Supplier not found' });
      await log(req.user._id, 'update_supplier', 'supplier', supplier._id, updates);
      res.json({ supplier });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/suppliers/:id
router.delete(
  '/:id',
  authorize('admin'),
  [param('id').isMongoId()],
  validate,
  async (req, res, next) => {
    try {
      const supplier = await Supplier.findByIdAndDelete(req.params.id);
      if (!supplier) return res.status(404).json({ message: 'Supplier not found' });
      await log(req.user._id, 'delete_supplier', 'supplier', supplier._id, { name: supplier.name });
      res.json({ message: 'Supplier deleted' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
