import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  outExtension: () => ({ js: '.js' }),
  clean: true,
  splitting: false,
  sourcemap: true,
  // agent-core is resolved from node_modules at runtime (workspace link in
  // dev; staged dependencies in the packaged layout). ws is a normal runtime
  // dependency of the host process.
  external: [/^@accomplish_ai\/agent-core($|\/)/, 'ws'],
});
