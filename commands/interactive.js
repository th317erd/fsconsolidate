'use strict';

const FileSystem = require('node:fs');
const Path = require('node:path');
const Readline = require('node:readline');
const { formatBytes, printError } = require('../lib/utils');
const { matchFileToRule } = require('../lib/patterns');
const { copyFileToDestination } = require('../lib/sync');
const { getShuttingDown } = require('../lib/hasher');

async function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

/**
 * Get unmatched files (no routing rule matches)
 */
function getUnmatchedFiles(db) {
  const routingRules = db.getRoutingRules();
  const defaultRoutingRules = db.getDefaultRoutingRules();
  const unmatched = [];
  const seenHashes = new Map();

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

  for (let [hash, fileInfo] of seenHashes) {
    const destFolder = matchFileToRule(fileInfo.sourcePath, routingRules, defaultRoutingRules);
    if (!destFolder)
      unmatched.push(fileInfo);
  }

  return unmatched;
}

async function commandInteractive(db, args) {
  const destPath = args.dest || db.getSyncDestination();
  if (!destPath) {
    printError('Error: No destination. Use --dest or config --set-dest');
    process.exit(1);
  }

  const resolved = Path.resolve(destPath);
  const rl = Readline.createInterface({ input: process.stdin, output: process.stdout });
  const unmatched = getUnmatchedFiles(db);

  if (unmatched.length === 0) {
    console.log('No unmatched files to process.');
    rl.close();
    return;
  }

  console.log(`\n${unmatched.length} files don't match any routing rules.`);
  console.log('Commands: [s]kip, [r]ule <pattern> <dest>, [d]est <folder>, [q]uit\n');

  let i = 0;
  while (i < unmatched.length && !getShuttingDown()) {
    const file = unmatched[i];
    const fileName = Path.basename(file.sourcePath);
    const ext = Path.extname(fileName).toLowerCase();

    console.log(`\n[${i + 1}/${unmatched.length}] ${fileName}`);
    console.log(`  Path: ${file.sourcePath}`);
    console.log(`  Size: ${formatBytes(file.size)}, Ext: ${ext || '(none)'}`);

    if (file.allFilenames.length > 1)
      console.log(`  Other names: ${file.allFilenames.join(', ')}`);

    const answer = await prompt(rl, '> ');
    const parts = answer.trim().split(/\s+/);
    const cmd = parts[0]?.toLowerCase();

    switch (cmd) {
      case 's':
      case 'skip':
        i++;
        break;

      case 'r':
      case 'rule':
        if (parts.length < 3) {
          console.log('Usage: rule <pattern> <destination>');
        } else {
          const pattern = parts[1];
          const dest = parts.slice(2).join(' ');
          db.addRoutingRule(pattern, dest);
          console.log(`Added rule: ${pattern} -> ${dest}`);

          const routingRules = db.getRoutingRules();
          const defaultRoutingRules = db.getDefaultRoutingRules();
          const newDest = matchFileToRule(file.sourcePath, routingRules, defaultRoutingRules);
          if (newDest)
            console.log(`This file now matches -> ${newDest}`);
        }
        break;

      case 'd':
      case 'dest':
        if (parts.length < 2) {
          console.log('Usage: dest <folder>');
        } else {
          const dest = parts.slice(1).join(' ');
          let chosenFilename = Path.basename(file.sourcePath);

          if (file.allFilenames.length > 1) {
            console.log(`\nThis file has ${file.allFilenames.length} different names:`);
            file.allFilenames.forEach((name, idx) => console.log(`  [${idx + 1}] ${name}`));
            const nameAnswer = await prompt(rl, `Choose [1-${file.allFilenames.length}] or type custom: `);
            const num = parseInt(nameAnswer.trim(), 10);
            if (!isNaN(num) && num >= 1 && num <= file.allFilenames.length)
              chosenFilename = file.allFilenames[num - 1];
            else if (nameAnswer.trim())
              chosenFilename = nameAnswer.trim();
          }

          try {
            const finalPath = copyFileToDestination(file.sourcePath, resolved, dest, chosenFilename);
            db.markSynced(
              file.hash,
              finalPath,
              file.sourcePath,
              chosenFilename,
              file.allSourcePaths,
              file.allFilenames
            );
            console.log(`Copied to: ${finalPath}`);
            i++;
          } catch (err) {
            printError(`Error: ${err.message}`);
          }
        }
        break;

      case 'q':
      case 'quit':
        console.log('Exiting...');
        rl.close();
        return;

      case '':
        console.log('Commands: [s]kip, [r]ule <pattern> <dest>, [d]est <folder>, [q]uit');
        break;

      default:
        console.log(`Unknown: ${cmd}. Commands: [s]kip, [r]ule, [d]est, [q]uit`);
    }
  }

  console.log('\nDone processing unmatched files.');
  rl.close();
}

module.exports = commandInteractive;
