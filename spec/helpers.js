'use strict';

const FileSystem = require('node:fs');
const Path       = require('node:path');
const Crypto     = require('node:crypto');

const SPEC_TMP_ROOT = Path.join(__dirname, '..', '.spec-tmp');

/**
 * Create an isolated temp directory for a test.
 * Returns the absolute path. Caller is responsible for cleanup via removeTempDir.
 */
function createTempDir(prefix = 'test') {
  FileSystem.mkdirSync(SPEC_TMP_ROOT, { recursive: true });

  const dirName = `${prefix}-${Crypto.randomBytes(6).toString('hex')}`;
  const dirPath = Path.join(SPEC_TMP_ROOT, dirName);
  FileSystem.mkdirSync(dirPath, { recursive: true });

  return dirPath;
}

/**
 * Recursively remove a temp directory.
 * Only removes directories under SPEC_TMP_ROOT for safety.
 */
function removeTempDir(dirPath) {
  const resolved = Path.resolve(dirPath);
  const safeRoot = Path.resolve(SPEC_TMP_ROOT);

  if (!resolved.startsWith(safeRoot))
    throw new Error(`Refusing to remove directory outside spec tmp root: ${resolved}`);

  FileSystem.rmSync(resolved, { recursive: true, force: true });
}

/**
 * Clean up all spec temp directories.
 * Call this in a global teardown or after all tests.
 */
function cleanAllTempDirs() {
  const resolved = Path.resolve(SPEC_TMP_ROOT);

  if (FileSystem.existsSync(resolved))
    FileSystem.rmSync(resolved, { recursive: true, force: true });
}

/**
 * Create a temp SQLite database for testing.
 * Returns { db, dbPath, cleanup }.
 * Always call cleanup() when done to close the database and remove the file.
 */
function createTempDatabase() {
  const FileDatabase = require('../lib/db');

  const tempDir = createTempDir('db');
  const dbPath  = Path.join(tempDir, 'test.sqlite');
  const db      = new FileDatabase(dbPath);

  db.open();

  return {
    db,
    dbPath,
    cleanup: () => {
      try { db.close(); } catch (_) { /* already closed */ }
      removeTempDir(tempDir);
    },
  };
}

/**
 * Create a file with known content in a directory.
 * Returns the absolute file path.
 */
function createFile(directory, fileName, content = '') {
  const filePath = Path.join(directory, fileName);
  const dirName  = Path.dirname(filePath);

  FileSystem.mkdirSync(dirName, { recursive: true });
  FileSystem.writeFileSync(filePath, content);

  return filePath;
}

/**
 * Create a directory structure from a descriptor object.
 * Keys are relative paths, values are file contents (string) or null for directories.
 *
 * Example:
 *   createStructure(tmpDir, {
 *     'photos/vacation.jpg':  'jpeg-data',
 *     'docs/readme.txt':      'hello',
 *     'empty-dir/':           null,
 *   });
 */
function createStructure(baseDir, descriptor) {
  for (let [relativePath, content] of Object.entries(descriptor)) {
    const fullPath = Path.join(baseDir, relativePath);

    if (relativePath.endsWith('/') || content === null) {
      FileSystem.mkdirSync(fullPath, { recursive: true });
    } else {
      FileSystem.mkdirSync(Path.dirname(fullPath), { recursive: true });
      FileSystem.writeFileSync(fullPath, content);
    }
  }
}

/**
 * Compute SHA1 hash of a string (for verifying hasher output against known values).
 */
function sha1(content) {
  return Crypto.createHash('sha1').update(content).digest('hex');
}

/**
 * Capture console.log/error/warn output during an async function call.
 * Returns { lines, errors, warnings, result }.
 */
async function captureOutput(fn) {
  const originalLog  = console.log;
  const originalErr  = console.error;
  const originalWarn = console.warn;

  const lines    = [];
  const errors   = [];
  const warnings = [];

  console.log   = (...args) => lines.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  console.warn  = (...args) => warnings.push(args.join(' '));

  try {
    const result = await fn();
    return { lines, errors, warnings, result };
  } finally {
    console.log   = originalLog;
    console.error = originalErr;
    console.warn  = originalWarn;
  }
}

module.exports = {
  SPEC_TMP_ROOT,
  createTempDir,
  removeTempDir,
  cleanAllTempDirs,
  createTempDatabase,
  createFile,
  createStructure,
  sha1,
  captureOutput,
};
