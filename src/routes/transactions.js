const express = require('express');
const { body, param } = require('express-validator');
const Transaction = require('../models/Transaction');
const Item = require('../models/Item');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { log } = require('../utils/activityLogger');

const router = express.Router();
router.use(authenticate);

// Average cost after buying qty at unitPrice: blended with the stock actually on hand. With none
// on hand (or less than none, after sales ran ahead of purchases) the new price is the cost.
function costAfterPurchase(quantity, costPrice, qty, unitPrice) {
  if (quantity <= 0) return unitPrice;
  return (quantity * costPrice + qty * unitPrice) / (quantity + qty);
}

// Average cost after taking a purchase of qty at unitPrice back out of an item holding
// quantity at costPrice: the exact inverse of the moving average applied when it was bought.
// With nothing left the average has no meaning, so it is kept as it was.
function costWithoutPurchase(quantity, costPrice, qty, unitPrice) {
  const remaining = quantity - qty;
  if (remaining <= 0) return costPrice;
  return Math.max(0, (quantity * costPrice - qty * unitPrice) / remaining);
}

// Takes a transaction's stock movements back out of its items. Purchases also take their
// price back out of the average cost, so a corrected purchase doesn't leave the old price blended in.
async function reverseTransactionStock(transaction) {
  for (const line of transaction.items) {
    if (transaction.transactionType === 'purchase') {
      const item = await Item.findById(line.item);
      if (!item) continue;
      await Item.findByIdAndUpdate(line.item, {
        quantity: item.quantity - line.quantity,
        costPrice: costWithoutPurchase(item.quantity, item.costPrice, line.quantity, line.unitPrice),
      });
    } else {
      const delta = transaction.transactionType === 'sale' || transaction.transactionType === 'transfer' ? line.quantity : -line.quantity;
      await Item.findByIdAndUpdate(line.item, { $inc: { quantity: delta } });
    }
  }
}

// GET /api/transactions
router.get('/', async (req, res, next) => {
  try {
    const {
      page = 1, limit = 20, type, search, startDate, endDate, createdBy, itemId,
    } = req.query;

    const filter = {};
    // One type, or several separated by commas (the cost sheet asks for "transfer,sale")
    if (type) {
      const types = String(type).split(',').map((t) => t.trim()).filter(Boolean);
      filter.transactionType = types.length > 1 ? { $in: types } : types[0];
    }
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
          purchaseRef: lineItem.purchaseRef || null,
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

        const newCostPrice = transactionType === 'purchase'
          ? costAfterPurchase(dbItem.quantity, dbItem.costPrice, lineItem.quantity, lineItem.unitPrice)
          : dbItem.costPrice;

        await Item.findByIdAndUpdate(
          lineItem.item,
          {
            $inc: { quantity: quantityDelta },
            ...(transactionType === 'purchase' && { costPrice: newCostPrice }),
          }
        );
        // The next line for the same item must see this one's effect
        dbItem.quantity += quantityDelta;
        dbItem.costPrice = newCostPrice;
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

      // Anyone may correct a transaction's details; changing its lines moves stock, which is
      // as serious as deleting it, so that stays with admins (like DELETE)
      if (items !== undefined && req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Only an admin can change the items on a transaction.' });
      }

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
        // Validate new items exist before touching stock
        const uniqueItemIds = [...new Set(items.map((i) => i.item))];
        if (await Item.countDocuments({ _id: { $in: uniqueItemIds } }) !== uniqueItemIds.length) {
          return res.status(404).json({ message: 'One or more items not found' });
        }

        // A purchase can't be cut below what has already gone out of it: check before changing anything
        if (transaction.transactionType === 'purchase') {
          const delta = {};
          for (const line of transaction.items) delta[line.item.toString()] = (delta[line.item.toString()] || 0) - line.quantity;
          for (const line of items) delta[line.item] = (delta[line.item] || 0) + line.quantity;
          const affected = await Item.find({ _id: { $in: Object.keys(delta) } });
          for (const item of affected) {
            const after = item.quantity + delta[item._id.toString()];
            if (after < 0) {
              return res.status(400).json({
                message: `"${item.name}" has ${item.quantity} in stock; this change would leave ${after}. More of it has already been sold or transferred than the edited purchase brings in.`,
              });
            }
          }
        }

        // Reverse old stock changes
        await reverseTransactionStock(transaction);

        // Re-read after the reversal so the stock check sees the returned quantities
        const dbItems = await Item.find({ _id: { $in: uniqueItemIds } });
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
          return { item: lineItem.item, quantity: lineItem.quantity, unitPrice: lineItem.unitPrice, totalPrice, profit, purchaseRef: lineItem.purchaseRef || null };
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

          const newCostPrice = transaction.transactionType === 'purchase'
            ? costAfterPurchase(dbItem.quantity, dbItem.costPrice, lineItem.quantity, lineItem.unitPrice)
            : dbItem.costPrice;

          await Item.findByIdAndUpdate(
            lineItem.item,
            {
              $inc: { quantity: quantityDelta },
              ...(transaction.transactionType === 'purchase' && { costPrice: newCostPrice }),
            }
          );
          // The next line for the same item must see this one's effect
          dbItem.quantity += quantityDelta;
          dbItem.costPrice = newCostPrice;
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

      // Reverse stock changes (and, for a purchase, its price in the average cost)
      await reverseTransactionStock(transaction);

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
