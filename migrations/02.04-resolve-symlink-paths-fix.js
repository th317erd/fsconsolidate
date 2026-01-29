'use strict';

const FileSystem = require('node:fs');
const { getShuttingDown } = require('../lib/hasher');

module.exports = {
  version:     2.04,
  description: 'Resolve symlink paths to real paths (fix: 02.03 failed due to busy connection)',
  migrate(db) {
    // Phase 1: Update roots
    const roots = db.prepare('SELECT path FROM roots').all();
    const updateRoot = db.prepare('UPDATE roots SET path = ? WHERE path = ?');
    const deleteRoot = db.prepare('DELETE FROM roots WHERE path = ?');
    const rootExists = db.prepare('SELECT path FROM roots WHERE path = ?');
    let rootsUpdated = 0;
    let rootsDeduped = 0;

    for (let root of roots) {
      try {
        const realPath = FileSystem.realpathSync(root.path);
        if (realPath !== root.path) {
          if (rootExists.get(realPath)) {
            deleteRoot.run(root.path);
            rootsDeduped++;
            console.log(`    Root deduped: ${root.path} (already exists as ${realPath})`);
          } else {
            updateRoot.run(realPath, root.path);
            rootsUpdated++;
            console.log(`    Root: ${root.path} -> ${realPath}`);
          }
        }
      } catch (err) {
        console.warn(`    Warning: Cannot resolve root ${root.path}: ${err.message}`);
      }
    }

    if (rootsUpdated > 0 || rootsDeduped > 0)
      console.log(`    Roots: ${rootsUpdated} updated, ${rootsDeduped} deduped`);

    // Phase 2: Update files
    // NOTE: Must use .all() instead of .iterate() — better-sqlite3 does not
    // allow executing other statements while an iterator is active.
    const allFiles = db.prepare('SELECT path, mtime_ms, mtime FROM files').all();
    const totalFiles = allFiles.length;
    const fileExists = db.prepare('SELECT path FROM files WHERE path = ?');
    const updateFile = db.prepare('UPDATE files SET path = ?, mtime_ms = ?, mtime = ? WHERE path = ?');
    const deleteFile = db.prepare('DELETE FROM files WHERE path = ?');
    let filesUpdated = 0;
    let filesDeduped = 0;
    let filesProcessed = 0;
    let errors = 0;

    for (let file of allFiles) {
      if (getShuttingDown())
        break;

      filesProcessed++;

      if (filesProcessed % 10000 === 0)
        console.log(`    Processing: ${filesProcessed}/${totalFiles} (${filesUpdated} updated, ${filesDeduped} deduped)`);

      try {
        const realPath = FileSystem.realpathSync(file.path);
        if (realPath !== file.path) {
          if (fileExists.get(realPath)) {
            // Real path already exists in DB - delete the symlink entry
            deleteFile.run(file.path);
            filesDeduped++;
          } else {
            // Re-stat to get mtime from the real path
            const stat = FileSystem.statSync(realPath);
            updateFile.run(realPath, stat.mtimeMs, stat.mtime.toISOString(), file.path);
            filesUpdated++;
          }
        }
      } catch (err) {
        // File may no longer exist - skip silently
        errors++;
      }
    }

    console.log(`    Files: ${filesUpdated} updated, ${filesDeduped} deduped, ${errors} unresolvable, ${totalFiles} total`);
  },
};
