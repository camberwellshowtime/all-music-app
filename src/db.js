import PouchDB from 'pouchdb-browser'

const DB_NAME = 'music-archive'

export const db = new PouchDB(DB_NAME)

export async function addBookmark(songId, time, label) {
  await db.post({ type: 'bookmark', songId, time, label })
}

export async function deleteBookmark(bookmark) {
  await db.remove(bookmark._id, bookmark._rev)
}

export async function updateBookmark(bookmark, { time, label }) {
  await db.put({ ...bookmark, time, label })
}

export async function createMashup(name, author) {
  const result = await db.post({ type: 'mashup', name, author, createdAt: Date.now(), cues: [] })
  return db.get(result.id)
}

export async function renameMashup(mashup, name) {
  await db.put({ ...mashup, name })
}

export async function deleteMashup(mashup) {
  await db.remove(mashup._id, mashup._rev)
}

export async function updateMashupCues(mashup, cues) {
  await db.put({ ...mashup, cues })
}
