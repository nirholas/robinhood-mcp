import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'bin/data-server': 'src/bin/data-server.ts',
    'bin/trading-server': 'src/bin/trading-server.ts',
    'bin/keygen': 'src/bin/keygen.ts',
  },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts' } },
  clean: true,
  sourcemap: true,
  target: 'node20',
})
