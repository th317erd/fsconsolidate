'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTempDatabase, captureOutput } = require('../helpers');
const commandGarbage = require('../../commands/garbage');

let cleanup;

afterEach(() => {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
});

// ============================================================================
// List ignored files (default subcommand)
// ============================================================================

describe('commandGarbage — list', { timeout: 10000 }, () => {
  it('should output nothing when scan log is empty', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const { lines } = await captureOutput(() =>
      commandGarbage(tmp.db, {})
    );

    assert.strictEqual(lines.length, 0);
  });

  it('should list ignored paths from scan log', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    // Populate scan log with ignored entries
    tmp.db.insertScanLogBatch([
      { path: '/root/.hidden', type: 'ignored', pattern: '.*', matchedOn: 'default' },
      { path: '/root/node_modules/x.js', type: 'ignored', pattern: 'node_modules', matchedOn: 'default' },
      { path: '/root/good.txt', type: 'scanned', pattern: '', matchedOn: '' },
    ]);

    const { lines } = await captureOutput(() =>
      commandGarbage(tmp.db, {})
    );

    // Should only list ignored entries
    assert.strictEqual(lines.length, 2);
    assert.ok(lines.some((l) => l.includes('.hidden')));
    assert.ok(lines.some((l) => l.includes('node_modules/x.js')));
  });

  it('should not list scanned entries', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    tmp.db.insertScanLogBatch([
      { path: '/root/good.txt', type: 'scanned', pattern: '', matchedOn: '' },
    ]);

    const { lines } = await captureOutput(() =>
      commandGarbage(tmp.db, {})
    );

    assert.strictEqual(lines.length, 0);
  });
});

// ============================================================================
// Clean subcommand
// ============================================================================

describe('commandGarbage — clean', { timeout: 10000 }, () => {
  it('should remove matching files from database', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    // Add files to database
    tmp.db.upsertFile('/root/.hidden', 'aaa111', 100, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/node_modules/x.js', 'bbb222', 200, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/good.txt', 'ccc333', 300, Date.now(), new Date().toISOString());

    // Add scan log entries marking some as ignored
    tmp.db.insertScanLogBatch([
      { path: '/root/.hidden', type: 'ignored', pattern: '.*', matchedOn: 'default' },
      { path: '/root/node_modules/x.js', type: 'ignored', pattern: 'node_modules', matchedOn: 'default' },
    ]);

    assert.strictEqual(tmp.db.getFileCount(), 3);

    const { lines } = await captureOutput(() =>
      commandGarbage(tmp.db, { garbageSubcommand: 'clean' })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Removed 2 entries'));
    assert.strictEqual(tmp.db.getFileCount(), 1);
    assert.ok(tmp.db.getFile('/root/good.txt'));
  });

  it('should remove 0 entries when scan log has no ignored paths in files table', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    // Files in database don't match scan log paths
    tmp.db.upsertFile('/root/good.txt', 'ccc333', 300, Date.now(), new Date().toISOString());

    tmp.db.insertScanLogBatch([
      { path: '/root/.hidden', type: 'ignored', pattern: '.*', matchedOn: 'default' },
    ]);

    const { lines } = await captureOutput(() =>
      commandGarbage(tmp.db, { garbageSubcommand: 'clean' })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Removed 0 entries'));
    assert.strictEqual(tmp.db.getFileCount(), 1);
  });

  it('should handle empty scan log gracefully', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    tmp.db.upsertFile('/root/good.txt', 'ccc333', 300, Date.now(), new Date().toISOString());

    const { lines } = await captureOutput(() =>
      commandGarbage(tmp.db, { garbageSubcommand: 'clean' })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Removed 0 entries'));
    assert.strictEqual(tmp.db.getFileCount(), 1);
  });
});
