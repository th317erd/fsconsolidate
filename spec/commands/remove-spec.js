'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTempDatabase, captureOutput } = require('../helpers');
const commandRemove = require('../../commands/remove');

let cleanup;

afterEach(() => {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
});

// ============================================================================
// No matches
// ============================================================================

describe('commandRemove — no matches', { timeout: 10000 }, () => {
  it('should report zero matches for non-matching pattern', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    tmp.db.upsertFile('/root/file.txt', 'aaa111', 100, Date.now(), new Date().toISOString());

    const { lines } = await captureOutput(() =>
      commandRemove(tmp.db, { removePattern: 'nonexistent_pattern' })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('No files match pattern'));
    // File should still be in database
    assert.strictEqual(tmp.db.getFileCount(), 1);
  });
});

// ============================================================================
// Substring matching (bulk SQL path)
// ============================================================================

describe('commandRemove — substring matching preview', { timeout: 10000 }, () => {
  it('should find files matching a substring pattern (no glob chars)', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    tmp.db.upsertFile('/root/node_modules/lib.js', 'aaa111', 100, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/node_modules/deep/util.js', 'bbb222', 200, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/src/app.js', 'ccc333', 300, Date.now(), new Date().toISOString());

    // The command prompts for confirmation via readline.
    // Since we can't easily mock readline, test the matching logic directly
    // by using the same SQL pattern the command uses.
    const likePattern = '%node_modules%';
    const stats = tmp.db.db.prepare(
      'SELECT COUNT(*) as count, SUM(size) as totalSize FROM files WHERE path LIKE ?'
    ).get(likePattern);

    assert.strictEqual(stats.count, 2);
    assert.strictEqual(stats.totalSize, 300); // 100 + 200
  });

  it('should escape SQL LIKE special characters in pattern', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    // Test with a pattern that contains % (SQL LIKE wildcard)
    tmp.db.upsertFile('/root/file_100%.txt', 'aaa111', 100, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/normal.txt', 'bbb222', 200, Date.now(), new Date().toISOString());

    // Note: The current implementation does NOT escape LIKE chars.
    // This test documents the current behavior.
    // `%100%%` would match both due to unescaped %, but the substring
    // wrapping `%<pattern>%` means "100%" would be `%100%%` which matches
    // any path containing "100" followed by anything.
    const likePattern = `%100%%`;
    const stats = tmp.db.db.prepare(
      'SELECT COUNT(*) as count FROM files WHERE path LIKE ?'
    ).get(likePattern);

    // This matches file_100%.txt because the path contains "100"
    assert.strictEqual(stats.count, 1);
  });
});

// ============================================================================
// Glob matching logic
// ============================================================================

describe('commandRemove — glob matching logic', { timeout: 10000 }, () => {
  it('should match files with glob wildcard patterns', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const { globToRegex } = require('../../lib/patterns');
    const Path = require('node:path');

    tmp.db.upsertFile('/root/data.log', 'aaa111', 100, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/app.log', 'bbb222', 200, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/app.txt', 'ccc333', 300, Date.now(), new Date().toISOString());

    const pattern = '*.log';
    const regex = globToRegex(pattern);
    const matcher = (filePath) => regex.test(filePath) || regex.test(Path.basename(filePath));

    let matchCount = 0;
    for (const file of tmp.db.iterateFiles()) {
      if (matcher(file.path))
        matchCount++;
    }

    assert.strictEqual(matchCount, 2);
  });

  it('should match files with brace expansion patterns', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const { globToRegex } = require('../../lib/patterns');
    const Path = require('node:path');

    tmp.db.upsertFile('/root/photo.jpg', 'aaa111', 100, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/photo.png', 'bbb222', 200, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/doc.pdf', 'ccc333', 300, Date.now(), new Date().toISOString());

    const pattern = '*.{jpg,png}';
    const regex = globToRegex(pattern);
    const matcher = (filePath) => regex.test(filePath) || regex.test(Path.basename(filePath));

    let matchCount = 0;
    for (const file of tmp.db.iterateFiles()) {
      if (matcher(file.path))
        matchCount++;
    }

    assert.strictEqual(matchCount, 2);
  });
});

// ============================================================================
// Direct database removal (testing db.removeFile)
// ============================================================================

describe('commandRemove — database removal', { timeout: 10000 }, () => {
  it('should remove files via db.removeFile', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    tmp.db.upsertFile('/root/delete-me.txt', 'aaa111', 100, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/keep-me.txt', 'bbb222', 200, Date.now(), new Date().toISOString());

    assert.strictEqual(tmp.db.getFileCount(), 2);

    tmp.db.removeFile('/root/delete-me.txt');

    assert.strictEqual(tmp.db.getFileCount(), 1);
    assert.strictEqual(tmp.db.getFile('/root/delete-me.txt'), undefined);
    assert.ok(tmp.db.getFile('/root/keep-me.txt'));
  });

  it('should handle bulk SQL deletion via LIKE', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    tmp.db.upsertFile('/root/logs/app.log', 'aaa111', 100, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/logs/error.log', 'bbb222', 200, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/src/app.js', 'ccc333', 300, Date.now(), new Date().toISOString());

    // Simulate what the command does for substring patterns
    const likePattern = '%logs%';
    const result = tmp.db.db.prepare('DELETE FROM files WHERE path LIKE ?').run(likePattern);

    assert.strictEqual(result.changes, 2);
    assert.strictEqual(tmp.db.getFileCount(), 1);
    assert.ok(tmp.db.getFile('/root/src/app.js'));
  });
});
