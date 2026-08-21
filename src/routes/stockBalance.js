const express = require('express');
const Item = require('../models/Item');
const Transaction = require('../models/Transaction');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Helper: calculate net quantity for an item from its transactions
function calcBalanceFromTransactions(transactions, itemId) {
  let qty = 0;
  for (const txn of transactions) {
    for (const li of txn.items) {
      if (li.item.toString() !== itemId.toString()) continue;
      if (txn.transactionType === 'purchase') qty += li.quantity;
      else if (txn.transactionType === 'sale' || txn.transactionType === 'transfer') qty -= li.quantity;
      else if (txn.transactionType === 'adjustment') qty += li.quantity;
    }
  }
  return qty;
}

// GET /api/stock-balance
// Returns current stock balance for all items, calculated from transactions
router.get('/', async (req, res, next) => {
  try {
    const { category, subcategory, search, page = 1, limit = 50 } = req.query;

    const filter = {};
    if (category) filter.category = category;
    if (subcategory) filter.subcategory = subcategory;
    if (search) filter.$text = { $search: search };

    const skip = (Number(page) - 1) * Number(limit);

    const [items, total] = await Promise.all([
      Item.find(filter)
        .populate('category', 'name')
        .populate('subcategory', 'name')
        .sort({ name: 1 })
        .skip(skip)
        .limit(Number(limit))
        .select('name sku category subcategory costPrice unitPrice uom lowStockThreshold'),
      Item.countDocuments(filter),
    ]);

    if (items.length === 0) {
      return res.json({ balances: [], total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
    }

    // Fetch ALL transactions for these items in one query
    const itemIds = items.map((i) => i._id);
    const transactions = await Transaction.find({ 'items.item': { $in: itemIds } })
      .select('transactionType items.item items.quantity')
      .lean();

    // Build a map of item_id -> transactions[]
    const txMap = {};
    for (const txn of transactions) {
      for (const li of txn.items) {
        const key = li.item.toString();
        if (!txMap[key]) txMap[key] = [];
        txMap[key].push(txn);
      }
    }

    const balances = items.map((item) => {
      const quantity = calcBalanceFromTransactions(txMap[item._id.toString()] || [], item._id);
      return {
        id: item._id,
        name: item.name,
        sku: item.sku,
        category: item.category,
        subcategory: item.subcategory,
        quantity,
        uom: item.uom,
        costPrice: item.costPrice,
        unitPrice: item.unitPrice,
        inventoryValue: quantity * item.costPrice,
        retailValue: quantity * item.unitPrice,
        lowStockThreshold: item.lowStockThreshold,
        isLowStock: quantity <= item.lowStockThreshold,
      };
    });

    res.json({ balances, total, page: Number(page), totalPages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    next(err);
  }
});

// GET /api/stock-balance/:itemId  — balance for a single item
router.get('/:itemId', async (req, res, next) => {
  try {
    const item = await Item.findById(req.params.itemId)
      .populate('category', 'name')
      .populate('subcategory', 'name');
    if (!item) return res.status(404).json({ message: 'Item not found' });

    // Fetch all transactions for this item
    const transactions = await Transaction.find({ 'items.item': item._id })
      .select('transactionType items items.totalPrice items.profit')
      .lean();

    // Calculate quantities from transactions
    let totalIn = 0, totalCost = 0;
    let totalSalesOut = 0, totalRevenue = 0, totalProfit = 0;
    let totalTransferOut = 0, totalTransferCost = 0;

    for (const txn of transactions) {
      for (const li of txn.items) {
        if (li.item.toString() !== item._id.toString()) continue;
        if (txn.transactionType === 'purchase') {
          totalIn += li.quantity;
          totalCost += li.totalPrice;
        } else if (txn.transactionType === 'sale') {
          totalSalesOut += li.quantity;
          totalRevenue += li.totalPrice;
          totalProfit += li.profit || 0;
        } else if (txn.transactionType === 'transfer') {
          totalTransferOut += li.quantity;
          totalTransferCost += li.totalPrice;
        }
      }
    }

    const quantity = totalIn - totalSalesOut - totalTransferOut;

    res.json({
      item: {
        id: item._id, name: item.name, sku: item.sku,
        category: item.category, subcategory: item.subcategory,
        uom: item.uom, quantity,
        costPrice: item.costPrice, unitPrice: item.unitPrice,
        inventoryValue: quantity * item.costPrice,
        lowStockThreshold: item.lowStockThreshold,
        isLowStock: quantity <= item.lowStockThreshold,
      },
      summary: {
        totalIn, totalCost,
        totalSalesOut, totalRevenue, totalProfit,
        totalTransferOut, totalTransferCost,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/stock-balance/recalculate  — recalculate all item quantities from transactions
router.post('/recalculate', async (req, res, next) => {
  try {
    const items = await Item.find({}).select('_id sku name').lean();
    const transactions = await Transaction.find({})
      .select('transactionType items.item items.quantity')
      .lean();

    // Build map: itemId -> net quantity delta from transactions
    const deltaMap = {};
    for (const txn of transactions) {
      for (const li of txn.items) {
        const key = li.item.toString();
        if (!deltaMap[key]) deltaMap[key] = 0;
        if (txn.transactionType === 'purchase') deltaMap[key] += li.quantity;
        else if (txn.transactionType === 'sale' || txn.transactionType === 'transfer') deltaMap[key] -= li.quantity;
        else if (txn.transactionType === 'adjustment') deltaMap[key] += li.quantity;
      }
    }

    let updated = 0;
    for (const item of items) {
      const newQty = deltaMap[item._id.toString()] || 0;
      if (newQty < 0) {
        // Clamp to 0 — shouldn't happen but safety net
        await Item.findByIdAndUpdate(item._id, { quantity: 0 });
      } else {
        await Item.findByIdAndUpdate(item._id, { quantity: newQty });
      }
      updated++;
    }

    res.json({ message: `Recalculated stock for ${updated} items`, updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
