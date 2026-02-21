'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const FileSystem = require('node:fs');
const Path = require('node:path');
const { createTempDir, removeTempDir, createStructure } = require('../helpers');
const { setShuttingDown } = require('../../lib/hasher');

const { scanDirectory, scanRoots } = require('../../lib/scanner');
const { DEFAULT_IGNORE_PATTERNS } = require('../../lib/constants');

// ============================================================================
// scanDirectory
// ============================================================================

describe('scanDirectory', { timeout: 10000 }, () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir('scanner');
    setShuttingDown(false);
  });

  afterEach(() => {
    setShuttingDown(false);
    removeTempDir(tempDir);
  });

  it('should find files in a flat directory', () => {
    createStructure(tempDir, {
      'a.txt': 'hello',
      'b.jpg': 'photo',
      'c.pdf': 'document',
    });

    const files = [...scanDirectory(tempDir)].filter((f) => !f._logEntry);
    assert.strictEqual(files.length, 3);
    const names = files.map((f) => Path.basename(f.fullPath));
    assert.ok(names.includes('a.txt'));
    assert.ok(names.includes('b.jpg'));
    assert.ok(names.includes('c.pdf'));
  });

  it('should recursively find files in subdirectories', () => {
    createStructure(tempDir, {
      'root.txt':       'root file',
      'sub/nested.txt': 'nested file',
      'sub/deep/deep.txt': 'deep file',
    });

    const files = [...scanDirectory(tempDir)].filter((f) => !f._logEntry);
    assert.strictEqual(files.length, 3);
  });

  it('should ignore files matching default ignore patterns', () => {
    createStructure(tempDir, {
      'visible.txt': 'visible',
      '.hidden':     'hidden file',
      'node_modules/lib.js': 'module',
    });

    // Must explicitly pass defaultIgnorePatterns — the scanner defaults to []
    // and the constants are injected by the scan command in real usage
    const items = [...scanDirectory(tempDir, { defaultIgnorePatterns: DEFAULT_IGNORE_PATTERNS })];
    const files      = items.filter((f) => !f._logEntry);
    const logEntries = items.filter((f) => f._logEntry);

    assert.strictEqual(files.length, 1);
    assert.strictEqual(Path.basename(files[0].fullPath), 'visible.txt');
    // Should have log entries for ignored items
    assert.ok(logEntries.length > 0);
  });

  it('should ignore files matching custom ignore patterns', () => {
    createStructure(tempDir, {
      'keep.txt': 'keep',
      'skip.bak': 'skip',
    });

    const files = [...scanDirectory(tempDir, { ignorePatterns: ['*.bak'], defaultIgnorePatterns: [] })]
      .filter((f) => !f._logEntry);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(Path.basename(files[0].fullPath), 'keep.txt');
  });

  it('should respect include patterns over ignore patterns', () => {
    createStructure(tempDir, {
      '.env':         'secret',
      '.env.example': 'template',
    });

    const files = [...scanDirectory(tempDir, {
      ignorePatterns:        [],
      includePatterns:       ['.env.example'],
      defaultIgnorePatterns: ['.*'],
    })].filter((f) => !f._logEntry);

    assert.strictEqual(files.length, 1);
    assert.strictEqual(Path.basename(files[0].fullPath), '.env.example');
  });

  it('should exclude database file path', () => {
    const dbPath = Path.join(tempDir, 'test.sqlite');
    createStructure(tempDir, {
      'data.txt':      'data',
      'test.sqlite':   'database',
      'test.sqlite-wal': 'wal',
      'test.sqlite-shm': 'shm',
    });

    const files = [...scanDirectory(tempDir, {
      excludePath:           dbPath,
      defaultIgnorePatterns: [],
    })].filter((f) => !f._logEntry);

    assert.strictEqual(files.length, 1);
    assert.strictEqual(Path.basename(files[0].fullPath), 'data.txt');
  });

  it('should handle symlinks to files', () => {
    createStructure(tempDir, { 'real.txt': 'content' });
    FileSystem.symlinkSync(
      Path.join(tempDir, 'real.txt'),
      Path.join(tempDir, 'link.txt'),
    );

    const files = [...scanDirectory(tempDir, { defaultIgnorePatterns: [] })]
      .filter((f) => !f._logEntry);

    // Should find both the real file and the symlink (resolved to same real path)
    // Actually, symlink resolves to real path, so both entries point to same real file
    assert.ok(files.length >= 1);
  });

  it('should handle broken symlinks gracefully', () => {
    createStructure(tempDir, { 'real.txt': 'content' });
    FileSystem.symlinkSync(
      Path.join(tempDir, 'nonexistent.txt'),
      Path.join(tempDir, 'broken-link.txt'),
    );

    // Should not throw
    const files = [...scanDirectory(tempDir, { defaultIgnorePatterns: [] })]
      .filter((f) => !f._logEntry);

    assert.strictEqual(files.length, 1, 'should find real file but skip broken symlink');
  });

  it('should detect circular symlinks', () => {
    // Create dir_a -> dir_b -> dir_a cycle
    const dirA = Path.join(tempDir, 'dir_a');
    const dirB = Path.join(tempDir, 'dir_b');
    FileSystem.mkdirSync(dirA);
    FileSystem.mkdirSync(dirB);
    createStructure(dirA, { 'file_a.txt': 'a' });
    createStructure(dirB, { 'file_b.txt': 'b' });

    FileSystem.symlinkSync(dirB, Path.join(dirA, 'link_to_b'));
    FileSystem.symlinkSync(dirA, Path.join(dirB, 'link_to_a'));

    // Should not hang, should not throw
    const files = [...scanDirectory(tempDir, { defaultIgnorePatterns: [] })]
      .filter((f) => !f._logEntry);

    // Should find both real files but not loop infinitely
    assert.ok(files.length >= 2, `found ${files.length} files, expected at least 2`);
  });

  it('should yield file stat objects', () => {
    createStructure(tempDir, { 'file.txt': 'content' });

    const files = [...scanDirectory(tempDir, { defaultIgnorePatterns: [] })]
      .filter((f) => !f._logEntry);

    assert.strictEqual(files.length, 1);
    assert.ok(files[0].stat, 'should have stat object');
    assert.ok(files[0].stat.size > 0, 'stat should have size');
    assert.ok(files[0].fullPath, 'should have fullPath');
    assert.ok(files[0].rootPath, 'should have rootPath');
  });

  it('should stop scanning when shutdown is requested', () => {
    // Create many files
    const structure = {};
    for (let i = 0; i < 50; i++)
      structure[`file_${i}.txt`] = `content ${i}`;

    createStructure(tempDir, structure);

    setShuttingDown(true);

    const files = [...scanDirectory(tempDir, { defaultIgnorePatterns: [] })]
      .filter((f) => !f._logEntry);

    // Should find fewer than all 50 files due to shutdown
    assert.ok(files.length < 50, `found ${files.length} files, expected less than 50`);
  });
});

// ============================================================================
// scanRoots
// ============================================================================

describe('scanRoots', { timeout: 10000 }, () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir('scanroots');
    setShuttingDown(false);
  });

  afterEach(() => {
    setShuttingDown(false);
    removeTempDir(tempDir);
  });

  it('should scan multiple roots', () => {
    const root1 = Path.join(tempDir, 'root1');
    const root2 = Path.join(tempDir, 'root2');
    FileSystem.mkdirSync(root1);
    FileSystem.mkdirSync(root2);
    createStructure(root1, { 'a.txt': 'hello' });
    createStructure(root2, { 'b.txt': 'world' });

    const result = scanRoots([root1, root2], { defaultIgnorePatterns: [] });
    assert.strictEqual(result.files.length, 2);
    assert.ok(result.stats.totalFiles === 2);
  });

  it('should skip nonexistent roots gracefully', () => {
    const root1 = Path.join(tempDir, 'exists');
    FileSystem.mkdirSync(root1);
    createStructure(root1, { 'a.txt': 'hello' });

    const result = scanRoots([root1, '/nonexistent/root/path'], { defaultIgnorePatterns: [] });
    assert.strictEqual(result.files.length, 1);
  });

  it('should return log entries for ignored files', () => {
    const root = Path.join(tempDir, 'root');
    FileSystem.mkdirSync(root);
    createStructure(root, {
      'visible.txt': 'ok',
      '.hidden':     'hidden',
    });

    const result = scanRoots([root], { defaultIgnorePatterns: DEFAULT_IGNORE_PATTERNS });
    assert.ok(result.logEntries.length > 0, 'should have log entries');
    assert.ok(result.logEntries.some((e) => e.type === 'ignored'));
  });
});
