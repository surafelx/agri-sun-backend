const ActivityLog = require('../models/ActivityLog');

const log = async (userId, action, entityType, entityId = null, details = null) => {
  try {
    await ActivityLog.create({ user: userId, action, entityType, entityId, details });
  } catch (err) {
    console.error('Activity log error:', err.message);
  }
};

module.exports = { log };
