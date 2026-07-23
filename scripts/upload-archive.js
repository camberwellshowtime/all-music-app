#!/usr/bin/env bun
// One-time (resumable) upload of ../../MUSIC Camberwell Showtime into the
// cst-music-archive R2 bucket, via `wrangler r2 object put`. Run `wrangler
// login` first. Progress is tracked in .upload-manifest.json so a re-run
// only uploads what's missing.
//
// Usage:
//   bun scripts/upload-archive.js --dry-run       # list what would upload
//   bun scripts/upload-archive.js --limit=5       # upload just a few, for testing
//   bun scripts/upload-archive.js                 # upload everything remaining

import { extname, join } from 'node:path'

const ARCHIVE_DIR = join(import.meta.dir, '..', '..', 'MUSIC Camberwell Showtime')
const BUCKET = 'cst-music-archive'
const MANIFEST_PATH = join(import.meta.dir, '..', '.upload-manifest.json')

const CONTENT_TYPES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
}

const dryRun = process.argv.includes('--dry-run')
const limitArg = process.argv.find((a) => a.startsWith('--limit='))
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity

const manifestFile = Bun.file(MANIFEST_PATH)
const uploaded = new Set(await manifestFile.exists() ? await manifestFile.json() : [])

async function saveManifest() {
  await Bun.write(MANIFEST_PATH, JSON.stringify([...uploaded].sort(), null, 2))
}

const glob = new Bun.Glob('**/*')
const files = []
for await (const rel of glob.scan({ cwd: ARCHIVE_DIR, onlyFiles: true })) {
  const ext = extname(rel).toLowerCase()
  if (ext === '.mp3' || ext === '.m4a') files.push(rel)
}
files.sort()

const toUpload = files.filter((rel) => !uploaded.has(rel))
console.log(`${files.length} audio files found, ${toUpload.length} remaining to upload.`)

let count = 0
let failed = 0
for (const rel of toUpload) {
  if (count >= limit) break
  count++

  const filePath = join(ARCHIVE_DIR, rel)
  const contentType = CONTENT_TYPES[extname(rel).toLowerCase()] ?? 'application/octet-stream'

  console.log(`[${count}/${Math.min(toUpload.length, limit)}] ${rel}`)
  if (dryRun) continue

  try {
    await Bun.$`bunx wrangler r2 object put ${`${BUCKET}/${rel}`} --file=${filePath} --content-type=${contentType} --remote`.quiet()
    uploaded.add(rel)
    await saveManifest()
  } catch (err) {
    failed++
    console.error(`  FAILED: ${err.message}`)
  }
}

if (dryRun) {
  console.log('Dry run complete, nothing uploaded.')
} else {
  console.log(`Done. ${uploaded.size}/${files.length} uploaded total.${failed ? ` (${failed} failed this run)` : ''}`)
}
