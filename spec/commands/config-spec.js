'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTempDir, createTempDatabase, captureOutput, removeTempDir } = require('../helpers');
const commandConfig = require('../../commands/config');

let cleanup;

afterEach(() => {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
});

// ============================================================================
// View config (no modifications)
// ============================================================================

describe('commandConfig — view only', { timeout: 10000 }, () => {
  it('should display default configuration when no options given', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const { lines } = await captureOutput(() =>
      commandConfig(tmp.db, {})
    );

    const text = lines.join('\n');
    assert.ok(text.includes('=== Configuration ==='));
    assert.ok(text.includes('Roots (0)'));
    assert.ok(text.includes('(none)'));
    assert.ok(text.includes('Sync destination: (not set)'));
    assert.ok(text.includes('Default routing rules'));
    assert.ok(text.includes('Default ignore patterns'));
  });
});

// ============================================================================
// Add/remove roots
// ============================================================================

describe('commandConfig — roots', { timeout: 10000 }, () => {
  it('should add a root via --add-root', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = createTempDir('root');

    const { lines } = await captureOutput(() =>
      commandConfig(tmp.db, { addRoot: rootDir })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Added root:'));

    const roots = tmp.db.getRoots();
    assert.strictEqual(roots.length, 1);

    removeTempDir(rootDir);
  });

  it('should remove a root via --remove-root', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = createTempDir('root');
    tmp.db.addRoot(rootDir);
    assert.strictEqual(tmp.db.getRoots().length, 1);

    const { lines } = await captureOutput(() =>
      commandConfig(tmp.db, { removeRoot: rootDir })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Removed root:'));
    assert.strictEqual(tmp.db.getRoots().length, 0);

    removeTempDir(rootDir);
  });

  it('should report when removing a non-existent root', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const { lines } = await captureOutput(() =>
      commandConfig(tmp.db, { removeRoot: '/nonexistent/path' })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Root not found:'));
  });
});

// ============================================================================
// Routing rules
// ============================================================================

describe('commandConfig — routing rules', { timeout: 10000 }, () => {
  it('should add a custom routing rule', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const { lines } = await captureOutput(() =>
      commandConfig(tmp.db, { addRulePattern: '*.psd', addRuleDest: 'Photoshop' })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Added rule: *.psd -> Photoshop'));

    const rules = tmp.db.getRoutingRules();
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0].pattern, '*.psd');
    assert.strictEqual(rules[0].dest, 'Photoshop');
  });
});

// ============================================================================
// Ignore patterns
// ============================================================================

describe('commandConfig — ignore patterns', { timeout: 10000 }, () => {
  it('should add a custom ignore pattern', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const { lines } = await captureOutput(() =>
      commandConfig(tmp.db, { addIgnore: '*.bak' })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Added ignore pattern: *.bak'));

    const patterns = tmp.db.getIgnorePatterns();
    assert.ok(patterns.includes('*.bak'));
  });
});

// ============================================================================
// Include patterns
// ============================================================================

describe('commandConfig — include patterns', { timeout: 10000 }, () => {
  it('should add an include pattern', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const { lines } = await captureOutput(() =>
      commandConfig(tmp.db, { addInclude: '.env.example' })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Added include pattern: .env.example'));

    const patterns = tmp.db.getIncludePatterns();
    assert.ok(patterns.includes('.env.example'));
  });

  it('should remove an include pattern', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    tmp.db.addIncludePattern('.env.example');

    const { lines } = await captureOutput(() =>
      commandConfig(tmp.db, { removeInclude: '.env.example' })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Removed include pattern: .env.example'));
    assert.strictEqual(tmp.db.getIncludePatterns().length, 0);
  });

  it('should report when removing non-existent include pattern', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const { lines } = await captureOutput(() =>
      commandConfig(tmp.db, { removeInclude: 'nope' })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Include pattern not found: nope'));
  });
});

// ============================================================================
// Sync destination
// ============================================================================

describe('commandConfig — set-dest', { timeout: 10000 }, () => {
  it('should set the sync destination', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const destDir = createTempDir('dest');

    const { lines } = await captureOutput(() =>
      commandConfig(tmp.db, { setDest: destDir })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Set sync destination:'));
    assert.ok(tmp.db.getSyncDestination() !== null);

    removeTempDir(destDir);
  });
});

// ============================================================================
// Reset
// ============================================================================

describe('commandConfig — reset', { timeout: 10000 }, () => {
  it('should reset config to defaults', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    // Add custom patterns and rules
    tmp.db.addIgnorePattern('*.custom');
    tmp.db.addRoutingRule('*.blend', 'Blender');

    assert.strictEqual(tmp.db.getIgnorePatterns().length, 1);
    assert.strictEqual(tmp.db.getRoutingRules().length, 1);

    const { lines } = await captureOutput(() =>
      commandConfig(tmp.db, { reset: true })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Reset rules and ignore patterns to defaults'));

    // Custom patterns and rules should be gone
    assert.strictEqual(tmp.db.getIgnorePatterns().length, 0);
    assert.strictEqual(tmp.db.getRoutingRules().length, 0);

    // Defaults should still be there
    assert.ok(tmp.db.getDefaultIgnorePatterns().length > 0);
    assert.ok(tmp.db.getDefaultRoutingRules().length > 0);
  });
});

// ============================================================================
// Root options
// ============================================================================

describe('commandConfig — root options', { timeout: 10000 }, () => {
  it('should set a root option', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = createTempDir('root');
    tmp.db.addRoot(rootDir);

    const { lines } = await captureOutput(() =>
      commandConfig(tmp.db, {
        rootOptionRoot:  rootDir,
        rootOptionKey:   'move_on_sync',
        rootOptionValue: 'true',
      })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Set root option:'));
    assert.ok(text.includes('move_on_sync=true'));

    removeTempDir(rootDir);
  });

  it('should remove a root option when value is "false"', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = createTempDir('root');
    tmp.db.addRoot(rootDir);
    tmp.db.setRootOption(rootDir, 'move_on_sync', 'true');

    const { lines } = await captureOutput(() =>
      commandConfig(tmp.db, {
        rootOptionRoot:  rootDir,
        rootOptionKey:   'move_on_sync',
        rootOptionValue: 'false',
      })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Disabled "move_on_sync"'));

    removeTempDir(rootDir);
  });

  it('should display root options in config output', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = createTempDir('root');
    tmp.db.addRoot(rootDir);
    tmp.db.setRootOption(rootDir, 'move_on_sync', 'true');

    const { lines } = await captureOutput(() =>
      commandConfig(tmp.db, {})
    );

    const text = lines.join('\n');
    assert.ok(text.includes('move_on_sync=true'));

    removeTempDir(rootDir);
  });
});

// ============================================================================
// Multiple operations in one call
// ============================================================================

describe('commandConfig — combined operations', { timeout: 10000 }, () => {
  it('should handle multiple config changes in one call', async () => {
    const tmp = createTempDatabase();
    cleanup = tmp.cleanup;

    const rootDir = createTempDir('root');
    const destDir = createTempDir('dest');

    const { lines } = await captureOutput(() =>
      commandConfig(tmp.db, {
        addRoot:        rootDir,
        addIgnore:      '*.custom',
        addRulePattern: '*.blend',
        addRuleDest:    'Blender',
        setDest:        destDir,
      })
    );

    const text = lines.join('\n');
    assert.ok(text.includes('Added root:'));
    assert.ok(text.includes('Added rule: *.blend -> Blender'));
    assert.ok(text.includes('Added ignore pattern: *.custom'));
    assert.ok(text.includes('Set sync destination:'));

    assert.strictEqual(tmp.db.getRoots().length, 1);
    assert.strictEqual(tmp.db.getRoutingRules().length, 1);
    assert.ok(tmp.db.getIgnorePatterns().includes('*.custom'));

    removeTempDir(rootDir);
    removeTempDir(destDir);
  });
});
