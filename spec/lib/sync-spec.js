'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const FileSystem = require('node:fs');
const Path = require('node:path');
const { createTempDir, removeTempDir, createFile, createStructure } = require('../helpers');

const { copyFileToDestination, isSameDevice } = require('../../lib/sync');

// ============================================================================
// isSameDevice
// ============================================================================

describe('isSameDevice', { timeout: 10000 }, () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir('sync-device');
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('should return true for files on same device', () => {
    createFile(tempDir, 'a.txt', 'aaa');
    createFile(tempDir, 'b.txt', 'bbb');
    assert.strictEqual(isSameDevice(
      Path.join(tempDir, 'a.txt'),
      Path.join(tempDir, 'b.txt'),
    ), true);
  });

  it('should return false for nonexistent paths', () => {
    assert.strictEqual(isSameDevice('/nonexistent/a', '/nonexistent/b'), false);
  });
});

// ============================================================================
// copyFileToDestination
// ============================================================================

describe('copyFileToDestination', { timeout: 10000 }, () => {
  let tempDir;
  let sourceDir;
  let destDir;

  beforeEach(() => {
    tempDir = createTempDir('sync-copy');
    sourceDir = Path.join(tempDir, 'source');
    destDir   = Path.join(tempDir, 'dest');
    FileSystem.mkdirSync(sourceDir);
    FileSystem.mkdirSync(destDir);
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('should copy a file to the destination', () => {
    const sourcePath = createFile(sourceDir, 'file.txt', 'hello world');
    const result = copyFileToDestination(sourcePath, destDir, 'Documents', 'file.txt');

    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.moved, false);
    assert.ok(FileSystem.existsSync(result.path));
    assert.strictEqual(FileSystem.readFileSync(result.path, 'utf8'), 'hello world');
    // Source should still exist (copy, not move)
    assert.ok(FileSystem.existsSync(sourcePath));
  });

  it('should create destination subdirectory if it does not exist', () => {
    const sourcePath = createFile(sourceDir, 'photo.jpg', 'jpeg-data');
    const result = copyFileToDestination(sourcePath, destDir, 'Pictures/Vacation', 'photo.jpg');

    assert.ok(FileSystem.existsSync(Path.join(destDir, 'Pictures', 'Vacation')));
    assert.ok(FileSystem.existsSync(result.path));
  });

  it('should skip copy when dest exists with same size and mtime', () => {
    const content = 'identical content';
    const sourcePath = createFile(sourceDir, 'same.txt', content);

    // First copy
    copyFileToDestination(sourcePath, destDir, 'test', 'same.txt');

    // Copy the source again to update dest mtime to match
    // Actually, to make mtimes match we need to copy stat
    const destPath = Path.join(destDir, 'test', 'same.txt');
    const sourceStat = FileSystem.statSync(sourcePath);
    FileSystem.utimesSync(destPath, sourceStat.atime, sourceStat.mtime);

    // Second copy should skip
    const result = copyFileToDestination(sourcePath, destDir, 'test', 'same.txt');
    assert.strictEqual(result.skipped, true);
  });

  it('should throw when dest exists with different content', () => {
    createFile(sourceDir, 'conflict.txt', 'version 1');
    copyFileToDestination(
      Path.join(sourceDir, 'conflict.txt'), destDir, 'test', 'conflict.txt'
    );

    // Modify source to have different content/size
    FileSystem.writeFileSync(Path.join(sourceDir, 'conflict.txt'), 'version 2 - longer');

    assert.throws(() => {
      copyFileToDestination(
        Path.join(sourceDir, 'conflict.txt'), destDir, 'test', 'conflict.txt'
      );
    }, /File exists with different content/);
  });

  it('should move a file when moveFile option is true', () => {
    const sourcePath = createFile(sourceDir, 'moveme.txt', 'moving');
    const result = copyFileToDestination(sourcePath, destDir, 'Moved', 'moveme.txt', { moveFile: true });

    assert.strictEqual(result.moved, true);
    assert.strictEqual(result.skipped, false);
    assert.ok(FileSystem.existsSync(result.path), 'dest should exist');
    assert.ok(!FileSystem.existsSync(sourcePath), 'source should be gone');
  });

  it('should preserve file content during copy', () => {
    const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]);
    const sourcePath = Path.join(sourceDir, 'binary.bin');
    FileSystem.writeFileSync(sourcePath, binaryContent);

    const result = copyFileToDestination(sourcePath, destDir, 'Data', 'binary.bin');
    const copied = FileSystem.readFileSync(result.path);
    assert.deepStrictEqual(copied, binaryContent);
  });

  // ============================================================================
  // BUG TEST: mtime tolerance is 1ms but should be ~1000ms (1 second)
  // ============================================================================

  it('BUG: should treat files as identical when mtime differs by less than 1 second', () => {
    // Filesystem mtime precision is typically 1 second (or 2 seconds on FAT).
    // The current code uses `< 1` (1ms tolerance), which means:
    // - Files copied to a different filesystem might have mtime rounded to the nearest second
    // - A file with source mtime 1700000000.500 and dest mtime 1700000000.000
    //   differs by 500ms, which SHOULD be considered identical but ISN'T.
    //
    // This test verifies the fix: tolerance should be >= 1000ms.

    const content = 'test content for mtime';
    const sourcePath = createFile(sourceDir, 'mtime.txt', content);

    // First copy
    copyFileToDestination(sourcePath, destDir, 'test', 'mtime.txt');
    const destPath = Path.join(destDir, 'test', 'mtime.txt');

    // Shift dest mtime by 500ms (half a second)
    const sourceStat = FileSystem.statSync(sourcePath);
    const shiftedMtime = new Date(sourceStat.mtimeMs - 500);
    FileSystem.utimesSync(destPath, sourceStat.atime, shiftedMtime);

    // With correct tolerance (>= 1s), this should SKIP (same file, trivial mtime diff)
    // With buggy tolerance (< 1ms), this will THROW (thinks files are different)
    const result = copyFileToDestination(sourcePath, destDir, 'test', 'mtime.txt');
    assert.strictEqual(result.skipped, true, 'should skip — 500ms mtime diff is within tolerance');
  });
});
