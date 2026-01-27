'use strict';

const FileSystem = require('node:fs');
const Path = require('node:path');
const { shouldIgnore } = require('./patterns');
const { getShuttingDown } = require('./hasher');

/**
 * Scan a directory recursively for files
 * Yields files as they're found (memory efficient)
 */
function* scanDirectory(basePath, options = {}) {
  const {
    ignorePatterns = [],
    includePatterns = [],
    defaultIgnorePatterns = [],
    excludePath = null,
  } = options;

  const stats = {
    fileCount:        0,
    dirCount:         0,
    ignoredCount:     0,
    brokenSymlinks:   0,
    permissionErrors: 0,
  };

  // Track visited directories to prevent circular symlinks
  const visitedDirs = new Set();

  function* scan(currentPath) {
    if (getShuttingDown())
      return;

    let entries;
    try {
      entries = FileSystem.readdirSync(currentPath);
    } catch (err) {
      if (err.code === 'EACCES')
        stats.permissionErrors++;
      else
        console.warn(`Warning: Cannot read directory ${currentPath}: ${err.message}`);

      return;
    }

    for (let entry of entries) {
      if (getShuttingDown())
        return;

      const fullPath = Path.join(currentPath, entry);

      // Skip excluded path (e.g., database file)
      if (excludePath && fullPath === excludePath)
        continue;

      // Check ignore patterns
      if (shouldIgnore(fullPath, entry, ignorePatterns, includePatterns, defaultIgnorePatterns)) {
        stats.ignoredCount++;
        continue;
      }

      // Get lstat first to check for symlinks
      let lstat;
      try {
        lstat = FileSystem.lstatSync(fullPath);
      } catch (err) {
        if (err.code === 'EACCES')
          stats.permissionErrors++;
        else
          console.warn(`Warning: Cannot lstat ${fullPath}: ${err.message}`);

        continue;
      }

      let stat;
      if (lstat.isSymbolicLink()) {
        try {
          stat = FileSystem.statSync(fullPath);
        } catch (err) {
          if (err.code === 'ENOENT')
            stats.brokenSymlinks++;
          else if (err.code === 'EACCES')
            stats.permissionErrors++;
          else
            console.warn(`Warning: Cannot follow symlink ${fullPath}: ${err.message}`);

          continue;
        }
      } else {
        stat = lstat;
      }

      if (stat.isDirectory()) {
        // Check for circular symlinks
        const dirId = `${stat.dev}:${stat.ino}`;
        if (visitedDirs.has(dirId))
          continue;

        visitedDirs.add(dirId);
        stats.dirCount++;
        yield* scan(fullPath);
      } else if (stat.isFile()) {
        stats.fileCount++;
        yield { fullPath, stat, rootPath: basePath };
      }
    }
  }

  // Start scanning and collect stats
  const generator = scan(basePath);
  generator.stats = stats;

  // Wrap to return stats at end
  for (let file of generator)
    yield file;

  // Return stats for caller
  return stats;
}

/**
 * Scan multiple roots, yielding files from each
 * Returns combined stats
 */
function scanRoots(roots, options = {}) {
  const allStats = {
    totalFiles:            0,
    totalDirs:             0,
    totalIgnored:          0,
    totalBrokenSymlinks:   0,
    totalPermissionErrors: 0,
    rootStats:             {},
  };

  const allFiles = [];

  for (let rootPath of roots) {
    if (getShuttingDown())
      break;

    const resolvedRoot = Path.resolve(rootPath);
    console.log(`Scanning: ${resolvedRoot}`);

    if (!FileSystem.existsSync(resolvedRoot)) {
      console.warn(`  Warning: Path does not exist, skipping`);
      continue;
    }

    const rootFiles = [];
    const stats = {
      fileCount:        0,
      dirCount:         0,
      ignoredCount:     0,
      brokenSymlinks:   0,
      permissionErrors: 0,
    };

    for (let file of scanDirectory(resolvedRoot, options)) {
      rootFiles.push(file);
      stats.fileCount++;
    }

    // Generator returns stats, but we tracked manually
    // Update dir count from scanning
    const scanGen = scanDirectory(resolvedRoot, options);
    let result = scanGen.next();
    while (!result.done) {
      result = scanGen.next();
    }

    // Merge files
    for (let file of rootFiles)
      allFiles.push(file);

    allStats.rootStats[resolvedRoot] = stats;
    allStats.totalFiles += rootFiles.length;

    // Print summary for this root
    let summary = `  Found ${rootFiles.length} files`;
    const notes = [];
    if (stats.ignoredCount > 0) notes.push(`${stats.ignoredCount} ignored`);
    if (stats.brokenSymlinks > 0) notes.push(`${stats.brokenSymlinks} broken symlinks`);
    if (stats.permissionErrors > 0) notes.push(`${stats.permissionErrors} permission denied`);
    if (notes.length > 0) summary += ` (${notes.join(', ')})`;
    console.log(summary);

    allStats.totalIgnored += stats.ignoredCount;
    allStats.totalBrokenSymlinks += stats.brokenSymlinks;
    allStats.totalPermissionErrors += stats.permissionErrors;
  }

  // Print overall summary
  if (allStats.totalIgnored > 0 || allStats.totalBrokenSymlinks > 0 || allStats.totalPermissionErrors > 0) {
    const summaryParts = [];
    if (allStats.totalIgnored > 0) summaryParts.push(`${allStats.totalIgnored} ignored by patterns`);
    if (allStats.totalBrokenSymlinks > 0) summaryParts.push(`${allStats.totalBrokenSymlinks} broken symlinks skipped`);
    if (allStats.totalPermissionErrors > 0) summaryParts.push(`${allStats.totalPermissionErrors} permission errors skipped`);
    console.log(`Skipped: ${summaryParts.join(', ')}`);
  }

  return { files: allFiles, stats: allStats };
}

module.exports = {
  scanDirectory,
  scanRoots,
};
