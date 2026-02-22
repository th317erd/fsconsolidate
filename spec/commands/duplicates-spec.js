'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTempDir, createTempDatabase, captureOutput, removeTempDir } = require('../helpers');
const commandDuplicates = require('../../commands/duplicates');

let cleanup;

afterEach(() => {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
});

// ============================================================================
// No duplicates
// ============================================================================

describe('commandDuplicates — no duplicates', { timeout: 10000 }, () => {
  it('should show zero counts when no files exist', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const { lines } = await captureOutput(() =>
      commandDuplicates(tmp.db, {})
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Unique hashes with duplicates: 0'));
    assert.ok(text.includes('Total duplicate files: 0'));
    assert.ok(text.includes('Wasted space: 0 Bytes'));
  });

  it('should show zero duplicates when all files are unique', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    tmp.db.upsertFile('/root/a.txt', 'aaa111', 100, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/b.txt', 'bbb222', 200, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/c.txt', 'ccc333', 300, Date.now(), new Date().toISOString());

    const { lines } = await captureOutput(() =>
      commandDuplicates(tmp.db, {})
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Unique hashes with duplicates: 0'));
    assert.ok(text.includes('Total duplicate files: 0'));
  });
});

// ============================================================================
// With duplicates
// ============================================================================

describe('commandDuplicates — with duplicates', { timeout: 10000 }, () => {
  it('should correctly count duplicate groups and wasted space', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    // 3 copies of same hash (1 original + 2 duplicates)
    tmp.db.upsertFile('/root/a1.txt', 'aaa111', 1000, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/a2.txt', 'aaa111', 1000, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/a3.txt', 'aaa111', 1000, Date.now(), new Date().toISOString());
    // 2 copies of another hash (1 original + 1 duplicate)
    tmp.db.upsertFile('/root/b1.txt', 'bbb222', 500, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/b2.txt', 'bbb222', 500, Date.now(), new Date().toISOString());
    // Unique file
    tmp.db.upsertFile('/root/c.txt', 'ccc333', 300, Date.now(), new Date().toISOString());

    const { lines } = await captureOutput(() =>
      commandDuplicates(tmp.db, {})
    );

    const text = lines.join('\n');
    // 2 groups have duplicates
    assert.ok(text.includes('Unique hashes with duplicates: 2'));
    // aaa: 3-1=2 dupes, bbb: 2-1=1 dupe = 3 total
    assert.ok(text.includes('Total duplicate files: 3'));
  });

  it('should display paths for duplicate groups', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    tmp.db.upsertFile('/root/photo1.jpg', 'aaa111', 5000, Date.now(), new Date().toISOString());
    tmp.db.upsertFile('/root/photo2.jpg', 'aaa111', 5000, Date.now(), new Date().toISOString());

    const { lines } = await captureOutput(() =>
      commandDuplicates(tmp.db, {})
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Duplicate groups'));
    assert.ok(text.includes('aaa111'));
    assert.ok(text.includes('/root/photo1.jpg'));
    assert.ok(text.includes('/root/photo2.jpg'));
    assert.ok(text.includes('2 copies'));
  });
});

// ============================================================================
// Limit option
// ============================================================================

describe('commandDuplicates — limit', { timeout: 10000 }, () => {
  it('should respect the limit option', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    // Create 5 duplicate groups
    for (let i = 0; i < 5; i++) {
      const hash = `hash${i}`.padEnd(40, '0');
      tmp.db.upsertFile(`/root/f${i}a.txt`, hash, 100, Date.now(), new Date().toISOString());
      tmp.db.upsertFile(`/root/f${i}b.txt`, hash, 100, Date.now(), new Date().toISOString());
    }

    const { lines } = await captureOutput(() =>
      commandDuplicates(tmp.db, { limit: 2 })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Unique hashes with duplicates: 5'));
    assert.ok(text.includes('first 2'));
  });
});
