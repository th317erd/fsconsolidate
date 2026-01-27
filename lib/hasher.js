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

  // Track large files for progress display
  const largeFilesInProgress = new Map();

  for (let i = 0; i < files.length; i += maxConcurrent) {
    if (isShuttingDown) {
      console.log('\nShutdown requested, stopping hash operation...');
      break;
    }

    const batch = files.slice(i, i + maxConcurrent);

    const batchResults = await Promise.all(
      batch.map(async (fileInfo) => {
        const { fullPath, stat } = fileInfo;
        const fileName = Path.basename(fullPath);
        const isLargeFile = stat.size >= PROGRESS_DISPLAY_THRESHOLD;

        try {
          // Check if file is safe to read
          const safeCheck = isFileSafeToRead(fullPath, stat);
          if (!safeCheck.safe) {
            console.warn(`\nSkipping unsafe file: ${fullPath} (${safeCheck.reason})`);
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
          if (isLargeFile) {
            console.log(`\n  [Large file] ${fileName} (${formatBytes(stat.size)}) - starting...`);
            largeFilesInProgress.set(fullPath, {
              bytesRead:  0,
              totalBytes: stat.size,
              startTime:  Date.now(),
              fileName,
            });
          }

          const onHashProgress = (isLargeFile) ? (bytesRead, totalBytes) => {
            const info = largeFilesInProgress.get(fullPath);
            if (info) {
              info.bytesRead = bytesRead;
              const pct = ((bytesRead / totalBytes) * 100).toFixed(1);
              const elapsed = (Date.now() - info.startTime) / 1000;
              const rate = bytesRead / elapsed;
              const eta = (rate > 0) ? ((totalBytes - bytesRead) / rate).toFixed(0) : '?';
              process.stdout.write(`\r  [Large file] ${fileName}: ${pct}% (${formatBytes(bytesRead)}/${formatBytes(totalBytes)}) - ${formatBytes(rate)}/s, ETA: ${eta}s    `);
            }
          } : null;

          const hash = await computeHash(fullPath, stat.size, onHashProgress);
          hashed++;
          completed++;

          if (isLargeFile) {
            const info = largeFilesInProgress.get(fullPath);
            const elapsed = (info) ? ((Date.now() - info.startTime) / 1000).toFixed(1) : '?';
            console.log(`\r  [Large file] ${fileName}: done in ${elapsed}s                                        `);
            largeFilesInProgress.delete(fullPath);
          }

          // Progress for non-large files
          if (!isLargeFile && (completed % 50 === 0 || completed === total))
            process.stdout.write(`\rHashing: ${completed}/${total} (${skipped} cached, ${hashed} new)    `);

          return {
            fullPath,
            path:    fullPath,
            hash,
            size:    stat.size,
            mtimeMs: stat.mtimeMs,
            mtime:   stat.mtime.toISOString(),
          };
        } catch (err) {
          if (largeFilesInProgress.has(fullPath))
            largeFilesInProgress.delete(fullPath);

          if (!isShuttingDown)
            printError(`\nError hashing ${fullPath}: ${err.message}`);

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

  if (total > 0)
    console.log(); // New line after progress

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
