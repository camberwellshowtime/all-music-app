#!/usr/bin/env bun
// One-time re-encode of every .m4a in the archive to a sibling .mp3 (same
// directory, same basename), to collapse the archive onto a single audio
// pipeline (mp3) after seeing a Chromium PIPELINE_ERROR_READ / FFmpegDemuxer
// error on an .m4a track on a real device. Resumable: skips files whose
// .mp3 already exists.
//
// Usage:
//   bun scripts/reencode-m4a-to-mp3.js --dry-run
//   bun scripts/reencode-m4a-to-mp3.js

import { join, dirname, basename, extname } from 'node:path'

const ARCHIVE_DIR = join(import.meta.dir, '..', '..', 'MUSIC Camberwell Showtime')
const CONCURRENCY = 8

const dryRun = process.argv.includes('--dry-run')

const glob = new Bun.Glob('**/*.m4a')
const files = []
for await (const rel of glob.scan({ cwd: ARCHIVE_DIR, onlyFiles: true })) files.push(rel)
files.sort()

const todo = files.filter(rel => {
  const mp3Path = join(ARCHIVE_DIR, dirname(rel), basename(rel, extname(rel)) + '.mp3')
  return !existsSyncSafe(mp3Path)
})

function existsSyncSafe(p) {
  try { return require('node:fs').existsSync(p) } catch { return false }
}

console.log(`${files.length} .m4a files found, ${todo.length} remaining to encode.`)
if (dryRun) {
  for (const rel of todo) console.log(`  ${rel}`)
  process.exit(0)
}

let done = 0
let failed = 0
let idx = 0

async function worker() {
  while (idx < todo.length) {
    const rel = todo[idx++]
    const inPath = join(ARCHIVE_DIR, rel)
    const outPath = join(ARCHIVE_DIR, dirname(rel), basename(rel, extname(rel)) + '.mp3')
    try {
      await Bun.$`ffmpeg -y -v error -i ${inPath} -codec:a libmp3lame -q:a 2 ${outPath}`.quiet()
      done++
      console.log(`[${done + failed}/${todo.length}] ${rel}`)
    } catch (err) {
      failed++
      console.error(`[${done + failed}/${todo.length}] FAILED: ${rel}\n  ${err.message}`)
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))
console.log(`Done. ${done} encoded, ${failed} failed.`)
