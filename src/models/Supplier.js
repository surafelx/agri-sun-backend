const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    tinNo: { type: String, trim: true, default: null },
    contact: { type: String, trim: true, default: null },
    address: { type: String, trim: true, default: null },
    notes: { type: String, trim: true, default: null },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

supplierSchema.index({ name: 'text', tinNo: 'text', contact: 'text' });

module.exports = mongoose.model('Supplier', supplierSchema);
