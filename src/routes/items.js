const express = require('express');
const { body, param, query } = require('express-validator');
const multer = require('multer');
const ExcelJS = require('exceljs');
const Item = require('../models/Item');
const Category = require('../models/Category');
const Subcategory = require('../models/Subcategory');
const Transaction = require('../models/Transaction');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { log } = require('../utils/activityLogger');

const router = express.Router();
router.use(authenticate);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// GET /api/items
router.get('/', async (req, res, next) => {
  try {
    const {
      page = 1, limit = 20, category, subcategory, search,
      lowStock, sortBy = 'name', sortOrder = 'asc',
    } = req.query;

    const filter = {};
    if (category) filter.category = category;
    if (subcategory) filter.subcategory = subcategory;
    if (search) filter.$text = { $search: search };
    if (lowStock === 'true') filter.$expr = { $lte: ['$quantity', '$lowStockThreshold'] };

    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };
    const skip = (Number(page) - 1) * Number(limit);

    const [items, total] = await Promise.all([
      Item.find(filter)
        .populate('category', 'name')
        .populate('subcategory', 'name')
        .populate('createdBy', 'fullName email')
        .sort(sort)
        .skip(skip)
        .limit(Number(limit)),
      Item.countDocuments(filter),
    ]);

    res.json({ items, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    next(err);
  }
});

// GET /api/items/low-stock
router.get('/low-stock', async (req, res, next) => {
  try {
    const items = await Item.find({
      $expr: { $lte: ['$quantity', '$lowStockThreshold'] },
    })
      .populate('category', 'name')
      .populate('subcategory', 'name')
      .sort({ quantity: 1 });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// GET /api/items/:id
router.get(
  '/:id',
  [param('id').isMongoId()],
  validate,
  async (req, res, next) => {
    try {
      const item = await Item.findById(req.params.id)
        .populate('category', 'name')
        .populate('subcategory', 'name')
        .populate('createdBy', 'fullName email');
      if (!item) return res.status(404).json({ message: 'Item not found' });
      res.json({ item });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/items/:id/stock-card  — full movement ledger per item
router.get(
  '/:id/stock-card',
  [param('id').isMongoId()],
  validate,
  async (req, res, next) => {
    try {
      const item = await Item.findById(req.params.id)
        .populate('category', 'name')
        .populate('subcategory', 'name');
      if (!item) return res.status(404).json({ message: 'Item not found' });

      // Fetch all transactions involving this item
      const transactions = await Transaction.find({ 'items.item': item._id })
        .populate('createdBy', 'fullName')
        .sort({ transactionDate: 1, createdAt: 1 });

      let runningBalance = 0;
      const movements = [];

      for (const txn of transactions) {
        const lineItem = txn.items.find((i) => i.item.toString() === item._id.toString());
        if (!lineItem) continue;

        const qtyIn = txn.transactionType === 'purchase' ? lineItem.quantity : 0;
        const qtyOut = txn.transactionType === 'sale' ? lineItem.quantity : 0;
        const adjustment = txn.transactionType === 'adjustment' ? lineItem.quantity : 0;

        runningBalance += qtyIn - qtyOut + adjustment;

        movements.push({
          id: lineItem._id,
          transactionId: txn._id,
          date: txn.transactionDate,
          reference: txn.referenceNumber,
          type: txn.transactionType,
          quantityIn: qtyIn,
          quantityOut: qtyOut,
          adjustment,
          balance: runningBalance,
          unitPrice: lineItem.unitPrice,
          valueIn: qtyIn * lineItem.unitPrice,
          valueOut: qtyOut * lineItem.unitPrice,
          profit: lineItem.profit,
          customerSupplier: txn.customerSupplierName,
          notes: txn.notes,
          createdBy: txn.createdBy,
        });
      }

      res.json({ item, movements, currentBalance: runningBalance });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/items
router.post(
  '/',
  authorize('admin', 'inventory_clerk'),
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('sku').trim().notEmpty().withMessage('SKU is required'),
    body('category').isMongoId().withMessage('Valid category ID required'),
    body('subcategory').optional().isMongoId(),
    body('unitPrice').optional().isFloat({ min: 0 }),
    body('costPrice').optional().isFloat({ min: 0 }),
    body('quantity').optional().isFloat({ min: 0 }),
    body('lowStockThreshold').optional().isFloat({ min: 0 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const categoryExists = await Category.findById(req.body.category);
      if (!categoryExists) return res.status(404).json({ message: 'Category not found' });

      const item = await Item.create({ ...req.body, createdBy: req.user._id });
      await item.populate('category', 'name');
      await item.populate('subcategory', 'name');

      await log(req.user._id, 'create_item', 'item', item._id, { name: item.name, sku: item.sku });
      res.status(201).json({ item });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/items/:id
router.put(
  '/:id',
  authorize('admin', 'inventory_clerk'),
  [
    param('id').isMongoId(),
    body('name').optional().trim().notEmpty(),
    body('sku').optional().trim().notEmpty(),
    body('category').optional().isMongoId(),
    body('subcategory').optional().isMongoId(),
    body('unitPrice').optional().isFloat({ min: 0 }),
    body('costPrice').optional().isFloat({ min: 0 }),
    body('lowStockThreshold').optional().isFloat({ min: 0 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      // Don't allow direct quantity edits — use transactions/adjustments
      const { quantity, createdBy, ...updates } = req.body;

      const item = await Item.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true })
        .populate('category', 'name')
        .populate('subcategory', 'name');
      if (!item) return res.status(404).json({ message: 'Item not found' });

      await log(req.user._id, 'update_item', 'item', item._id, updates);
      res.json({ item });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/items/:id
router.delete(
  '/:id',
  authorize('admin'),
  [param('id').isMongoId()],
  validate,
  async (req, res, next) => {
    try {
      const item = await Item.findByIdAndDelete(req.params.id);
      if (!item) return res.status(404).json({ message: 'Item not found' });
      await log(req.user._id, 'delete_item', 'item', item._id, { name: item.name, sku: item.sku });
      res.json({ message: 'Item deleted' });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/items/import  — bulk import from Excel/CSV
router.post(
  '/import',
  authorize('admin', 'inventory_clerk'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const sheet = workbook.worksheets[0];
      if (!sheet) return res.status(400).json({ message: 'No worksheet found in file' });

      // Build rows from the sheet (first row = headers)
      const headers = [];
      sheet.getRow(1).eachCell((cell) => headers.push(cell.value?.toString().trim() || ''));
      const rows = [];
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const obj = {};
        row.eachCell((cell, colNumber) => {
          obj[headers[colNumber - 1]] = cell.value;
        });
        rows.push(obj);
      });

      const results = { created: 0, updated: 0, errors: [] };

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
          // Resolve or create category
          let category = await Category.findOne({ name: row.category || row.Category });
          if (!category && (row.category || row.Category)) {
            category = await Category.create({ name: row.category || row.Category });
          }
          if (!category) {
            results.errors.push({ row: i + 2, error: 'Category is required' });
            continue;
          }

          const sku = (row.sku || row.SKU || '').toString().toUpperCase().trim();
          if (!sku) { results.errors.push({ row: i + 2, error: 'SKU is required' }); continue; }

          const itemData = {
            name: row.name || row.Name,
            sku,
            category: category._id,
            description: row.description || row.Description || null,
            unitPrice: parseFloat(row.unit_price || row.unitPrice || 0),
            costPrice: parseFloat(row.cost_price || row.costPrice || 0),
            quantity: parseFloat(row.quantity || row.Quantity || 0),
            uom: row.uom || row.UOM || null,
            supplier: row.supplier || row.Supplier || null,
            lowStockThreshold: parseFloat(row.low_stock_threshold || row.lowStockThreshold || 10),
            createdBy: req.user._id,
          };

          const existing = await Item.findOne({ sku: itemData.sku });
          if (existing) {
            await Item.findByIdAndUpdate(existing._id, itemData);
            results.updated++;
          } else {
            await Item.create(itemData);
            results.created++;
          }
        } catch (rowErr) {
          results.errors.push({ row: i + 2, error: rowErr.message });
        }
      }

      await log(req.user._id, 'import_items', 'item', null, results);
      res.json({ message: 'Import complete', results });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
