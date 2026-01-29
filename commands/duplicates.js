'use strict';

const Path = require('node:path');
const { formatBytes } = require('../lib/utils');
const { getShuttingDown } = require('../lib/hasher');

async function commandDuplicates(db, args) {
  let hashCount = 0;
  let totalDupeFiles = 0;
  let totalWastedBytes = 0;
  const duplicateGroups = [];

  for (let dupe of db.iterateDuplicates()) {
    if (getShuttingDown()) break;
    hashCount++;
    totalDupeFiles += dupe.count - 1;
    totalWastedBytes += dupe.size * (dupe.count - 1);
    duplicateGroups.push(dupe);
  }

  console.log(`\n=== Duplicate Summary ===`);
  console.log(`Unique hashes with duplicates: ${hashCount}`);
  console.log(`Total duplicate files: ${totalDupeFiles}`);
  console.log(`Wasted space: ${formatBytes(totalWastedBytes)}`);

  const limit = args.limit || 10;
  const toShow = duplicateGroups.slice(0, limit);

  if (toShow.length > 0) {
    console.log(`\nDuplicate groups (first ${limit}):`);
    for (let dupe of toShow) {
      console.log(`\n  ${dupe.hash.substring(0, 12)}... (${formatBytes(dupe.size)}) - ${dupe.count} copies`);
      for (let p of dupe.paths.slice(0, 5))
        console.log(`    - ${p}`);

      if (dupe.paths.length > 5)
        console.log(`    ... and ${dupe.paths.length - 5} more`);
    }
  }
}

module.exports = commandDuplicates;
