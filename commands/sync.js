'use strict';

const FileSystem = require('node:fs');
const Path = require('node:path');
const Readline = require('node:readline');
const { formatBytes, printError } = require('../lib/utils');
const { matchFileToRule } = require('../lib/patterns');
const { copyFileToDestination } = require('../lib/sync');
const { getShuttingDown } = require('../lib/hasher');
const { LARGE_FILE_THRESHOLD } = require('../lib/constants');

/**
 * Prompt user for input
 */
async function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

/**
 * Prompt user to choose a filename when duplicates have different names
 */
async function promptForFilename(allFilenames, allSourcePaths, rl) {
  console.log(`\n  File has ${allFilenames.length} different names across duplicates:`);
  allFilenames.forEach((name, idx) => {
    console.log(`    [${idx + 1}] ${name}`);
  });

  console.log(`  Source locations:`);
  allSourcePaths.slice(0, 5).forEach((p) => console.log(`    - ${p}`));
  if (allSourcePaths.length > 5)
    console.log(`    ... and ${allSourcePaths.length - 5} more`);

  while (true) {
    const answer = await prompt(rl, `  Choose filename [1-${allFilenames.length}], or type custom name: `);

    if (getShuttingDown())
      return null;

    const trimmed = answer.trim();
    if (!trimmed)
      continue;

    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= allFilenames.length)
      return allFilenames[num - 1];

    if (trimmed.includes('/') || trimmed.includes('\\')) {
      console.log('  Invalid: filename cannot contain path separators');
      continue;
    }

    return trimmed;
  }
}

/**
 * Get unique files pending sync, grouped by hash
 */
function getPendingFiles(db) {
  const routingRules = db.getRoutingRules();
  const defaultRoutingRules = db.getDefaultRoutingRules();

  const pending = [];
  const unmatched = [];
  const seenHashes = new Map(); // hash -> file info

  for (let file of db.iterateFiles()) {
    if (!file.hash)
      continue;

    if (db.isSynced(file.hash))
      continue;

    if (!seenHashes.has(file.hash)) {
      seenHashes.set(file.hash, {
        hash:           file.hash,
        size:           file.size,
        sourcePath:     file.path,
        allSourcePaths: [file.path],
        allFilenames:   [Path.basename(file.path)],
      });
    } else {
      const existing = seenHashes.get(file.hash);
      existing.allSourcePaths.push(file.path);
      const filename = Path.basename(file.path);
      if (!existing.allFilenames.includes(filename))
        existing.allFilenames.push(filename);
    }
  }

  // Categorize by routing rules
  for (let [hash, fileInfo] of seenHashes) {
    const destFolder = matchFileToRule(fileInfo.sourcePath, routingRules, defaultRoutingRules);
    if (destFolder) {
      fileInfo.destFolder = destFolder;
      pending.push(fileInfo);
    } else {
      unmatched.push(fileInfo);
    }
  }

  return { pending, unmatched };
}

async function commandSync(db, args) {
  const destPath = args.dest || db.getSyncDestination();

  if (!destPath) {
    printError('Error: No destination specified. Use --dest or config --set-dest');
    process.exit(1);
  }

  const resolved = Path.resolve(destPath);
  if (!FileSystem.existsSync(resolved)) {
    console.log(`Creating destination: ${resolved}`);
    FileSystem.mkdirSync(resolved, { recursive: true });
  }

  const { pending, unmatched } = getPendingFiles(db);

  const regularFiles = [];
  const largeFiles = [];

  for (let file of pending) {
    if (file.size > LARGE_FILE_THRESHOLD)
      largeFiles.push(file);
    else
      regularFiles.push(file);
  }

  const multiNameFiles = pending.filter((f) => f.allFilenames.length > 1);

  console.log(`\nSync Status:`);
  console.log(`  Already synced: ${db.getSyncedCount()}`);
  console.log(`  Pending: ${pending.length}`);
  if (largeFiles.length > 0) {
    console.log(`    - Large (>${formatBytes(LARGE_FILE_THRESHOLD)}): ${largeFiles.length}`);
    console.log(`    - Regular: ${regularFiles.length}`);
  }
  if (multiNameFiles.length > 0)
    console.log(`    - With multiple filenames: ${multiNameFiles.length} (will prompt)`);

  console.log(`  Unmatched: ${unmatched.length}`);

  let toProcess = (args.includeLarge) ? pending : regularFiles;
  toProcess = toProcess.slice(0, args.limit || 50);

  if (!args.includeLarge && largeFiles.length > 0 && !args.dryRun)
    console.log(`\nSkipping ${largeFiles.length} large files. Use --include-large to include them.`);

  if (toProcess.length === 0) {
    console.log('\nNo files to sync.');
    return;
  }

  console.log(`\n${(args.dryRun) ? '[DRY RUN] Would sync' : 'Syncing'} ${toProcess.length} files to ${resolved}...`);

  let copied = 0;
  let errors = 0;

  const needsPrompt = !args.dryRun && toProcess.some((f) => f.allFilenames.length > 1);
  const rl = (needsPrompt) ? Readline.createInterface({ input: process.stdin, output: process.stdout }) : null;

  for (let file of toProcess) {
    if (getShuttingDown())
      break;

    try {
      let chosenFilename = Path.basename(file.sourcePath);

      if (file.allFilenames.length > 1) {
        if (args.dryRun) {
          console.log(`  [DRY] ${file.allFilenames.join(' | ')} -> ${file.destFolder}/ (would prompt for name)`);
          continue;
        }

        const chosen = await promptForFilename(file.allFilenames, file.allSourcePaths, rl);
        if (chosen === null)
          break;

        chosenFilename = chosen;

        const matchingSource = file.allSourcePaths.find((p) => Path.basename(p) === chosenFilename);
        if (matchingSource)
          file.sourcePath = matchingSource;
      }

      if (args.dryRun) {
        console.log(`  [DRY] ${chosenFilename} -> ${file.destFolder}/`);
      } else {
        const finalPath = copyFileToDestination(file.sourcePath, resolved, file.destFolder, chosenFilename);
        db.markSynced(
          file.hash,
          finalPath,
          file.sourcePath,
          chosenFilename,
          file.allSourcePaths,
          file.allFilenames
        );
        copied++;
        console.log(`  Copied: ${chosenFilename} -> ${file.destFolder}/`);
      }
    } catch (err) {
      printError(`\n  Error copying ${file.sourcePath}: ${err.message}`);
      errors++;
    }
  }

  if (rl)
    rl.close();

  if (!args.dryRun)
    console.log(`\nSync complete: ${copied} copied, ${errors} errors`);
}

module.exports = commandSync;
