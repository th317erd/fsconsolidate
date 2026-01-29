'use strict';

const Path = require('node:path');
const FileSystem = require('node:fs');
const Readline = require('node:readline');
const { formatBytes, printError } = require('../lib/utils');
const { getShuttingDown } = require('../lib/hasher');

// ============================================================================
// Directory Name Normalization
// ============================================================================

/**
 * Canonical directory names and their aliases (patterns)
 * All canonicals are plural for consistency
 */
const DIRECTORY_ALIASES = [
  {
    canonical: 'Documents',
    patterns:  [/^docs?$/i, /^documents?$/i, /^my\s*doc(ument)?s?$/i, /^papers?$/i, /^files?$/i],
  },
  {
    canonical: 'Pictures',
    patterns:  [/^pictures?$/i, /^images?$/i, /^photos?$/i, /^pics?$/i, /^my\s*pictures?$/i, /^my\s*photos?$/i],
  },
  {
    canonical: 'Videos',
    patterns:  [/^videos?$/i, /^vids?$/i, /^movies?$/i, /^films?$/i, /^my\s*videos?$/i],
  },
  {
    canonical: 'Music',
    patterns:  [/^music$/i, /^songs?$/i, /^audio$/i, /^my\s*music$/i, /^tracks?$/i],
  },
  {
    canonical: 'Downloads',
    patterns:  [/^downloads?$/i, /^downloaded?$/i],
  },
  {
    canonical: 'Archives',
    patterns:  [/^archives?$/i, /^backups?$/i, /^old$/i, /^archived?$/i],
  },
  {
    canonical: 'Code',
    patterns:  [/^code$/i, /^source$/i, /^src$/i, /^projects?$/i, /^dev$/i, /^development$/i, /^programming$/i],
  },
  {
    canonical: 'Games',
    patterns:  [/^games?$/i, /^gaming$/i],
  },
  {
    canonical: 'Books',
    patterns:  [/^books?$/i, /^ebooks?$/i, /^reading$/i, /^library$/i],
  },
  {
    canonical: 'Desktop',
    patterns:  [/^desktop$/i],
  },
];

/**
 * Normalize a directory name to its canonical form if it matches an alias
 * Returns null if no match found
 */
function normalizeDirectoryName(dirName) {
  for (let alias of DIRECTORY_ALIASES) {
    for (let pattern of alias.patterns) {
      if (pattern.test(dirName))
        return alias.canonical;
    }
  }
  return null;
}

/**
 * Try to infer a target from the source path's directory structure
 * Looks for common directory names in the path and normalizes them
 */
function inferTargetFromPath(sourcePath) {
  const parts = sourcePath.split(Path.sep);

  // Walk from deepest to shallowest, looking for recognizable directory names
  for (let i = parts.length - 2; i >= 0; i--) {
    const normalized = normalizeDirectoryName(parts[i]);
    if (normalized)
      return normalized;
  }

  return null;
}

// ============================================================================
// Tab Completion
// ============================================================================

/**
 * Get all existing directories in the destination (for tab completion)
 */
function getDestinationDirs(destPath) {
  const dirs = new Set(['']);  // Root is always an option

  function walkDir(currentPath, relativePath) {
    if (getShuttingDown()) return;
    try {
      const entries = FileSystem.readdirSync(currentPath, { withFileTypes: true });
      for (let entry of entries) {
        if (getShuttingDown()) return;
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const relPath = relativePath ? Path.join(relativePath, entry.name) : entry.name;
          dirs.add(relPath);
          walkDir(Path.join(currentPath, entry.name), relPath);
        }
      }
    } catch (err) {
      // Ignore permission errors etc.
    }
  }

  if (FileSystem.existsSync(destPath))
    walkDir(destPath, '');

  return [...dirs].sort();
}

/**
 * Create a completer function for readline
 */
function createCompleter(destDirs) {
  return function completer(line) {
    const hits = destDirs.filter((d) => d.toLowerCase().startsWith(line.toLowerCase()));
    // Show all options if nothing matches, otherwise show matches
    return [hits.length ? hits : destDirs, line];
  };
}

// ============================================================================
// Interactive Prompt Helpers
// ============================================================================

async function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function promptYesNo(rl, question) {
  const answer = await prompt(rl, question + ' (y/n): ');
  return answer.trim().toLowerCase().startsWith('y');
}

/**
 * Format a list of files for display, collapsing into ellipsis if too many
 */
function formatFileList(files, maxShow = 3) {
  const names = files.map((f) => Path.basename(f.path));
  if (names.length <= maxShow)
    return names.join(', ');

  return names.slice(0, maxShow).join(', ') + `, ... (+${names.length - maxShow} more)`;
}

/**
 * Format bytes for display
 */
function formatTotalSize(files) {
  const total = files.reduce((sum, f) => sum + (f.size || 0), 0);
  return formatBytes(total);
}

// ============================================================================
// Hash Map Building
// ============================================================================

/**
 * Build a map of hash -> relative target path from files in the destination
 */
function buildHashToTargetMap(db, destPath) {
  const hashMap = new Map();
  const normalizedDest = destPath.endsWith('/') ? destPath : destPath + '/';

  for (let file of db.iterateFilesInDestination(destPath)) {
    if (!file.hash)
      continue;

    const relativePath = file.path.slice(normalizedDest.length);
    const parentDir = Path.dirname(relativePath);

    if (!hashMap.has(file.hash))
      hashMap.set(file.hash, (parentDir === '.') ? '' : parentDir);
  }

  return hashMap;
}

// ============================================================================
// Directory Grouping and Analysis
// ============================================================================

/**
 * Group files by their source directory
 */
function groupFilesByDirectory(files) {
  const groups = new Map();

  for (let file of files) {
    const dir = Path.dirname(file.path);
    if (!groups.has(dir))
      groups.set(dir, []);
    groups.get(dir).push(file);
  }

  return groups;
}

/**
 * Sort directories by depth (shallowest first) for parent-first processing
 */
function sortDirectoriesByDepth(dirs) {
  return [...dirs].sort((a, b) => {
    const depthA = a.split(Path.sep).length;
    const depthB = b.split(Path.sep).length;
    if (depthA !== depthB)
      return depthA - depthB;
    return a.localeCompare(b);
  });
}

/**
 * Check if a directory is a subdirectory of any assigned directory
 * @param {string} dir - The directory to check
 * @param {Iterable<string>} assignedDirs - Iterator of assigned directory paths
 */
function isSubdirectoryOfAssigned(dir, assignedDirs) {
  for (let assigned of assignedDirs) {
    if (dir.startsWith(assigned + Path.sep))
      return assigned;
  }
  return null;
}

/**
 * Analyze a directory and find potential target from hash matches
 */
function analyzeDirectoryHashes(files, hashMap) {
  const targetVotes = new Map();
  const unmatchedFiles = [];

  for (let file of files) {
    const target = hashMap.get(file.hash);
    if (target !== undefined) {
      if (!targetVotes.has(target))
        targetVotes.set(target, []);
      targetVotes.get(target).push(file);
    } else {
      unmatchedFiles.push(file);
    }
  }

  return { targetVotes, unmatchedFiles };
}

// ============================================================================
// Main Command
// ============================================================================

async function commandAnalyzeGuessTargets(db, args) {
  const destPath = args.dest || db.getSyncDestination();
  if (!destPath) {
    printError('Error: No destination set. Use --dest or config --set-dest');
    process.exit(1);
  }

  const resolvedDest = Path.resolve(destPath);
  const dryRun = args.dryRun;

  console.log(`\nAnalyze guess-targets${(dryRun) ? ' (DRY RUN)' : ''}`);
  console.log(`Destination: ${resolvedDest}`);

  // Build hash -> target map from destination files
  console.log('\nPhase 1: Building hash map from destination files...');
  const hashMap = buildHashToTargetMap(db, resolvedDest);
  console.log(`  Found ${hashMap.size} unique hashes in destination`);

  // Collect all unassigned files outside destination
  console.log('\nPhase 2: Collecting unassigned files...');
  const unassignedFiles = [];
  for (let file of db.iterateUnassignedFilesOutsideDestination(resolvedDest))
    unassignedFiles.push(file);

  console.log(`  Found ${unassignedFiles.length} files without target assignments`);

  if (unassignedFiles.length === 0) {
    console.log('\nNo unassigned files to process.');
    return;
  }

  // Group by directory and sort by depth (parent-first)
  const dirGroups = groupFilesByDirectory(unassignedFiles);
  const sortedDirs = sortDirectoriesByDepth([...dirGroups.keys()]);
  console.log(`  Spanning ${dirGroups.size} directories`);

  // Get destination directories for tab completion
  console.log('\nPhase 3: Scanning destination for tab completion...');
  const destDirs = getDestinationDirs(resolvedDest);
  console.log(`  Found ${destDirs.length} directories in destination`);

  // Setup readline with tab completion
  const rl = Readline.createInterface({
    input:     process.stdin,
    output:    process.stdout,
    completer: createCompleter(destDirs),
  });

  let totalAssigned = 0;
  let totalSkipped = 0;
  let totalAutoResolved = 0;
  const assignedDirTargets = new Map(); // dir -> assigned target

  console.log('\n--- Processing directories (parent-first) ---\n');
  console.log('Commands: Type a destination path (Tab for completion), or:');
  console.log('  [s]kip     - Skip this directory');
  console.log('  [q]uit     - Stop processing\n');

  for (let dir of sortedDirs) {
    if (getShuttingDown())
      break;

    const files = dirGroups.get(dir);

    // Check if this is a subdirectory of an already-assigned parent
    const assignedParent = isSubdirectoryOfAssigned(dir, assignedDirTargets.keys());
    if (assignedParent) {
      // Subdirectory of assigned parent - inherit relative path structure
      const relativeTail = dir.slice(assignedParent.length);
      const parentTarget = assignedDirTargets.get(assignedParent);

      const subTarget = parentTarget + relativeTail;
      if (!dryRun)
        db.setTargetSyncLocationBatch(files.map((f) => f.path), subTarget);
      totalAssigned += files.length;
      assignedDirTargets.set(dir, subTarget);
      continue;  // Silent - parent already reported
    }

    // Try hash-based matching first
    const { targetVotes, unmatchedFiles } = analyzeDirectoryHashes(files, hashMap);

    // Single hash match - auto-assign
    if (targetVotes.size === 1) {
      const [[target, matchedFiles]] = [...targetVotes.entries()];
      const allFiles = files;

      if (!dryRun)
        db.setTargetSyncLocationBatch(allFiles.map((f) => f.path), target);

      console.log(`[Auto-hash] ${dir}`);
      console.log(`  -> "${target || '(root)'}" (${matchedFiles.length} matched, ${unmatchedFiles.length} siblings)`);
      totalAutoResolved += allFiles.length;
      totalAssigned += allFiles.length;
      assignedDirTargets.set(dir, target);
      continue;
    }

    // Multiple hash matches - show conflict
    if (targetVotes.size > 1) {
      console.log(`\n[Conflict] ${dir}`);
      console.log(`  Files: ${formatFileList(files)} (${formatTotalSize(files)})`);

      const options = [...targetVotes.entries()].sort((a, b) => b[1].length - a[1].length);
      options.forEach(([target, matchedFiles], idx) => {
        console.log(`  [${idx + 1}] ${matchedFiles.length} files -> "${target || '(root)'}"`);
      });

      const answer = await prompt(rl, `Choose [1-${options.length}], path, skip, or quit: `);
      const trimmed = answer.trim().toLowerCase();

      if (trimmed === 'q' || trimmed === 'quit')
        break;

      if (trimmed === 's' || trimmed === 'skip') {
        totalSkipped += files.length;
        continue;
      }

      const choiceNum = parseInt(trimmed, 10);
      let chosenTarget;

      if (!isNaN(choiceNum) && choiceNum >= 1 && choiceNum <= options.length) {
        chosenTarget = options[choiceNum - 1][0];
      } else if (trimmed) {
        chosenTarget = await handleCustomPath(rl, trimmed, resolvedDest, destDirs, dryRun);
        if (chosenTarget === null) {
          totalSkipped += files.length;
          continue;
        }
      } else {
        totalSkipped += files.length;
        continue;
      }

      if (!dryRun)
        db.setTargetSyncLocationBatch(files.map((f) => f.path), chosenTarget);

      console.log(`  Assigned -> "${chosenTarget || '(root)'}"`);
      totalAssigned += files.length;
      assignedDirTargets.set(dir, chosenTarget);
      continue;
    }

    // No hash matches - try directory name normalization
    const inferredTarget = inferTargetFromPath(dir);
    if (inferredTarget) {
      if (!dryRun)
        db.setTargetSyncLocationBatch(files.map((f) => f.path), inferredTarget);

      console.log(`[Auto-name] ${dir}`);
      console.log(`  -> "${inferredTarget}" (inferred from directory name)`);
      totalAutoResolved += files.length;
      totalAssigned += files.length;
      assignedDirTargets.set(dir, inferredTarget);
      continue;
    }

    // No automatic resolution - prompt user
    console.log(`\n[Manual] ${dir}`);
    console.log(`  Files: ${formatFileList(files)} (${formatTotalSize(files)})`);

    const answer = await prompt(rl, `  Target (Tab to complete): `);
    const trimmed = answer.trim().toLowerCase();

    if (trimmed === 'q' || trimmed === 'quit')
      break;

    if (trimmed === 's' || trimmed === 'skip' || trimmed === '') {
      totalSkipped += files.length;
      continue;
    }

    const chosenTarget = await handleCustomPath(rl, answer.trim(), resolvedDest, destDirs, dryRun);
    if (chosenTarget === null) {
      totalSkipped += files.length;
      continue;
    }

    if (!dryRun)
      db.setTargetSyncLocationBatch(files.map((f) => f.path), chosenTarget);

    console.log(`  Assigned -> "${chosenTarget || '(root)'}"`);
    totalAssigned += files.length;
    assignedDirTargets.set(dir, chosenTarget);
  }

  rl.close();

  // Summary
  console.log('\n--- Summary ---');
  if (dryRun) {
    console.log(`Would auto-resolve: ${totalAutoResolved} files`);
    console.log(`Would assign (total): ${totalAssigned} files`);
    console.log(`Would skip: ${totalSkipped} files`);
  } else {
    console.log(`Auto-resolved: ${totalAutoResolved} files`);
    console.log(`Total assigned: ${totalAssigned} files`);
    console.log(`Skipped: ${totalSkipped} files`);

    const stats = db.getTargetAssignmentStats();
    console.log(`\nCurrent assignment status:`);
    console.log(`  Assigned: ${stats.assigned}`);
    console.log(`  Unassigned: ${stats.unassigned}`);
  }
}

/**
 * Handle a custom path entered by the user
 * Returns the target path, or null if cancelled
 */
async function handleCustomPath(rl, inputPath, destBase, destDirs, dryRun) {
  // Normalize the path (remove leading/trailing slashes for consistency)
  const normalizedPath = inputPath.replace(/^\/+|\/+$/g, '');

  // Check if directory exists
  const fullPath = Path.join(destBase, normalizedPath);
  if (FileSystem.existsSync(fullPath))
    return normalizedPath;

  // Directory doesn't exist - ask to create
  console.log(`  Directory doesn't exist: ${normalizedPath}`);
  const create = await promptYesNo(rl, `  Create "${normalizedPath}" in destination?`);

  if (!create)
    return null;

  if (!dryRun) {
    try {
      FileSystem.mkdirSync(fullPath, { recursive: true });
      console.log(`  Created: ${fullPath}`);
    } catch (err) {
      printError(`  Error creating directory: ${err.message}`);
      return null;
    }
  } else {
    console.log(`  [DRY RUN] Would create: ${fullPath}`);
  }

  return normalizedPath;
}

// ============================================================================
// Command Entry Point
// ============================================================================

async function commandAnalyze(db, args) {
  const subcommand = args.analyzeType;

  if (!subcommand) {
    console.log(`
analyze - Analyze files and infer sync targets

Subcommands:
  guess-targets    Infer target locations from hash matches and directory names

Options:
  --dry-run        Show what would be assigned without writing to DB

Features:
  - Hash matching: Files with matching hashes in destination get same target
  - Name inference: Common directory names (Docs, Pictures, etc.) normalized
  - Interactive: Prompts for unresolved directories with Tab completion
  - Parent-first: Assigns parents before children to preserve structure

Example:
  node index.js analyze guess-targets --db ~/mydb.db --dry-run
  node index.js analyze guess-targets --db ~/mydb.db
`);
    return;
  }

  switch (subcommand) {
    case 'guess-targets':
      await commandAnalyzeGuessTargets(db, args);
      break;
    default:
      printError(`Unknown analyze subcommand: ${subcommand}`);
      console.log('Available: guess-targets');
      process.exit(1);
  }
}

module.exports = commandAnalyze;
