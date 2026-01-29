'use strict';

const Path = require('node:path');
const Readline = require('node:readline');
const { formatBytes, printError } = require('../lib/utils');
const { globToRegex } = require('../lib/patterns');
const { getShuttingDown } = require('../lib/hasher');

async function commandRemove(db, args) {
  const pattern = args.removePattern;

  if (!pattern) {
    printError('Error: No pattern specified.');
    console.log('Usage: remove <pattern> --db <database>');
    console.log('');
    console.log('Pattern can be:');
    console.log('  - Glob pattern: "*.log", "node_modules/**", "/path/to/dir/*"');
    console.log('  - Part of path: "node_modules" matches any path containing "node_modules"');
    console.log('');
    console.log('Examples:');
    console.log('  node index.js remove "*.log" --db mydb.db');
    console.log('  node index.js remove "node_modules" --db mydb.db');
    console.log('  node index.js remove "/unwanted/path/**" --db mydb.db');
    process.exit(1);
  }

  // Determine if we can use bulk SQL (simple substring pattern)
  const isGlob = pattern.includes('*') || pattern.includes('?') || pattern.includes('{');
  const canBulkDelete = !isGlob;

  // Preview matching files
  let matchCount;
  let totalSize;
  let sampleFiles;

  if (canBulkDelete) {
    const likePattern = `%${pattern}%`;
    const stats = db.db.prepare('SELECT COUNT(*) as count, SUM(size) as totalSize FROM files WHERE path LIKE ?').get(likePattern);
    matchCount = stats.count;
    totalSize = stats.totalSize || 0;
    sampleFiles = db.db.prepare('SELECT path, size FROM files WHERE path LIKE ? LIMIT 50').all(likePattern);
  } else {
    const regex = globToRegex(pattern);
    const matcher = (filePath) => regex.test(filePath) || regex.test(Path.basename(filePath));
    sampleFiles = [];
    matchCount = 0;
    totalSize = 0;

    for (let file of db.iterateFiles()) {
      if (matcher(file.path)) {
        matchCount++;
        totalSize += file.size || 0;
        if (sampleFiles.length < 50)
          sampleFiles.push(file);
      }
    }
  }

  if (matchCount === 0) {
    console.log(`No files match pattern: ${pattern}`);
    return;
  }

  console.log(`\n=== Files matching "${pattern}" ===`);
  console.log(`Found: ${matchCount} files (${formatBytes(totalSize)})\n`);

  for (let file of sampleFiles)
    console.log(`  ${file.path} (${formatBytes(file.size)})`);

  if (matchCount > sampleFiles.length)
    console.log(`  ... and ${matchCount - sampleFiles.length} more files`);

  console.log('');
  console.log(`This will remove ${matchCount} files from the DATABASE ONLY.`);
  console.log(`(The actual files on disk will NOT be deleted.)`);

  const rl = Readline.createInterface({ input: process.stdin, output: process.stdout });

  const answer = await new Promise((resolve) => {
    rl.question('\nProceed with removal? [y/N] ', resolve);
  });
  rl.close();

  const confirmed = answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';

  if (!confirmed) {
    console.log('Cancelled.');
    return;
  }

  // Remove files — bulk SQL for substring patterns, row-by-row for globs
  let removed;
  if (canBulkDelete) {
    const likePattern = `%${pattern}%`;
    const result = db.db.prepare('DELETE FROM files WHERE path LIKE ?').run(likePattern);
    removed = result.changes;
  } else {
    const regex = globToRegex(pattern);
    const matcher = (filePath) => regex.test(filePath) || regex.test(Path.basename(filePath));
    const allFiles = db.db.prepare('SELECT path FROM files').all();
    removed = 0;
    for (let file of allFiles) {
      if (getShuttingDown()) break;
      if (matcher(file.path)) {
        if (db.removeFile(file.path))
          removed++;
      }
    }
  }

  console.log(`\nRemoved ${removed} files from database.`);
}

module.exports = commandRemove;
