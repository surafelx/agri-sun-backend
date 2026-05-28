require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const connectDB = require('../../config/db');
const User = require('../models/User');
const Category = require('../models/Category');
const Subcategory = require('../models/Subcategory');
const Item = require('../models/Item');

const seed = async () => {
  await connectDB();

  // Admin user
  const existingAdmin = await User.findOne({ email: 'admin@agrisun.com' });
  if (!existingAdmin) {
    await User.create({
      fullName: 'Admin User',
      email: 'admin@agrisun.com',
      password: 'Admin@1234',
      role: 'admin',
    });
    console.log('Admin user created: admin@agrisun.com / Admin@1234');
  } else {
    console.log('Admin user already exists');
  }

  // Demo categories
  const categoryData = [
    { name: 'Seeds', subs: ['Cereal Seeds', 'Vegetable Seeds', 'Legume Seeds'] },
    { name: 'Fertilizers', subs: ['Organic', 'Inorganic', 'Foliar'] },
    { name: 'Pesticides', subs: ['Herbicides', 'Fungicides', 'Insecticides'] },
    { name: 'Farm Equipment', subs: ['Hand Tools', 'Power Tools', 'Irrigation'] },
    { name: 'Animal Feed', subs: ['Poultry Feed', 'Cattle Feed', 'Fish Feed'] },
  ];

  for (const catDef of categoryData) {
    let category = await Category.findOne({ name: catDef.name });
    if (!category) {
      category = await Category.create({ name: catDef.name });
      console.log(`Created category: ${catDef.name}`);
    }
    for (const subName of catDef.subs) {
      const existing = await Subcategory.findOne({ name: subName, category: category._id });
      if (!existing) {
        await Subcategory.create({ name: subName, category: category._id });
        console.log(`  Created subcategory: ${subName}`);
      }
    }
  }

  console.log('\nSeed complete!');
  await mongoose.disconnect();
};

seed().catch((err) => { console.error(err); process.exit(1); });
