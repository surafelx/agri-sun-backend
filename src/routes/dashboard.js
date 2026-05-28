const express = require('express');
const Item = require('../models/Item');
const Transaction = require('../models/Transaction');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/dashboard/stats
router.get('/stats', async (req, res, next) => {
  try {
    const [totalItems, lowStockItems, recentTransactions] = await Promise.all([
      Item.countDocuments(),
      Item.countDocuments({ $expr: { $lte: ['$quantity', '$lowStockThreshold'] } }),
      Transaction.countDocuments({
        transactionDate: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      }),
    ]);

    // Total inventory value (quantity × costPrice)
    const valueAgg = await Item.aggregate([
      {
        $group: {
          _id: null,
          totalValue: { $sum: { $multiply: ['$quantity', '$costPrice'] } },
          totalRetailValue: { $sum: { $multiply: ['$quantity', '$unitPrice'] } },
        },
      },
    ]);

    const { totalValue = 0, totalRetailValue = 0 } = valueAgg[0] || {};

    // Revenue / cost totals this month
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const monthlySales = await Transaction.aggregate([
      { $match: { transactionType: 'sale', transactionDate: { $gte: monthStart } } },
      { $group: { _id: null, revenue: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
    ]);

    const monthlyPurchases = await Transaction.aggregate([
      { $match: { transactionType: 'purchase', transactionDate: { $gte: monthStart } } },
      { $group: { _id: null, cost: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
    ]);

    res.json({
      totalItems,
      lowStockItems,
      recentTransactions,
      totalInventoryValue: totalValue,
      totalRetailValue,
      monthlyRevenue: monthlySales[0]?.revenue || 0,
      monthlySaleCount: monthlySales[0]?.count || 0,
      monthlyPurchaseCost: monthlyPurchases[0]?.cost || 0,
      monthlyPurchaseCount: monthlyPurchases[0]?.count || 0,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/charts/transactions  — monthly transaction totals (last 12 months)
router.get('/charts/transactions', async (req, res, next) => {
  try {
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
    twelveMonthsAgo.setDate(1);
    twelveMonthsAgo.setHours(0, 0, 0, 0);

    const data = await Transaction.aggregate([
      { $match: { transactionDate: { $gte: twelveMonthsAgo } } },
      {
        $group: {
          _id: {
            year: { $year: '$transactionDate' },
            month: { $month: '$transactionDate' },
            type: '$transactionType',
          },
          total: { $sum: '$totalAmount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    // Reshape into { month, purchase, sale, adjustment } per period
    const months = {};
    data.forEach(({ _id, total, count }) => {
      const key = `${_id.year}-${String(_id.month).padStart(2, '0')}`;
      if (!months[key]) months[key] = { month: key, purchase: 0, sale: 0, adjustment: 0 };
      months[key][_id.type] = total;
    });

    res.json({ chartData: Object.values(months).sort((a, b) => a.month.localeCompare(b.month)) });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/charts/top-items  — top 10 items by quantity sold
router.get('/charts/top-items', async (req, res, next) => {
  try {
    const { days = 30 } = req.query;
    const since = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000);

    const data = await Transaction.aggregate([
      { $match: { transactionType: 'sale', transactionDate: { $gte: since } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.item',
          totalQuantitySold: { $sum: '$items.quantity' },
          totalRevenue: { $sum: '$items.totalPrice' },
          totalProfit: { $sum: '$items.profit' },
        },
      },
      { $sort: { totalQuantitySold: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'items', localField: '_id', foreignField: '_id',
          as: 'item',
        },
      },
      { $unwind: '$item' },
      {
        $project: {
          name: '$item.name', sku: '$item.sku',
          totalQuantitySold: 1, totalRevenue: 1, totalProfit: 1,
        },
      },
    ]);

    res.json({ items: data });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/charts/stock-by-category
router.get('/charts/stock-by-category', async (req, res, next) => {
  try {
    const data = await Item.aggregate([
      {
        $group: {
          _id: '$category',
          itemCount: { $sum: 1 },
          totalQuantity: { $sum: '$quantity' },
          totalValue: { $sum: { $multiply: ['$quantity', '$costPrice'] } },
        },
      },
      {
        $lookup: {
          from: 'categories', localField: '_id', foreignField: '_id',
          as: 'category',
        },
      },
      { $unwind: { path: '$category', preserveNullAndEmpty: true } },
      {
        $project: {
          categoryName: { $ifNull: ['$category.name', 'Uncategorized'] },
          itemCount: 1, totalQuantity: 1, totalValue: 1,
        },
      },
      { $sort: { totalValue: -1 } },
    ]);

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
