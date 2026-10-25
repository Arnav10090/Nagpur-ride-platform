import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/** Walk node_modules trees and find every directory that is a direct `moduleName` inside a node_modules folder. */
function findModuleDirs(root: string, moduleName: string): string[] {
  const results: string[] = [];
  function walk(dir: string) {
    const nm = join(dir, 'node_modules');
    if (!existsSync(nm)) return;
    const candidate = join(nm, moduleName);
    if (existsSync(join(candidate, 'package.json'))) {
      results.push(candidate);
    }
    // recurse into scoped and unscoped packages' own node_modules
    try {
      for (const entry of readdirSync(nm)) {
        if (entry === '.cache' || entry === '.package-lock.json') continue;
        const full = join(nm, entry);
        try { if (statSync(full).isDirectory()) walk(full); } catch {}
      }
    } catch {}
  }
  walk(root);
  return results;
}

describe('workspace hygiene', () => {
  it('has exactly ONE copy of react, react-dom and react-native (two copies break hooks at runtime but still bundle and still pass tests)', () => {
    const root = join(__dirname, '..');
    for (const m of ['react', 'react-dom', 'react-native']) {
      const dirs = findModuleDirs(root, m);
      const versions = dirs.map(d => JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).version);
      expect(dirs, `${m} installed at: ${dirs.join(', ')}`).toHaveLength(1); expect(versions).toHaveLength(1);
    }
  });
});
