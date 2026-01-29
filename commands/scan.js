'use strict';

const Path = require('node:path');
const FileSystem = require('node:fs');
const { scanRoots } = require('../lib/scanner');
const { hashFilesWithProgress, getShuttingDown } = require('../lib/hasher');
const { MAX_CONCURRENT } = require('../lib/constants');

async function commandScan(db, args) {
  // Add any new roots from command line
  const rootsToAdd = [...(args.roots || [])];
  if (args.addRoot)
    rootsToAdd.push(args.addRoot);

  for (let root of rootsToAdd) {
    const resolved = db.addRoot(root);
    console.log(`Added root: ${resolved}`);
  }

  const roots = db.getRoots();
  if (roots.length === 0) {
    console.error('Error: No roots to scan. Use --root or config --add-root first.');
    process.exit(1);
  }

  // Build list of paths to scan: roots + destination (if set)
  // Resolve all paths and deduplicate to prevent scanning the same location twice
  const destination = db.getSyncDestination();

  // First, resolve and deduplicate roots
  const seenPaths = new Set();
  const pathsToScan = [];

  for (let p of roots) {
    try {
      const realPath = FileSystem.realpathSync(p);
      if (!seenPaths.has(realPath)) {
        seenPaths.add(realPath);
        pathsToScan.push(realPath);
      }
    } catch (err) {
      console.warn(`Warning: Cannot resolve root ${p}: ${err.message}`);
    }
  }

  // Add destination if set and not already covered by a root
  let scanningDestination = false;
  if (destination && FileSystem.existsSync(destination)) {
    try {
      const destRealPath = FileSystem.realpathSync(destination);

      // Check if destination is already in the list OR is a subdirectory of a scanned path
      const alreadyCovered = seenPaths.has(destRealPath) ||
        pathsToScan.some((p) => destRealPath.startsWith(p + '/'));

      if (!alreadyCovered) {
        seenPaths.add(destRealPath);
        pathsToScan.push(destRealPath);
        scanningDestination = true;
      }
    } catch (err) {
      console.warn(`Warning: Cannot resolve destination ${destination}: ${err.message}`);
    }
  }

  const ignorePatterns = db.getIgnorePatterns();
  const defaultIgnorePatterns = db.getDefaultIgnorePatterns();
  const includePatterns = db.getIncludePatterns();

  const ignoreCount = ignorePatterns.length + defaultIgnorePatterns.length;
  console.log(`\nIgnoring ${ignoreCount} patterns`);
  console.log(`Scanning ${roots.length} root(s)${(scanningDestination) ? ' + destination' : ''}...\n`);

  const { files } = scanRoots(pathsToScan, {
    ignorePatterns,
    defaultIgnorePatterns,
    includePatterns,
    excludePath: db.dbPath,
  });

  if (getShuttingDown())
    return;

  console.log(`\nTotal files: ${files.length}`);
  console.log(`\nHashing (max ${MAX_CONCURRENT} concurrent)...`);

  const results = await hashFilesWithProgress(files, db, {
    onSave: (fileResults) => {
      // Batch save to database
      const toSave = fileResults.map((r) => ({
        path:    r.fullPath,
        hash:    r.hash,
        size:    r.size,
        mtimeMs: r.mtimeMs,
        mtime:   r.mtime,
        error:   r.error,
      }));
      db.upsertFiles(toSave);
      console.log(`  [Saved ${toSave.length} files to database]`);
    },
  });

  // Save any remaining results
  const toSave = results
    .filter((r) => !r.error && r.hash)
    .map((r) => ({
      path:    r.fullPath,
      hash:    r.hash,
      size:    r.size,
      mtimeMs: r.mtimeMs,
      mtime:   r.mtime,
      error:   null,
    }));

  if (toSave.length > 0)
    db.upsertFiles(toSave);

  console.log('\nScan complete!');
}

module.exports = commandScan;
