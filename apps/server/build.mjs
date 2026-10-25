// Bundles the server (and @app/shared) into dist/ for production; node_modules deps stay external.
import { build } from 'esbuild';
import { cp, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/index.ts', 'src/cli.ts', 'src/scripts/migrate.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  packages: 'external',
  alias: { '@app/shared': '../../packages/shared/src/index.ts' },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
await cp('drizzle', 'dist/drizzle', { recursive: true });
console.log('server built to dist/');
