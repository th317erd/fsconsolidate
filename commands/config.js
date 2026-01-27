'use strict';

const Path = require('node:path');

async function commandConfig(db, args) {
  let modified = false;

  if (args.reset) {
    db.resetConfig();
    modified = true;
    console.log('Reset rules and ignore patterns to defaults.');
  }

  if (args.addRoot) {
    const resolved = db.addRoot(args.addRoot);
    modified = true;
    console.log(`Added root: ${resolved}`);
  }

  if (args.removeRoot) {
    const resolved = Path.resolve(args.removeRoot);
    if (db.removeRoot(resolved)) {
      modified = true;
      console.log(`Removed root: ${resolved}`);
    } else {
      console.log(`Root not found: ${resolved}`);
    }
  }

  if (args.addRulePattern && args.addRuleDest) {
    db.addRoutingRule(args.addRulePattern, args.addRuleDest);
    modified = true;
    console.log(`Added rule: ${args.addRulePattern} -> ${args.addRuleDest}`);
  }

  if (args.addIgnore) {
    db.addIgnorePattern(args.addIgnore);
    modified = true;
    console.log(`Added ignore pattern: ${args.addIgnore}`);
  }

  if (args.addInclude) {
    db.addIncludePattern(args.addInclude);
    modified = true;
    console.log(`Added include pattern: ${args.addInclude}`);
  }

  if (args.removeInclude) {
    if (db.removeIncludePattern(args.removeInclude)) {
      modified = true;
      console.log(`Removed include pattern: ${args.removeInclude}`);
    } else {
      console.log(`Include pattern not found: ${args.removeInclude}`);
    }
  }

  if (args.setDest) {
    db.setSyncDestination(args.setDest);
    modified = true;
    console.log(`Set sync destination: ${db.getSyncDestination()}`);
  }

  // Show current config
  const roots = db.getRoots();
  const syncDest = db.getSyncDestination();
  const customRules = db.getRoutingRules();
  const defaultRules = db.getDefaultRoutingRules();
  const customIgnore = db.getIgnorePatterns();
  const defaultIgnore = db.getDefaultIgnorePatterns();
  const includePatterns = db.getIncludePatterns();

  console.log(`\n=== Configuration ===`);
  console.log(`\nRoots (${roots.length}):`);
  if (roots.length === 0)
    console.log('  (none)');
  else
    for (let r of roots) console.log(`  - ${r}`);

  console.log(`\nSync destination: ${syncDest || '(not set)'}`);

  console.log(`\nCustom routing rules (${customRules.length}):`);
  if (customRules.length === 0)
    console.log('  (none)');
  else
    for (let r of customRules) console.log(`  ${r.pattern} -> ${r.dest}`);

  console.log(`\nDefault routing rules (${defaultRules.length}):`);
  for (let r of defaultRules)
    console.log(`  ${r.pattern} -> ${r.dest}`);

  console.log(`\nCustom ignore patterns (${customIgnore.length}):`);
  if (customIgnore.length === 0)
    console.log('  (none)');
  else
    for (let p of customIgnore) console.log(`  ${p}`);

  console.log(`\nDefault ignore patterns (${defaultIgnore.length}):`);
  console.log(`  ${defaultIgnore.slice(0, 8).join(', ')}${(defaultIgnore.length > 8) ? ', ...' : ''}`);

  console.log(`\nInclude patterns (override ignores) (${includePatterns.length}):`);
  if (includePatterns.length === 0)
    console.log('  (none)');
  else
    for (let p of includePatterns) console.log(`  ${p}`);
}

module.exports = commandConfig;
