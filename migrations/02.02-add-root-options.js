'use strict';

module.exports = {
  version:     2.02,
  description: 'Add root_options table',
  migrate(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS root_options (
        root_path TEXT NOT NULL,
        option_key TEXT NOT NULL,
        option_value TEXT,
        PRIMARY KEY (root_path, option_key)
      )
    `);
  },
};
