'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTempDir, createTempDatabase, captureOutput, removeTempDir } = require('../helpers');
const commandStatus = require('../../commands/status');

let cleanup;

afterEach(() => {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
});

// ============================================================================
// Empty database
// ============================================================================

describe('commandStatus — empty database', { timeout: 10000 }, () => {
  it('should show zero counts for an empty database', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const { lines } = await captureOutput(() =>
      commandStatus(tmp.db, {})
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Total files: 0'));
    assert.ok(text.includes('Unique (by hash): 0'));
    assert.ok(text.includes('Duplicates: 0'));
    assert.ok(text.includes('Synced: 0'));
    assert.ok(text.includes('Pending: 0'));
    assert.ok(text.includes('Unmatched: 0'));
    assert.ok(text.includes('Destination: (not set)'));
    assert.ok(text.includes('Roots: 0'));
  });
});

// ============================================================================
// With files and roots
// ============================================================================

describe('commandStatus — with files', { timeout: 10000 }, () => {
  it('should show correct file counts', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = createTempDir('root');
    tmp.db.addRoot(rootDir);

    // Insert files with known hashes
    tmp.db.upsertFile(`${rootDir}/photo.jpg`, 'aaa111', 1000, Date.now(), new Date().toISOString());
    tmp.db.upsertFile(`${rootDir}/doc.pdf`, 'bbb222', 2000, Date.now(), new Date().toISOString());
    tmp.db.upsertFile(`${rootDir}/song.mp3`, 'ccc333', 3000, Date.now(), new Date().toISOString());

    const { lines } = await captureOutput(() =>
      commandStatus(tmp.db, {})
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Total files: 3'));
    assert.ok(text.includes('Unique (by hash): 3'));
    assert.ok(text.includes('Duplicates: 0'));
    assert.ok(text.includes('Roots: 1'));

    removeTempDir(rootDir);
  });

  it('should show correct duplicate counts', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = createTempDir('root');
    tmp.db.addRoot(rootDir);

    // Two files with the same hash = 1 duplicate
    tmp.db.upsertFile(`${rootDir}/photo1.jpg`, 'aaa111', 1000, Date.now(), new Date().toISOString());
    tmp.db.upsertFile(`${rootDir}/photo2.jpg`, 'aaa111', 1000, Date.now(), new Date().toISOString());
    tmp.db.upsertFile(`${rootDir}/unique.jpg`, 'bbb222', 2000, Date.now(), new Date().toISOString());

    const { lines } = await captureOutput(() =>
      commandStatus(tmp.db, {})
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Total files: 3'));
    assert.ok(text.includes('Unique (by hash): 2'));
    assert.ok(text.includes('Duplicates: 1'));

    removeTempDir(rootDir);
  });

  it('should show synced count', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = createTempDir('root');
    tmp.db.addRoot(rootDir);

    tmp.db.upsertFile(`${rootDir}/photo.jpg`, 'aaa111', 1000, Date.now(), new Date().toISOString());
    tmp.db.markSynced('aaa111', '/dest/Pictures/photo.jpg', `${rootDir}/photo.jpg`, 'photo.jpg', [], []);

    const { lines } = await captureOutput(() =>
      commandStatus(tmp.db, {})
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Synced: 1'));

    removeTempDir(rootDir);
  });
});

// ============================================================================
// Pending and unmatched
// ============================================================================

describe('commandStatus — pending and unmatched', { timeout: 10000 }, () => {
  it('should show pending files that match routing rules', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = createTempDir('root');
    tmp.db.addRoot(rootDir);

    // .jpg matches default routing rule -> Pictures
    tmp.db.upsertFile(`${rootDir}/photo.jpg`, 'aaa111', 1000, Date.now(), new Date().toISOString());

    const { lines } = await captureOutput(() =>
      commandStatus(tmp.db, {})
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Pending: 1'));
    assert.ok(text.includes('Pictures: 1'));

    removeTempDir(rootDir);
  });

  it('should show unmatched files that have no routing rule', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = createTempDir('root');
    tmp.db.addRoot(rootDir);

    // .xyz has no routing rule
    tmp.db.upsertFile(`${rootDir}/data.xyz`, 'aaa111', 1000, Date.now(), new Date().toISOString());

    const { lines } = await captureOutput(() =>
      commandStatus(tmp.db, {})
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Unmatched: 1'));
    assert.ok(text.includes('.xyz: 1'));

    removeTempDir(rootDir);
  });

  it('should not count synced files as pending', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = createTempDir('root');
    tmp.db.addRoot(rootDir);

    tmp.db.upsertFile(`${rootDir}/photo.jpg`, 'aaa111', 1000, Date.now(), new Date().toISOString());
    tmp.db.markSynced('aaa111', '/dest/Pictures/photo.jpg', `${rootDir}/photo.jpg`, 'photo.jpg', [], []);

    const { lines } = await captureOutput(() =>
      commandStatus(tmp.db, {})
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Pending: 0'));

    removeTempDir(rootDir);
  });
});

// ============================================================================
// Destination display
// ============================================================================

describe('commandStatus — destination', { timeout: 10000 }, () => {
  it('should show sync destination when set', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const destDir = createTempDir('dest');
    tmp.db.setSyncDestination(destDir);

    const { lines } = await captureOutput(() =>
      commandStatus(tmp.db, {})
    );

    const text = lines.join('\n');
    assert.ok(text.includes(`Destination: ${destDir}`));

    removeTempDir(destDir);
  });
});
