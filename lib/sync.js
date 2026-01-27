'use strict';

const FileSystem = require('node:fs');
const Path = require('node:path');

/**
 * Copy a file to destination with a specific filename
 * NEVER overwrites - throws error if file exists
 */
function copyFileToDestination(sourcePath, destBasePath, destFolder, fileName) {
  const destDir = Path.join(destBasePath, destFolder);
  const destPath = Path.join(destDir, fileName);

  if (!FileSystem.existsSync(destDir))
    FileSystem.mkdirSync(destDir, { recursive: true });

  // NEVER overwrite - if file exists, abort
  if (FileSystem.existsSync(destPath))
    throw new Error(`File already exists: ${destPath} - refusing to overwrite`);

  // Use COPYFILE_EXCL flag for extra safety
  FileSystem.copyFileSync(sourcePath, destPath, FileSystem.constants.COPYFILE_EXCL);
  return destPath;
}

module.exports = {
  copyFileToDestination,
};
