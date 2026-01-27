'use strict';

const Path = require('node:path');
const { formatBytes } = require('../lib/utils');
const { matchFileToRule } = require('../lib/patterns');
const { LARGE_FILE_THRESHOLD } = require('../lib/constants');

async function commandLargeFiles(db, args) {
  const routingRules = db.getRoutingRules();
  const defaultRoutingRules = db.getDefaultRoutingRules();

  const pendingLarge = [];
  const syncedLarge = [];
  const seenHashes = new Set();

  for (let file of db.iterateFiles()) {
    if (!file.hash || file.size <= LARGE_FILE_THRESHOLD)
      continue;

    if (seenHashes.has(file.hash))
      continue;

    seenHashes.add(file.hash);

    if (db.isSynced(file.hash)) {
      syncedLarge.push(file);
    } else {
      const destFolder = matchFileToRule(file.path, routingRules, defaultRoutingRules);
      pendingLarge.push({ ...file, destFolder });
    }
  }

  console.log(`\n=== Large Files (>${formatBytes(LARGE_FILE_THRESHOLD)}) ===`);
  console.log(`Already synced: ${syncedLarge.length}`);
  console.log(`Pending: ${pendingLarge.length}`);

  if (pendingLarge.length === 0) {
    console.log('\nNo large files pending.');
    return;
  }

  pendingLarge.sort((a, b) => b.size - a.size);
  const totalSize = pendingLarge.reduce((sum, f) => sum + f.size, 0);
  console.log(`Total size: ${formatBytes(totalSize)}`);

  console.log(`\nPending large files:`);
  for (let file of pendingLarge) {
    console.log(`\n  ${Path.basename(file.path)}`);
    console.log(`    Size: ${formatBytes(file.size)}`);
    console.log(`    Path: ${file.path}`);
    console.log(`    Dest: ${file.destFolder || '(unmatched)'}`);
  }
}

module.exports = commandLargeFiles;
