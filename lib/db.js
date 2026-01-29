'use strict';

const Database = require('better-sqlite3');
const Path = require('node:path');
const FileSystem = require('node:fs');
const { DEFAULT_IGNORE_PATTERNS, DEFAULT_ROUTING_RULES } = require('./constants');
const { getShuttingDown } = require('./hasher');
const migrations = require('../migrations');

/**
 * SQLite Database wrapper for file-helper
 *
 * Schema:
 * - meta: key-value store for metadata (created, updated, version)
 * - config: key-value store for configuration (sync_destination)
 * - roots: root paths to scan
 * - ignore_patterns: patterns to ignore (is_default flag)
 * - include_patterns: patterns to include (override ignores)
 * - routing_rules: pattern -> destination mappings (is_default flag)
 * - files: path, hash, size, mtime_ms, mtime, error
 * - synced: hash, dest_path, source_path, chosen_filename, synced_at
 * - synced_sources: hash -> source_path (all source paths)
 * - synced_filenames: hash -> filename (all filenames)
 */
class FileDatabase {
  constructor(dbPath) {
    const resolved = Path.resolve(dbPath);
    // Use realpathSync if the file exists, otherwise resolve for new databases
    this.dbPath = FileSystem.existsSync(resolved)
      ? FileSystem.realpathSync(resolved)
      : resolved;
    this.db = null;
  }

  /**
   * Open database connection and initialize schema
   */
  open() {
    // Ensure directory exists
    const dir = Path.dirname(this.dbPath);
    if (!FileSystem.existsSync(dir))
      FileSystem.mkdirSync(dir, { recursive: true });

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this._initSchema();
    this._ensureDefaults();

    return this;
  }

  /**
   * Close database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Initialize database schema
   */
  _initSchema() {
    this.db.exec(`
      -- Metadata
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      -- Configuration
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      -- Root paths to scan
      CREATE TABLE IF NOT EXISTS roots (
        path TEXT PRIMARY KEY
      );

      -- Per-root options
      CREATE TABLE IF NOT EXISTS root_options (
        root_path TEXT NOT NULL,
        option_key TEXT NOT NULL,
        option_value TEXT,
        PRIMARY KEY (root_path, option_key)
      );

      -- Ignore patterns
      CREATE TABLE IF NOT EXISTS ignore_patterns (
        pattern TEXT PRIMARY KEY,
        is_default INTEGER DEFAULT 0
      );

      -- Include patterns (override ignores)
      CREATE TABLE IF NOT EXISTS include_patterns (
        pattern TEXT PRIMARY KEY
      );

      -- Routing rules
      CREATE TABLE IF NOT EXISTS routing_rules (
        pattern TEXT PRIMARY KEY,
        dest TEXT NOT NULL,
        description TEXT,
        is_default INTEGER DEFAULT 0
      );

      -- Scanned files
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT,
        size INTEGER,
        mtime_ms REAL,
        mtime TEXT,
        error TEXT,
        target_sync_location TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);

      -- Synced files (by hash)
      CREATE TABLE IF NOT EXISTS synced (
        hash TEXT PRIMARY KEY,
        dest_path TEXT NOT NULL,
        source_path TEXT,
        chosen_filename TEXT,
        synced_at TEXT
      );

      -- All source paths for a synced hash
      CREATE TABLE IF NOT EXISTS synced_sources (
        hash TEXT NOT NULL,
        source_path TEXT NOT NULL,
        PRIMARY KEY (hash, source_path),
        FOREIGN KEY (hash) REFERENCES synced(hash) ON DELETE CASCADE
      );

      -- All filenames for a synced hash
      CREATE TABLE IF NOT EXISTS synced_filenames (
        hash TEXT NOT NULL,
        filename TEXT NOT NULL,
        PRIMARY KEY (hash, filename),
        FOREIGN KEY (hash) REFERENCES synced(hash) ON DELETE CASCADE
      );
    `);

    // Set initial metadata
    // Derive latest version from migrations list, fallback to 2.0
    const latestVersion = (migrations.length > 0)
      ? migrations[migrations.length - 1].version
      : 2.0;

    const existingVersion = this._getMeta('version');
    if (!existingVersion) {
      this._setMeta('version', String(latestVersion));
      this._setMeta('created', new Date().toISOString());
    }

    // Run any pending migrations
    this._runMigrations();
  }

  /**
   * Versioned migration system
   *
   * Migrations are loaded from migrations/index.js. Each exports:
   *   { version: number, description: string, migrate(db): void }
   *
   * Migrations run in order, only if the current schema version is below
   * the migration's version. After each migration, the version is bumped.
   *
   * For brand-new databases, _initSchema() creates the latest schema
   * directly, so migrations only run on existing databases that need
   * upgrading.
   */
  _runMigrations() {
    const currentVersion = parseFloat(this._getMeta('version') || '2.0');

    for (let migration of migrations) {
      if (currentVersion < migration.version) {
        try {
          this.db.transaction(() => {
            migration.migrate(this.db);
            this._setMeta('version', String(migration.version));
          })();
          console.log(`  [Migration ${migration.version}] ${migration.description}`);
        } catch (err) {
          console.error(`  [Migration ${migration.version}] FAILED: ${err.message}`);
          console.error(`  Database is at version ${this._getMeta('version')}. Aborting.`);
          process.exit(1);
        }
      }
    }
  }

  /**
   * Ensure default patterns and rules exist
   */
  _ensureDefaults() {
    const insertIgnore = this.db.prepare(
      'INSERT OR IGNORE INTO ignore_patterns (pattern, is_default) VALUES (?, 1)'
    );
    const insertRule = this.db.prepare(
      'INSERT OR IGNORE INTO routing_rules (pattern, dest, description, is_default) VALUES (?, ?, ?, 1)'
    );

    const insertMany = this.db.transaction(() => {
      for (let pattern of DEFAULT_IGNORE_PATTERNS)
        insertIgnore.run(pattern);

      for (let rule of DEFAULT_ROUTING_RULES)
        insertRule.run(rule.pattern, rule.dest, rule.description);
    });

    insertMany();
  }

  // ============================================================================
  // Meta helpers
  // ============================================================================

  _getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return (row) ? row.value : null;
  }

  _setMeta(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  /**
   * Update the 'updated' timestamp
   */
  touch() {
    this._setMeta('updated', new Date().toISOString());
  }

  // ============================================================================
  // Config
  // ============================================================================

  getSyncDestination() {
    const row = this.db.prepare('SELECT value FROM config WHERE key = ?').get('sync_destination');
    return (row) ? row.value : null;
  }

  setSyncDestination(path) {
    const resolved = (path) ? FileSystem.realpathSync(Path.resolve(path)) : null;
    if (resolved)
      this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('sync_destination', resolved);
    else
      this.db.prepare('DELETE FROM config WHERE key = ?').run('sync_destination');

    this.touch();
  }

  // ============================================================================
  // Roots
  // ============================================================================

  getRoots() {
    return this.db.prepare('SELECT path FROM roots ORDER BY path').all().map((r) => r.path);
  }

  addRoot(rootPath) {
    const resolved = FileSystem.realpathSync(Path.resolve(rootPath));
    this.db.prepare('INSERT OR IGNORE INTO roots (path) VALUES (?)').run(resolved);
    this.touch();
    return resolved;
  }

  removeRoot(rootPath) {
    const resolved = FileSystem.realpathSync(Path.resolve(rootPath));
    const result = this.db.prepare('DELETE FROM roots WHERE path = ?').run(resolved);
    this.touch();
    return result.changes > 0;
  }

  // ============================================================================
  // Root Options
  // ============================================================================

  /**
   * Get a single option for a root
   */
  getRootOption(rootPath, key) {
    const row = this.db.prepare(
      'SELECT option_value FROM root_options WHERE root_path = ? AND option_key = ?'
    ).get(rootPath, key);
    return (row) ? row.option_value : null;
  }

  /**
   * Get all options for a root as an object
   */
  getRootOptions(rootPath) {
    const rows = this.db.prepare(
      'SELECT option_key, option_value FROM root_options WHERE root_path = ?'
    ).all(rootPath);
    const options = {};
    for (let row of rows)
      options[row.option_key] = row.option_value;
    return options;
  }

  /**
   * Set an option for a root
   */
  setRootOption(rootPath, key, value) {
    const resolved = FileSystem.realpathSync(Path.resolve(rootPath));
    // Verify root exists
    const root = this.db.prepare('SELECT path FROM roots WHERE path = ?').get(resolved);
    if (!root)
      return false;

    this.db.prepare(
      'INSERT OR REPLACE INTO root_options (root_path, option_key, option_value) VALUES (?, ?, ?)'
    ).run(resolved, key, value);
    this.touch();
    return true;
  }

  /**
   * Remove an option for a root
   */
  removeRootOption(rootPath, key) {
    const resolved = FileSystem.realpathSync(Path.resolve(rootPath));
    const result = this.db.prepare(
      'DELETE FROM root_options WHERE root_path = ? AND option_key = ?'
    ).run(resolved, key);
    this.touch();
    return result.changes > 0;
  }

  /**
   * Find which root a file belongs to (longest matching prefix)
   */
  findRootForFile(filePath) {
    const roots = this.getRoots();
    let bestMatch = null;
    let bestLen = 0;

    for (let root of roots) {
      const prefix = root.endsWith('/') ? root : root + '/';
      if (filePath.startsWith(prefix) && prefix.length > bestLen) {
        bestMatch = root;
        bestLen = prefix.length;
      }
    }

    return bestMatch;
  }

  /**
   * Check if move_on_sync is enabled for the root that contains a file
   */
  isMoveOnSync(filePath) {
    const root = this.findRootForFile(filePath);
    if (!root)
      return false;
    const val = this.getRootOption(root, 'move_on_sync');
    return val === 'true';
  }

  // ============================================================================
  // File Removal
  // ============================================================================

  /**
   * Remove a single file record from the database
   */
  removeFile(filePath) {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
  }

  // ============================================================================
  // Patterns
  // ============================================================================

  getIgnorePatterns() {
    return this.db.prepare('SELECT pattern FROM ignore_patterns WHERE is_default = 0 ORDER BY pattern')
      .all().map((r) => r.pattern);
  }

  getDefaultIgnorePatterns() {
    return this.db.prepare('SELECT pattern FROM ignore_patterns WHERE is_default = 1 ORDER BY pattern')
      .all().map((r) => r.pattern);
  }

  getAllIgnorePatterns() {
    return this.db.prepare('SELECT pattern FROM ignore_patterns ORDER BY pattern')
      .all().map((r) => r.pattern);
  }

  addIgnorePattern(pattern) {
    this.db.prepare('INSERT OR IGNORE INTO ignore_patterns (pattern, is_default) VALUES (?, 0)').run(pattern);
    this.touch();
  }

  removeIgnorePattern(pattern) {
    const result = this.db.prepare('DELETE FROM ignore_patterns WHERE pattern = ? AND is_default = 0').run(pattern);
    this.touch();
    return result.changes > 0;
  }

  getIncludePatterns() {
    return this.db.prepare('SELECT pattern FROM include_patterns ORDER BY pattern')
      .all().map((r) => r.pattern);
  }

  addIncludePattern(pattern) {
    this.db.prepare('INSERT OR IGNORE INTO include_patterns (pattern) VALUES (?)').run(pattern);
    this.touch();
  }

  removeIncludePattern(pattern) {
    const result = this.db.prepare('DELETE FROM include_patterns WHERE pattern = ?').run(pattern);
    this.touch();
    return result.changes > 0;
  }

  // ============================================================================
  // Routing Rules
  // ============================================================================

  getRoutingRules() {
    return this.db.prepare('SELECT pattern, dest, description FROM routing_rules WHERE is_default = 0 ORDER BY rowid')
      .all();
  }

  getDefaultRoutingRules() {
    return this.db.prepare('SELECT pattern, dest, description FROM routing_rules WHERE is_default = 1 ORDER BY rowid')
      .all();
  }

  getAllRoutingRules() {
    // User rules first, then defaults
    return this.db.prepare('SELECT pattern, dest, description, is_default FROM routing_rules ORDER BY is_default, rowid')
      .all();
  }

  addRoutingRule(pattern, dest, description = 'User rule') {
    this.db.prepare(
      'INSERT OR REPLACE INTO routing_rules (pattern, dest, description, is_default) VALUES (?, ?, ?, 0)'
    ).run(pattern, dest, description);
    this.touch();
  }

  removeRoutingRule(pattern) {
    const result = this.db.prepare('DELETE FROM routing_rules WHERE pattern = ? AND is_default = 0').run(pattern);
    this.touch();
    return result.changes > 0;
  }

  // ============================================================================
  // Files
  // ============================================================================

  getFileCount() {
    return this.db.prepare('SELECT COUNT(*) as count FROM files').get().count;
  }

  getFile(filePath) {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(filePath);
  }

  /**
   * Iterate over all files (memory efficient)
   */
  *iterateFiles() {
    const stmt = this.db.prepare('SELECT * FROM files');
    for (let row of stmt.iterate()) {
      if (getShuttingDown()) return;
      yield row;
    }
  }

  /**
   * Get files matching a filter function (streams results)
   */
  *iterateFilesWhere(filterFn) {
    for (let file of this.iterateFiles()) {
      if (getShuttingDown()) return;
      if (filterFn(file))
        yield file;
    }
  }

  /**
   * Get files by hash
   */
  getFilesByHash(hash) {
    return this.db.prepare('SELECT * FROM files WHERE hash = ?').all(hash);
  }

  /**
   * Check if a file needs rehashing based on mtime/size
   */
  needsRehash(filePath, stat) {
    const cached = this.getFile(filePath);
    if (!cached)
      return true;

    return cached.size !== stat.size || cached.mtime_ms !== stat.mtimeMs;
  }

  /**
   * Upsert a file record
   */
  upsertFile(filePath, hash, size, mtimeMs, mtime, error = null) {
    this.db.prepare(`
      INSERT OR REPLACE INTO files (path, hash, size, mtime_ms, mtime, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(filePath, hash, size, mtimeMs, mtime, error);
  }

  /**
   * Batch upsert files (more efficient for bulk operations)
   */
  upsertFiles(files) {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO files (path, hash, size, mtime_ms, mtime, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((items) => {
      for (let f of items)
        insert.run(f.path, f.hash, f.size, f.mtimeMs, f.mtime, f.error || null);
    });

    insertMany(files);
    this.touch();
  }

  /**
   * Remove a file from the database
   */
  removeFile(filePath) {
    const result = this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
    return result.changes > 0;
  }

  /**
   * Remove files matching a predicate (memory efficient)
   */
  removeFilesWhere(filterFn) {
    const toRemove = [];
    for (let file of this.iterateFiles()) {
      if (getShuttingDown()) break;
      if (filterFn(file))
        toRemove.push(file.path);
    }

    if (toRemove.length === 0)
      return 0;

    const deleteStmt = this.db.prepare('DELETE FROM files WHERE path = ?');
    const deleteMany = this.db.transaction((paths) => {
      for (let path of paths)
        deleteStmt.run(path);
    });

    deleteMany(toRemove);
    this.touch();
    return toRemove.length;
  }

  /**
   * Get unique hashes with count
   */
  getUniqueHashCount() {
    return this.db.prepare('SELECT COUNT(DISTINCT hash) as count FROM files WHERE hash IS NOT NULL').get().count;
  }

  /**
   * Get total size of all files
   */
  getTotalSize() {
    const result = this.db.prepare('SELECT SUM(size) as total FROM files').get();
    return result.total || 0;
  }

  /**
   * Get size of unique files (by hash)
   */
  getUniqueSize() {
    const result = this.db.prepare(`
      SELECT SUM(size) as total FROM (
        SELECT hash, MIN(size) as size FROM files
        WHERE hash IS NOT NULL
        GROUP BY hash
      )
    `).get();
    return result.total || 0;
  }

  /**
   * Get count and total size of unique files (single query)
   */
  getUniqueFilesStats() {
    const result = this.db.prepare(`
      SELECT COUNT(*) as count, SUM(size) as totalSize FROM (
        SELECT hash, MIN(size) as size FROM files
        WHERE hash IS NOT NULL
        GROUP BY hash
      )
    `).get();
    return {
      count:     result.count || 0,
      totalSize: result.totalSize || 0,
    };
  }

  /**
   * Find all duplicate file groups (returns hash -> paths)
   */
  *iterateDuplicates() {
    const stmt = this.db.prepare(`
      SELECT hash, GROUP_CONCAT(path, '|||') as paths, COUNT(*) as count, MIN(size) as size
      FROM files
      WHERE hash IS NOT NULL
      GROUP BY hash
      HAVING count > 1
      ORDER BY count DESC
    `);

    for (let row of stmt.iterate()) {
      if (getShuttingDown()) return;
      yield {
        hash:  row.hash,
        paths: row.paths.split('|||'),
        count: row.count,
        size:  row.size,
      };
    }
  }

  // ============================================================================
  // Target Sync Location
  // ============================================================================

  /**
   * Get target sync location for a file
   */
  getTargetSyncLocation(filePath) {
    const row = this.db.prepare('SELECT target_sync_location FROM files WHERE path = ?').get(filePath);
    return (row) ? row.target_sync_location : null;
  }

  /**
   * Set target sync location for a file
   */
  setTargetSyncLocation(filePath, target) {
    this.db.prepare('UPDATE files SET target_sync_location = ? WHERE path = ?').run(target, filePath);
    this.touch();
  }

  /**
   * Batch set target sync location for multiple files
   */
  setTargetSyncLocationBatch(filePaths, target) {
    const update = this.db.prepare('UPDATE files SET target_sync_location = ? WHERE path = ?');
    const updateMany = this.db.transaction((paths) => {
      for (let path of paths)
        update.run(target, path);
    });
    updateMany(filePaths);
    this.touch();
  }

  /**
   * Get all files in a directory (siblings)
   */
  getFilesInDirectory(dirPath) {
    const normalized = dirPath.endsWith('/') ? dirPath : dirPath + '/';
    return this.db.prepare(`
      SELECT * FROM files
      WHERE path LIKE ? AND path NOT LIKE ?
    `).all(normalized + '%', normalized + '%/%');
  }

  /**
   * Iterate files within sync destination (for hash matching)
   */
  *iterateFilesInDestination(destPath) {
    const normalized = destPath.endsWith('/') ? destPath : destPath + '/';
    const stmt = this.db.prepare('SELECT * FROM files WHERE path LIKE ?');
    for (let row of stmt.iterate(normalized + '%')) {
      if (getShuttingDown()) return;
      yield row;
    }
  }

  /**
   * Iterate files NOT in destination with NULL target_sync_location
   */
  *iterateUnassignedFilesOutsideDestination(destPath) {
    const normalized = destPath.endsWith('/') ? destPath : destPath + '/';
    const stmt = this.db.prepare(`
      SELECT * FROM files
      WHERE path NOT LIKE ?
        AND target_sync_location IS NULL
        AND hash IS NOT NULL
    `);
    for (let row of stmt.iterate(normalized + '%')) {
      if (getShuttingDown()) return;
      yield row;
    }
  }

  /**
   * Get statistics about target_sync_location assignments
   */
  getTargetAssignmentStats() {
    const assigned = this.db.prepare(`
      SELECT COUNT(*) as count FROM files
      WHERE target_sync_location IS NOT NULL
    `).get().count;

    const unassigned = this.db.prepare(`
      SELECT COUNT(*) as count FROM files
      WHERE target_sync_location IS NULL AND hash IS NOT NULL
    `).get().count;

    return { assigned, unassigned };
  }

  /**
   * Get files grouped by root
   */
  getFileCountByRoot(roots) {
    const results = {};
    for (let root of roots) {
      const count = this.db.prepare('SELECT COUNT(*) as count FROM files WHERE path LIKE ?')
        .get(root + '%');
      results[root] = count.count;
    }
    return results;
  }

  // ============================================================================
  // Synced
  // ============================================================================

  getSyncedCount() {
    return this.db.prepare('SELECT COUNT(*) as count FROM synced').get().count;
  }

  getSynced(hash) {
    const synced = this.db.prepare('SELECT * FROM synced WHERE hash = ?').get(hash);
    if (!synced)
      return null;

    synced.allSourcePaths = this.db.prepare('SELECT source_path FROM synced_sources WHERE hash = ?')
      .all(hash).map((r) => r.source_path);
    synced.allFilenames = this.db.prepare('SELECT filename FROM synced_filenames WHERE hash = ?')
      .all(hash).map((r) => r.filename);

    return synced;
  }

  isSynced(hash) {
    const row = this.db.prepare('SELECT 1 FROM synced WHERE hash = ?').get(hash);
    return !!row;
  }

  /**
   * Iterate over all synced records
   */
  *iterateSynced() {
    const stmt = this.db.prepare('SELECT * FROM synced');
    for (let row of stmt.iterate()) {
      if (getShuttingDown()) return;
      row.allSourcePaths = this.db.prepare('SELECT source_path FROM synced_sources WHERE hash = ?')
        .all(row.hash).map((r) => r.source_path);
      row.allFilenames = this.db.prepare('SELECT filename FROM synced_filenames WHERE hash = ?')
        .all(row.hash).map((r) => r.filename);
      yield row;
    }
  }

  /**
   * Mark a file as synced
   */
  markSynced(hash, destPath, sourcePath, chosenFilename, allSourcePaths, allFilenames) {
    const insertSynced = this.db.prepare(`
      INSERT OR REPLACE INTO synced (hash, dest_path, source_path, chosen_filename, synced_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const deleteSources = this.db.prepare('DELETE FROM synced_sources WHERE hash = ?');
    const deleteFilenames = this.db.prepare('DELETE FROM synced_filenames WHERE hash = ?');
    const insertSource = this.db.prepare('INSERT OR IGNORE INTO synced_sources (hash, source_path) VALUES (?, ?)');
    const insertFilename = this.db.prepare('INSERT OR IGNORE INTO synced_filenames (hash, filename) VALUES (?, ?)');

    const syncedAt = new Date().toISOString();

    const transaction = this.db.transaction(() => {
      insertSynced.run(hash, destPath, sourcePath, chosenFilename, syncedAt);

      // Clear and re-insert sources/filenames
      deleteSources.run(hash);
      deleteFilenames.run(hash);

      for (let sp of (allSourcePaths || []))
        insertSource.run(hash, sp);

      for (let fn of (allFilenames || []))
        insertFilename.run(hash, fn);
    });

    transaction();
    this.touch();
  }

  // ============================================================================
  // Reset
  // ============================================================================

  /**
   * Reset config to defaults (keeps file data)
   */
  resetConfig() {
    this.db.exec(`
      DELETE FROM ignore_patterns;
      DELETE FROM routing_rules;
    `);
    this._ensureDefaults();
    this.touch();
  }

  // ============================================================================
  // Stats
  // ============================================================================

  getStats() {
    return {
      fileCount:       this.getFileCount(),
      uniqueHashCount: this.getUniqueHashCount(),
      totalSize:       this.getTotalSize(),
      uniqueSize:      this.getUniqueSize(),
      syncedCount:     this.getSyncedCount(),
      rootCount:       this.getRoots().length,
    };
  }
}

module.exports = FileDatabase;
