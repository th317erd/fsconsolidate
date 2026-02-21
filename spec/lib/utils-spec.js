'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTempDir, removeTempDir, createFile } = require('../helpers');
const FileSystem = require('node:fs');

const { formatBytes, assertRootsAccessible } = require('../../lib/utils');

// ============================================================================
// formatBytes
// ============================================================================

describe('formatBytes', { timeout: 10000 }, () => {
  it('should return "0 Bytes" for 0', () => {
    assert.strictEqual(formatBytes(0), '0 Bytes');
  });

  it('should format bytes (< 1 KB)', () => {
    assert.strictEqual(formatBytes(500), '500 Bytes');
    assert.strictEqual(formatBytes(1), '1 Bytes');
  });

  it('should format kilobytes', () => {
    assert.strictEqual(formatBytes(1024), '1 KB');
    assert.strictEqual(formatBytes(1536), '1.5 KB');
  });

  it('should format megabytes', () => {
    assert.strictEqual(formatBytes(1048576), '1 MB');
    assert.strictEqual(formatBytes(1572864), '1.5 MB');
  });

  it('should format gigabytes', () => {
    assert.strictEqual(formatBytes(1073741824), '1 GB');
  });

  it('should format terabytes', () => {
    assert.strictEqual(formatBytes(1099511627776), '1 TB');
  });

  it('should handle values larger than TB without crashing', () => {
    // 1 PB = 1024 TB — should not return "NaN undefined"
    const petabyte = 1099511627776 * 1024;
    const result = formatBytes(petabyte);
    assert.ok(!result.includes('undefined'), `Got "${result}" — sizes array overflow`);
    assert.ok(!result.includes('NaN'), `Got "${result}" — NaN in output`);
  });

  it('should handle negative values without returning NaN', () => {
    const result = formatBytes(-1024);
    assert.ok(!result.includes('NaN'), `Got "${result}" — NaN from negative input`);
  });

  it('should handle NaN input without crashing', () => {
    const result = formatBytes(NaN);
    assert.ok(!result.includes('undefined'), `Got "${result}" — undefined from NaN input`);
  });

  it('should handle Infinity without crashing', () => {
    const result = formatBytes(Infinity);
    assert.ok(!result.includes('undefined'), `Got "${result}" — undefined from Infinity`);
    assert.ok(!result.includes('NaN'), `Got "${result}" — NaN from Infinity`);
  });
});

// ============================================================================
// assertRootsAccessible
// ============================================================================

describe('assertRootsAccessible', { timeout: 10000 }, () => {
  let tempDir;

  beforeEach(() => {
    tempDir = createTempDir('roots');
  });

  afterEach(() => {
    if (tempDir)
      removeTempDir(tempDir);
  });

  it('should not throw for valid, accessible directories', () => {
    // assertRootsAccessible calls process.exit(1) on failure,
    // so if it doesn't throw/exit, the test passes.
    // We can't easily test process.exit without refactoring,
    // but we CAN test that valid dirs don't trigger it.
    assertRootsAccessible([tempDir]);
  });

  it('should not throw for multiple valid directories', () => {
    const dir2 = createTempDir('roots2');

    try {
      assertRootsAccessible([tempDir, dir2]);
    } finally {
      removeTempDir(dir2);
    }
  });

  it('should not throw for empty roots array', () => {
    assertRootsAccessible([]);
  });
});
