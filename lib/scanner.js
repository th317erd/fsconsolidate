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

  // Build set of excluded paths (database file + WAL/SHM temp files)
  const excludePaths = new Set();
  if (excludePath) {
    excludePaths.add(excludePath);
    excludePaths.add(excludePath + '-wal');
    excludePaths.add(excludePath + '-shm');
  }

  const stats = {
    fileCount:        0,
    dirCount:         0,
    ignoredCount:     0,
    brokenSymlinks:   0,
    permissionErrors: 0,
  };

  // Resolve basePath to canonical real path (follows symlinks)
  let realBasePath;
  try {
    realBasePath = FileSystem.realpathSync(basePath);
  } catch (err) {
    console.warn(`Warning: Cannot resolve base path ${basePath}: ${err.message}`);
    return;
  }

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

      // Skip excluded paths (e.g., database file + WAL/SHM temp files)
      if (excludePaths.has(fullPath))
        continue;

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

      // Resolve symlinks
      let stat;
      let resolvedPath = fullPath;
      const isSymlink = lstat.isSymbolicLink();

      if (isSymlink) {
        try {
          resolvedPath = FileSystem.realpathSync(fullPath);
          stat = FileSystem.statSync(resolvedPath);
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

      // Also check excludePaths against resolved path
      if (excludePaths.has(resolvedPath))
        continue;

      // Check ignore/include patterns against both original and resolved paths
      const resolvedEntry = (isSymlink) ? Path.basename(resolvedPath) : null;
      const result = shouldIgnore(
        fullPath, entry,
        (isSymlink) ? resolvedPath : null,
        resolvedEntry,
        ignorePatterns, includePatterns, defaultIgnorePatterns
      );

      if (result.included) {
        if (isSymlink && result.matchedOn === 'resolved')
          console.log(`  [Include] "${result.pattern}" matched resolved path: ${resolvedPath} (symlink: ${fullPath})`);
        else if (isSymlink)
          console.log(`  [Include] "${result.pattern}" matched symlink: ${fullPath} (real: ${resolvedPath})`);
      }

      if (result.ignored) {
        stats.ignoredCount++;
        if (isSymlink && result.matchedOn === 'resolved')
          console.log(`  [Ignore] "${result.pattern}" matched resolved path: ${resolvedPath} (symlink: ${fullPath})`);
        else if (isSymlink)
          console.log(`  [Ignore] "${result.pattern}" matched symlink: ${fullPath} (real: ${resolvedPath})`);
        continue;
      }

      if (stat.isDirectory()) {
        // Check for circular symlinks
        const dirId = `${stat.dev}:${stat.ino}`;
        if (visitedDirs.has(dirId))
          continue;

        visitedDirs.add(dirId);
        stats.dirCount++;
        yield* scan(resolvedPath);
      } else if (stat.isFile()) {
        stats.fileCount++;
        yield { fullPath: resolvedPath, stat, rootPath: realBasePath };
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

    let resolvedRoot;
    try {
      resolvedRoot = FileSystem.realpathSync(Path.resolve(rootPath));
    } catch (err) {
      console.warn(`Warning: Cannot resolve root ${rootPath}: ${err.message}`);
      continue;
    }
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
