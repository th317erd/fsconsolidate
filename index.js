'use strict';

/**
 * file-helper - Consolidate and deduplicate files from multiple backup locations
 *
 * WORKFLOW:
 * 1. SCAN: Scan root paths and compute SHA1 hashes for every file
 *    - All roots (including eventual sync destination) can be scanned
 *    - Uses mtime+size to skip re-hashing unchanged files on subsequent runs
 *    - Database stores roots, config, and file hashes in SQLite
 *
 * 2. SYNC: Copy unique files to a destination based on routing rules
 *    - Each unique hash is copied exactly ONCE (deduplication)
 *    - Files are routed to subdirectories based on glob pattern rules
 *    - NEVER overwrites existing files
 *    - Tracks synced files in database for resume capability
 *
 * 3. INTERACTIVE: Handle files that don't match any routing rule
 *    - Manually specify destinations or create new rules
 *
 * SAFETY:
 * - No files are deleted from source locations
 * - No files are overwritten at destination
 * - Graceful Ctrl+C handling saves database before exit
 * - Database allows resuming interrupted operations
 */

const Path = require('node:path');
const FileDatabase = require('./lib/db');
const { setShuttingDown } = require('./lib/hasher');
const { printError } = require('./lib/utils');

// Commands
const commandScan = require('./commands/scan');
const commandStatus = require('./commands/status');
const commandSync = require('./commands/sync');
const commandConfig = require('./commands/config');
const commandInteractive = require('./commands/interactive');
const commandDuplicates = require('./commands/duplicates');
const commandLargeFiles = require('./commands/large-files');
const commandInspect = require('./commands/inspect');
const commandRemove = require('./commands/remove');
const commandMigrate = require('./commands/migrate');

// Global state
let globalDb = null;

// ============================================================================
// Graceful Shutdown Handler
// ============================================================================

function setupShutdownHandler() {
  const shutdown = (signal) => {
    setShuttingDown(true);
    console.log(`\n\nReceived ${signal}. Closing database...`);

    if (globalDb) {
      try {
        globalDb.close();
        console.log('Database closed successfully.');
      } catch (err) {
        printError(`Error closing database: ${err.message}`);
      }
    }

    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ============================================================================
// CLI
// ============================================================================

function printUsage() {
  console.log(`
file-helper - Scan, deduplicate, and consolidate files from multiple locations

Usage: node index.js <command> --db <database-file> [options]

Commands:
  scan          Scan root paths and build/update the hash database
  status        Show database and sync status
  sync          Sync pending files to destination
  large-files   Review large files (>300MB) before syncing
  interactive   Interactively handle unmatched files
  config        Show or modify configuration (roots, rules, ignore patterns)
  duplicates    Show duplicate file summary
  inspect       Browse database (files, roots, duplicates, synced, hash, search)
  remove        Remove files from database matching a pattern
  migrate       Migrate from old JSON database to SQLite

Required:
  --db <file>   Path to the database file (SQLite, .db extension recommended)

Scan Options:
  -r, --root <path>      Root path to scan (can specify multiple)
  --add-root <path>      Add a root path and scan (same as config --add-root + scan)

Sync Options:
  -d, --dest <path>   Destination folder for synced files
  --dry-run           Show what would be synced without copying
  --limit N           Only sync up to N files (default: 50)
  --include-large     Include files over 300MB

Config Options:
  --add-root <path>           Add a root path to scan
  --remove-root <path>        Remove a root path
  --add-rule <pattern> <dest> Add a routing rule
  --add-ignore <pattern>      Add an ignore pattern
  --add-include <pattern>     Add include pattern (overrides ignore patterns)
  --remove-include <pattern>  Remove an include pattern
  --set-dest <path>           Set default sync destination
  --reset                     Reset to defaults (keeps file hashes)

Inspect Subcommands:
  inspect files              List all files in database
  inspect roots              Show files grouped by root
  inspect duplicates         Show duplicates with cross-root analysis
  inspect synced             Show synced files and their original names
  inspect hash <prefix>      Find files by hash prefix
  inspect search <pattern>   Search files by name pattern

Inspect Options:
  --limit N              Limit number of results (default: 50)
  --filter-root <path>   Filter to specific root
  --ext <extension>      Filter by extension (e.g., .jpg)

Migration:
  migrate <json-file>    Import data from old JSON database format

Examples:

  # SCAN - Create database and scan one or more roots
  node index.js scan --db ~/mydb.db -r ~/GoogleDrive
  node index.js scan --db ~/mydb.db -r ~/Drive1 -r ~/Drive2 -r ~/Drive3
  node index.js scan --db ~/mydb.db --add-root /mnt/newbackup

  # STATUS - View database summary and sync progress
  node index.js status --db ~/mydb.db

  # CONFIG - Modify settings (view config by running with no options)
  node index.js config --db ~/mydb.db
  node index.js config --db ~/mydb.db --add-root /mnt/backup2
  node index.js config --db ~/mydb.db --set-dest /mnt/consolidated
  node index.js config --db ~/mydb.db --add-rule "*.psd" "Photoshop"

  # SYNC - Copy unique files to destination
  node index.js sync --db ~/mydb.db --dest /mnt/consolidated --dry-run
  node index.js sync --db ~/mydb.db --dest /mnt/consolidated
  node index.js sync --db ~/mydb.db --include-large

  # MIGRATE - Import from old JSON format
  node index.js migrate ~/old-database.json --db ~/new-database.db

  # INSPECT - Browse and search the database
  node index.js inspect files --db ~/mydb.db --limit 100
  node index.js inspect duplicates --db ~/mydb.db
  node index.js inspect search "vacation" --db ~/mydb.db
`);
}

function parseArgs(argv) {
  const args = {
    command:        null,
    dbPath:         null,
    dest:           null,
    roots:          [],
    dryRun:         false,
    limit:          50,
    includeLarge:   false,
    addRoot:        null,
    removeRoot:     null,
    addRulePattern: null,
    addRuleDest:    null,
    addIgnore:      null,
    addInclude:     null,
    removeInclude:  null,
    setDest:        null,
    reset:          false,
    inspectType:    null,
    filterRoot:     null,
    filterExt:      null,
    hashQuery:      null,
    searchPattern:  null,
    removePattern:  null,
    jsonPath:       null,
  };

  const positional = [];
  let i = 2;

  while (i < argv.length) {
    const arg = argv[i];

    switch (arg) {
      case '--db':
        args.dbPath = argv[++i];
        break;
      case '--dest':
      case '-d':
        args.dest = argv[++i];
        break;
      case '--root':
      case '-r':
        args.roots.push(argv[++i]);
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--limit':
        args.limit = parseInt(argv[++i], 10);
        break;
      case '--include-large':
        args.includeLarge = true;
        break;
      case '--add-root':
        args.addRoot = argv[++i];
        break;
      case '--remove-root':
        args.removeRoot = argv[++i];
        break;
      case '--add-rule':
        args.addRulePattern = argv[++i];
        args.addRuleDest = argv[++i];
        break;
      case '--add-ignore':
        args.addIgnore = argv[++i];
        break;
      case '--add-include':
        args.addInclude = argv[++i];
        break;
      case '--remove-include':
        args.removeInclude = argv[++i];
        break;
      case '--set-dest':
        args.setDest = argv[++i];
        break;
      case '--reset':
        args.reset = true;
        break;
      case '--filter-root':
      case '--root-filter':
        args.filterRoot = argv[++i];
        break;
      case '--ext':
      case '--extension':
        args.filterExt = argv[++i];
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        if (!arg.startsWith('-'))
          positional.push(arg);
        else {
          printUsage();
          printError(`Error: Unknown option '${arg}'`);
          process.exit(1);
        }
    }
    i++;
  }

  if (positional.length > 0) {
    args.command = positional[0];

    if (args.command === 'inspect' && positional.length > 1) {
      args.inspectType = positional[1];

      if (args.inspectType === 'hash' && positional.length > 2)
        args.hashQuery = positional[2];
      else if (args.inspectType === 'search' && positional.length > 2)
        args.searchPattern = positional.slice(2).join(' ');
    } else if (args.command === 'remove' && positional.length > 1) {
      args.removePattern = positional.slice(1).join(' ');
    } else if (args.command === 'migrate' && positional.length > 1) {
      args.jsonPath = positional[1];
    } else {
      args.roots.push(...positional.slice(1));
    }
  }

  return args;
}

// ============================================================================
// Main
// ============================================================================

(async function main() {
  setupShutdownHandler();

  const args = parseArgs(process.argv);

  if (!args.command) {
    printUsage();
    printError('Error: No command specified');
    process.exit(1);
  }

  if (!args.dbPath) {
    printUsage();
    printError('Error: Database path required (--db <file>)');
    process.exit(1);
  }

  const dbPath = Path.resolve(args.dbPath);
  globalDb = new FileDatabase(dbPath);

  try {
    globalDb.open();
    const stats = globalDb.getStats();
    console.log(`Loaded database: ${stats.fileCount} files, ${stats.rootCount} roots`);
  } catch (err) {
    printError(`Error opening database: ${err.message}`);
    process.exit(1);
  }

  try {
    switch (args.command) {
      case 'scan':
        await commandScan(globalDb, args);
        break;
      case 'status':
        await commandStatus(globalDb, args);
        break;
      case 'sync':
        await commandSync(globalDb, args);
        break;
      case 'large-files':
        await commandLargeFiles(globalDb, args);
        break;
      case 'interactive':
        await commandInteractive(globalDb, args);
        break;
      case 'config':
        await commandConfig(globalDb, args);
        break;
      case 'duplicates':
        await commandDuplicates(globalDb, args);
        break;
      case 'remove':
        await commandRemove(globalDb, args);
        break;
      case 'inspect':
        await commandInspect(globalDb, args);
        break;
      case 'migrate':
        await commandMigrate(globalDb, args);
        break;
      default:
        printUsage();
        printError(`Error: Unknown command '${args.command}'`);
        process.exit(1);
    }
  } finally {
    globalDb.close();
  }
})();
