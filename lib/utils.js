'use strict';

/**
 * Format bytes as human-readable string
 */
function formatBytes(bytes) {
  if (bytes === 0)
    return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
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
};
