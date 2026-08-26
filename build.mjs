import { build } from 'esbuild';

await build({
  entryPoints: {
    index: 'src/index.ts',
    'index-v2': 'src/v2/index.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: 'dist',
  external: ['@openai/codex'],
  // Polyfill `require` for CJS modules bundled into ESM output
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
});
