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
 * Check if a path (file or directory) should be ignored
 * Include patterns override ignore patterns
 */
function shouldIgnore(fullPath, entryName, ignorePatterns, includePatterns, defaultIgnorePatterns) {
  const includes = includePatterns || [];

  // Check include patterns first - if matched, don't ignore
  for (let pattern of includes) {
    if (pattern === entryName)
      return false;

    if (globToRegex(pattern).test(entryName))
      return false;
  }

  // Check ignore patterns
  const allIgnorePatterns = [
    ...(ignorePatterns || []),
    ...(defaultIgnorePatterns || DEFAULT_IGNORE_PATTERNS),
  ];

  for (let pattern of allIgnorePatterns) {
    if (pattern === entryName)
      return true;

    if (globToRegex(pattern).test(entryName))
      return true;
  }

  return false;
}

module.exports = {
  globToRegex,
  matchFileToRule,
  shouldIgnore,
};
