'use strict';

const FileSystem = require('node:fs');
const Path = require('node:path');

/**
 * Check if two paths are on the same block device
 */
function isSameDevice(pathA, pathB) {
  try {
    const statA = FileSystem.statSync(pathA);
    const statB = FileSystem.statSync(pathB);
    return statA.dev === statB.dev;
  } catch (err) {
    return false;
  }
}

/**
 * Copy or move a file to destination with a specific filename
 *
 * Protection logic for existing destination files:
 * - If dest file exists with SAME size AND mtime as source: skip (assume identical)
 * - If dest file exists with DIFFERENT size OR mtime: throw error (refuse to overwrite)
 *
 * Move logic (when moveFile is true):
 * - If source and dest are on the same block device: uses rename (instant)
 * - If different devices: copies then deletes source
 *
 * @param {string} sourcePath - Source file path
 * @param {string} destBasePath - Destination base directory
 * @param {string} destFolder - Subdirectory within destination
 * @param {string} fileName - Target filename
 * @param {object} [options] - Options
 * @param {boolean} [options.moveFile=false] - Move instead of copy
 * @returns {{ path: string, skipped: boolean, moved: boolean }}
 */
function copyFileToDestination(sourcePath, destBasePath, destFolder, fileName, options = {}) {
  const { moveFile = false } = options;
  const destDir = Path.join(destBasePath, destFolder);
  const destPath = Path.join(destDir, fileName);

  if (!FileSystem.existsSync(destDir))
    FileSystem.mkdirSync(destDir, { recursive: true });

  // Check if destination file already exists
  if (FileSystem.existsSync(destPath)) {
    const sourceStat = FileSystem.statSync(sourcePath);
    const destStat = FileSystem.statSync(destPath);

    // Compare size and mtime (within 1 second tolerance for filesystem precision)
    const sameSize  = sourceStat.size === destStat.size;
    const sameMtime = Math.abs(sourceStat.mtimeMs - destStat.mtimeMs) < 1000;

    if (sameSize && sameMtime) {
      // Same size and mtime - assume identical file, skip
      // If move was requested and source still exists, remove the source
      if (moveFile)
        FileSystem.unlinkSync(sourcePath);
      return { path: destPath, skipped: true, moved: moveFile };
    }

    // Different size or mtime - refuse to overwrite (protect destination)
    throw new Error(
      `File exists with different content: ${destPath}\n` +
      `  Source: ${sourceStat.size} bytes, mtime ${new Date(sourceStat.mtimeMs).toISOString()}\n` +
      `  Dest:   ${destStat.size} bytes, mtime ${new Date(destStat.mtimeMs).toISOString()}\n` +
      `  Refusing to overwrite - resolve manually`
    );
  }

  if (moveFile) {
    // Try rename first (instant on same device)
    if (isSameDevice(sourcePath, destDir)) {
      FileSystem.renameSync(sourcePath, destPath);
    } else {
      // Different devices - copy then delete
      FileSystem.copyFileSync(sourcePath, destPath, FileSystem.constants.COPYFILE_EXCL);
      FileSystem.unlinkSync(sourcePath);
    }
    return { path: destPath, skipped: false, moved: true };
  }

  // Standard copy with COPYFILE_EXCL for safety
  FileSystem.copyFileSync(sourcePath, destPath, FileSystem.constants.COPYFILE_EXCL);
  return { path: destPath, skipped: false, moved: false };
}

module.exports = {
  copyFileToDestination,
  isSameDevice,
};
