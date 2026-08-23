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
      page = 1, limit = 20, type, search, startDate, endDate, createdBy, itemId,
    } = req.query;

    const filter = {};
    if (type) filter.transactionType = type;
    if (createdBy) filter.createdBy = createdBy;
    if (itemId) filter['items.item'] = itemId;
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
        .populate('items.item', 'name sku uom category subcategory costPrice')
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
        .populate('items.item', 'name sku uom category subcategory costPrice');
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
    body('referenceNumber').optional({ values: 'falsy' }).trim(),
    body('transactionDate').optional().isISO8601().toDate(),
    body('items').isArray({ min: 1 }).withMessage('At least one item is required'),
    body('items.*.item').isMongoId().withMessage('Valid item ID required'),
    body('items.*.quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be > 0'),
    body('items.*.unitPrice').optional().isFloat({ min: 0 }).withMessage('Unit price must be >= 0'),
  ],
  validate,
    async (req, res, next) => {
    try {
      const { transactionType, referenceNumber: refInput, transactionDate, customerSupplierName,
        customerSupplierContact, tinNo, notes, items } = req.body;

      const referenceNumber = refInput || `${transactionType === 'transfer' ? 'TRF' : 'TXN'}-${Date.now()}`;

      // Validate all items exist
      const uniqueItemIds = [...new Set(items.map((i) => i.item))];
      const dbItems = await Item.find({ _id: { $in: uniqueItemIds } });
      if (dbItems.length !== uniqueItemIds.length) {
        return res.status(404).json({ message: 'One or more items not found' });
      }

      const dbItemMap = {};
      dbItems.forEach((i) => { dbItemMap[i._id.toString()] = i; });

      // Validate stock for sales and transfers — aggregate quantities per item
      if (transactionType === 'sale' || transactionType === 'transfer') {
        const requestedQty = {};
        for (const lineItem of items) {
          requestedQty[lineItem.item] = (requestedQty[lineItem.item] || 0) + lineItem.quantity;
        }
        for (const [itemId, totalRequested] of Object.entries(requestedQty)) {
          const dbItem = dbItemMap[itemId];
          if (dbItem.quantity < totalRequested) {
            return res.status(400).json({
              message: `Insufficient stock for "${dbItem.name}". Available: ${dbItem.quantity}, Requested: ${totalRequested}`,
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
          : transactionType === 'transfer' ? -lineItem.quantity
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
        .populate('items.item', 'name sku uom category subcategory');

      await log(req.user._id, `create_${transactionType}`, 'transaction', transaction._id, {
        reference: referenceNumber, totalAmount,
      });

      res.status(201).json({ transaction: populated });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/transactions/:id — edit metadata and/or line items (reverses stock for old items, applies new)
router.put(
  '/:id',
  [
    param('id').isMongoId(),
    body('referenceNumber').optional().trim().notEmpty(),
    body('transactionDate').optional().isISO8601().toDate(),
    body('customerSupplierName').optional().trim(),
    body('customerSupplierContact').optional().trim(),
    body('tinNo').optional().trim(),
    body('notes').optional().trim(),
    body('items').optional().isArray({ min: 1 }),
    body('items.*.item').optional().isMongoId(),
    body('items.*.quantity').optional().isFloat({ min: 0.01 }),
    body('items.*.unitPrice').optional().isFloat({ min: 0 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { referenceNumber, transactionDate, customerSupplierName, customerSupplierContact, tinNo, notes, items } = req.body;
      const transaction = await Transaction.findById(req.params.id);
      if (!transaction) return res.status(404).json({ message: 'Transaction not found' });

      const updates = {};
      if (referenceNumber !== undefined) updates.referenceNumber = referenceNumber;
      if (transactionDate !== undefined) updates.transactionDate = transactionDate;
      if (customerSupplierName !== undefined) updates.customerSupplierName = customerSupplierName;
      if (customerSupplierContact !== undefined) updates.customerSupplierContact = customerSupplierContact;
      if (tinNo !== undefined) updates.tinNo = tinNo;
      if (notes !== undefined) updates.notes = notes;

      if (items && items.length > 0) {
        // Reverse old stock changes
        for (const oldItem of transaction.items) {
          const reverseDelta =
            transaction.transactionType === 'purchase' ? -oldItem.quantity
            : transaction.transactionType === 'sale' ? oldItem.quantity
            : transaction.transactionType === 'transfer' ? oldItem.quantity
            : -oldItem.quantity;
          await Item.findByIdAndUpdate(oldItem.item, { $inc: { quantity: reverseDelta } });
        }

        // Validate new items exist
        const uniqueItemIds = [...new Set(items.map((i) => i.item))];
        const dbItems = await Item.find({ _id: { $in: uniqueItemIds } });
        if (dbItems.length !== uniqueItemIds.length) {
          return res.status(404).json({ message: 'One or more items not found' });
        }
        const dbItemMap = {};
        dbItems.forEach((i) => { dbItemMap[i._id.toString()] = i; });

        // Validate stock for sales and transfers
        if (transaction.transactionType === 'sale' || transaction.transactionType === 'transfer') {
          const requestedQty = {};
          for (const lineItem of items) {
            requestedQty[lineItem.item] = (requestedQty[lineItem.item] || 0) + lineItem.quantity;
          }
          for (const [itemId, totalRequested] of Object.entries(requestedQty)) {
            const dbItem = dbItemMap[itemId];
            if (dbItem.quantity < totalRequested) {
              // Re-apply old stock before returning error
              for (const oldItem of transaction.items) {
                const reDelta =
                  transaction.transactionType === 'purchase' ? oldItem.quantity
                  : transaction.transactionType === 'sale' ? -oldItem.quantity
                  : transaction.transactionType === 'transfer' ? -oldItem.quantity
                  : oldItem.quantity;
                await Item.findByIdAndUpdate(oldItem.item, { $inc: { quantity: reDelta } });
              }
              return res.status(400).json({
                message: `Insufficient stock for "${dbItem.name}". Available: ${dbItem.quantity}, Requested: ${totalRequested}`,
              });
            }
          }
        }

        // Build new line items
        const lineItems = items.map((lineItem) => {
          const dbItem = dbItemMap[lineItem.item];
          const totalPrice = lineItem.quantity * lineItem.unitPrice;
          const profit = transaction.transactionType === 'sale' ? (lineItem.unitPrice - dbItem.costPrice) * lineItem.quantity : 0;
          return { item: lineItem.item, quantity: lineItem.quantity, unitPrice: lineItem.unitPrice, totalPrice, profit };
        });

        updates.items = lineItems;
        updates.totalAmount = lineItems.reduce((sum, i) => sum + i.totalPrice, 0);

        // Apply new stock changes
        for (const lineItem of lineItems) {
          const dbItem = dbItemMap[lineItem.item.toString()];
          const quantityDelta =
            transaction.transactionType === 'purchase' ? lineItem.quantity
            : transaction.transactionType === 'sale' ? -lineItem.quantity
            : transaction.transactionType === 'transfer' ? -lineItem.quantity
            : lineItem.quantity;

          let newCostPrice = dbItem.costPrice;
          if (transaction.transactionType === 'purchase' && dbItem.quantity + lineItem.quantity > 0) {
            newCostPrice =
              (dbItem.quantity * dbItem.costPrice + lineItem.quantity * lineItem.unitPrice) /
              (dbItem.quantity + lineItem.quantity);
          }

          await Item.findByIdAndUpdate(
            lineItem.item,
            {
              $inc: { quantity: quantityDelta },
              ...(transaction.transactionType === 'purchase' && { costPrice: newCostPrice }),
            }
          );
        }
      }

      const updated = await Transaction.findByIdAndUpdate(req.params.id, updates, { new: true })
        .populate('createdBy', 'fullName email')
        .populate('items.item', 'name sku uom category subcategory');
      if (!updated) return res.status(404).json({ message: 'Transaction not found' });

      await log(req.user._id, 'update_transaction', 'transaction', updated._id, updates);
      res.json({ transaction: updated });
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
          : transaction.transactionType === 'transfer' ? lineItem.quantity
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
