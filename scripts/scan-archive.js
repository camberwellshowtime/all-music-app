#!/usr/bin/env bun
// Walks ../../MUSIC Camberwell Showtime and emits a first-draft data/catalog.json.
// Vocals/no-vocals pairing is best-effort — old folder naming has inconsistencies
// (typos, missing suffixes, stray duplicates) that won't auto-resolve. Anything
// pairing couldn't confidently resolve lands in each show's `unmatched` list so
// nothing silently disappears; treat the whole file as a draft to hand-fix.

import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

const ARCHIVE_DIR = join(import.meta.dir, '..', '..', 'MUSIC Camberwell Showtime')
const OUTPUT_PATH = join(import.meta.dir, '..', 'data', 'catalog.json')

const NO_VOCALS_PATTERNS = [
  /\s*\(no\s*vocals\)/i,
  /\s*-\s*no\s*vocals\b/i,
  /\s*-\s*instrumental\b/i,
  /\s*-\s*intrumental\b/i, // typo seen in the archive (2018)
]

const VOCALS_PATTERNS = [/\s*\(vocals\)/i, /\s*-\s*vocals\b/i]

const TRACK_PREFIX = /^\s*\d+(\.\d+)*\s*[-.]?\s*/
const YEAR_FOLDER = /^(\d{4})\s*-\s*(.+?)\s*$/

function stripExt(name) {
  return name.slice(0, name.length - extname(name).length)
}

function stripMarkers(name) {
  let s = name
  for (const p of [...NO_VOCALS_PATTERNS, ...VOCALS_PATTERNS]) s = s.replace(p, '')
  return s
}

function cleanTitle(name) {
  let title = stripMarkers(stripExt(name))
  title = title.replace(TRACK_PREFIX, '')
  title = title.replace(/_/g, "'")
  title = title.replace(/\s*-\s*$/, '')
  title = title.replace(/\s+/g, ' ').trim()
  return title || stripExt(name)
}

function matchKey(relPath) {
  let key = stripMarkers(stripExt(basename(relPath)))
  key = key.replace(TRACK_PREFIX, '')
  key = key.replace(/_/g, "'")
  key = key.replace(/\s*-\s*$/, '')
  return key.replace(/\s+/g, ' ').trim().toLowerCase()
}

function classify(relPath) {
  const dir = dirname(relPath)
  if (/(^|\/)no vocals$/i.test(dir)) return 'noVocals'
  if (NO_VOCALS_PATTERNS.some((p) => p.test(basename(relPath)))) return 'noVocals'
  return 'vocals'
}

async function listAudioFiles(dir) {
  const glob = new Bun.Glob('**/*')
  const files = []
  for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) {
    const ext = extname(rel).toLowerCase()
    if (ext === '.mp3' || ext === '.m4a') files.push(rel)
  }
  return files.sort()
}

function buildShow(id, folderName, relFiles) {
  const groups = new Map()
  for (const rel of relFiles) {
    const key = matchKey(rel)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(rel)
  }

  const songs = []
  const unmatched = []
  let index = 0

  for (const group of groups.values()) {
    index++
    let vocalsFile = null
    let noVocalsFile = null
    const extras = []

    for (const rel of group) {
      const kind = classify(rel)
      if (kind === 'vocals' && !vocalsFile) vocalsFile = rel
      else if (kind === 'noVocals' && !noVocalsFile) noVocalsFile = rel
      else extras.push(rel)
    }

    const primary = vocalsFile ?? noVocalsFile
    songs.push({
      id: `${id}-${String(index).padStart(2, '0')}`,
      title: cleanTitle(basename(primary)),
      vocalsFile: vocalsFile ? `${folderName}/${vocalsFile}` : null,
      noVocalsFile: noVocalsFile ? `${folderName}/${noVocalsFile}` : null,
    })

    for (const rel of extras) unmatched.push(`${folderName}/${rel}`)
  }

  return { songs, unmatched }
}

// The Random folder is a misc/extras bucket with its own inconsistent nested
// structure (per-year subfolders, alternate mixes) — not worth the same
// vocals/no-vocals pairing logic. List it flat, one entry per file.
function buildRandomShow(folderName, relFiles) {
  const songs = relFiles.map((rel, i) => ({
    id: `random-${String(i + 1).padStart(3, '0')}`,
    title: cleanTitle(basename(rel)),
    vocalsFile: `${folderName}/${rel}`,
    noVocalsFile: null,
  }))
  return { songs, unmatched: [] }
}

async function main() {
  const topEntries = await readdir(ARCHIVE_DIR, { withFileTypes: true })
  const shows = []

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue
    const folderName = entry.name
    const relFiles = await listAudioFiles(join(ARCHIVE_DIR, folderName))
    if (relFiles.length === 0) continue

    if (folderName.toLowerCase() === 'random') {
      const { songs, unmatched } = buildRandomShow(folderName, relFiles)
      shows.push({ id: 'random', year: null, title: 'Random / Extras', folder: folderName, songs, unmatched })
      continue
    }

    const match = YEAR_FOLDER.exec(folderName)
    if (!match) {
      console.warn(`Skipping unrecognized top-level folder: ${folderName}`)
      continue
    }
    const [, yearStr, rawTitle] = match
    const title = rawTitle.replace(/_/g, "'").trim()
    const { songs, unmatched } = buildShow(yearStr, folderName, relFiles)
    shows.push({ id: yearStr, year: Number(yearStr), title, folder: folderName, songs, unmatched })
  }

  shows.sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity))

  const totalSongs = shows.reduce((n, s) => n + s.songs.length, 0)
  const totalUnmatched = shows.reduce((n, s) => n + s.unmatched.length, 0)
  console.log(`${shows.length} shows, ${totalSongs} songs, ${totalUnmatched} unmatched files.`)
  for (const s of shows) {
    if (s.unmatched.length) console.log(`  ${s.folder}: ${s.unmatched.length} unmatched`)
  }

  await Bun.write(OUTPUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), shows }, null, 2))
  console.log(`Wrote ${OUTPUT_PATH}`)
}

main()
