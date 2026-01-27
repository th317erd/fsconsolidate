'use strict';

const Path = require('node:path');
const Readline = require('node:readline');
const { formatBytes, printError } = require('../lib/utils');
const { globToRegex } = require('../lib/patterns');

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

  // Build matcher
  let matcher;
  if (pattern.includes('*') || pattern.includes('?') || pattern.includes('{')) {
    const regex = globToRegex(pattern);
    matcher = (filePath) => regex.test(filePath) || regex.test(Path.basename(filePath));
  } else {
    const lowerPattern = pattern.toLowerCase();
    matcher = (filePath) => filePath.toLowerCase().includes(lowerPattern);
  }

  // Find matching files
  const matchingFiles = [];
  let totalSize = 0;

  for (let file of db.iterateFiles()) {
    if (matcher(file.path)) {
      matchingFiles.push(file);
      totalSize += file.size || 0;
    }
  }

  if (matchingFiles.length === 0) {
    console.log(`No files match pattern: ${pattern}`);
    return;
  }

  console.log(`\n=== Files matching "${pattern}" ===`);
  console.log(`Found: ${matchingFiles.length} files (${formatBytes(totalSize)})\n`);

  const displayLimit = 50;
  for (let file of matchingFiles.slice(0, displayLimit))
    console.log(`  ${file.path} (${formatBytes(file.size)})`);

  if (matchingFiles.length > displayLimit)
    console.log(`  ... and ${matchingFiles.length - displayLimit} more files`);

  console.log('');
  console.log(`This will remove ${matchingFiles.length} files from the DATABASE ONLY.`);
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

  // Remove files
  let removed = 0;
  for (let file of matchingFiles) {
    if (db.removeFile(file.path))
      removed++;
  }

  console.log(`\nRemoved ${removed} files from database.`);
}

module.exports = commandRemove;
