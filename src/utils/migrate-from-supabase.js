/**
 * One-time migration: Supabase → MongoDB
 *
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_KEY=<service_role_key> \
 *   MONGODB_URI=mongodb+srv://... \
 *   node src/utils/migrate-from-supabase.js
 *
 * The service_role key bypasses RLS and can read every table.
 * Find it in Supabase → Project Settings → API → service_role (secret).
 *
 * Safe to re-run: uses upsert, so duplicates are skipped.
 */

require('dotenv').config();
const mongoose = require('mongoose');

// ── Models ───────────────────────────────────────────────────────────────────
const Category    = require('../models/Category');
const Subcategory = require('../models/Subcategory');
const Item        = require('../models/Item');
const Transaction = require('../models/Transaction');

// ── Config ───────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service_role key
const MONGODB_URI  = process.env.MONGODB_URI;

if (!SUPABASE_URL || !SUPABASE_KEY || !MONGODB_URI) {
  console.error('Missing env vars. Need: SUPABASE_URL, SUPABASE_SERVICE_KEY, MONGODB_URI');
  process.exit(1);
}

// ── Supabase REST helper ─────────────────────────────────────────────────────
async function fetchAll(table, select = '*') {
  const rows = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}&limit=${pageSize}&offset=${from}`;
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'count=exact',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase fetch failed for ${table}: ${res.status} ${text}`);
    }

    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

// ── UUID → ObjectId mapping ──────────────────────────────────────────────────
// We build a map so cross-table references stay consistent.
// Each UUID gets a stable new ObjectId for the lifetime of this script run.
const idMap = new Map();

function toOid(uuid) {
  if (!uuid) return undefined;
  if (!idMap.has(uuid)) idMap.set(uuid, new mongoose.Types.ObjectId());
  return idMap.get(uuid);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function migrate() {
  await mongoose.connect(MONGODB_URI);
  console.log('MongoDB connected');

  // ── 1. Categories ──────────────────────────────────────────────────────────
  console.log('\n── Categories ──');
  const sbCategories = await fetchAll('categories', 'id,name');
  console.log(`  Found ${sbCategories.length} categories in Supabase`);

  for (const cat of sbCategories) {
    const _id = toOid(cat.id);
    await Category.findByIdAndUpdate(
      _id,
      { _id, name: cat.name },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
  console.log(`  ✓ Upserted ${sbCategories.length} categories`);

  // ── 2. Subcategories ───────────────────────────────────────────────────────
  console.log('\n── Subcategories ──');
  const sbSubs = await fetchAll('subcategories', 'id,name,category_id');
  console.log(`  Found ${sbSubs.length} subcategories in Supabase`);

  for (const sub of sbSubs) {
    const _id = toOid(sub.id);
    await Subcategory.findByIdAndUpdate(
      _id,
      { _id, name: sub.name, category: toOid(sub.category_id) },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
  console.log(`  ✓ Upserted ${sbSubs.length} subcategories`);

  // ── 3. Items ───────────────────────────────────────────────────────────────
  console.log('\n── Items ──');
  const sbItems = await fetchAll(
    'items',
    'id,name,sku,category_id,subcategory_id,description,quantity,unit_price,cost_price,supplier,parameters,low_stock_threshold,created_at'
  );
  console.log(`  Found ${sbItems.length} items in Supabase`);

  for (const it of sbItems) {
    const _id = toOid(it.id);
    await Item.findByIdAndUpdate(
      _id,
      {
        _id,
        name:              it.name,
        sku:               (it.sku || '').toUpperCase(),
        category:          toOid(it.category_id),
        subcategory:       toOid(it.subcategory_id),
        description:       it.description || '',
        quantity:          Number(it.quantity) || 0,
        unitPrice:         Number(it.unit_price) || 0,
        costPrice:         Number(it.cost_price) || 0,
        supplier:          it.supplier || '',
        parameters:        it.parameters || {},
        lowStockThreshold: Number(it.low_stock_threshold) || 10,
        createdAt:         it.created_at ? new Date(it.created_at) : new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
  console.log(`  ✓ Upserted ${sbItems.length} items`);

  // ── 4. Transactions + line items ───────────────────────────────────────────
  console.log('\n── Transactions ──');
  const sbTxns = await fetchAll(
    'transactions',
    'id,transaction_type,transaction_date,reference_number,customer_supplier_name,customer_supplier_contact,notes,total_amount,created_by,created_at'
  );
  console.log(`  Found ${sbTxns.length} transactions in Supabase`);

  const sbItems2 = await fetchAll(
    'transaction_items',
    'id,transaction_id,item_id,quantity,unit_price,total_price,profit'
  );
  console.log(`  Found ${sbItems2.length} transaction line items in Supabase`);

  // Group line items by transaction_id for fast lookup
  const linesByTxn = new Map();
  for (const li of sbItems2) {
    if (!linesByTxn.has(li.transaction_id)) linesByTxn.set(li.transaction_id, []);
    linesByTxn.get(li.transaction_id).push(li);
  }

  let skipped = 0;
  for (const txn of sbTxns) {
    const lines = linesByTxn.get(txn.id) || [];

    if (lines.length === 0) {
      // Can't reconstruct a transaction without line items — skip
      console.warn(`  ⚠ Skipping transaction ${txn.reference_number} (no line items)`);
      skipped++;
      continue;
    }

    const embeddedItems = lines.map((li) => ({
      item:       toOid(li.item_id),
      quantity:   Number(li.quantity),
      unitPrice:  Number(li.unit_price),
      totalPrice: Number(li.total_price),
      // Supabase stored profit per unit; we store profit for the whole line
      profit:     Number(li.profit) * Number(li.quantity),
    }));

    const _id = toOid(txn.id);

    await Transaction.findByIdAndUpdate(
      _id,
      {
        _id,
        transactionType:        txn.transaction_type,
        referenceNumber:        txn.reference_number,
        transactionDate:        txn.transaction_date ? new Date(txn.transaction_date) : new Date(),
        customerSupplierName:   txn.customer_supplier_name || '',
        customerSupplierContact: txn.customer_supplier_contact || '',
        notes:                  txn.notes || '',
        totalAmount:            Number(txn.total_amount) || 0,
        items:                  embeddedItems,
        // created_by is a Supabase auth UUID — we map it but it won't match a real
        // MongoDB user. Set to undefined so the field is just omitted.
        createdAt: txn.created_at ? new Date(txn.created_at) : new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
  console.log(`  ✓ Upserted ${sbTxns.length - skipped} transactions (${skipped} skipped — no line items)`);

  // ── Summary ────────────────────────────────────────────────────────────────
  const [catCount, subCount, itemCount, txnCount] = await Promise.all([
    Category.countDocuments(),
    Subcategory.countDocuments(),
    Item.countDocuments(),
    Transaction.countDocuments(),
  ]);

  console.log('\n── MongoDB totals after migration ──');
  console.log(`  Categories:   ${catCount}`);
  console.log(`  Subcategories:${subCount}`);
  console.log(`  Items:        ${itemCount}`);
  console.log(`  Transactions: ${txnCount}`);
  console.log('\nMigration complete.');
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
