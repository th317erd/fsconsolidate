'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { globToRegex, matchFileToRule, shouldIgnore } = require('../../lib/patterns');

// ============================================================================
// globToRegex
// ============================================================================

describe('globToRegex', { timeout: 10000 }, () => {
  it('should match simple wildcard patterns', () => {
    const regex = globToRegex('*.jpg');
    assert.ok(regex.test('photo.jpg'));
    assert.ok(regex.test('PHOTO.JPG')); // case insensitive
    assert.ok(!regex.test('photo.png'));
  });

  it('should match brace expansion patterns', () => {
    const regex = globToRegex('*.{jpg,png,gif}');
    assert.ok(regex.test('photo.jpg'));
    assert.ok(regex.test('image.png'));
    assert.ok(regex.test('animation.gif'));
    assert.ok(!regex.test('document.pdf'));
  });

  it('should match single character wildcard', () => {
    const regex = globToRegex('file?.txt');
    assert.ok(regex.test('file1.txt'));
    assert.ok(regex.test('fileA.txt'));
    assert.ok(!regex.test('file12.txt'));
  });

  it('should match globstar (**) across path separators', () => {
    const regex = globToRegex('**/photos/**');
    assert.ok(regex.test('/home/user/photos/vacation/img.jpg'));
    assert.ok(regex.test('/photos/img.jpg'));
    // NOTE: bare relative `photos/img.jpg` does NOT match because `**/` compiles
    // to `.*/` which requires a preceding char. In practice all paths in this tool
    // are absolute, so this is acceptable behavior.
  });

  it('should escape regex special characters in patterns', () => {
    const regex = globToRegex('file.name+test.txt');
    assert.ok(regex.test('file.name+test.txt'));
    assert.ok(!regex.test('filexname+test.txt')); // dot should be literal
  });

  it('should not match across path separators with single *', () => {
    const regex = globToRegex('*.jpg');
    assert.ok(regex.test('photo.jpg'));
    assert.ok(!regex.test('sub/photo.jpg')); // * should not cross /
  });

  it('should match hidden file patterns', () => {
    const regex = globToRegex('.*');
    assert.ok(regex.test('.gitignore'));
    assert.ok(regex.test('.hidden'));
    assert.ok(!regex.test('visible'));
  });
});

// ============================================================================
// matchFileToRule
// ============================================================================

describe('matchFileToRule', { timeout: 10000 }, () => {
  const defaultRules = [
    { pattern: '*.{jpg,jpeg,png}', dest: 'Pictures' },
    { pattern: '*.{mp4,mov}', dest: 'Videos' },
    { pattern: '*.pdf', dest: 'Documents' },
  ];

  it('should match a file to the correct routing rule', () => {
    assert.strictEqual(matchFileToRule('/home/user/photo.jpg', [], defaultRules), 'Pictures');
    assert.strictEqual(matchFileToRule('/home/user/video.mp4', [], defaultRules), 'Videos');
    assert.strictEqual(matchFileToRule('/home/user/doc.pdf', [], defaultRules), 'Documents');
  });

  it('should return null for unmatched files', () => {
    assert.strictEqual(matchFileToRule('/home/user/file.xyz', [], defaultRules), null);
  });

  it('should prioritize custom rules over defaults', () => {
    const customRules = [{ pattern: '*.jpg', dest: 'CustomPictures' }];
    assert.strictEqual(matchFileToRule('/home/user/photo.jpg', customRules, defaultRules), 'CustomPictures');
  });

  it('should match case-insensitively', () => {
    assert.strictEqual(matchFileToRule('/home/user/PHOTO.JPG', [], defaultRules), 'Pictures');
    assert.strictEqual(matchFileToRule('/home/user/Video.MP4', [], defaultRules), 'Videos');
  });

  it('should handle path-based patterns', () => {
    const pathRules = [{ pattern: 'photos/**/*.jpg', dest: 'Photos' }];
    assert.strictEqual(matchFileToRule('photos/vacation/img.jpg', pathRules, []), 'Photos');
  });

  it('should handle null/undefined rule arrays gracefully', () => {
    assert.strictEqual(matchFileToRule('/home/user/photo.jpg', null, null), null);
    assert.strictEqual(matchFileToRule('/home/user/photo.jpg', undefined, undefined), null);
  });
});

// ============================================================================
// shouldIgnore
// ============================================================================

describe('shouldIgnore', { timeout: 10000 }, () => {
  const ignorePatterns = ['*.tmp', 'cache'];
  const includePatterns = ['important.tmp'];
  const defaultIgnores = ['.*', 'node_modules'];

  it('should ignore files matching ignore patterns', () => {
    const result = shouldIgnore('/root/file.tmp', 'file.tmp', null, null, ignorePatterns, [], []);
    assert.strictEqual(result.ignored, true);
    assert.strictEqual(result.pattern, '*.tmp');
  });

  it('should ignore files matching default ignore patterns', () => {
    const result = shouldIgnore('/root/.hidden', '.hidden', null, null, [], [], defaultIgnores);
    assert.strictEqual(result.ignored, true);
    assert.strictEqual(result.pattern, '.*');
  });

  it('should ignore node_modules', () => {
    const result = shouldIgnore('/root/node_modules', 'node_modules', null, null, [], [], defaultIgnores);
    assert.strictEqual(result.ignored, true);
  });

  it('should NOT ignore files matching include patterns (include overrides ignore)', () => {
    const result = shouldIgnore('/root/important.tmp', 'important.tmp', null, null, ignorePatterns, includePatterns, []);
    assert.strictEqual(result.ignored, false);
    assert.strictEqual(result.included, true);
  });

  it('should not ignore normal files', () => {
    const result = shouldIgnore('/root/photo.jpg', 'photo.jpg', null, null, ignorePatterns, [], defaultIgnores);
    assert.strictEqual(result.ignored, false);
    assert.strictEqual(result.included, false);
  });

  it('should test resolved (symlink) paths too', () => {
    // Original path is normal, but resolved path matches ignore
    const result = shouldIgnore(
      '/root/link-to-hidden', 'link-to-hidden',
      '/root/.actual-hidden', '.actual-hidden',
      [], [], defaultIgnores,
    );
    assert.strictEqual(result.ignored, true);
    assert.strictEqual(result.matchedOn, 'resolved');
  });

  it('should handle symlink include override on resolved path', () => {
    const result = shouldIgnore(
      '/root/link', 'link',
      '/root/important.tmp', 'important.tmp',
      ignorePatterns, includePatterns, [],
    );
    assert.strictEqual(result.ignored, false);
    assert.strictEqual(result.included, true);
    assert.strictEqual(result.matchedOn, 'resolved');
  });

  it('should not treat same original and resolved path as symlink', () => {
    const result = shouldIgnore(
      '/root/file.tmp', 'file.tmp',
      '/root/file.tmp', 'file.tmp', // same path = not a symlink
      ignorePatterns, [], [],
    );
    assert.strictEqual(result.ignored, true);
    assert.strictEqual(result.matchedOn, 'original');
  });

  it('should handle empty pattern arrays', () => {
    const result = shouldIgnore('/root/file.txt', 'file.txt', null, null, [], [], []);
    assert.strictEqual(result.ignored, false);
    assert.strictEqual(result.included, false);
    assert.strictEqual(result.pattern, null);
  });
});
