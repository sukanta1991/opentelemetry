import * as assert from 'assert';
import * as path from 'path';
import {
  globSafe,
  isInside,
  rankBySuffix,
  relativeCandidates,
  sanitizeFilePath,
  suffixScore,
} from '../../src/views/codeNavPaths';

describe('codeNavPaths', () => {
  describe('sanitizeFilePath', () => {
    it('accepts plain paths and normalises separators', () => {
      assert.strictEqual(sanitizeFilePath('  src/a.ts '), 'src/a.ts');
      assert.strictEqual(sanitizeFilePath('C:\\repo\\src\\a.ts'), 'C:/repo/src/a.ts');
      assert.strictEqual(sanitizeFilePath('/abs/a.ts'), '/abs/a.ts');
    });

    it('converts file URIs to paths', () => {
      assert.strictEqual(sanitizeFilePath('file:///tmp/my%20file.ts'), '/tmp/my file.ts');
      assert.strictEqual(sanitizeFilePath('file:///C:/repo/a.ts'), 'C:/repo/a.ts');
      assert.strictEqual(sanitizeFilePath('file://evil.test/share/a.ts'), undefined);
    });

    it('rejects other schemes', () => {
      assert.strictEqual(sanitizeFilePath('http://evil.test/a.ts'), undefined);
      assert.strictEqual(sanitizeFilePath('command:workbench.action.terminal.new'), undefined);
      assert.strictEqual(sanitizeFilePath('vscode://x'), undefined);
    });

    it('rejects empty, oversized, NUL and non-string input', () => {
      assert.strictEqual(sanitizeFilePath(''), undefined);
      assert.strictEqual(sanitizeFilePath('   '), undefined);
      assert.strictEqual(sanitizeFilePath('a'.repeat(4097)), undefined);
      assert.strictEqual(sanitizeFilePath('a\0b'), undefined);
      assert.strictEqual(sanitizeFilePath(42), undefined);
    });
  });

  describe('isInside / relativeCandidates', () => {
    const root = path.resolve('/ws/app');

    it('detects containment', () => {
      assert.ok(isInside(root, path.join(root, 'src/a.ts')));
      assert.ok(isInside(root, root));
      assert.ok(isInside(root, path.join(root, '..foo')));
      assert.ok(!isInside(root, path.resolve('/ws/other/a.ts')));
      assert.ok(!isInside(root, path.resolve('/ws')));
    });

    it('resolves relative paths inside folders only', () => {
      assert.deepStrictEqual(relativeCandidates([root], 'src/a.ts'), [path.join(root, 'src/a.ts')]);
      assert.deepStrictEqual(relativeCandidates([root], '../../etc/passwd'), []);
      assert.deepStrictEqual(relativeCandidates([root], path.resolve('/abs/a.ts')), []);
    });
  });

  describe('globSafe', () => {
    it('replaces glob metacharacters with single-char wildcards', () => {
      assert.strictEqual(globSafe('a.ts'), 'a.ts');
      assert.strictEqual(globSafe('[id].tsx'), '?id?.tsx');
      assert.strictEqual(globSafe('{a,b}*!(x)?.ts'), '?a?b????x??.ts');
    });
  });

  describe('suffix ranking', () => {
    it('scores matching trailing segments', () => {
      assert.strictEqual(suffixScore('/ws/pkg/src/a.ts', '/build/pkg/src/a.ts'), 3);
      assert.strictEqual(suffixScore('C:\\ws\\src\\a.ts', 'src/a.ts'), 2);
      assert.strictEqual(suffixScore('/ws/a.ts', 'b.ts'), 0);
    });

    it('orders the closest match first with ties by path', () => {
      const ranked = rankBySuffix(['/ws/b/src/a.ts', '/ws/lib/a.ts', '/ws/c/src/a.ts'], '/app/c/src/a.ts');
      assert.deepStrictEqual(
        ranked.map((r) => [r.path, r.score]),
        [
          ['/ws/c/src/a.ts', 3],
          ['/ws/b/src/a.ts', 2],
          ['/ws/lib/a.ts', 1],
        ]
      );
    });
  });
});
