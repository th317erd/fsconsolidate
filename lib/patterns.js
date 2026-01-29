'use strict';

const Path = require('node:path');
const { DEFAULT_IGNORE_PATTERNS } = require('./constants');

/**
 * Convert a glob pattern to a RegExp
 * Supports: *, **, ?, {a,b,c}
 */
function globToRegex(pattern) {
  let regexStr = pattern
    .replace(/[.+^$|\\()[\]]/g, '\\$&') // Escape special regex chars (except * ? {})
    .replace(/\{([^}]+)\}/g, (_, group) => `(${group.split(',').join('|')})`) // {a,b} -> (a|b)
    .replace(/\*\*/g, '{{GLOBSTAR}}') // Temporarily mark **
    .replace(/\*/g, '[^/]*') // * matches anything except /
    .replace(/\?/g, '[^/]') // ? matches single char except /
    .replace(/\{\{GLOBSTAR\}\}/g, '.*'); // ** matches anything including /

  return new RegExp(`^${regexStr}$`, 'i');
}

/**
 * Match a file path against routing rules
 * Returns the destination folder or null if no match
 */
function matchFileToRule(filePath, routingRules, defaultRoutingRules) {
  const fileName = Path.basename(filePath);
  const allRules = [...(routingRules || []), ...(defaultRoutingRules || [])];

  for (let rule of allRules) {
    const regex = globToRegex(rule.pattern);
    const testString = (rule.pattern.includes('/')) ? filePath : fileName;
    if (regex.test(testString))
      return rule.dest;
  }

  return null;
}

/**
 * Test a single path/entry against a list of patterns
 * Returns the matching pattern or null
 */
function matchAgainstPatterns(fullPath, entryName, patterns) {
  for (let pattern of patterns) {
    if (pattern === entryName)
      return pattern;

    if (globToRegex(pattern).test(entryName))
      return pattern;

    // Also test against full path for path-based patterns
    if (pattern.includes('/') && globToRegex(pattern).test(fullPath))
      return pattern;
  }

  return null;
}

/**
 * Check if a path should be ignored, testing against both the original
 * and resolved paths (for symlink support)
 *
 * Include patterns override ignore patterns.
 * Both original and resolved paths are tested against all patterns.
 *
 * @param {string} originalPath - The original path (may be a symlink)
 * @param {string} originalEntry - The original entry name
 * @param {string|null} resolvedPath - The resolved real path (null if not a symlink)
 * @param {string|null} resolvedEntry - The resolved entry name (null if not a symlink)
 * @param {string[]} ignorePatterns - Custom ignore patterns
 * @param {string[]} includePatterns - Include patterns (override ignores)
 * @param {string[]} defaultIgnorePatterns - Default ignore patterns
 * @returns {{ ignored: boolean, included: boolean, pattern: string|null, matchedOn: 'original'|'resolved'|null }}
 */
function shouldIgnore(originalPath, originalEntry, resolvedPath, resolvedEntry, ignorePatterns, includePatterns, defaultIgnorePatterns) {
  const includes = includePatterns || [];
  const isSymlink = resolvedPath && resolvedPath !== originalPath;

  // Check include patterns first — if matched, don't ignore
  const includeMatchOriginal = matchAgainstPatterns(originalPath, originalEntry, includes);
  if (includeMatchOriginal)
    return { ignored: false, included: true, pattern: includeMatchOriginal, matchedOn: 'original' };

  if (isSymlink) {
    const includeMatchResolved = matchAgainstPatterns(resolvedPath, resolvedEntry, includes);
    if (includeMatchResolved)
      return { ignored: false, included: true, pattern: includeMatchResolved, matchedOn: 'resolved' };
  }

  // Check ignore patterns
  const allIgnorePatterns = [
    ...(ignorePatterns || []),
    ...(defaultIgnorePatterns || DEFAULT_IGNORE_PATTERNS),
  ];

  const ignoreMatchOriginal = matchAgainstPatterns(originalPath, originalEntry, allIgnorePatterns);
  if (ignoreMatchOriginal)
    return { ignored: true, included: false, pattern: ignoreMatchOriginal, matchedOn: 'original' };

  if (isSymlink) {
    const ignoreMatchResolved = matchAgainstPatterns(resolvedPath, resolvedEntry, allIgnorePatterns);
    if (ignoreMatchResolved)
      return { ignored: true, included: false, pattern: ignoreMatchResolved, matchedOn: 'resolved' };
  }

  return { ignored: false, included: false, pattern: null, matchedOn: null };
}

module.exports = {
  globToRegex,
  matchFileToRule,
  shouldIgnore,
};
