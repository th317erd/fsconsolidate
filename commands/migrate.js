'use strict';

const FileSystem = require('node:fs');
const Path = require('node:path');
const { formatBytes, printSuccess, printError } = require('../lib/utils');

/**
 * Migrate a JSON database to SQLite format
 */
async function commandMigrate(db, args) {
  const jsonPath = args.jsonPath;

  if (!jsonPath) {
    printError('Error: No JSON file specified.');
    console.log('Usage: migrate <json-file> --db <sqlite-database>');
    console.log('');
    console.log('This command migrates data from an old JSON database to the new SQLite format.');
    console.log('');
    console.log('Example:');
    console.log('  node index.js migrate ~/old-database.json --db ~/new-database.db');
    process.exit(1);
  }

  const resolvedJsonPath = Path.resolve(jsonPath);

  if (!FileSystem.existsSync(resolvedJsonPath)) {
    printError(`Error: JSON file not found: ${resolvedJsonPath}`);
    process.exit(1);
  }

  console.log(`\n=== Migrating JSON to SQLite ===`);
  console.log(`Source (JSON): ${resolvedJsonPath}`);
  console.log(`Target (SQLite): ${db.dbPath}`);
  console.log('');

  // Read JSON file
  console.log('Reading JSON file...');
  let jsonData;
  try {
    const data = FileSystem.readFileSync(resolvedJsonPath, 'utf8');
    jsonData = JSON.parse(data);
  } catch (err) {
    printError(`Error reading JSON file: ${err.message}`);
    process.exit(1);
  }

  // Migrate config
  console.log('Migrating configuration...');

  // Roots
  const roots = jsonData.config?.roots || [];
  for (let root of roots)
    db.addRoot(root);

  console.log(`  - ${roots.length} roots`);

  // Sync destination
  if (jsonData.config?.syncDestination)
    db.setSyncDestination(jsonData.config.syncDestination);

  // Custom ignore patterns
  const customIgnore = jsonData.config?.ignorePatterns || [];
  for (let pattern of customIgnore)
    db.addIgnorePattern(pattern);

  console.log(`  - ${customIgnore.length} custom ignore patterns`);

  // Include patterns
  const includePatterns = jsonData.config?.includePatterns || [];
  for (let pattern of includePatterns)
    db.addIncludePattern(pattern);

  console.log(`  - ${includePatterns.length} include patterns`);

  // Custom routing rules
  const customRules = jsonData.config?.routingRules || [];
  for (let rule of customRules)
    db.addRoutingRule(rule.pattern, rule.dest, rule.description || 'User rule');

  console.log(`  - ${customRules.length} custom routing rules`);

  // Migrate files
  const files = jsonData.files || {};
  const fileCount = Object.keys(files).length;
  console.log(`\nMigrating ${fileCount} files...`);

  const BATCH_SIZE = 5000;
  let batch = [];
  let processed = 0;

  for (let [filePath, info] of Object.entries(files)) {
    batch.push({
      path:    filePath,
      hash:    info.hash,
      size:    info.size,
      mtimeMs: info.mtimeMs,
      mtime:   info.mtime,
      error:   info.error || null,
    });

    if (batch.length >= BATCH_SIZE) {
      db.upsertFiles(batch);
      processed += batch.length;
      process.stdout.write(`\r  Processed ${processed}/${fileCount} files...`);
      batch = [];
    }
  }

  // Insert remaining
  if (batch.length > 0) {
    db.upsertFiles(batch);
    processed += batch.length;
  }

  console.log(`\r  Processed ${processed}/${fileCount} files.    `);

  // Migrate synced
  const synced = jsonData.synced || {};
  const syncedCount = Object.keys(synced).length;
  console.log(`\nMigrating ${syncedCount} synced records...`);

  let syncedProcessed = 0;
  for (let [hash, info] of Object.entries(synced)) {
    db.markSynced(
      hash,
      info.destPath,
      info.sourcePath,
      info.chosenFilename || Path.basename(info.destPath),
      info.allSourcePaths || [info.sourcePath],
      info.allFilenames || [Path.basename(info.destPath)]
    );
    syncedProcessed++;

    if (syncedProcessed % 1000 === 0)
      process.stdout.write(`\r  Processed ${syncedProcessed}/${syncedCount} synced records...`);
  }

  console.log(`\r  Processed ${syncedProcessed}/${syncedCount} synced records.    `);

  // Summary
  const stats = db.getStats();
  console.log(`\n=== Migration Complete ===`);
  printSuccess('Successfully migrated to SQLite!');
  console.log('');
  console.log(`  Files: ${stats.fileCount}`);
  console.log(`  Unique hashes: ${stats.uniqueHashCount}`);
  console.log(`  Total size: ${formatBytes(stats.totalSize)}`);
  console.log(`  Synced: ${stats.syncedCount}`);
  console.log(`  Roots: ${stats.rootCount}`);
  console.log('');
  console.log(`The JSON file has not been modified.`);
  console.log(`You can delete it once you've verified the migration.`);
}

module.exports = commandMigrate;
