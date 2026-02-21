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
const commandAnalyze = require('./commands/analyze');
const commandGarbage = require('./commands/garbage');

// Global state
let globalDb = null;

// ============================================================================
// Graceful Shutdown Handler
// ============================================================================

function setupShutdownHandler() {
  let shutdownRequested = false;

  const shutdown = (signal) => {
    if (shutdownRequested) {
      console.log('\nForce exiting...');

      if (globalDb) {
        try { globalDb.close(); } catch (err) { /* ignore */ }
      }

      process.exit(1);
    }

    shutdownRequested = true;
    setShuttingDown(true);
    console.log(`\n\nReceived ${signal}. Shutting down gracefully... (press again to force)`);

    if (globalDb) {
      try {
        globalDb.close();
        console.log('Database closed.');
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

// ============================================================================
// Command Help Definitions (imported from command modules)
// ============================================================================

const COMMAND_HELP = {
  'scan':        commandScan.HELP,
  'status':      commandStatus.HELP,
  'sync':        commandSync.HELP,
  'large-files': commandLargeFiles.HELP,
  'interactive': commandInteractive.HELP,
  'config':      commandConfig.HELP,
  'duplicates':  commandDuplicates.HELP,
  'inspect':     commandInspect.HELP,
  'analyze':     commandAnalyze.HELP,
  'remove':      commandRemove.HELP,
  'migrate':     commandMigrate.HELP,
  'garbage':     commandGarbage.HELP,
  'help': {
    summary: 'Show help for a command',
    description: `
Displays detailed help and examples for a specific command.`,
    options: null,
    examples: `
  # Show general help
  node index.js help --db ~/mydb.db

  # Show help for a specific command
  node index.js help scan --db ~/mydb.db
  node index.js help sync --db ~/mydb.db
  node index.js help config --db ~/mydb.db`,
  },
};

function printCommandHelp(commandName) {
  const help = COMMAND_HELP[commandName];

  if (!help) {
    console.log(`Unknown command: ${commandName}`);
    console.log(`\nAvailable commands: ${Object.keys(COMMAND_HELP).join(', ')}`);
    process.exit(1);
  }

  console.log(`
${commandName} - ${help.summary}
${help.description}
${help.options ? `\nOptions:${help.options}` : ''}
Examples:
${help.examples}
`);
}

function printUsage() {
  console.log(`
file-helper - Scan, deduplicate, and consolidate files from multiple locations

Usage: node index.js <command> --db <database-file> [options]
       node index.js help <command> --db <database-file>

Commands:
  scan          Scan root paths and build/update the hash database
  status        Show database and sync status
  sync          Sync pending files to destination
  large-files   Review large files (>300MB) before syncing
  interactive   Interactively handle unmatched files
  config        Show or modify configuration (roots, rules, ignore patterns)
  duplicates    Show duplicate file summary
  inspect       Browse database (files, roots, duplicates, synced, hash, search)
  analyze       Analyze files (guess-targets: infer sync locations from hashes)
  remove        Remove files from database matching a pattern
  garbage       Find/delete files in database that match ignore patterns
  migrate       Migrate from old JSON database to SQLite
  help          Show help for a specific command

Required:
  --db <file>   Path to the database file (SQLite, .db extension recommended)

Run 'node index.js help <command> --db <file>' for detailed help on a command.

Quick Examples:

  # Scan directories
  node index.js scan --db ~/mydb.db -r ~/GoogleDrive -r ~/Backups

  # Check status
  node index.js status --db ~/mydb.db

  # Sync files (dry run first)
  node index.js sync --db ~/mydb.db --dry-run
  node index.js sync --db ~/mydb.db

  # Get help on a command
  node index.js help sync --db ~/mydb.db
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
    addRoot:          null,
    removeRoot:       null,
    rootOptionRoot:   null,
    rootOptionKey:    null,
    rootOptionValue:  null,
    addRulePattern:   null,
    addRuleDest:    null,
    addIgnore:      null,
    addInclude:     null,
    removeInclude:  null,
    setDest:        null,
    reset:          false,
    inspectType:    null,
    analyzeType:    null,
    filterRoot:     null,
    filterExt:      null,
    hashQuery:      null,
    searchPattern:  null,
    removePattern:  null,
    filterType:     null,
    jsonPath:       null,
    helpCommand:    null,
    garbageSubcommand: null,
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
      case '--root-option':
        if (i + 2 >= argv.length)
          throw new Error('--root-option requires at least 2 arguments: <root> <key> [value]');
        args.rootOptionRoot = argv[++i];
        args.rootOptionKey = argv[++i];
        // Value is optional - omitting it implies 'true'
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--'))
          args.rootOptionValue = argv[++i];
        else
          args.rootOptionValue = 'true';
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
      case '--type':
        args.filterType = argv[++i];
        break;
      case '--help':
      case '-h':
        args._help = true;
        break;
      default:
        if (!arg.startsWith('-'))
          positional.push(arg);
        else
          throw new Error(`Unknown option '${arg}'`);
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
    } else if (args.command === 'analyze' && positional.length > 1) {
      args.analyzeType = positional[1];
    } else if (args.command === 'remove' && positional.length > 1) {
      args.removePattern = positional.slice(1).join(' ');
    } else if (args.command === 'migrate' && positional.length > 1) {
      args.jsonPath = positional[1];
    } else if (args.command === 'help' && positional.length > 1) {
      args.helpCommand = positional[1];
    } else if (args.command === 'garbage' && positional.length > 1) {
      args.garbageSubcommand = positional[1];
    } else {
      args.roots.push(...positional.slice(1));
    }
  }

  return args;
}

// ============================================================================
// Main
// ============================================================================

if (require.main === module) (async function main() {
  setupShutdownHandler();

  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    printUsage();
    printError(`Error: ${err.message}`);
    process.exit(1);
  }

  if (args._help) {
    printUsage();
    process.exit(0);
  }

  if (!args.command) {
    printUsage();
    printError('Error: No command specified');
    process.exit(1);
  }

  // Handle help command before requiring database
  if (args.command === 'help') {
    if (args.helpCommand) {
      printCommandHelp(args.helpCommand);
    } else {
      printUsage();
    }
    process.exit(0);
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
      case 'analyze':
        await commandAnalyze(globalDb, args);
        break;
      case 'migrate':
        await commandMigrate(globalDb, args);
        break;
      case 'garbage':
        await commandGarbage(globalDb, args);
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

module.exports = { parseArgs };
