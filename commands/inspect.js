'use strict';

const Path = require('node:path');
const { formatBytes } = require('../lib/utils');
const { getShuttingDown } = require('../lib/hasher');

async function commandInspect(db, args) {
  const subcommand = args.inspectType || 'help';

  switch (subcommand) {
    case 'files':
      inspectFiles(db, args);
      break;
    case 'roots':
      inspectRoots(db, args);
      break;
    case 'duplicates':
      inspectDuplicates(db, args);
      break;
    case 'synced':
      inspectSynced(db, args);
      break;
    case 'hash':
      inspectHash(db, args);
      break;
    case 'search':
      inspectSearch(db, args);
      break;
    case 'final-target-size':
      inspectFinalTargetSize(db, args);
      break;
    default:
      printHelp();
  }
}

function printHelp() {
  console.log(`
inspect - Browse database contents

Subcommands:
  inspect files       List all files in database
  inspect roots       Show files grouped by root
  inspect duplicates  Show duplicates with cross-root analysis
  inspect synced      Show synced files and their original names
  inspect hash <hash> Show all files with a specific hash
  inspect search <pattern>  Search files by name pattern
  inspect final-target-size  Calculate total size if all unique files were synced

Options:
  --limit N           Limit number of results (default: 50)
  --filter-root <path>  Filter to specific root
  --ext <extension>   Filter by extension (e.g., .jpg)

Examples:
  node index.js inspect files --db mydb.db --limit 20
  node index.js inspect roots --db mydb.db
  node index.js inspect duplicates --db mydb.db --filter-root /mnt/backup1
  node index.js inspect hash abc123 --db mydb.db
  node index.js inspect search "vacation" --db mydb.db
`);
}

function inspectFiles(db, args) {
  const limit = args.limit || 50;
  const filterRoot = (args.filterRoot) ? Path.resolve(args.filterRoot) : null;
  const filterExt = (args.filterExt) ? args.filterExt.toLowerCase() : null;

  const files = [];
  let count = 0;

  for (let file of db.iterateFiles()) {
    if (filterRoot && !file.path.startsWith(filterRoot))
      continue;

    if (filterExt) {
      const ext = (filterExt.startsWith('.')) ? filterExt : '.' + filterExt;
      if (!file.path.toLowerCase().endsWith(ext))
        continue;
    }

    files.push(file);
    count++;

    if (count >= limit)
      break;
  }

  const totalCount = db.getFileCount();

  console.log(`\n=== Files in Database ===`);
  console.log(`Total: ${totalCount}${(limit < totalCount) ? ` (showing first ${limit})` : ''}`);
  if (filterRoot) console.log(`Filtered by root: ${filterRoot}`);
  if (filterExt) console.log(`Filtered by extension: ${filterExt}`);
  console.log('');

  for (let file of files) {
    const filename = Path.basename(file.path);
    const dir = Path.dirname(file.path);
    console.log(`${filename}`);
    console.log(`  Path: ${dir}/`);
    console.log(`  Size: ${formatBytes(file.size)}, Hash: ${file.hash?.substring(0, 12)}...`);
    console.log('');
  }

  if (totalCount > limit)
    console.log(`... and ${totalCount - limit} more files. Use --limit to see more.`);
}

function inspectRoots(db, args) {
  const roots = db.getRoots();

  console.log(`\n=== Files by Root ===`);
  console.log(`Total roots: ${roots.length}\n`);

  const fileCountByRoot = db.getFileCountByRoot(roots);

  for (let root of roots) {
    if (getShuttingDown()) break;

    const count = fileCountByRoot[root] || 0;

    // Calculate unique hashes in this root
    const hashesInRoot = new Set();
    const hashCounts = {};
    let totalSize = 0;

    for (let file of db.iterateFiles()) {
      if (!file.path.startsWith(root))
        continue;

      totalSize += file.size || 0;
      if (file.hash) {
        hashesInRoot.add(file.hash);
        hashCounts[file.hash] = (hashCounts[file.hash] || 0) + 1;
      }
    }

    const internalDupes = Object.values(hashCounts).filter((c) => c > 1).length;

    console.log(`${root}`);
    console.log(`  Files: ${count}`);
    console.log(`  Unique hashes: ${hashesInRoot.size}`);
    console.log(`  Internal duplicates: ${internalDupes} hash groups`);
    console.log(`  Total size: ${formatBytes(totalSize)}`);
    console.log('');
  }
}

function inspectDuplicates(db, args) {
  const limit = args.limit || 20;
  const filterRoot = (args.filterRoot) ? Path.resolve(args.filterRoot) : null;
  const roots = db.getRoots();

  const crossRootDupes = [];
  const sameRootDupes = [];

  for (let dupe of db.iterateDuplicates()) {
    const rootsContaining = new Set();
    for (let filePath of dupe.paths) {
      for (let root of roots) {
        if (filePath.startsWith(root)) {
          rootsContaining.add(root);
          break;
        }
      }
    }

    const filenames = [...new Set(dupe.paths.map((p) => Path.basename(p)))];

    const dupeInfo = {
      hash:      dupe.hash,
      paths:     dupe.paths,
      filenames,
      roots:     [...rootsContaining],
      size:      dupe.size,
    };

    if (rootsContaining.size > 1)
      crossRootDupes.push(dupeInfo);
    else
      sameRootDupes.push(dupeInfo);
  }

  let displayDupes = [...crossRootDupes, ...sameRootDupes];
  if (filterRoot)
    displayDupes = displayDupes.filter((d) => d.roots.includes(filterRoot));

  displayDupes.sort((a, b) => b.paths.length - a.paths.length);

  console.log(`\n=== Duplicate Analysis ===`);
  console.log(`Cross-root duplicates: ${crossRootDupes.length} groups`);
  console.log(`Same-root duplicates: ${sameRootDupes.length} groups`);
  if (filterRoot) console.log(`Filtered by root: ${filterRoot}`);
  console.log('');

  console.log(`Showing ${Math.min(limit, displayDupes.length)} of ${displayDupes.length} duplicate groups:\n`);

  for (let dupe of displayDupes.slice(0, limit)) {
    const isCrossRoot = dupe.roots.length > 1;
    const label = (isCrossRoot) ? '[CROSS-ROOT]' : '[SAME-ROOT]';
    const nameInfo = (dupe.filenames.length > 1) ? ` (${dupe.filenames.length} different names)` : '';

    console.log(`${label} ${dupe.filenames[0]}${nameInfo}`);
    console.log(`  Hash: ${dupe.hash.substring(0, 16)}...`);
    console.log(`  Size: ${formatBytes(dupe.size)}, Copies: ${dupe.paths.length}`);
    console.log(`  Roots: ${dupe.roots.map((r) => Path.basename(r)).join(', ')}`);

    if (dupe.filenames.length > 1)
      console.log(`  All names: ${dupe.filenames.join(', ')}`);

    console.log(`  Locations:`);
    for (let p of dupe.paths.slice(0, 5))
      console.log(`    - ${p}`);

    if (dupe.paths.length > 5)
      console.log(`    ... and ${dupe.paths.length - 5} more`);

    console.log('');
  }
}

function inspectSynced(db, args) {
  const limit = args.limit || 50;
  let count = 0;
  const syncedCount = db.getSyncedCount();

  console.log(`\n=== Synced Files ===`);
  console.log(`Total synced: ${syncedCount}\n`);

  if (syncedCount === 0) {
    console.log('No files have been synced yet.');
    return;
  }

  for (let synced of db.iterateSynced()) {
    if (count >= limit)
      break;

    console.log(`${synced.chosen_filename || Path.basename(synced.dest_path)}`);
    console.log(`  Dest: ${synced.dest_path}`);
    console.log(`  Hash: ${synced.hash.substring(0, 16)}...`);

    if (synced.allFilenames && synced.allFilenames.length > 1)
      console.log(`  Original names: ${synced.allFilenames.join(', ')}`);

    if (synced.allSourcePaths && synced.allSourcePaths.length > 1)
      console.log(`  Source copies: ${synced.allSourcePaths.length}`);

    console.log(`  Synced: ${synced.synced_at}`);
    console.log('');
    count++;
  }

  if (syncedCount > limit)
    console.log(`... and ${syncedCount - limit} more. Use --limit to see more.`);
}

function inspectHash(db, args) {
  const hashQuery = args.hashQuery;
  if (!hashQuery) {
    console.log('Usage: inspect hash <hash-prefix>');
    console.log('Example: inspect hash abc123');
    return;
  }

  const matches = [];
  for (let file of db.iterateFiles()) {
    if (file.hash && file.hash.startsWith(hashQuery))
      matches.push(file);
  }

  if (matches.length === 0) {
    console.log(`No files found with hash starting with: ${hashQuery}`);
    return;
  }

  // Group by full hash
  const byHash = {};
  for (let file of matches) {
    if (!byHash[file.hash])
      byHash[file.hash] = [];

    byHash[file.hash].push(file);
  }

  console.log(`\n=== Files matching hash: ${hashQuery}* ===`);
  console.log(`Found ${Object.keys(byHash).length} unique hash(es)\n`);

  for (let [hash, files] of Object.entries(byHash)) {
    const filenames = [...new Set(files.map((f) => Path.basename(f.path)))];

    console.log(`Hash: ${hash}`);
    console.log(`  Size: ${formatBytes(files[0].size)}`);
    console.log(`  Copies: ${files.length}`);
    console.log(`  Filenames: ${filenames.join(', ')}`);
    console.log(`  Locations:`);
    for (let f of files)
      console.log(`    - ${f.path}`);

    if (db.isSynced(hash)) {
      const synced = db.getSynced(hash);
      console.log(`  SYNCED TO: ${synced.dest_path}`);
    } else {
      console.log(`  Status: Not synced`);
    }

    console.log('');
  }
}

function inspectSearch(db, args) {
  const pattern = args.searchPattern;
  if (!pattern) {
    console.log('Usage: inspect search <pattern>');
    console.log('Example: inspect search vacation');
    return;
  }

  const limit = args.limit || 50;
  const regex = new RegExp(pattern, 'i');

  const matches = [];
  for (let file of db.iterateFiles()) {
    if (regex.test(file.path))
      matches.push(file);
  }

  console.log(`\n=== Search: "${pattern}" ===`);
  console.log(`Found: ${matches.length} files\n`);

  if (matches.length === 0)
    return;

  // Group by hash
  const byHash = {};
  for (let file of matches) {
    if (!byHash[file.hash])
      byHash[file.hash] = [];

    byHash[file.hash].push(file.path);
  }

  let shown = 0;
  for (let [hash, paths] of Object.entries(byHash)) {
    if (shown >= limit)
      break;

    const firstFile = matches.find((f) => f.hash === hash);
    const isDupe = paths.length > 1;

    console.log(`${Path.basename(paths[0])}${(isDupe) ? ` (${paths.length} copies)` : ''}`);
    console.log(`  Hash: ${hash.substring(0, 16)}...`);
    console.log(`  Size: ${formatBytes(firstFile.size)}`);

    for (let p of paths.slice(0, 3))
      console.log(`  - ${p}`);

    if (paths.length > 3)
      console.log(`  ... and ${paths.length - 3} more locations`);

    console.log('');
    shown++;
  }

  if (Object.keys(byHash).length > limit)
    console.log(`... and ${Object.keys(byHash).length - limit} more. Use --limit to see more.`);
}

function inspectFinalTargetSize(db, args) {
  const result = db.getUniqueFilesStats();

  console.log(`\n=== Final Target Size ===`);
  console.log(`Unique files: ${result.count}`);
  console.log(`Total size:   ${formatBytes(result.totalSize)}`);
  console.log(`\nThis is the total disk space needed if all unique files were synced.`);
}

module.exports = commandInspect;
