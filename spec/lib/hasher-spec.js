'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const FileSystem = require('node:fs');
const Path = require('node:path');
const { createTempDir, removeTempDir, createFile, sha1 } = require('../helpers');

const {
  computeHash,
  isFileSafeToRead,
  setShuttingDown,
  getShuttingDown,
} = require('../../lib/hasher');

// ============================================================================
// isFileSafeToRead
// ============================================================================

describe('isFileSafeToRead', { timeout: 10000 }, () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir('hasher');
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('should allow regular files', () => {
    const filePath = createFile(tempDir, 'regular.txt', 'hello');
    const stat = FileSystem.statSync(filePath);
    const result = isFileSafeToRead(filePath, stat);
    assert.strictEqual(result.safe, true);
  });

  it('should reject FIFO (named pipe)', () => {
    // Create a mock stat that claims to be a FIFO
    const fakeStat = {
      isFIFO:            () => true,
      isSocket:          () => false,
      isCharacterDevice: () => false,
      isBlockDevice:     () => false,
      isFile:            () => false,
    };
    const result = isFileSafeToRead('/fake/fifo', fakeStat);
    assert.strictEqual(result.safe, false);
    assert.ok(result.reason.includes('FIFO'));
  });

  it('should reject sockets', () => {
    const fakeStat = {
      isFIFO:            () => false,
      isSocket:          () => true,
      isCharacterDevice: () => false,
      isBlockDevice:     () => false,
      isFile:            () => false,
    };
    const result = isFileSafeToRead('/fake/socket', fakeStat);
    assert.strictEqual(result.safe, false);
    assert.ok(result.reason.includes('Socket'));
  });

  it('should reject character devices', () => {
    const fakeStat = {
      isFIFO:            () => false,
      isSocket:          () => false,
      isCharacterDevice: () => true,
      isBlockDevice:     () => false,
      isFile:            () => false,
    };
    const result = isFileSafeToRead('/fake/chardev', fakeStat);
    assert.strictEqual(result.safe, false);
    assert.ok(result.reason.includes('Character device'));
  });

  it('should reject block devices', () => {
    const fakeStat = {
      isFIFO:            () => false,
      isSocket:          () => false,
      isCharacterDevice: () => false,
      isBlockDevice:     () => true,
      isFile:            () => false,
    };
    const result = isFileSafeToRead('/fake/blockdev', fakeStat);
    assert.strictEqual(result.safe, false);
    assert.ok(result.reason.includes('Block device'));
  });

  it('should reject non-regular files (e.g. directories)', () => {
    const fakeStat = {
      isFIFO:            () => false,
      isSocket:          () => false,
      isCharacterDevice: () => false,
      isBlockDevice:     () => false,
      isFile:            () => false,
    };
    const result = isFileSafeToRead('/fake/dir', fakeStat);
    assert.strictEqual(result.safe, false);
    assert.ok(result.reason.includes('Not a regular file'));
  });
});

// ============================================================================
// computeHash
// ============================================================================

describe('computeHash', { timeout: 10000 }, () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir('hash');
    setShuttingDown(false);
  });

  afterEach(() => {
    setShuttingDown(false);
    removeTempDir(tempDir);
  });

  it('should compute correct SHA1 hash for known content', async () => {
    const content = 'hello world';
    const filePath = createFile(tempDir, 'known.txt', content);
    const expected = sha1(content);
    const actual = await computeHash(filePath, content.length);
    assert.strictEqual(actual, expected);
  });

  it('should compute correct hash for empty file', async () => {
    const filePath = createFile(tempDir, 'empty.txt', '');
    const expected = sha1('');
    const actual = await computeHash(filePath, 0);
    assert.strictEqual(actual, expected);
  });

  it('should compute correct hash for binary-like content', async () => {
    const content = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
    const filePath = Path.join(tempDir, 'binary.bin');
    FileSystem.writeFileSync(filePath, content);
    const expected = sha1(content);
    const actual = await computeHash(filePath, content.length);
    assert.strictEqual(actual, expected);
  });

  it('should reject on nonexistent file', async () => {
    await assert.rejects(
      computeHash(Path.join(tempDir, 'nonexistent.txt'), 0),
      { code: 'ENOENT' },
    );
  });

  it('should call progress callback for file hashing', async () => {
    const content = 'a'.repeat(10000);
    const filePath = createFile(tempDir, 'progress.txt', content);
    let progressCalled = false;

    await computeHash(filePath, content.length, (bytesRead, totalBytes) => {
      progressCalled = true;
      assert.ok(bytesRead > 0);
      assert.strictEqual(totalBytes, content.length);
    });

    assert.strictEqual(progressCalled, true);
  });
});

// ============================================================================
// Shutdown flag
// ============================================================================

describe('shutdown flag', { timeout: 10000 }, () => {
  afterEach(() => {
    setShuttingDown(false);
  });

  it('should default to false', () => {
    setShuttingDown(false);
    assert.strictEqual(getShuttingDown(), false);
  });

  it('should be settable to true', () => {
    setShuttingDown(true);
    assert.strictEqual(getShuttingDown(), true);
  });

  it('should be resettable', () => {
    setShuttingDown(true);
    setShuttingDown(false);
    assert.strictEqual(getShuttingDown(), false);
  });
});
