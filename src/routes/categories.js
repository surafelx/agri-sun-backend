const express = require('express');
const { body, param } = require('express-validator');
const Category = require('../models/Category');
const Subcategory = require('../models/Subcategory');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { log } = require('../utils/activityLogger');

const router = express.Router();
router.use(authenticate);

// ── Categories ──────────────────────────────────────────────────────────────

// GET /api/categories
router.get('/', async (req, res, next) => {
  try {
    const categories = await Category.find().sort({ name: 1 });
    res.json({ categories });
  } catch (err) {
    next(err);
  }
});

// GET /api/categories/:id
router.get(
  '/:id',
  [param('id').isMongoId()],
  validate,
  async (req, res, next) => {
    try {
      const category = await Category.findById(req.params.id);
      if (!category) return res.status(404).json({ message: 'Category not found' });
      res.json({ category });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/categories
router.post(
  '/',
  authorize('admin'),
  [body('name').trim().notEmpty().withMessage('Category name is required')],
  validate,
  async (req, res, next) => {
    try {
      const category = await Category.create({ name: req.body.name });
      await log(req.user._id, 'create_category', 'category', category._id, { name: category.name });
      res.status(201).json({ category });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/categories/:id
router.put(
  '/:id',
  authorize('admin'),
  [param('id').isMongoId(), body('name').trim().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const category = await Category.findByIdAndUpdate(
        req.params.id,
        { name: req.body.name },
        { new: true, runValidators: true }
      );
      if (!category) return res.status(404).json({ message: 'Category not found' });
      await log(req.user._id, 'update_category', 'category', category._id, { name: category.name });
      res.json({ category });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/categories/:id
router.delete(
  '/:id',
  authorize('admin'),
  [param('id').isMongoId()],
  validate,
  async (req, res, next) => {
    try {
      const category = await Category.findByIdAndDelete(req.params.id);
      if (!category) return res.status(404).json({ message: 'Category not found' });
      // Cascade delete subcategories
      await Subcategory.deleteMany({ category: req.params.id });
      await log(req.user._id, 'delete_category', 'category', category._id, { name: category.name });
      res.json({ message: 'Category deleted' });
    } catch (err) {
      next(err);
    }
  }
);

// ── Subcategories ────────────────────────────────────────────────────────────

// GET /api/categories/:categoryId/subcategories
router.get(
  '/:categoryId/subcategories',
  [param('categoryId').isMongoId()],
  validate,
  async (req, res, next) => {
    try {
      const subcategories = await Subcategory.find({ category: req.params.categoryId }).sort({ name: 1 });
      res.json({ subcategories });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/categories/:categoryId/subcategories
router.post(
  '/:categoryId/subcategories',
  authorize('admin'),
  [param('categoryId').isMongoId(), body('name').trim().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const category = await Category.findById(req.params.categoryId);
      if (!category) return res.status(404).json({ message: 'Category not found' });
      const subcategory = await Subcategory.create({ name: req.body.name, category: req.params.categoryId });
      await log(req.user._id, 'create_subcategory', 'subcategory', subcategory._id, { name: subcategory.name });
      res.status(201).json({ subcategory });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/categories/:categoryId/subcategories/:id
router.put(
  '/:categoryId/subcategories/:id',
  authorize('admin'),
  [param('categoryId').isMongoId(), param('id').isMongoId(), body('name').trim().notEmpty()],
  validate,
  async (req, res, next) => {
    try {
      const subcategory = await Subcategory.findOneAndUpdate(
        { _id: req.params.id, category: req.params.categoryId },
        { name: req.body.name },
        { new: true, runValidators: true }
      );
      if (!subcategory) return res.status(404).json({ message: 'Subcategory not found' });
      await log(req.user._id, 'update_subcategory', 'subcategory', subcategory._id, { name: subcategory.name });
      res.json({ subcategory });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/categories/:categoryId/subcategories/:id
router.delete(
  '/:categoryId/subcategories/:id',
  authorize('admin'),
  [param('categoryId').isMongoId(), param('id').isMongoId()],
  validate,
  async (req, res, next) => {
    try {
      const subcategory = await Subcategory.findOneAndDelete({
        _id: req.params.id,
        category: req.params.categoryId,
      });
      if (!subcategory) return res.status(404).json({ message: 'Subcategory not found' });
      await log(req.user._id, 'delete_subcategory', 'subcategory', subcategory._id);
      res.json({ message: 'Subcategory deleted' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
