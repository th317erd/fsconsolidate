'use strict';

const FileSystem = require('node:fs');
const Crypto = require('node:crypto');
const Path = require('node:path');
const { formatBytes, printError } = require('./utils');
const {
  MAX_CONCURRENT,
  PROGRESS_DISPLAY_THRESHOLD,
  STALL_CHECK_INTERVAL_MS,
  SAVE_INTERVAL,
} = require('./constants');

// Global shutdown flag - set by main process
let isShuttingDown = false;

function setShuttingDown(value) {
  isShuttingDown = value;
}

function getShuttingDown() {
  return isShuttingDown;
}

// ============================================================================
// Multi-line Progress Display
// ============================================================================

/**
 * Manages multiple concurrent progress bars on separate lines
 * Uses ANSI escape codes for cursor positioning
 */
class MultiProgressDisplay {
  constructor() {
    this.slots = new Map();       // filePath -> slot index
    this.slotData = new Map();    // slot index -> { fileName, bytesRead, totalBytes, startTime, status }
    this.nextSlot = 0;
    this.activeSlots = 0;
    this.isTTY = process.stdout.isTTY;
  }

  /**
   * Allocate a slot for a new file
   */
  addFile(filePath, fileName, totalBytes) {
    const slot = this.nextSlot++;
    this.slots.set(filePath, slot);
    this.slotData.set(slot, {
      fileName,
      bytesRead:  0,
      totalBytes,
      startTime:  Date.now(),
      status:     'starting',
    });
    this.activeSlots++;

    // Print initial line for this slot
    if (this.isTTY) {
      const display = this._formatLine(slot);
      process.stdout.write(display + '\n');
    } else {
      console.log(`[Large] ${fileName} (${formatBytes(totalBytes)}) - starting...`);
    }
  }

  /**
   * Update progress for a file
   */
  updateProgress(filePath, bytesRead) {
    const slot = this.slots.get(filePath);
    if (slot === undefined)
      return;

    const data = this.slotData.get(slot);
    if (!data)
      return;

    data.bytesRead = bytesRead;
    data.status = 'hashing';

    if (this.isTTY)
      this._redrawSlot(slot);
  }

  /**
   * Mark a file as complete
   */
  completeFile(filePath) {
    const slot = this.slots.get(filePath);
    if (slot === undefined)
      return;

    const data = this.slotData.get(slot);
    if (!data)
      return;

    data.status = 'done';
    data.bytesRead = data.totalBytes;
    const elapsed = ((Date.now() - data.startTime) / 1000).toFixed(1);

    if (this.isTTY) {
      this._redrawSlot(slot);
    } else {
      console.log(`[Large] ${data.fileName}: done in ${elapsed}s`);
    }

    this.activeSlots--;
    this.slots.delete(filePath);
  }

  /**
   * Mark a file as errored
   */
  errorFile(filePath, errorMsg) {
    const slot = this.slots.get(filePath);
    if (slot === undefined)
      return;

    const data = this.slotData.get(slot);
    if (!data)
      return;

    data.status = 'error';

    if (this.isTTY)
      this._redrawSlot(slot);

    this.activeSlots--;
    this.slots.delete(filePath);
  }

  /**
   * Format a progress line for a slot
   */
  _formatLine(slot) {
    const data = this.slotData.get(slot);
    if (!data)
      return '';

    const { fileName, bytesRead, totalBytes, startTime, status } = data;
    const elapsed = (Date.now() - startTime) / 1000;

    // Truncate filename if too long
    const maxNameLen = 30;
    const displayName = (fileName.length > maxNameLen)
      ? fileName.slice(0, maxNameLen - 3) + '...'
      : fileName.padEnd(maxNameLen);

    if (status === 'starting') {
      return `  [${displayName}] starting...`;
    }

    if (status === 'done') {
      return `  [${displayName}] done in ${elapsed.toFixed(1)}s                              `;
    }

    if (status === 'error') {
      return `  [${displayName}] error                                    `;
    }

    // Hashing in progress
    const pct = ((bytesRead / totalBytes) * 100).toFixed(1);
    const rate = (elapsed > 0) ? bytesRead / elapsed : 0;
    const eta = (rate > 0) ? ((totalBytes - bytesRead) / rate).toFixed(0) : '?';

    // Progress bar
    const barWidth = 20;
    const filled = Math.round((bytesRead / totalBytes) * barWidth);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);

    return `  [${displayName}] ${bar} ${pct.padStart(5)}% ${formatBytes(rate).padStart(10)}/s ETA ${eta}s`;
  }

  /**
   * Redraw a specific slot by moving cursor to its line
   */
  _redrawSlot(slot) {
    // Calculate how many lines up from current position
    const linesUp = this.nextSlot - slot;

    // Move up, clear line, write, move back down
    process.stdout.write(
      `\x1b[${linesUp}A` +  // Move up
      '\x1b[2K' +           // Clear line
      '\r' +                // Carriage return
      this._formatLine(slot) +
      `\x1b[${linesUp}B` +  // Move back down
      '\r'                  // Return to start of line
    );
  }

  /**
   * Move cursor past all progress lines (call when batch is done)
   */
  finalize() {
    // Nothing special needed - cursor is already past the lines
  }
}

/**
 * Check if a file is safe to read (not a special file that might block)
 */
function isFileSafeToRead(filePath, stat) {
  if (stat.isFIFO())
    return { safe: false, reason: 'FIFO/named pipe - would block' };

  if (stat.isSocket())
    return { safe: false, reason: 'Socket - would block' };

  if (stat.isCharacterDevice())
    return { safe: false, reason: 'Character device - might block' };

  if (stat.isBlockDevice())
    return { safe: false, reason: 'Block device - skipping' };

  if (!stat.isFile())
    return { safe: false, reason: 'Not a regular file' };

  return { safe: true };
}

/**
 * Compute SHA1 hash of a file with stall detection and shutdown support
 */
function computeHash(filePath, fileSize = 0, onProgress = null) {
  return new Promise((resolve, reject) => {
    const hash = Crypto.createHash('sha1');
    const stream = FileSystem.createReadStream(filePath);

    let bytesRead = 0;
    let lastBytesRead = 0;
    let checkInterval = null;
    let resolved = false;

    const cleanup = () => {
      if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
      }
    };

    const finish = (err, result) => {
      if (resolved)
        return;

      resolved = true;
      cleanup();

      if (err)
        reject(err);
      else
        resolve(result);
    };

    // Periodic check for shutdown and I/O stalls (every 500ms for responsive Ctrl+C)
    let stallCheckCounter = 0;
    const STALL_CHECK_THRESHOLD = STALL_CHECK_INTERVAL_MS / 500;

    checkInterval = setInterval(() => {
      // Check for shutdown request
      if (isShuttingDown) {
        stream.destroy();
        finish(new Error('Shutdown requested'));
        return;
      }

      // Stall detection
      stallCheckCounter++;
      if (stallCheckCounter >= STALL_CHECK_THRESHOLD) {
        if (bytesRead === lastBytesRead && bytesRead < fileSize) {
          stream.destroy();
          const readPct = (fileSize > 0) ? ((bytesRead / fileSize) * 100).toFixed(1) : '?';
          finish(new Error(`I/O stall detected - no progress for ${STALL_CHECK_INTERVAL_MS / 1000}s (read ${formatBytes(bytesRead)} / ${formatBytes(fileSize)}, ${readPct}%)`));
          return;
        }
        lastBytesRead = bytesRead;
        stallCheckCounter = 0;
      }
    }, 500);

    stream.on('error', (err) => {
      finish(err);
    });

    stream.on('data', (chunk) => {
      bytesRead += chunk.length;
      hash.update(chunk);
      if (onProgress)
        onProgress(bytesRead, fileSize);
    });

    stream.on('end', () => {
      finish(null, hash.digest('hex'));
    });
  });
}

/**
 * Hash files with concurrency control and progress display
 * Saves to database periodically via callback
 */
async function hashFilesWithProgress(files, db, options = {}) {
  const {
    maxConcurrent = MAX_CONCURRENT,
    onProgress = null,
    onSave = null,
  } = options;

  const results = [];
  let completed = 0;
  let skipped = 0;
  let hashed = 0;
  let skippedUnsafe = 0;
  const total = files.length;

  // Multi-line progress display for large files
  const progressDisplay = new MultiProgressDisplay();

  for (let i = 0; i < files.length; i += maxConcurrent) {
    if (isShuttingDown) {
      console.log('\nShutdown requested, stopping hash operation...');
      break;
    }

    const batch = files.slice(i, i + maxConcurrent);

    // Print overall progress before processing batch
    if (process.stdout.isTTY) {
      const label = (hashed > 0) ? 'Hashing' : 'Checking';
      const currentFile = batch[0]?.fullPath || '';
      process.stdout.write(`\r${label}: ${completed}/${total} (${skipped} cached, ${hashed} new) ${currentFile}    \n`);
    }

    const batchResults = await Promise.all(
      batch.map(async (fileInfo) => {
        const { fullPath, stat } = fileInfo;
        const fileName = Path.basename(fullPath);
        const isLargeFile = stat.size >= PROGRESS_DISPLAY_THRESHOLD;

        try {
          // Check if file is safe to read
          const safeCheck = isFileSafeToRead(fullPath, stat);
          if (!safeCheck.safe) {
            console.warn(`Skipping unsafe file: ${fullPath} (${safeCheck.reason})`);
            skippedUnsafe++;
            completed++;
            return { fullPath, error: safeCheck.reason, skippedUnsafe: true };
          }

          if (!db.needsRehash(fullPath, stat)) {
            skipped++;
            completed++;
            const cached = db.getFile(fullPath);
            return { ...cached, fullPath, skipped: true };
          }

          // Large file progress display
          if (isLargeFile)
            progressDisplay.addFile(fullPath, fileName, stat.size);

          const onHashProgress = (isLargeFile) ? (bytesRead, totalBytes) => {
            progressDisplay.updateProgress(fullPath, bytesRead);
          } : null;

          const hash = await computeHash(fullPath, stat.size, onHashProgress);
          hashed++;
          completed++;

          if (isLargeFile)
            progressDisplay.completeFile(fullPath);

          return {
            fullPath,
            path:    fullPath,
            hash,
            size:    stat.size,
            mtimeMs: stat.mtimeMs,
            mtime:   stat.mtime.toISOString(),
          };
        } catch (err) {
          // Check if this was a large file being tracked
          if (progressDisplay.slots.has(fullPath))
            progressDisplay.errorFile(fullPath, err.message);

          if (!isShuttingDown)
            printError(`Error hashing ${fullPath}: ${err.message}`);

          return { fullPath, path: fullPath, error: err.message };
        }
      })
    );

    for (let result of batchResults)
      results.push(result);

    // Periodic save
    if (onSave && hashed > 0 && hashed % SAVE_INTERVAL === 0) {
      const toSave = results.filter((r) => !r.error && r.hash);
      if (toSave.length > 0) {
        onSave(toSave);
        results.length = 0; // Clear after saving
      }
    }
  }

  progressDisplay.finalize();

  // Final progress line
  if (total > 0) {
    const label = (hashed > 0) ? 'Hashing' : 'Checking';
    console.log(`${label} complete: ${completed}/${total} (${skipped} cached, ${hashed} new)`);
  }

  if (skippedUnsafe > 0)
    console.log(`Skipped ${skippedUnsafe} unsafe files (FIFOs, sockets, devices, etc.)`);

  return results;
}

module.exports = {
  computeHash,
  hashFilesWithProgress,
  isFileSafeToRead,
  setShuttingDown,
  getShuttingDown,
};
