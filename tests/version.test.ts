/**
 * The handshake version, package.json, and server.json are three separate
 * sources of truth for one number. A publish that bumps only some of them
 * ships a server that misreports itself, so pin them together here.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { VERSION } from '../src/version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (name: string) =>
  JSON.parse(readFileSync(path.join(ROOT, name), 'utf8')) as Record<string, unknown>;

describe('version consistency', () => {
  const pkg = readJson('package.json');
  const server = readJson('server.json');

  it('exports the same version package.json declares', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('declares the same version in server.json', () => {
    expect(server.version).toBe(pkg.version);
  });

  it('pins the npm package entry in server.json to the same version', () => {
    const packages = server.packages as Array<{ identifier: string; version: string }>;
    const npmEntry = packages.find((p) => p.identifier === pkg.name);
    expect(npmEntry, `server.json has no npm package entry for ${String(pkg.name)}`).toBeDefined();
    expect(npmEntry?.version).toBe(pkg.version);
  });

  it('keeps mcpName equal to the registry server name, which npm publish requires', () => {
    expect(pkg.mcpName).toBe(server.name);
  });
});
