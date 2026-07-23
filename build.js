#!/usr/bin/env bun
import plugin from 'bun-plugin-tailwind'
import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import path from 'path'

const outdir = path.join(process.cwd(), 'dist')

// Clean dist/
if (existsSync(outdir)) {
  console.log('Cleaning dist/')
  await rm(outdir, { recursive: true, force: true })
}

const start = performance.now()

// Build app (HTML entrypoints) and service worker in parallel.
// Audio and catalog.json are served from the Cloudflare Worker/R2 — nothing
// to bundle or copy locally for those.
const [appResult, swResult] = await Promise.all([
  Bun.build({
    entrypoints: ['src/index.html'],
    outdir,
    plugins: [plugin],
    minify: true,
    target: 'browser',
    sourcemap: 'linked',
    define: {
      'process.env.NODE_ENV': '"production"',
      '__BUILD_DATE__': JSON.stringify(new Date().toISOString()),
    },
  }),
  Bun.build({
    entrypoints: ['src/sw.js'],
    outdir,
    minify: true,
    target: 'browser',
    naming: '[name].[ext]',
  }),
])

if (!appResult.success) {
  console.error('App build failed:', appResult.logs)
  process.exit(1)
}
if (!swResult.success) {
  console.error('SW build failed:', swResult.logs)
  process.exit(1)
}

console.log('\nCopying PWA assets…')
await Promise.all([
  Bun.write(`${outdir}/manifest.json`, Bun.file('src/manifest.json')),
  Bun.write(`${outdir}/icon-180.png`, Bun.file('src/icon-180.png')),
  Bun.write(`${outdir}/icon-192.png`, Bun.file('src/icon-192.png')),
  Bun.write(`${outdir}/icon-512.png`, Bun.file('src/icon-512.png')),
])

const elapsed = ((performance.now() - start) / 1000).toFixed(1)
console.log(`\nBuild complete in ${elapsed}s`)
