'use strict';

module.exports = {
  version:     2.01,
  description: 'Add target_sync_location column to files',
  migrate(db) {
    const has = db.prepare(
      "SELECT COUNT(*) as count FROM pragma_table_info('files') WHERE name = 'target_sync_location'"
    ).get();
    if (has.count === 0)
      db.exec('ALTER TABLE files ADD COLUMN target_sync_location TEXT');
  },
};
