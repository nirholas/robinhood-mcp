/**
 * The strategy catalogue.
 *
 * A strategy file that is never added to ALL_STRATEGIES is dead code: the
 * supervisor cannot advance it, `algo_start` cannot launch it, and its tests
 * still pass, so nothing reports the gap. That has already happened once here
 * when two changes to the index landed on top of each other.
 *
 * These tests read the directory and assert the catalogue matches it, so the
 * omission fails the build instead of shipping silently.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ALL_STRATEGIES } from '../src/engine/strategies/index.js';

const strategyDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'engine', 'strategies');

/** Files in the directory that are strategies rather than shared helpers. */
const NON_STRATEGY_FILES = new Set(['index.ts', 'params.ts']);

function strategyFiles(): string[] {
  return readdirSync(strategyDir)
    .filter((file) => file.endsWith('.ts') && !NON_STRATEGY_FILES.has(file))
    .sort();
}

describe('strategy catalogue', () => {
  it('registers every strategy file', async () => {
    const registered = new Set(ALL_STRATEGIES.map((s) => s.name));
    const missing: string[] = [];

    for (const file of strategyFiles()) {
      const module = (await import(join(strategyDir, file))) as Record<string, unknown>;
      const exported = Object.values(module).filter(
        (value): value is { name: string } =>
          typeof value === 'object' &&
          value !== null &&
          'name' in value &&
          'advance' in value &&
          'init' in value,
      );

      for (const strategy of exported) {
        if (!registered.has(strategy.name)) {
          missing.push(`${strategy.name} (${file})`);
        }
      }
    }

    expect(
      missing,
      `These strategies exist but are absent from ALL_STRATEGIES, so nothing can run them: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('has a uniquely named entry per strategy', () => {
    const names = ALL_STRATEGIES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every strategy the metadata the tools surface', () => {
    for (const strategy of ALL_STRATEGIES) {
      expect(strategy.name, 'strategy name').toMatch(/^[a-z][a-z_]*$/);
      expect(strategy.description.length, `${strategy.name} description`).toBeGreaterThan(20);
      expect(strategy.defaultIntervalMs, `${strategy.name} interval`).toBeGreaterThan(0);
      expect(typeof strategy.init, `${strategy.name} init`).toBe('function');
      expect(typeof strategy.advance, `${strategy.name} advance`).toBe('function');
    }
  });

  it('covers the order types Robinhood does not provide natively', () => {
    // The product claim this package makes. If one of these disappears, the
    // README is lying and this test is where that surfaces.
    const names = ALL_STRATEGIES.map((s) => s.name);
    for (const expected of [
      'twap',
      'iceberg',
      'ladder',
      'dca',
      'trailing_stop',
      'bracket',
      'oco',
      'chase',
      'rebalance',
    ]) {
      expect(names, `missing strategy: ${expected}`).toContain(expected);
    }
  });
});
