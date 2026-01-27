'use strict';

const Path = require('node:path');
const { formatBytes } = require('../lib/utils');
const { matchFileToRule } = require('../lib/patterns');

async function commandStatus(db, args) {
  const stats = db.getStats();
  const roots = db.getRoots();
  const syncDest = db.getSyncDestination();

  const duplicateCount = stats.fileCount - stats.uniqueHashCount;
  const wastedSize = stats.totalSize - stats.uniqueSize;

  console.log(`\n=== Database: ${db.dbPath} ===`);
  console.log(`Roots: ${roots.length}`);
  for (let root of roots)
    console.log(`  - ${root}`);

  console.log(`\n=== File Stats ===`);
  console.log(`Total files: ${stats.fileCount} (${formatBytes(stats.totalSize)})`);
  console.log(`Unique (by hash): ${stats.uniqueHashCount} (${formatBytes(stats.uniqueSize)})`);
  console.log(`Duplicates: ${duplicateCount} (${formatBytes(wastedSize)} redundant)`);

  console.log(`\n=== Sync Status ===`);
  if (syncDest)
    console.log(`Destination: ${syncDest}`);
  else
    console.log(`Destination: (not set)`);

  console.log(`Synced: ${stats.syncedCount}`);

  // Calculate pending and unmatched
  const routingRules = db.getRoutingRules();
  const defaultRoutingRules = db.getDefaultRoutingRules();

  let pending = 0;
  let unmatched = 0;
  const pendingByDest = {};
  const unmatchedByExt = {};

  // Iterate through unique hashes
  const seenHashes = new Set();
  for (let file of db.iterateFiles()) {
    if (!file.hash || seenHashes.has(file.hash))
      continue;

    seenHashes.add(file.hash);

    if (db.isSynced(file.hash))
      continue;

    const destFolder = matchFileToRule(file.path, routingRules, defaultRoutingRules);
    if (destFolder) {
      pending++;
      pendingByDest[destFolder] = (pendingByDest[destFolder] || 0) + 1;
    } else {
      unmatched++;
      const ext = Path.extname(file.path).toLowerCase() || '(none)';
      unmatchedByExt[ext] = (unmatchedByExt[ext] || 0) + 1;
    }
  }

  console.log(`Pending: ${pending}`);
  console.log(`Unmatched: ${unmatched}`);

  if (pending > 0) {
    console.log(`\nPending by destination:`);
    const sorted = Object.entries(pendingByDest).sort((a, b) => b[1] - a[1]);
    for (let [dest, count] of sorted)
      console.log(`  ${dest}: ${count}`);
  }

  if (unmatched > 0) {
    console.log(`\nUnmatched by extension:`);
    const sorted = Object.entries(unmatchedByExt).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (let [ext, count] of sorted)
      console.log(`  ${ext}: ${count}`);
  }
}

module.exports = commandStatus;
