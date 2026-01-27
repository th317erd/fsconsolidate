'use strict';

const MAX_CONCURRENT = 8;
const LARGE_FILE_THRESHOLD = 300 * 1024 * 1024; // 300 MB
const PROGRESS_DISPLAY_THRESHOLD = 100 * 1024 * 1024; // 100 MB
const STALL_CHECK_INTERVAL_MS = 30000; // 30 seconds
const SAVE_INTERVAL = 500; // Save database every N hashed files

// Default patterns to ignore during scanning
const DEFAULT_IGNORE_PATTERNS = [
  '.*',              // Hidden files/folders (starting with dot)
  'node_modules',
  '__pycache__',
  'Thumbs.db',
  '$RECYCLE.BIN',
  'System Volume Information',
  'vendor',          // PHP/Go dependencies
  'venv',            // Python virtual env
  'env',
  '*.tmp',
  '*.temp',
  '*.swp',
  '*.swo',
  '*~',
];

// Default routing rules for common file types
const DEFAULT_ROUTING_RULES = [
  { pattern: '*.{jpg,jpeg,png,gif,webp,bmp,tiff,heic,heif}', dest: 'Pictures', description: 'Images' },
  { pattern: '*.{mp4,mov,avi,mkv,wmv,flv,webm,m4v}', dest: 'Videos', description: 'Videos' },
  { pattern: '*.{mp3,wav,flac,aac,ogg,wma,m4a}', dest: 'Music', description: 'Audio' },
  { pattern: '*.{pdf,doc,docx,xls,xlsx,ppt,pptx,odt,ods,odp}', dest: 'Documents', description: 'Documents' },
  { pattern: '*.{zip,tar,gz,rar,7z,bz2}', dest: 'Archives', description: 'Archives' },
  { pattern: '*.{js,ts,py,java,c,cpp,h,cs,go,rs,rb,php}', dest: 'Code', description: 'Source code' },
];

module.exports = {
  MAX_CONCURRENT,
  LARGE_FILE_THRESHOLD,
  PROGRESS_DISPLAY_THRESHOLD,
  STALL_CHECK_INTERVAL_MS,
  SAVE_INTERVAL,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_ROUTING_RULES,
};
