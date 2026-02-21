'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// parseArgs is currently embedded in index.js with process.exit side effects.
// To make it testable, we need to extract it. For now, we'll test the exported
// version after refactoring. The function takes argv (array) and returns an object.
const { parseArgs } = require('../index');

// Helper: build argv like Node.js would (node, script, ...args)
function argv(...args) {
  return ['node', 'index.js', ...args];
}

// ============================================================================
// Basic command parsing
// ============================================================================

describe('parseArgs', { timeout: 10000 }, () => {
  it('should parse command from positional argument', () => {
    const args = parseArgs(argv('scan', '--db', 'test.db'));
    assert.strictEqual(args.command, 'scan');
  });

  it('should parse --db flag', () => {
    const args = parseArgs(argv('status', '--db', '/path/to/db.sqlite'));
    assert.strictEqual(args.dbPath, '/path/to/db.sqlite');
  });

  it('should parse multiple --root flags', () => {
    const args = parseArgs(argv('scan', '--db', 'test.db', '-r', '/root1', '-r', '/root2'));
    assert.deepStrictEqual(args.roots, ['/root1', '/root2']);
  });

  it('should parse --dry-run as boolean', () => {
    const args = parseArgs(argv('sync', '--db', 'test.db', '--dry-run'));
    assert.strictEqual(args.dryRun, true);
  });

  it('should parse --limit as integer', () => {
    const args = parseArgs(argv('inspect', 'files', '--db', 'test.db', '--limit', '100'));
    assert.strictEqual(args.limit, 100);
  });

  it('should default limit to 50', () => {
    const args = parseArgs(argv('sync', '--db', 'test.db'));
    assert.strictEqual(args.limit, 50);
  });

  it('should parse --include-large as boolean', () => {
    const args = parseArgs(argv('sync', '--db', 'test.db', '--include-large'));
    assert.strictEqual(args.includeLarge, true);
  });

  it('should parse --dest / -d flag', () => {
    const args = parseArgs(argv('sync', '--db', 'test.db', '-d', '/mnt/dest'));
    assert.strictEqual(args.dest, '/mnt/dest');
  });
});

// ============================================================================
// Config flags
// ============================================================================

describe('parseArgs config flags', { timeout: 10000 }, () => {
  it('should parse --add-root', () => {
    const args = parseArgs(argv('config', '--db', 'test.db', '--add-root', '/new/root'));
    assert.strictEqual(args.addRoot, '/new/root');
  });

  it('should parse --remove-root', () => {
    const args = parseArgs(argv('config', '--db', 'test.db', '--remove-root', '/old/root'));
    assert.strictEqual(args.removeRoot, '/old/root');
  });

  it('should parse --add-rule with pattern and dest', () => {
    const args = parseArgs(argv('config', '--db', 'test.db', '--add-rule', '*.psd', 'Photoshop'));
    assert.strictEqual(args.addRulePattern, '*.psd');
    assert.strictEqual(args.addRuleDest, 'Photoshop');
  });

  it('should parse --add-ignore', () => {
    const args = parseArgs(argv('config', '--db', 'test.db', '--add-ignore', '*.bak'));
    assert.strictEqual(args.addIgnore, '*.bak');
  });

  it('should parse --add-include', () => {
    const args = parseArgs(argv('config', '--db', 'test.db', '--add-include', '.env.example'));
    assert.strictEqual(args.addInclude, '.env.example');
  });

  it('should parse --remove-include', () => {
    const args = parseArgs(argv('config', '--db', 'test.db', '--remove-include', '.env.example'));
    assert.strictEqual(args.removeInclude, '.env.example');
  });

  it('should parse --set-dest', () => {
    const args = parseArgs(argv('config', '--db', 'test.db', '--set-dest', '/mnt/consolidated'));
    assert.strictEqual(args.setDest, '/mnt/consolidated');
  });

  it('should parse --reset as boolean', () => {
    const args = parseArgs(argv('config', '--db', 'test.db', '--reset'));
    assert.strictEqual(args.reset, true);
  });
});

// ============================================================================
// Root option parsing
// ============================================================================

describe('parseArgs --root-option', { timeout: 10000 }, () => {
  it('should parse --root-option with root, key, and value', () => {
    const args = parseArgs(argv('config', '--db', 'test.db', '--root-option', '/my/root', 'move_on_sync', 'true'));
    assert.strictEqual(args.rootOptionRoot, '/my/root');
    assert.strictEqual(args.rootOptionKey, 'move_on_sync');
    assert.strictEqual(args.rootOptionValue, 'true');
  });

  it('should default --root-option value to "true" when omitted', () => {
    const args = parseArgs(argv('config', '--db', 'test.db', '--root-option', '/my/root', 'move_on_sync'));
    assert.strictEqual(args.rootOptionRoot, '/my/root');
    assert.strictEqual(args.rootOptionKey, 'move_on_sync');
    assert.strictEqual(args.rootOptionValue, 'true');
  });

  it('BUG: should not crash when --root-option is last flag without enough args', () => {
    // This tests the argv bounds overflow bug.
    // --root-option expects 2-3 more args, but if it's the last flag, argv[++i] is undefined
    // and then `argv[i + 1].startsWith('--')` throws on undefined.
    assert.throws(
      () => parseArgs(argv('config', '--db', 'test.db', '--root-option')),
      // Should throw a clear error, not a cryptic TypeError
    );
  });
});

// ============================================================================
// Inspect subcommands
// ============================================================================

describe('parseArgs inspect subcommands', { timeout: 10000 }, () => {
  it('should parse inspect with subcommand', () => {
    const args = parseArgs(argv('inspect', 'files', '--db', 'test.db'));
    assert.strictEqual(args.command, 'inspect');
    assert.strictEqual(args.inspectType, 'files');
  });

  it('should parse inspect hash with query', () => {
    const args = parseArgs(argv('inspect', 'hash', 'abc123', '--db', 'test.db'));
    assert.strictEqual(args.inspectType, 'hash');
    assert.strictEqual(args.hashQuery, 'abc123');
  });

  it('should parse inspect search with multi-word pattern', () => {
    const args = parseArgs(argv('inspect', 'search', 'vacation', 'photos', '--db', 'test.db'));
    assert.strictEqual(args.inspectType, 'search');
    assert.strictEqual(args.searchPattern, 'vacation photos');
  });
});

// ============================================================================
// Other subcommands
// ============================================================================

describe('parseArgs other subcommands', { timeout: 10000 }, () => {
  it('should parse analyze subcommand', () => {
    const args = parseArgs(argv('analyze', 'guess-targets', '--db', 'test.db'));
    assert.strictEqual(args.command, 'analyze');
    assert.strictEqual(args.analyzeType, 'guess-targets');
  });

  it('should parse remove with pattern', () => {
    const args = parseArgs(argv('remove', '*.tmp', '--db', 'test.db'));
    assert.strictEqual(args.command, 'remove');
    assert.strictEqual(args.removePattern, '*.tmp');
  });

  it('should parse migrate with json path', () => {
    const args = parseArgs(argv('migrate', '/old/db.json', '--db', 'test.db'));
    assert.strictEqual(args.command, 'migrate');
    assert.strictEqual(args.jsonPath, '/old/db.json');
  });

  it('should parse help with command', () => {
    const args = parseArgs(argv('help', 'scan', '--db', 'test.db'));
    assert.strictEqual(args.command, 'help');
    assert.strictEqual(args.helpCommand, 'scan');
  });

  it('should parse garbage subcommand', () => {
    const args = parseArgs(argv('garbage', 'clean', '--db', 'test.db'));
    assert.strictEqual(args.command, 'garbage');
    assert.strictEqual(args.garbageSubcommand, 'clean');
  });
});

// ============================================================================
// Filter flags
// ============================================================================

describe('parseArgs filter flags', { timeout: 10000 }, () => {
  it('should parse --filter-root', () => {
    const args = parseArgs(argv('inspect', 'files', '--db', 'test.db', '--filter-root', '/my/root'));
    assert.strictEqual(args.filterRoot, '/my/root');
  });

  it('should parse --root-filter as alias for --filter-root', () => {
    const args = parseArgs(argv('inspect', 'files', '--db', 'test.db', '--root-filter', '/my/root'));
    assert.strictEqual(args.filterRoot, '/my/root');
  });

  it('should parse --ext / --extension', () => {
    const args = parseArgs(argv('inspect', 'files', '--db', 'test.db', '--ext', 'jpg'));
    assert.strictEqual(args.filterExt, 'jpg');
  });

  it('should parse --type', () => {
    const args = parseArgs(argv('inspect', 'scan-log', '--db', 'test.db', '--type', 'ignored'));
    assert.strictEqual(args.filterType, 'ignored');
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe('parseArgs edge cases', { timeout: 10000 }, () => {
  it('should return null command when no args given', () => {
    const args = parseArgs(argv());
    assert.strictEqual(args.command, null);
  });

  it('should handle unknown flags gracefully', () => {
    // After refactoring, unknown flags should return an error, not call process.exit
    assert.throws(
      () => parseArgs(argv('scan', '--db', 'test.db', '--unknown-flag')),
    );
  });
});
