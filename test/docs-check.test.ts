import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const checker = fileURLToPath(new URL('../scripts/check-docs.mjs', import.meta.url));
function fixture(t: TestContext, markdown: string) {
  const directory = mkdtempSync(join(tmpdir(), 'rita-docs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'example');
  const put = (name: string, content: string) => {
    const file = join(root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content);
  };
  put('package.json', JSON.stringify({ scripts: { test: 'node --test', 'docs:check': 'node checker' } }));
  put('../sibling/package.json', JSON.stringify({ scripts: { 'sibling:test': 'node --test' } }));
  put('../sibling/README.md', '# Sibling\n');
  put('test/example.test.ts', '');
  put('README.md', markdown);
  const run = () => spawnSync(process.execPath, [checker, root], { encoding: 'utf8', windowsHide: true });
  return { put, run };
}
test('docs checker resolves duplicate headings, explicit anchors, sibling links and project commands', t => {
  const f = fixture(t, '# Title\n## Repeat\n## Repeat\n<a id="custom"></a>\n' +
    '[repeat](#repeat-1) [custom](#custom) [sibling](../sibling/README.md#sibling)\n' +
    'npm test\nnode --import tsx --test test/example.test.ts\n' +
    '<!-- docs:project ../sibling -->\nnpm run sibling:test\n<!-- docs:project . -->\nnpm run docs:check\n' +
    '```md\n[ignored](missing.md)\n# Fake\n```\n`[inline ignored](missing.md)`\n[external](https://example.invalid)\n');
  const result = f.run(); assert.equal(result.status, 0, result.stdout + result.stderr);
});
test('docs checker reports missing links, anchors, npm scripts and test paths', t => {
  const f = fixture(t, '# Title\n[bad](absent.md) [anchor](#absent)\nnpm run absent\nnode --test test/absent.test.ts\n');
  const result = f.run(); assert.equal(result.status, 1);
  for (const expected of ['missing link', 'missing anchor', 'missing npm script', 'missing path']) assert.match(result.stdout, new RegExp(expected));
});
test('historical markers exclude only old commands, while links and current commands remain checked', t => {
  const f = fixture(t, '# Title\n<!-- docs:historical:start -->\nnpm run old\nnode test/deleted.test.ts\n<!-- docs:historical:end -->\nnpm test\n');
  assert.equal(f.run().status, 0);
  f.put('README.md', '<!-- docs:historical:start -->\n[bad](absent.md)\n<!-- docs:historical:end -->\nnpm run absent\n');
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stdout, /missing link/); assert.match(result.stdout, /missing npm script/);
});
test('unbalanced historical markers and stale flow locations fail validation', t => {
  const f = fixture(t, '<!-- docs:historical:start -->\nnpm run old\n');
  assert.match(f.run().stdout, /unclosed historical/);
  f.put('docs/flows/README.md', '[old](docs/flows/01-login-and-guard.md)\n');
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stdout, /Missing flow directory/); assert.match(result.stdout, /obsolete flow link/);
});
