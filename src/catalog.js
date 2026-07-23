import { AUDIO_BASE_URL } from './config'

let catalogPromise = null

export function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch(`${AUDIO_BASE_URL}/catalog.json`).then(r => r.json())
  }
  return catalogPromise
}

function encodePath(relPath) {
  return relPath.split('/').map(encodeURIComponent).join('/')
}

export function vocalsUrl(song) {
  return song?.vocalsFile ? `${AUDIO_BASE_URL}/${encodePath(song.vocalsFile)}` : null
}

export function noVocalsUrl(song) {
  return song?.noVocalsFile ? `${AUDIO_BASE_URL}/${encodePath(song.noVocalsFile)}` : null
}

export function songUrls(song) {
  return [vocalsUrl(song), noVocalsUrl(song)].filter(Boolean)
}

export function findShow(catalog, showId) {
  return catalog?.shows.find(s => s.id === showId) ?? null
}

// Songs are addressed by their own globally-unique id (e.g. "2026-01") — this
// looks them up across every show, which mashup cues need since a mashup can
// span songs from different years.
export function findSongGlobal(catalog, songId) {
  if (!catalog || !songId) return null
  for (const show of catalog.shows) {
    const song = show.songs.find(s => s.id === songId)
    if (song) return { show, song }
  }
  return null
}
