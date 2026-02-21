# Claude Code Instructions

## !!!MANDATORY FIRST ACTION!!!

**STOP. Before responding to the user, ask yourself: "Do I have the contents of `~/.claude-config/startup.md` in my current context?"**

If NO → Use the Read tool to read `~/.claude-config/startup.md` RIGHT NOW, before doing anything else.
If YES → Proceed normally.

This applies after every `/compact`, session start, or context reset. The file contains critical workflow rules and preferences.

---

# file-helper

A Node.js CLI tool for scanning, deduplicating, and consolidating files from multiple backup locations into a single destination.

## Purpose

This tool was built to solve the problem of having files scattered across multiple backup locations (Google Drive sync, external backup drives, home folders, etc.) where many files are duplicates but organized differently. It:

1. Scans multiple root paths and computes SHA1 hashes for all files
2. Builds a persistent SQLite database tracking all files and their hashes
3. Identifies duplicates (same content, potentially different names/locations)
4. Syncs unique files to a consolidated destination
5. Never deletes or overwrites files

## Architecture

### File Structure

```
file-helper/
├── index.js              # Entry point - CLI parsing and dispatch
├── lib/
│   ├── db.js             # SQLite database layer
│   ├── scanner.js        # File system scanning
│   ├── hasher.js         # File hashing with progress
│   ├── patterns.js       # Glob/routing pattern matching
│   ├── sync.js           # Sync operations (copy)
│   ├── utils.js          # Utilities (formatBytes, printError)
│   └── constants.js      # Constants and defaults
├── commands/
│   ├── scan.js           # Scan root paths
│   ├── status.js         # Show database summary
│   ├── sync.js           # Copy files to destination
│   ├── config.js         # View/modify configuration
│   ├── interactive.js    # Handle unmatched files
│   ├── duplicates.js     # Show duplicate summary
│   ├── large-files.js    # Review large files
│   ├── inspect.js        # Browse database
│   ├── remove.js         # Remove files from database
│   └── migrate.js        # Migrate from JSON to SQLite
└── package.json
```

### SQLite Database Schema

The database (`.db` file) contains these tables:

- `meta` - Key-value metadata (created, updated, version)
- `config` - Configuration key-values (sync_destination)
- `roots` - Root paths to scan
- `ignore_patterns` - Patterns to ignore during scanning
- `include_patterns` - Override ignore patterns
- `routing_rules` - Pattern → destination mappings
- `files` - File records (path, hash, size, mtime)
- `synced` - Synced file records by hash
- `synced_sources` - All source paths for synced hashes
- `synced_filenames` - All filenames for synced hashes

### Key Design Decisions

1. **SQLite instead of JSON** - Handles millions of files with minimal memory usage. The old JSON format could cause OOM errors with large file sets.

2. **Memory-efficient iteration** - Uses SQLite's row-by-row iteration via generators instead of loading all data into memory.

3. **Modular file structure** - Commands and library code are separated for maintainability.

4. **Database location is independent** - The `--db` flag specifies where the database lives, separate from any root or destination.

5. **Roots are stored and reused** - Once you add roots via `scan -r <path>` or `config --add-root`, they're saved in the database.

6. **Deduplication by hash** - Files with identical SHA1 hashes are considered duplicates. Only one copy is synced.

7. **Multiple filenames handling** - When duplicates have different filenames across locations, the user is prompted to choose which filename to use.

8. **Never overwrite** - The copy operation uses `COPYFILE_EXCL` and refuses to overwrite existing files.

9. **Graceful shutdown** - SIGINT/SIGTERM handlers close the database cleanly.

10. **mtime+size caching** - Files are only re-hashed if their size or modification time changed.

11. **I/O stall detection** - Hashing monitors read progress and aborts after 30 seconds of no data.

## Commands

| Command | Description |
|---------|-------------|
| `scan` | Scan root paths and build/update hash database |
| `status` | Show database and sync status summary |
| `sync` | Copy unique files to destination based on routing rules |
| `large-files` | Review files >300MB before syncing |
| `interactive` | Handle unmatched files one-by-one |
| `config` | View/modify roots, rules, ignore patterns |
| `duplicates` | Show duplicate file summary |
| `inspect` | Browse database contents |
| `remove` | Remove files from database by pattern |
| `migrate` | Import data from old JSON database format |

## Workflow

```bash
# 1. Initial scan - create database and scan all locations
node index.js scan --db ~/mydb.db \
  -r ~/GoogleDrive \
  -r /mnt/backup1 \
  -r /mnt/consolidated

# 2. Set default sync destination
node index.js config --db ~/mydb.db --set-dest /mnt/consolidated

# 3. Check status
node index.js status --db ~/mydb.db

# 4. Review what will be synced (dry run)
node index.js sync --db ~/mydb.db --dry-run

# 5. Sync files
node index.js sync --db ~/mydb.db

# 6. Handle files that don't match routing rules
node index.js interactive --db ~/mydb.db

# 7. Inspect the database
node index.js inspect duplicates --db ~/mydb.db
node index.js inspect search "vacation" --db ~/mydb.db
```

## Migration from JSON

If you have an existing JSON database from the previous version:

```bash
node index.js migrate ~/old-database.json --db ~/new-database.db
```

This imports all data (files, synced records, config) into the new SQLite format.

## Default Ignore Patterns

These paths/patterns are skipped during scanning:

- `.*` (hidden files/folders)
- `node_modules`, `__pycache__`
- `Thumbs.db`, `$RECYCLE.BIN`, `System Volume Information`
- `vendor`, `venv`, `env`
- `*.tmp`, `*.temp`, `*.swp`, `*.swo`, `*~`

Add custom patterns: `config --add-ignore "<pattern>"`

## Default Routing Rules

Files are routed to subdirectories based on extension:

| Pattern | Destination |
|---------|-------------|
| `*.{jpg,jpeg,png,gif,webp,bmp,tiff,heic,heif}` | Pictures |
| `*.{mp4,mov,avi,mkv,wmv,flv,webm,m4v}` | Videos |
| `*.{mp3,wav,flac,aac,ogg,wma,m4a}` | Music |
| `*.{pdf,doc,docx,xls,xlsx,ppt,pptx,odt,ods,odp}` | Documents |
| `*.{zip,tar,gz,rar,7z,bz2}` | Archives |
| `*.{js,ts,py,java,c,cpp,h,cs,go,rs,rb,php}` | Code |

Add custom rules: `config --add-rule "*.psd" "Photoshop"`

## Large File Handling

Files over 300MB are skipped by default during sync. This provides a safety check for large files that might be:
- Accidentally included
- Better handled separately
- Requiring extra verification

Review large files: `large-files --db ~/mydb.db`
Include them in sync: `sync --include-large`

## Safety Guarantees

1. **No deletions** - Source files are never deleted
2. **No overwrites** - Existing files at destination are never overwritten
3. **Resumable** - Database tracks progress; interrupted syncs can resume
4. **Auditable** - Database preserves all original paths and filenames

## Inspect Subcommands

| Subcommand | Description |
|------------|-------------|
| `inspect files` | List all files with hashes and sizes |
| `inspect roots` | Show per-root file counts and internal duplicates |
| `inspect duplicates` | Cross-root vs same-root duplicate analysis |
| `inspect synced` | Show synced files with original names |
| `inspect hash <prefix>` | Find files by hash prefix |
| `inspect search <pattern>` | Search files by name pattern |
| `inspect final-target-size` | Calculate total size if all unique files were synced |

Options: `--limit N`, `--filter-root <path>`, `--ext <extension>`

## Technical Details

- **Hash algorithm**: SHA1 (40-character hex)
- **Concurrency**: 8 parallel hash operations
- **Large file threshold**: 300MB
- **Progress display threshold**: 100MB
- **Stall detection interval**: 30 seconds
- **Database**: SQLite with WAL mode for performance
- **Glob pattern support**: `*`, `**`, `?`, `{a,b,c}` brace expansion

## Large File Progress

Files over 100MB display real-time per-file progress during hashing:

```
[Large file] bigvideo.mp4: 45.2% (2.3GB/5.1GB) - 150.5MB/s, ETA: 18s
[Large file] bigvideo.mp4: done in 34.2s
```

## I/O Safety Features

### Stall Detection

The hashing process monitors read progress and aborts if no bytes are read for 30 seconds. This catches:
- Files on stalled/disconnected network mounts
- Files locked by other processes
- Other I/O issues that would cause indefinite hangs

### Unsafe File Detection

Before hashing, files are checked for potentially blocking file types. The following are automatically skipped:
- FIFOs (named pipes)
- Sockets
- Character devices
- Block devices

## Dependencies

- `better-sqlite3` - Fast, synchronous SQLite3 binding

Built-in Node.js modules:
- `node:fs`, `node:path`, `node:crypto`, `node:readline`

---

## Development Log

### Session: January 2025 - SQLite Migration & Refactor

**Problem:** The original JSON-based database caused JavaScript heap out of memory errors (4GB+) when scanning large file sets (~110k files, 2TB+).

**Solution:** Complete rewrite from JSON to SQLite with modular file structure.

#### Work Completed:

1. **Added SQLite dependency** - `better-sqlite3` added to package.json, version bumped to 2.0.0

2. **Created modular file structure:**
   - `lib/constants.js` - Configuration constants
   - `lib/utils.js` - Utility functions (formatBytes, printError, etc.)
   - `lib/patterns.js` - Glob matching and pattern functions
   - `lib/db.js` - SQLite database layer (FileDatabase class with WAL mode)
   - `lib/hasher.js` - File hashing with progress, stall detection, shutdown support
   - `lib/scanner.js` - Memory-efficient file system scanning with generators
   - `lib/sync.js` - File copy operations
   - `commands/*.js` - Individual command files (scan, status, sync, config, interactive, duplicates, large-files, inspect, remove, migrate)

3. **Created migrate command** - Converts old JSON database to SQLite format

4. **Added `inspect final-target-size` subcommand** - Calculates total unique file size using efficient SQL aggregation:
   ```sql
   SELECT COUNT(*) as count, SUM(size) as totalSize FROM (
     SELECT hash, MIN(size) as size FROM files
     WHERE hash IS NOT NULL
     GROUP BY hash
   )
   ```

#### Test Database Stats:

- **Database location:** `/media/Data/Remote/.fs-consolide-mains.sqlite`
- **Total files:** 109,959 (2.08 TB with duplicates)
- **Unique files:** 67,881 (1.83 TB deduplicated)
- **Duplicates:** 42,078 files (254 GB redundant)
- **Roots:** 3
  - `/media/Data/Remote/Seafile/th317erd@gmail.com`
  - `/media/Data/Remote/Seafile/wyatt-desktop`
  - `/media/wyatt/Elements/wyatt-desktop`

#### Migration Verification:

To verify a JSON → SQLite migration:
```bash
# Compare counts
node index.js status --db /path/to/new.sqlite

# Check JSON counts
node -e "const d = require('/path/to/old.json'); console.log('Files:', Object.keys(d.files || {}).length)"
node -e "const d = require('/path/to/old.json'); console.log('Synced:', Object.keys(d.synced || {}).length)"
node -e "const d = require('/path/to/old.json'); console.log('Roots:', (d.config?.roots || []).length)"

# Spot-check specific hashes
node index.js inspect hash <hash-prefix> --db /path/to/new.sqlite
```

#### User Coding Preferences (from quirks.md):

- Single quotes, semicolons required, 2-space indentation
- Aligned value spacing in objects
- Trailing commas on multiline
- Curly braces: multi-or-nest, body on next line
- Ternary parentheses required: `(condition) ? a : b`
- Strict equality: `===` and `!==` (with `== null` exception)
- Design for intent, not strict types (flexible utility functions)

### Next Steps / Future Work:

- Full workflow test with real data sync
- Consider adding progress bar for long operations
- Potential: add `--verify` flag to sync command for post-copy hash verification
