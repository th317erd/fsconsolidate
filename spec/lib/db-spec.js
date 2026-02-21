'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTempDatabase, createTempDir, removeTempDir } = require('../helpers');

// ============================================================================
// Database Lifecycle
// ============================================================================

describe('FileDatabase lifecycle', { timeout: 10000 }, () => {
  let db;
  let cleanup;

  beforeEach(() => {
    ({ db, cleanup } = createTempDatabase());
  });

  afterEach(() => {
    cleanup();
  });

  it('should open and close without error', () => {
    assert.ok(db.db, 'db handle should exist after open');
    db.close();
    assert.strictEqual(db.db, null, 'db handle should be null after close');
  });

  it('should be safe to close twice', () => {
    db.close();
    db.close(); // should not throw
  });

  it('should set initial metadata on open', () => {
    const version = db._getMeta('version');
    assert.ok(version, 'version should be set');
    assert.ok(parseFloat(version) >= 2.0, 'version should be >= 2.0');

    const created = db._getMeta('created');
    assert.ok(created, 'created timestamp should be set');
  });

  it('should create default ignore patterns', () => {
    const defaults = db.getDefaultIgnorePatterns();
    assert.ok(defaults.length > 0, 'should have default ignore patterns');
    assert.ok(defaults.includes('node_modules'), 'should include node_modules');
    assert.ok(defaults.includes('.*'), 'should include .* pattern');
  });

  it('should create default routing rules', () => {
    const defaults = db.getDefaultRoutingRules();
    assert.ok(defaults.length > 0, 'should have default routing rules');
    const dests = defaults.map((r) => r.dest);
    assert.ok(dests.includes('Pictures'), 'should route to Pictures');
    assert.ok(dests.includes('Videos'), 'should route to Videos');
  });
});

// ============================================================================
// Roots
// ============================================================================

describe('FileDatabase roots', { timeout: 10000 }, () => {
  let db;
  let cleanup;
  let tempDir;

  beforeEach(() => {
    ({ db, cleanup } = createTempDatabase());
    tempDir = createTempDir('root');
  });

  afterEach(() => {
    cleanup();
    removeTempDir(tempDir);
  });

  it('should start with no roots', () => {
    const roots = db.getRoots();
    assert.deepStrictEqual(roots, []);
  });

  it('should add and retrieve a root', () => {
    db.addRoot(tempDir);
    const roots = db.getRoots();
    assert.strictEqual(roots.length, 1);
    assert.ok(roots[0].includes('root'), 'should contain resolved path');
  });

  it('should not add duplicate roots', () => {
    db.addRoot(tempDir);
    db.addRoot(tempDir);
    const roots = db.getRoots();
    assert.strictEqual(roots.length, 1);
  });

  it('should remove a root', () => {
    const resolved = db.addRoot(tempDir);
    const removed = db.removeRoot(resolved);
    assert.strictEqual(removed, true);
    assert.deepStrictEqual(db.getRoots(), []);
  });

  it('should return false when removing non-existent root', () => {
    const removed = db.removeRoot('/nonexistent/path/that/does/not/exist');
    assert.strictEqual(removed, false);
  });

  it('should find the correct root for a file path', () => {
    const resolved = db.addRoot(tempDir);
    const filePath = resolved + '/subdir/file.txt';
    assert.strictEqual(db.findRootForFile(filePath), resolved);
  });

  it('should return null for file not under any root', () => {
    db.addRoot(tempDir);
    assert.strictEqual(db.findRootForFile('/some/other/path/file.txt'), null);
  });
});

// ============================================================================
// Root Options
// ============================================================================

describe('FileDatabase root options', { timeout: 10000 }, () => {
  let db;
  let cleanup;
  let tempDir;
  let resolvedRoot;

  beforeEach(() => {
    ({ db, cleanup } = createTempDatabase());
    tempDir = createTempDir('root-opts');
    resolvedRoot = db.addRoot(tempDir);
  });

  afterEach(() => {
    cleanup();
    removeTempDir(tempDir);
  });

  it('should set and get a root option', () => {
    db.setRootOption(resolvedRoot, 'move_on_sync', 'true');
    assert.strictEqual(db.getRootOption(resolvedRoot, 'move_on_sync'), 'true');
  });

  it('should return null for non-existent option', () => {
    assert.strictEqual(db.getRootOption(resolvedRoot, 'nonexistent'), null);
  });

  it('should return false when setting option on non-existent root', () => {
    const result = db.setRootOption('/fake/root/path', 'key', 'value');
    assert.strictEqual(result, false);
  });

  it('should get all options for a root', () => {
    db.setRootOption(resolvedRoot, 'opt_a', 'val_a');
    db.setRootOption(resolvedRoot, 'opt_b', 'val_b');
    const options = db.getRootOptions(resolvedRoot);
    assert.deepStrictEqual(options, { opt_a: 'val_a', opt_b: 'val_b' });
  });

  it('should check move_on_sync via isMoveOnSync', () => {
    const filePath = resolvedRoot + '/file.txt';
    assert.strictEqual(db.isMoveOnSync(filePath), false);

    db.setRootOption(resolvedRoot, 'move_on_sync', 'true');
    assert.strictEqual(db.isMoveOnSync(filePath), true);
  });

  it('should remove a root option', () => {
    db.setRootOption(resolvedRoot, 'key', 'value');
    const removed = db.removeRootOption(resolvedRoot, 'key');
    assert.strictEqual(removed, true);
    assert.strictEqual(db.getRootOption(resolvedRoot, 'key'), null);
  });
});

// ============================================================================
// Files
// ============================================================================

describe('FileDatabase files', { timeout: 10000 }, () => {
  let db;
  let cleanup;

  beforeEach(() => {
    ({ db, cleanup } = createTempDatabase());
  });

  afterEach(() => {
    cleanup();
  });

  it('should start with zero files', () => {
    assert.strictEqual(db.getFileCount(), 0);
  });

  it('should upsert and retrieve a file', () => {
    db.upsertFile('/test/file.txt', 'abc123', 1024, 1700000000000, '2023-11-14T22:13:20.000Z');
    const file = db.getFile('/test/file.txt');
    assert.ok(file);
    assert.strictEqual(file.hash, 'abc123');
    assert.strictEqual(file.size, 1024);
    assert.strictEqual(file.mtime_ms, 1700000000000);
  });

  it('should update existing file on upsert (preserving created_at)', () => {
    db.upsertFile('/test/file.txt', 'hash1', 100, 1000, '2023-01-01');
    const first = db.getFile('/test/file.txt');

    db.upsertFile('/test/file.txt', 'hash2', 200, 2000, '2023-06-01');
    const second = db.getFile('/test/file.txt');

    assert.strictEqual(second.hash, 'hash2');
    assert.strictEqual(second.size, 200);
    assert.strictEqual(second.created_at, first.created_at, 'created_at should be preserved');
  });

  it('should batch upsert files', () => {
    db.upsertFiles([
      { path: '/a.txt', hash: 'h1', size: 10, mtimeMs: 1000, mtime: '2023-01-01' },
      { path: '/b.txt', hash: 'h2', size: 20, mtimeMs: 2000, mtime: '2023-01-02' },
      { path: '/c.txt', hash: 'h3', size: 30, mtimeMs: 3000, mtime: '2023-01-03' },
    ]);
    assert.strictEqual(db.getFileCount(), 3);
  });

  it('should detect when file needs rehashing', () => {
    db.upsertFile('/test/file.txt', 'hash1', 1024, 1700000000000, '2023-11-14');

    // Same mtime and size — no rehash needed
    assert.strictEqual(db.needsRehash('/test/file.txt', { size: 1024, mtimeMs: 1700000000000 }), false);

    // Different size — needs rehash
    assert.strictEqual(db.needsRehash('/test/file.txt', { size: 2048, mtimeMs: 1700000000000 }), true);

    // Different mtime — needs rehash
    assert.strictEqual(db.needsRehash('/test/file.txt', { size: 1024, mtimeMs: 1800000000000 }), true);

    // File not in database — needs rehash
    assert.strictEqual(db.needsRehash('/nonexistent.txt', { size: 100, mtimeMs: 1000 }), true);
  });

  it('should remove a file', () => {
    db.upsertFile('/test/file.txt', 'hash1', 100, 1000, '2023-01-01');
    assert.strictEqual(db.getFileCount(), 1);
    db.removeFile('/test/file.txt');
    assert.strictEqual(db.getFileCount(), 0);
  });

  it('should remove files matching a predicate', () => {
    db.upsertFiles([
      { path: '/keep/a.txt', hash: 'h1', size: 10, mtimeMs: 1000, mtime: '2023-01-01' },
      { path: '/remove/b.txt', hash: 'h2', size: 20, mtimeMs: 2000, mtime: '2023-01-02' },
      { path: '/remove/c.txt', hash: 'h3', size: 30, mtimeMs: 3000, mtime: '2023-01-03' },
    ]);

    const removed = db.removeFilesWhere((f) => f.path.startsWith('/remove/'));
    assert.strictEqual(removed, 2);
    assert.strictEqual(db.getFileCount(), 1);
    assert.ok(db.getFile('/keep/a.txt'));
  });

  it('should get files by hash', () => {
    db.upsertFiles([
      { path: '/a.txt', hash: 'same_hash', size: 100, mtimeMs: 1000, mtime: '2023-01-01' },
      { path: '/b.txt', hash: 'same_hash', size: 100, mtimeMs: 2000, mtime: '2023-01-02' },
      { path: '/c.txt', hash: 'different', size: 50, mtimeMs: 3000, mtime: '2023-01-03' },
    ]);

    const files = db.getFilesByHash('same_hash');
    assert.strictEqual(files.length, 2);
  });

  it('should iterate all files via generator', () => {
    db.upsertFiles([
      { path: '/a.txt', hash: 'h1', size: 10, mtimeMs: 1000, mtime: '2023-01-01' },
      { path: '/b.txt', hash: 'h2', size: 20, mtimeMs: 2000, mtime: '2023-01-02' },
    ]);

    const files = [...db.iterateFiles()];
    assert.strictEqual(files.length, 2);
  });

  it('should iterate files with filter', () => {
    db.upsertFiles([
      { path: '/a.txt', hash: 'h1', size: 10, mtimeMs: 1000, mtime: '2023-01-01' },
      { path: '/b.txt', hash: 'h2', size: 200, mtimeMs: 2000, mtime: '2023-01-02' },
    ]);

    const large = [...db.iterateFilesWhere((f) => f.size > 100)];
    assert.strictEqual(large.length, 1);
    assert.strictEqual(large[0].path, '/b.txt');
  });
});

// ============================================================================
// Duplicates
// ============================================================================

describe('FileDatabase duplicates', { timeout: 10000 }, () => {
  let db;
  let cleanup;

  beforeEach(() => {
    ({ db, cleanup } = createTempDatabase());
  });

  afterEach(() => {
    cleanup();
  });

  it('should find duplicate file groups', () => {
    db.upsertFiles([
      { path: '/backup1/photo.jpg', hash: 'dupe_hash', size: 5000, mtimeMs: 1000, mtime: '2023-01-01' },
      { path: '/backup2/photo.jpg', hash: 'dupe_hash', size: 5000, mtimeMs: 2000, mtime: '2023-01-02' },
      { path: '/unique/doc.pdf',    hash: 'unique_hash', size: 3000, mtimeMs: 3000, mtime: '2023-01-03' },
    ]);

    const dupes = [...db.iterateDuplicates()];
    assert.strictEqual(dupes.length, 1);
    assert.strictEqual(dupes[0].hash, 'dupe_hash');
    assert.strictEqual(dupes[0].count, 2);
    assert.strictEqual(dupes[0].paths.length, 2);
  });

  it('should not report unique files as duplicates', () => {
    db.upsertFiles([
      { path: '/a.txt', hash: 'h1', size: 10, mtimeMs: 1000, mtime: '2023-01-01' },
      { path: '/b.txt', hash: 'h2', size: 20, mtimeMs: 2000, mtime: '2023-01-02' },
    ]);

    const dupes = [...db.iterateDuplicates()];
    assert.strictEqual(dupes.length, 0);
  });

  it('should not include files with null hash in duplicates', () => {
    db.upsertFiles([
      { path: '/a.txt', hash: null, size: 10, mtimeMs: 1000, mtime: '2023-01-01' },
      { path: '/b.txt', hash: null, size: 10, mtimeMs: 2000, mtime: '2023-01-02' },
    ]);

    const dupes = [...db.iterateDuplicates()];
    assert.strictEqual(dupes.length, 0);
  });
});

// ============================================================================
// Stats
// ============================================================================

describe('FileDatabase stats', { timeout: 10000 }, () => {
  let db;
  let cleanup;

  beforeEach(() => {
    ({ db, cleanup } = createTempDatabase());
  });

  afterEach(() => {
    cleanup();
  });

  it('should report correct stats for empty database', () => {
    const stats = db.getStats();
    assert.strictEqual(stats.fileCount, 0);
    assert.strictEqual(stats.uniqueHashCount, 0);
    assert.strictEqual(stats.totalSize, 0);
    assert.strictEqual(stats.uniqueSize, 0);
    assert.strictEqual(stats.syncedCount, 0);
  });

  it('should report correct stats with files and duplicates', () => {
    db.upsertFiles([
      { path: '/a.txt', hash: 'h1', size: 1000, mtimeMs: 1000, mtime: '2023-01-01' },
      { path: '/b.txt', hash: 'h1', size: 1000, mtimeMs: 2000, mtime: '2023-01-02' },
      { path: '/c.txt', hash: 'h2', size: 500,  mtimeMs: 3000, mtime: '2023-01-03' },
    ]);

    assert.strictEqual(db.getFileCount(), 3);
    assert.strictEqual(db.getUniqueHashCount(), 2);
    assert.strictEqual(db.getTotalSize(), 2500); // 1000 + 1000 + 500
    assert.strictEqual(db.getUniqueSize(), 1500); // 1000 + 500
  });

  it('should report unique file stats in single query', () => {
    db.upsertFiles([
      { path: '/a.txt', hash: 'h1', size: 1000, mtimeMs: 1000, mtime: '2023-01-01' },
      { path: '/b.txt', hash: 'h1', size: 1000, mtimeMs: 2000, mtime: '2023-01-02' },
      { path: '/c.txt', hash: 'h2', size: 500,  mtimeMs: 3000, mtime: '2023-01-03' },
    ]);

    const stats = db.getUniqueFilesStats();
    assert.strictEqual(stats.count, 2);
    assert.strictEqual(stats.totalSize, 1500);
  });
});

// ============================================================================
// Synced Records
// ============================================================================

describe('FileDatabase synced', { timeout: 10000 }, () => {
  let db;
  let cleanup;

  beforeEach(() => {
    ({ db, cleanup } = createTempDatabase());
  });

  afterEach(() => {
    cleanup();
  });

  it('should mark a file as synced and retrieve it', () => {
    db.markSynced(
      'test_hash',
      '/dest/photo.jpg',
      '/source/photo.jpg',
      'photo.jpg',
      ['/source/photo.jpg', '/backup/photo.jpg'],
      ['photo.jpg', 'photo_copy.jpg'],
    );

    assert.strictEqual(db.isSynced('test_hash'), true);
    assert.strictEqual(db.getSyncedCount(), 1);

    const synced = db.getSynced('test_hash');
    assert.strictEqual(synced.dest_path, '/dest/photo.jpg');
    assert.strictEqual(synced.chosen_filename, 'photo.jpg');
    assert.deepStrictEqual(synced.allSourcePaths.sort(), ['/backup/photo.jpg', '/source/photo.jpg']);
    assert.deepStrictEqual(synced.allFilenames.sort(), ['photo.jpg', 'photo_copy.jpg']);
  });

  it('should return false for unsynced hash', () => {
    assert.strictEqual(db.isSynced('nonexistent'), false);
    assert.strictEqual(db.getSynced('nonexistent'), null);
  });

  it('should iterate synced records with sources and filenames', () => {
    db.markSynced('h1', '/dest/a.txt', '/src/a.txt', 'a.txt', ['/src/a.txt'], ['a.txt']);
    db.markSynced('h2', '/dest/b.txt', '/src/b.txt', 'b.txt', ['/src/b.txt'], ['b.txt']);

    const all = [...db.iterateSynced()];
    assert.strictEqual(all.length, 2);
    assert.ok(all[0].allSourcePaths, 'should have allSourcePaths populated');
    assert.ok(all[0].allFilenames, 'should have allFilenames populated');
  });

  it('should update synced record on re-sync (preserving created_at)', () => {
    db.markSynced('h1', '/dest/old.txt', '/src/old.txt', 'old.txt', [], []);
    const first = db.getSynced('h1');

    db.markSynced('h1', '/dest/new.txt', '/src/new.txt', 'new.txt', [], []);
    const second = db.getSynced('h1');

    assert.strictEqual(second.dest_path, '/dest/new.txt');
    assert.strictEqual(second.created_at, first.created_at, 'created_at should be preserved');
  });
});

// ============================================================================
// Patterns
// ============================================================================

describe('FileDatabase patterns', { timeout: 10000 }, () => {
  let db;
  let cleanup;

  beforeEach(() => {
    ({ db, cleanup } = createTempDatabase());
  });

  afterEach(() => {
    cleanup();
  });

  it('should add and retrieve custom ignore pattern', () => {
    db.addIgnorePattern('*.bak');
    const customs = db.getIgnorePatterns();
    assert.ok(customs.includes('*.bak'));
  });

  it('should not remove default ignore patterns', () => {
    const removed = db.removeIgnorePattern('node_modules');
    assert.strictEqual(removed, false, 'should not remove default pattern');
  });

  it('should remove custom ignore pattern', () => {
    db.addIgnorePattern('*.bak');
    const removed = db.removeIgnorePattern('*.bak');
    assert.strictEqual(removed, true);
    assert.ok(!db.getIgnorePatterns().includes('*.bak'));
  });

  it('should add and retrieve include pattern', () => {
    db.addIncludePattern('.env.example');
    const includes = db.getIncludePatterns();
    assert.ok(includes.includes('.env.example'));
  });

  it('should remove include pattern', () => {
    db.addIncludePattern('.env.example');
    const removed = db.removeIncludePattern('.env.example');
    assert.strictEqual(removed, true);
  });
});

// ============================================================================
// Routing Rules
// ============================================================================

describe('FileDatabase routing rules', { timeout: 10000 }, () => {
  let db;
  let cleanup;

  beforeEach(() => {
    ({ db, cleanup } = createTempDatabase());
  });

  afterEach(() => {
    cleanup();
  });

  it('should add a custom routing rule', () => {
    db.addRoutingRule('*.psd', 'Photoshop', 'Photoshop files');
    const rules = db.getRoutingRules();
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].pattern, '*.psd');
    assert.strictEqual(rules[0].dest, 'Photoshop');
  });

  it('should list custom rules before defaults', () => {
    db.addRoutingRule('*.psd', 'Photoshop');
    const all = db.getAllRoutingRules();
    assert.strictEqual(all[0].pattern, '*.psd', 'custom rule should be first');
    assert.strictEqual(all[0].is_default, 0);
  });

  it('should not remove default routing rules', () => {
    const defaults = db.getDefaultRoutingRules();
    const removed = db.removeRoutingRule(defaults[0].pattern);
    assert.strictEqual(removed, false);
  });

  it('should remove custom routing rule', () => {
    db.addRoutingRule('*.psd', 'Photoshop');
    const removed = db.removeRoutingRule('*.psd');
    assert.strictEqual(removed, true);
    assert.strictEqual(db.getRoutingRules().length, 0);
  });
});

// ============================================================================
// Target Sync Location
// ============================================================================

describe('FileDatabase target sync location', { timeout: 10000 }, () => {
  let db;
  let cleanup;

  beforeEach(() => {
    ({ db, cleanup } = createTempDatabase());
    db.upsertFiles([
      { path: '/root/a.txt', hash: 'h1', size: 10, mtimeMs: 1000, mtime: '2023-01-01' },
      { path: '/root/b.txt', hash: 'h2', size: 20, mtimeMs: 2000, mtime: '2023-01-02' },
      { path: '/root/c.txt', hash: 'h3', size: 30, mtimeMs: 3000, mtime: '2023-01-03' },
    ]);
  });

  afterEach(() => {
    cleanup();
  });

  it('should set and get target sync location', () => {
    db.setTargetSyncLocation('/root/a.txt', 'Pictures');
    assert.strictEqual(db.getTargetSyncLocation('/root/a.txt'), 'Pictures');
  });

  it('should return null for unset target', () => {
    assert.strictEqual(db.getTargetSyncLocation('/root/a.txt'), null);
  });

  it('should batch set target sync locations', () => {
    db.setTargetSyncLocationBatch(['/root/a.txt', '/root/b.txt'], 'Documents');
    assert.strictEqual(db.getTargetSyncLocation('/root/a.txt'), 'Documents');
    assert.strictEqual(db.getTargetSyncLocation('/root/b.txt'), 'Documents');
    assert.strictEqual(db.getTargetSyncLocation('/root/c.txt'), null);
  });

  it('should get assignment stats', () => {
    db.setTargetSyncLocation('/root/a.txt', 'Pictures');
    const stats = db.getTargetAssignmentStats();
    assert.strictEqual(stats.assigned, 1);
    assert.strictEqual(stats.unassigned, 2);
  });
});

// ============================================================================
// Scan Log
// ============================================================================

describe('FileDatabase scan log', { timeout: 10000 }, () => {
  let db;
  let cleanup;

  beforeEach(() => {
    ({ db, cleanup } = createTempDatabase());
  });

  afterEach(() => {
    cleanup();
  });

  it('should insert and retrieve scan log entries', () => {
    db.insertScanLogBatch([
      { path: '/root/.git', type: 'ignored', pattern: '.*', matchedOn: 'original' },
      { path: '/root/node_modules', type: 'ignored', pattern: 'node_modules', matchedOn: 'original' },
    ]);

    assert.strictEqual(db.getScanLogCount(), 2);
    assert.strictEqual(db.getScanLogCount('ignored'), 2);
  });

  it('should clear scan log', () => {
    db.insertScanLogBatch([
      { path: '/root/.git', type: 'ignored', pattern: '.*', matchedOn: 'original' },
    ]);
    db.clearScanLog();
    assert.strictEqual(db.getScanLogCount(), 0);
  });

  it('should get pattern summary', () => {
    db.insertScanLogBatch([
      { path: '/root/.git', type: 'ignored', pattern: '.*', matchedOn: 'original' },
      { path: '/root/.env', type: 'ignored', pattern: '.*', matchedOn: 'original' },
      { path: '/root/node_modules', type: 'ignored', pattern: 'node_modules', matchedOn: 'original' },
    ]);

    const summary = db.getScanLogPatternSummary('ignored');
    assert.ok(summary.length > 0);
    const dotPattern = summary.find((s) => s.pattern === '.*');
    assert.strictEqual(dotPattern.count, 2);
  });

  it('should iterate scan log entries filtered by type', () => {
    db.insertScanLogBatch([
      { path: '/root/.git', type: 'ignored', pattern: '.*', matchedOn: 'original' },
      { path: '/root/include', type: 'included', pattern: '.env.example', matchedOn: 'original' },
    ]);

    const ignored = [...db.iterateScanLog('ignored')];
    assert.strictEqual(ignored.length, 1);
    assert.strictEqual(ignored[0].path, '/root/.git');
  });
});

// ============================================================================
// Config
// ============================================================================

describe('FileDatabase config', { timeout: 10000 }, () => {
  let db;
  let cleanup;
  let tempDir;

  beforeEach(() => {
    ({ db, cleanup } = createTempDatabase());
    tempDir = createTempDir('dest');
  });

  afterEach(() => {
    cleanup();
    removeTempDir(tempDir);
  });

  it('should set and get sync destination', () => {
    db.setSyncDestination(tempDir);
    const dest = db.getSyncDestination();
    assert.ok(dest);
  });

  it('should clear sync destination with null', () => {
    db.setSyncDestination(tempDir);
    db.setSyncDestination(null);
    assert.strictEqual(db.getSyncDestination(), null);
  });

  it('should throw when setting sync destination to invalid path', () => {
    // BUG: realpathSync crashes without try-catch on non-existent path
    assert.throws(() => {
      db.setSyncDestination('/absolutely/nonexistent/path/that/cannot/exist');
    }, { code: 'ENOENT' });
  });

  it('should reset config to defaults', () => {
    db.addIgnorePattern('*.custom');
    db.addRoutingRule('*.custom', 'Custom');
    db.resetConfig();

    assert.strictEqual(db.getIgnorePatterns().length, 0, 'custom ignore patterns should be cleared');
    assert.strictEqual(db.getRoutingRules().length, 0, 'custom routing rules should be cleared');
    assert.ok(db.getDefaultIgnorePatterns().length > 0, 'default ignores should be restored');
    assert.ok(db.getDefaultRoutingRules().length > 0, 'default rules should be restored');
  });
});

// ============================================================================
// getFilesInDirectory
// ============================================================================

describe('FileDatabase getFilesInDirectory', { timeout: 10000 }, () => {
  let db;
  let cleanup;

  beforeEach(() => {
    ({ db, cleanup } = createTempDatabase());
    db.upsertFiles([
      { path: '/root/dir/a.txt', hash: 'h1', size: 10, mtimeMs: 1000, mtime: '2023-01-01' },
      { path: '/root/dir/b.txt', hash: 'h2', size: 20, mtimeMs: 2000, mtime: '2023-01-02' },
      { path: '/root/dir/sub/c.txt', hash: 'h3', size: 30, mtimeMs: 3000, mtime: '2023-01-03' },
      { path: '/other/d.txt', hash: 'h4', size: 40, mtimeMs: 4000, mtime: '2023-01-04' },
    ]);
  });

  afterEach(() => {
    cleanup();
  });

  it('should return files in directory but not subdirectories', () => {
    const files = db.getFilesInDirectory('/root/dir');
    assert.strictEqual(files.length, 2);
    const paths = files.map((f) => f.path);
    assert.ok(paths.includes('/root/dir/a.txt'));
    assert.ok(paths.includes('/root/dir/b.txt'));
    assert.ok(!paths.includes('/root/dir/sub/c.txt'));
  });
});
