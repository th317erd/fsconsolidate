'use strict';

const FileSystem = require('node:fs');

/**
 * Verify all root paths are accessible (exist and are readable directories).
 * Aborts the process with a clear error if any root is inaccessible.
 * Call this at the start of commands that need filesystem access to roots.
 */
function assertRootsAccessible(roots) {
  const failures = [];

  for (let root of roots) {
    try {
      const stat = FileSystem.statSync(root);
      if (!stat.isDirectory())
        failures.push({ root, reason: 'exists but is not a directory' });
      else
        FileSystem.accessSync(root, FileSystem.constants.R_OK);
    } catch (err) {
      if (err.code === 'ENOENT')
        failures.push({ root, reason: 'path does not exist (drive not mounted?)' });
      else if (err.code === 'EACCES')
        failures.push({ root, reason: 'permission denied' });
      else
        failures.push({ root, reason: err.message });
    }
  }

  if (failures.length > 0) {
    printError('\nError: Some roots are not accessible. Aborting to prevent a bad scan.\n');
    for (let f of failures)
      printError(`  ${f.root}\n    → ${f.reason}`);
    printError('\nIf a drive is unmounted, mount it first. To remove a stale root:');
    printError('  node index.js config --db <file> --remove-root <path>\n');
    process.exit(1);
  }
}

/**
 * Format bytes as human-readable string
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes === 0)
    return '0 Bytes';

  if (bytes < 0)
    return '-' + formatBytes(-bytes);

  const k     = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  const i     = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Print error message in red to stderr
 */
function printError(message) {
  console.error(`\x1b[31m${message}\x1b[0m`);
}

/**
 * Print warning message in yellow
 */
function printWarning(message) {
  console.warn(`\x1b[33m${message}\x1b[0m`);
}

/**
 * Print success message in green
 */
function printSuccess(message) {
  console.log(`\x1b[32m${message}\x1b[0m`);
}

module.exports = {
  formatBytes,
  printError,
  printWarning,
  printSuccess,
  assertRootsAccessible,
};
