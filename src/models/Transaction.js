const mongoose = require('mongoose');

const transactionItemSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
    quantity: { type: Number, required: true, min: 0.01 },
    unitPrice: { type: Number, required: true, min: 0 },
    totalPrice: { type: Number, required: true, min: 0 },
    profit: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const transactionSchema = new mongoose.Schema(
  {
    transactionType: {
      type: String,
      enum: ['purchase', 'sale', 'adjustment'],
      required: true,
    },
    transactionDate: { type: Date, default: Date.now },
    referenceNumber: { type: String, required: true, trim: true },
    customerSupplierName: { type: String, trim: true, default: null },
    customerSupplierContact: { type: String, trim: true, default: null },
    notes: { type: String, trim: true, default: null },
    totalAmount: { type: Number, default: 0, min: 0 },
    items: [transactionItemSchema],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

transactionSchema.index({ transactionType: 1 });
transactionSchema.index({ transactionDate: -1 });
transactionSchema.index({ referenceNumber: 1 });
transactionSchema.index({ createdBy: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
