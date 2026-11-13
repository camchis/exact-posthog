// Exact's type check reads a package's declarations, never its source, so index.d.ts must be what index.ts
// declares today: `bun run types` writes it again. TypeScript is pinned to the version Exact checks with.
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('index.d.ts is what index.ts declares', () => {
  const here = resolve(import.meta.dir, '..');
  const out = mkdtempSync(join(tmpdir(), 'exact-posthog-types-'));
  const tsc = resolve(here, 'node_modules/.bin/tsc');
  const run = Bun.spawnSync([tsc, 'index.ts', '--declaration', '--emitDeclarationOnly', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--strict', '--skipLibCheck', '--outDir', out], { cwd: here });
  expect(run.stderr.toString() + run.stdout.toString()).toBe('');
  expect(readFileSync(join(here, 'index.d.ts'), 'utf8')).toBe(readFileSync(join(out, 'index.d.ts'), 'utf8'));
});

test("reportErrors wraps an Exact app's generic answer, inline, and types the report's arguments", () => {
  const here = resolve(import.meta.dir, '..');
  const tsc = resolve(here, 'node_modules/.bin/tsc');
  const run = Bun.spawnSync([tsc, 'test/answer.fixture.ts', '--noEmit', '--target', 'es2022', '--module', 'esnext', '--moduleResolution', 'bundler', '--strict', '--skipLibCheck', '--allowImportingTsExtensions'], { cwd: here });
  expect(run.stderr.toString() + run.stdout.toString()).toBe('');
});
