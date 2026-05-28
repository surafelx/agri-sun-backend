const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, required: true, unique: true, uppercase: true, trim: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    subcategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Subcategory', default: null },
    description: { type: String, trim: true, default: null },
    quantity: { type: Number, default: 0, min: 0 },
    unitPrice: { type: Number, default: 0, min: 0 },
    costPrice: { type: Number, default: 0, min: 0 },
    uom: { type: String, trim: true, default: null },
    supplier: { type: String, trim: true, default: null },
    parameters: { type: mongoose.Schema.Types.Mixed, default: {} },
    lowStockThreshold: { type: Number, default: 10, min: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

itemSchema.index({ name: 'text', sku: 'text', description: 'text' });
itemSchema.index({ category: 1 });
itemSchema.index({ subcategory: 1 });

module.exports = mongoose.model('Item', itemSchema);
