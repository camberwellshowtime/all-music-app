import { useState, useEffect } from 'react'
import { db } from './db'

export function useBookmarks(songId) {
  const [bookmarks, setBookmarks] = useState([])

  useEffect(() => {
    if (!songId) { setBookmarks([]); return }
    const load = () =>
      db.allDocs({ include_docs: true }).then(result =>
        setBookmarks(
          result.rows
            .map(r => r.doc)
            .filter(d => d.type === 'bookmark' && d.songId === songId)
            .sort((a, b) => a.time - b.time)
        )
      )
    load()
    const changes = db.changes({ live: true, since: 'now', include_docs: true })
      .on('change', () => load())
    return () => { changes.cancel() }
  }, [songId])

  return bookmarks
}

export function useMashups() {
  const [mashups, setMashups] = useState([])

  useEffect(() => {
    const load = () =>
      db.allDocs({ include_docs: true }).then(result =>
        setMashups(
          result.rows
            .map(r => r.doc)
            .filter(d => d.type === 'mashup')
            .sort((a, b) => b.createdAt - a.createdAt)
        )
      )
    load()
    const changes = db.changes({ live: true, since: 'now', include_docs: true })
      .on('change', () => load())
    return () => { changes.cancel() }
  }, [])

  return mashups
}
