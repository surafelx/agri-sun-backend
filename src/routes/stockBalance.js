const express = require('express');
const Item = require('../models/Item');
const Transaction = require('../models/Transaction');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/stock-balance
// Returns current stock balance for all items, with optional filters
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
        .select('name sku category subcategory quantity costPrice unitPrice uom lowStockThreshold'),
      Item.countDocuments(filter),
    ]);

    const balances = items.map((item) => ({
      id: item._id,
      name: item.name,
      sku: item.sku,
      category: item.category,
      subcategory: item.subcategory,
      quantity: item.quantity,
      uom: item.uom,
      costPrice: item.costPrice,
      unitPrice: item.unitPrice,
      inventoryValue: item.quantity * item.costPrice,
      retailValue: item.quantity * item.unitPrice,
      lowStockThreshold: item.lowStockThreshold,
      isLowStock: item.quantity <= item.lowStockThreshold,
    }));

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

    // Summary of in / out from transactions
    const [purchaseSummary, saleSummary] = await Promise.all([
      Transaction.aggregate([
        { $match: { transactionType: 'purchase', 'items.item': item._id } },
        { $unwind: '$items' },
        { $match: { 'items.item': item._id } },
        { $group: { _id: null, totalIn: { $sum: '$items.quantity' }, totalCost: { $sum: '$items.totalPrice' } } },
      ]),
      Transaction.aggregate([
        { $match: { transactionType: { $in: ['sale', 'transfer'] }, 'items.item': item._id } },
        { $unwind: '$items' },
        { $match: { 'items.item': item._id } },
        { $group: { _id: null, totalOut: { $sum: '$items.quantity' }, totalRevenue: { $sum: '$items.totalPrice' }, totalProfit: { $sum: '$items.profit' } } },
      ]),
    ]);

    res.json({
      item: {
        id: item._id, name: item.name, sku: item.sku,
        category: item.category, subcategory: item.subcategory,
        uom: item.uom, quantity: item.quantity,
        costPrice: item.costPrice, unitPrice: item.unitPrice,
        inventoryValue: item.quantity * item.costPrice,
        lowStockThreshold: item.lowStockThreshold,
        isLowStock: item.quantity <= item.lowStockThreshold,
      },
      summary: {
        totalIn: purchaseSummary[0]?.totalIn || 0,
        totalCost: purchaseSummary[0]?.totalCost || 0,
        totalOut: saleSummary[0]?.totalOut || 0,
        totalRevenue: saleSummary[0]?.totalRevenue || 0,
        totalProfit: saleSummary[0]?.totalProfit || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
