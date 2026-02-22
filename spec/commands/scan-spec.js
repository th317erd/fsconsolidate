'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const FileSystem = require('node:fs');
const { createTempDir, createTempDatabase, createFile, createStructure, captureOutput, removeTempDir, sha1 } = require('../helpers');
const commandScan = require('../../commands/scan');

let cleanup;
const tempDirs = [];

afterEach(() => {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  for (const dir of tempDirs) {
    try { removeTempDir(dir); } catch (_) {}
  }
  tempDirs.length = 0;
});

function trackDir(dir) {
  tempDirs.push(dir);
  return dir;
}

// ============================================================================
// Basic scan
// ============================================================================

describe('commandScan — basic scan', { timeout: 30000 }, () => {
  it('should scan files and store hashes in database', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = trackDir(createTempDir('scanroot'));
    createStructure(rootDir, {
      'file1.txt': 'hello world',
      'file2.txt': 'goodbye world',
      'subdir/file3.txt': 'nested file',
    });

    await captureOutput(() =>
      commandScan(tmp.db, { roots: [rootDir] })
    );

    // Files should be in the database
    assert.strictEqual(tmp.db.getFileCount(), 3);

    // Hashes should be correct SHA1
    const f1 = tmp.db.getFile(`${rootDir}/file1.txt`);
    assert.strictEqual(f1.hash, sha1('hello world'));

    const f2 = tmp.db.getFile(`${rootDir}/file2.txt`);
    assert.strictEqual(f2.hash, sha1('goodbye world'));

    const f3 = tmp.db.getFile(`${rootDir}/subdir/file3.txt`);
    assert.strictEqual(f3.hash, sha1('nested file'));
  });

  it('should add root to database when scanning with -r', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = trackDir(createTempDir('scanroot'));
    createFile(rootDir, 'test.txt', 'data');

    await captureOutput(() =>
      commandScan(tmp.db, { roots: [rootDir] })
    );

    const roots = tmp.db.getRoots();
    assert.strictEqual(roots.length, 1);
    assert.ok(roots[0].includes('scanroot'));
  });

  it('should store file sizes', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = trackDir(createTempDir('scanroot'));
    const content = 'known content for size test';
    createFile(rootDir, 'sized.txt', content);

    await captureOutput(() =>
      commandScan(tmp.db, { roots: [rootDir] })
    );

    const f = tmp.db.getFile(`${rootDir}/sized.txt`);
    assert.strictEqual(f.size, Buffer.byteLength(content));
  });
});

// ============================================================================
// Incremental re-scan
// ============================================================================

describe('commandScan — incremental', { timeout: 30000 }, () => {
  it('should skip unchanged files on re-scan (cached)', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = trackDir(createTempDir('scanroot'));
    createFile(rootDir, 'stable.txt', 'stable content');

    // First scan
    const { lines: lines1 } = await captureOutput(() =>
      commandScan(tmp.db, { roots: [rootDir] })
    );

    const countBefore = tmp.db.getFileCount();
    assert.strictEqual(countBefore, 1);

    // Second scan — file unchanged, should be cached
    const { lines: lines2 } = await captureOutput(() =>
      commandScan(tmp.db, { roots: [] })
    );

    const text2 = lines2.join('\n');
    // Should show "cached" in the output
    assert.ok(text2.includes('cached'));

    // Database should still have 1 file
    assert.strictEqual(tmp.db.getFileCount(), 1);
  });

  it('should re-hash modified files', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = trackDir(createTempDir('scanroot'));
    const filePath = createFile(rootDir, 'changing.txt', 'original content');

    // First scan
    await captureOutput(() =>
      commandScan(tmp.db, { roots: [rootDir] })
    );

    const original = tmp.db.getFile(filePath);
    assert.strictEqual(original.hash, sha1('original content'));

    // Modify the file (change content and ensure mtime changes)
    // Need a slight delay to ensure mtime differs
    const future = new Date(Date.now() + 2000);
    FileSystem.writeFileSync(filePath, 'modified content');
    FileSystem.utimesSync(filePath, future, future);

    // Second scan
    await captureOutput(() =>
      commandScan(tmp.db, { roots: [] })
    );

    const modified = tmp.db.getFile(filePath);
    assert.strictEqual(modified.hash, sha1('modified content'));
    assert.notStrictEqual(modified.hash, original.hash);
  });

  it('should pick up new files on re-scan', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = trackDir(createTempDir('scanroot'));
    createFile(rootDir, 'first.txt', 'first');

    // First scan
    await captureOutput(() =>
      commandScan(tmp.db, { roots: [rootDir] })
    );

    assert.strictEqual(tmp.db.getFileCount(), 1);

    // Add a new file
    createFile(rootDir, 'second.txt', 'second');

    // Second scan
    await captureOutput(() =>
      commandScan(tmp.db, { roots: [] })
    );

    assert.strictEqual(tmp.db.getFileCount(), 2);
  });
});

// ============================================================================
// Ignore patterns
// ============================================================================

describe('commandScan — ignore patterns', { timeout: 30000 }, () => {
  it('should skip files matching default ignore patterns', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = trackDir(createTempDir('scanroot'));
    createStructure(rootDir, {
      'good.txt':               'good file',
      'node_modules/lib.js':    'ignored module',
      '.hidden':                'hidden file',
    });

    await captureOutput(() =>
      commandScan(tmp.db, { roots: [rootDir] })
    );

    // Only good.txt should be in database
    assert.strictEqual(tmp.db.getFileCount(), 1);
    assert.ok(tmp.db.getFile(`${rootDir}/good.txt`));
  });

  it('should skip files matching custom ignore patterns', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = trackDir(createTempDir('scanroot'));
    createStructure(rootDir, {
      'keep.txt':  'keep',
      'skip.bak':  'skip this',
    });

    tmp.db.addIgnorePattern('*.bak');

    await captureOutput(() =>
      commandScan(tmp.db, { roots: [rootDir] })
    );

    assert.strictEqual(tmp.db.getFileCount(), 1);
    assert.ok(tmp.db.getFile(`${rootDir}/keep.txt`));
  });
});

// ============================================================================
// Scan log
// ============================================================================

describe('commandScan — scan log', { timeout: 30000 }, () => {
  it('should populate scan log with ignored entries', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = trackDir(createTempDir('scanroot'));
    createStructure(rootDir, {
      'good.txt':               'good file',
      'node_modules/lib.js':    'ignored module',
    });

    await captureOutput(() =>
      commandScan(tmp.db, { roots: [rootDir] })
    );

    // scan_log should have the ignored file
    const logCount = tmp.db.getScanLogCount('ignored');
    assert.ok(logCount > 0);
  });
});

// ============================================================================
// Multiple roots
// ============================================================================

describe('commandScan — multiple roots', { timeout: 30000 }, () => {
  it('should scan multiple roots and store all files', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const root1 = trackDir(createTempDir('root1'));
    const root2 = trackDir(createTempDir('root2'));

    createFile(root1, 'a.txt', 'from root 1');
    createFile(root2, 'b.txt', 'from root 2');

    await captureOutput(() =>
      commandScan(tmp.db, { roots: [root1, root2] })
    );

    assert.strictEqual(tmp.db.getFileCount(), 2);
    assert.strictEqual(tmp.db.getRoots().length, 2);
  });
});

// ============================================================================
// Console output
// ============================================================================

describe('commandScan — output', { timeout: 30000 }, () => {
  it('should output scan statistics', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = trackDir(createTempDir('scanroot'));
    createFile(rootDir, 'test.txt', 'test data');

    const { lines } = await captureOutput(() =>
      commandScan(tmp.db, { roots: [rootDir] })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Scanning'));
    assert.ok(text.includes('Total files:'));
    assert.ok(text.includes('Scan complete!'));
  });
});
