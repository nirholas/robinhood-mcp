import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'bin/data-server': 'src/bin/data-server.ts',
    'bin/trading-server': 'src/bin/trading-server.ts',
    'bin/keygen': 'src/bin/keygen.ts',
    'bin/daemon': 'src/bin/daemon.ts',
  },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts' } },
  clean: true,
  sourcemap: true,
  target: 'node22',
  platform: 'node',
  esbuildOptions(options) {
    // esbuild's builtin list predates `node:sqlite`, so it helpfully strips the
    // `node:` prefix and emits a bare `sqlite` import, which resolves to a
    // package that does not exist. Marking it external is not enough; the
    // specifier itself has to be pinned.
    options.plugins = [
      ...(options.plugins ?? []),
      {
        name: 'preserve-node-sqlite-specifier',
        setup(build) {
          build.onResolve({ filter: /^node:sqlite$/ }, () => ({
            path: 'node:sqlite',
            external: true,
          }))
        },
      },
    ]
  },
})
