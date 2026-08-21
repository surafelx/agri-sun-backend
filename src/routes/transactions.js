const express = require('express');
const { body, param } = require('express-validator');
const Transaction = require('../models/Transaction');
const Item = require('../models/Item');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { log } = require('../utils/activityLogger');

const router = express.Router();
router.use(authenticate);

// GET /api/transactions
router.get('/', async (req, res, next) => {
  try {
    const {
      page = 1, limit = 20, type, search, startDate, endDate, createdBy,
    } = req.query;

    const filter = {};
    if (type) filter.transactionType = type;
    if (createdBy) filter.createdBy = createdBy;
    if (search) {
      filter.$or = [
        { referenceNumber: { $regex: search, $options: 'i' } },
        { customerSupplierName: { $regex: search, $options: 'i' } },
        { notes: { $regex: search, $options: 'i' } },
      ];
    }
    if (startDate || endDate) {
      filter.transactionDate = {};
      if (startDate) filter.transactionDate.$gte = new Date(startDate);
      if (endDate) filter.transactionDate.$lte = new Date(endDate);
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [transactions, total] = await Promise.all([
      Transaction.find(filter)
        .populate('createdBy', 'fullName email')
        .populate('items.item', 'name sku uom')
        .sort({ transactionDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(Number(limit)),
      Transaction.countDocuments(filter),
    ]);

    res.json({ transactions, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    next(err);
  }
});

// GET /api/transactions/:id
router.get(
  '/:id',
  [param('id').isMongoId()],
  validate,
  async (req, res, next) => {
    try {
      const transaction = await Transaction.findById(req.params.id)
        .populate('createdBy', 'fullName email')
        .populate('items.item', 'name sku uom category costPrice');
      if (!transaction) return res.status(404).json({ message: 'Transaction not found' });
      res.json({ transaction });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/transactions
router.post(
  '/',
  [
    body('transactionType').isIn(['purchase', 'sale', 'adjustment', 'transfer']).withMessage('Invalid transaction type'),
    body('referenceNumber').trim().notEmpty().withMessage('Reference number is required'),
    body('transactionDate').optional().isISO8601().toDate(),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.item').isMongoId().withMessage('Valid item ID required'),
    body('items.*.quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be > 0'),
    body('items.*.unitPrice').isFloat({ min: 0 }).withMessage('Unit price must be >= 0'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { transactionType, referenceNumber, transactionDate, customerSupplierName,
        customerSupplierContact, tinNo, notes, items } = req.body;

      // Validate all items exist
      const itemIds = items.map((i) => i.item);
      const dbItems = await Item.find({ _id: { $in: itemIds } });
      if (dbItems.length !== itemIds.length) {
        return res.status(404).json({ message: 'One or more items not found' });
      }

      const dbItemMap = {};
      dbItems.forEach((i) => { dbItemMap[i._id.toString()] = i; });

      // Validate stock for sales
      if (transactionType === 'sale') {
        for (const lineItem of items) {
          const dbItem = dbItemMap[lineItem.item];
          if (dbItem.quantity < lineItem.quantity) {
            return res.status(400).json({
              message: `Insufficient stock for "${dbItem.name}". Available: ${dbItem.quantity}, Requested: ${lineItem.quantity}`,
            });
          }
        }
      }

      // Build line items with computed fields
      const lineItems = items.map((lineItem) => {
        const dbItem = dbItemMap[lineItem.item];
        const totalPrice = lineItem.quantity * lineItem.unitPrice;
        const profit = transactionType === 'sale' ? (lineItem.unitPrice - dbItem.costPrice) * lineItem.quantity : 0;
        return {
          item: lineItem.item,
          quantity: lineItem.quantity,
          unitPrice: lineItem.unitPrice,
          totalPrice,
          profit,
        };
      });

      const totalAmount = lineItems.reduce((sum, i) => sum + i.totalPrice, 0);

      const transaction = await Transaction.create({
        transactionType, referenceNumber, transactionDate: transactionDate || new Date(),
        customerSupplierName, customerSupplierContact, tinNo, notes, totalAmount,
        items: lineItems, createdBy: req.user._id,
      });

      // Update item quantities and cost prices
      for (const lineItem of lineItems) {
        const dbItem = dbItemMap[lineItem.item.toString()];
        const quantityDelta =
          transactionType === 'purchase' ? lineItem.quantity
          : transactionType === 'sale' ? -lineItem.quantity
          : lineItem.quantity;

        let newCostPrice = dbItem.costPrice;
        if (transactionType === 'purchase' && dbItem.quantity + lineItem.quantity > 0) {
          newCostPrice =
            (dbItem.quantity * dbItem.costPrice + lineItem.quantity * lineItem.unitPrice) /
            (dbItem.quantity + lineItem.quantity);
        }

        await Item.findByIdAndUpdate(
          lineItem.item,
          {
            $inc: { quantity: quantityDelta },
            ...(transactionType === 'purchase' && { costPrice: newCostPrice }),
          }
        );
      }

      const populated = await Transaction.findById(transaction._id)
        .populate('createdBy', 'fullName email')
        .populate('items.item', 'name sku uom');

      await log(req.user._id, `create_${transactionType}`, 'transaction', transaction._id, {
        reference: referenceNumber, totalAmount,
      });

      res.status(201).json({ transaction: populated });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/transactions/:id  — admin only, only edits metadata (not line items)
router.put(
  '/:id',
  authorize('admin'),
  [
    param('id').isMongoId(),
    body('referenceNumber').optional().trim().notEmpty(),
    body('transactionDate').optional().isISO8601().toDate(),
    body('customerSupplierName').optional().trim(),
    body('customerSupplierContact').optional().trim(),
    body('tinNo').optional().trim(),
    body('notes').optional().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { referenceNumber, transactionDate, customerSupplierName, customerSupplierContact, tinNo, notes } = req.body;
      const updates = {};
      if (referenceNumber !== undefined) updates.referenceNumber = referenceNumber;
      if (transactionDate !== undefined) updates.transactionDate = transactionDate;
      if (customerSupplierName !== undefined) updates.customerSupplierName = customerSupplierName;
      if (customerSupplierContact !== undefined) updates.customerSupplierContact = customerSupplierContact;
      if (tinNo !== undefined) updates.tinNo = tinNo;
      if (notes !== undefined) updates.notes = notes;

      const transaction = await Transaction.findByIdAndUpdate(req.params.id, updates, { new: true })
        .populate('createdBy', 'fullName email')
        .populate('items.item', 'name sku uom');
      if (!transaction) return res.status(404).json({ message: 'Transaction not found' });

      await log(req.user._id, 'update_transaction', 'transaction', transaction._id, updates);
      res.json({ transaction });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/transactions/:id  — admin only, reverses stock changes
router.delete(
  '/:id',
  authorize('admin'),
  [param('id').isMongoId()],
  validate,
  async (req, res, next) => {
    try {
      const transaction = await Transaction.findById(req.params.id);
      if (!transaction) {
        return res.status(404).json({ message: 'Transaction not found' });
      }

      // Reverse stock changes
      for (const lineItem of transaction.items) {
        const reverseDelta =
          transaction.transactionType === 'purchase' ? -lineItem.quantity
          : transaction.transactionType === 'sale' ? lineItem.quantity
          : -lineItem.quantity;

        await Item.findByIdAndUpdate(lineItem.item, { $inc: { quantity: reverseDelta } });
      }

      await Transaction.findByIdAndDelete(req.params.id);

      await log(req.user._id, 'delete_transaction', 'transaction', transaction._id, {
        reference: transaction.referenceNumber, type: transaction.transactionType,
      });

      res.json({ message: 'Transaction deleted and stock reversed' });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
