import { useState, useEffect, useRef, Fragment } from 'react'
import { loadCatalog, findShow, findSongGlobal, vocalsUrl, noVocalsUrl, songUrls } from './catalog'
import GestureMenu from './GestureMenu'
import { addBookmark, deleteBookmark, updateBookmark, createMashup, deleteMashup as deleteMashupDoc, renameMashup, updateMashupCues } from './db'
import { useBookmarks, useMashups } from './hooks'
import { initDebugConsole, logAudioEvents } from './debug'
import { AUDIO_CACHE } from './cacheNames'

const _saved = (() => {
  try {
    const s = sessionStorage.getItem('music-restore')
    if (s) sessionStorage.removeItem('music-restore')
    return s ? JSON.parse(s) : null
  } catch { return null }
})()

const _hadController = !!navigator.serviceWorker?.controller

// __BUILD_DATE__ is substituted at build time (see build.js's `define`);
// `typeof` is the one operator that's safe to use on an identifier that was
// never declared at all, which is what happens in dev (no bundler define).
const BUILD_DATE_LABEL = typeof __BUILD_DATE__ !== 'undefined' ? new Date(__BUILD_DATE__).toLocaleString() : 'dev build'

const MAX_AUTO_RETRIES = 3

const MEDIA_ERROR_NAMES = {
  1: 'MEDIA_ERR_ABORTED',
  2: 'MEDIA_ERR_NETWORK',
  3: 'MEDIA_ERR_DECODE',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
}

function fmt(s) {
  if (!isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`
}

function BookmarkPill({ bm, loopStart, loopEnd, onSeek, onMenu, onGesture }) {
  const timerRef = useRef(null)
  const suppressRef = useRef(false)
  const dotsRef = useRef(null)

  const dotsPos = () => {
    const r = dotsRef.current?.getBoundingClientRect()
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
  }

  const handlePointerDown = (e) => {
    if (e.button > 0) return // left button / touch only
    const x = e.clientX, y = e.clientY
    const pid = e.pointerId

    const cleanup = () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      document.removeEventListener('pointercancel', onUp)
    }

    const onMove = (ev) => {
      if (ev.pointerId !== pid) return
      if (Math.hypot(ev.clientX - x, ev.clientY - y) > 10) {
        clearTimeout(timerRef.current)
        timerRef.current = null
        cleanup()
      }
    }

    const onUp = (ev) => {
      if (ev.pointerId !== pid) return
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      cleanup()
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null
      suppressRef.current = true
      cleanup()
      navigator.vibrate?.(20)
      const pos = dotsPos()
      onGesture(bm, pos?.x ?? x, pos?.y ?? y)
    }, 400)

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    document.addEventListener('pointercancel', onUp)
  }

  return (
    <span
      className={`flex items-center bg-gray-700 rounded-full text-xs select-none ${loopStart === bm.time ? 'ring-1 ring-green-500/60' : loopEnd === bm.time ? 'ring-1 ring-orange-500/60' : ''}`}
      onPointerDown={handlePointerDown}
      onContextMenu={e => e.preventDefault()}
    >
      <button
        onClick={() => { if (suppressRef.current) { suppressRef.current = false; return }; onSeek(bm.time) }}
        className='pl-2.5 pr-1 py-1 hover:text-white transition-colors whitespace-nowrap'
        title={fmt(bm.time)}
      >
        {bm.label}
      </button>
      <button
        ref={dotsRef}
        onClick={e => { e.stopPropagation(); onMenu(bm) }}
        className='pl-1 pr-2.5 py-1 text-gray-500 hover:text-white transition-colors'
        aria-label='Bookmark options'
      >⋯</button>
    </span>
  )
}

export default function App() {
  const [catalog, setCatalog] = useState(null)
  const [browsingShowId, setBrowsingShowId] = useState(null)
  const [currentId, setCurrentId] = useState(_saved?.currentId ?? null)
  const [mode, setMode] = useState(_saved?.mode ?? 'vocals')
  const [isPlaying, setIsPlaying] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const [trackError, setTrackError] = useState(false)
  const [trackErrorInfo, setTrackErrorInfo] = useState(null)
  const [diagCopied, setDiagCopied] = useState(false)
  const [buildDateLabel, setBuildDateLabel] = useState(null)
  const [downloadStatus, setDownloadStatus] = useState({}) // songId -> 'idle' | 'downloading' | 'done' | 'error'
  const [showDownloadStatus, setShowDownloadStatus] = useState({}) // showId -> { state, done, total }
  const [copiedSongId, setCopiedSongId] = useState(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [addingBookmark, setAddingBookmark] = useState(false)
  const [labelInput, setLabelInput] = useState('')
  const [pendingDeleteId, setPendingDeleteId] = useState(null)
  const [loopActive, setLoopActive] = useState(_saved?.loopActive ?? false)
  const [loopStart, setLoopStart] = useState(_saved?.loopStart ?? null)
  const [loopEnd, setLoopEnd] = useState(_saved?.loopEnd ?? null)
  const [editingBookmark, setEditingBookmark] = useState(null)
  const [editLabel, setEditLabel] = useState('')
  const [editTime, setEditTime] = useState(0)
  const [bookmarkMenu, setBookmarkMenu] = useState(null)
  const [gestureMenu, setGestureMenu] = useState(null)

  // Mashup state
  const [editingCue, setEditingCue] = useState(null)
  const [editCueLabel, setEditCueLabel] = useState('')
  const [editCueStart, setEditCueStart] = useState(0)
  const [editCueEnd, setEditCueEnd] = useState(null)
  const [mashupPanelOpen, setMashupPanelOpen] = useState(false)
  const [activeMashupId, setActiveMashupId] = useState(() => localStorage.getItem('mashup-active-id'))
  const [mashupPlaying, setMashupPlaying] = useState(false)
  const [mashupCueIdx, setMashupCueIdx] = useState(0)
  const [creatingMashup, setCreatingMashup] = useState(false)
  const [newMashupName, setNewMashupName] = useState('')
  const [renamingMashup, setRenamingMashup] = useState(false)
  const [renameInput, setRenameInput] = useState('')
  const [newMashupAuthor, setNewMashupAuthor] = useState(() => localStorage.getItem('mashup-author') ?? '')

  const pendingDeleteRef = useRef(null)
  const vocalsRef = useRef(null)
  const noVocalsRef = useRef(null)
  const isPlayingRef = useRef(false)
  const errorRetryCountRef = useRef(0)
  const titleTapCountRef = useRef(0)
  const titleTapTimerRef = useRef(null)
  const pendingSeek = useRef(
    _saved?.currentId && _saved?.currentTime > 0
      ? { time: _saved.currentTime, play: false }
      : null
  )
  const loopStartRef = useRef(_saved?.loopStart ?? null)
  const loopEndRef = useRef(_saved?.loopEnd ?? null)
  const loopActiveRef = useRef(_saved?.loopActive ?? false)
  const pendingSwReload = useRef(false)
  const doReloadRef = useRef(null)
  const bookmarkMenuPushedRef = useRef(false)
  const editBookmarkPushedRef = useRef(false)
  const browsingShowPushedRef = useRef(false)

  // Mashup refs
  const songDurationsRef = useRef({})
  const playingShowSongsRef = useRef([])
  const mashupPanelPushedRef = useRef(false)
  const mashupPlayingRef = useRef(false)
  const mashupCueIdxRef = useRef(0)
  const mashupCuesRef = useRef([])
  const advanceMashupRef = useRef(null)
  const activeCueRef = useRef(null)
  const activeMashupRef = useRef(null)
  const playerBarRef = useRef(null)
  const [playerHeight, setPlayerHeight] = useState(0)
  const wakeLockRef = useRef(null)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const [dragging, setDragging] = useState(null) // { fromIdx, dropIdx }
  const draggingRef = useRef(null)
  const [mashupUndoMsg, setMashupUndoMsg] = useState(null)
  const mashupUndoRef = useRef(null)
  const [fadeDuration, setFadeDuration] = useState(() => parseInt(localStorage.getItem('mashup-fade-ms') ?? '1500'))
  const [crossfadeEnabled, setCrossfadeEnabled] = useState(() => localStorage.getItem('mashup-fade-enabled') !== 'false')

  // Secondary audio deck for crossfade
  const vocalsSecRef = useRef(null)
  const noVocalsSecRef = useRef(null)
  const currentIdRef = useRef(null)
  const modeRef = useRef('vocals')
  const fadeDurationRef = useRef(fadeDuration)
  const crossfadeEnabledRef = useRef(crossfadeEnabled)
  const crossfadingRef = useRef(false)
  const crossfadeRafRef = useRef(null)
  const crossfadeCompleteRef = useRef(false) // skip audio reload when crossfade just swapped decks

  const location = currentId ? findSongGlobal(catalog, currentId) : null
  const currentSong = location?.song ?? null
  const playingShow = location?.show ?? null
  const playingShowSongs = playingShow?.songs ?? []
  const currentIdx = currentSong ? playingShowSongs.findIndex(s => s.id === currentId) : -1
  const browsingShow = browsingShowId ? findShow(catalog, browsingShowId) : null
  const browsingShowSongs = browsingShow?.songs ?? []
  const allBookmarks = useBookmarks(currentId)
  const bookmarks = allBookmarks.filter(bm => bm._id !== pendingDeleteId)
  const loopStartLabel = bookmarks.find(bm => bm.time === loopStart)?.label
  const loopEndLabel = bookmarks.find(bm => bm.time === loopEnd)?.label

  const mashups = useMashups()
  const activeMashup = mashups.find(m => m._id === activeMashupId) ?? null
  // Keep refs in sync every render so closures always see fresh values
  mashupCuesRef.current = activeMashup?.cues ?? []
  activeMashupRef.current = activeMashup
  playingShowSongsRef.current = playingShowSongs
  currentIdRef.current = currentId
  modeRef.current = mode
  fadeDurationRef.current = fadeDuration
  crossfadeEnabledRef.current = crossfadeEnabled

  doReloadRef.current = () => {
    sessionStorage.setItem('music-restore', JSON.stringify({
      currentId,
      currentTime: vocalsRef.current?.currentTime ?? 0,
      mode,
      loopStart,
      loopEnd,
      loopActive,
    }))
    window.location.reload()
  }

  // Entering/leaving a show's song list pushes/consumes a history entry, the
  // same way the bookmark/mashup overlays below do — so the device back
  // button steps song-list → show-list → (previous page/exit) like a native
  // app's back stack, instead of leaving the show list and song list
  // sharing one history entry (which would make back skip straight past
  // the song list).
  const enterShow = (showId) => {
    history.pushState({ browsingShow: true }, '')
    browsingShowPushedRef.current = true
    setBrowsingShowId(showId)
  }

  const exitShow = () => {
    setBrowsingShowId(null)
    if (browsingShowPushedRef.current) {
      browsingShowPushedRef.current = false
      history.back()
    }
  }

  useEffect(() => {
    loadCatalog().then(cat => {
      setCatalog(cat)
      // A sessionStorage restore (from a service-worker-triggered reload)
      // takes priority over the URL; otherwise a shared/bookmarked link's
      // ?show=&song= params seed the initial view.
      if (_saved) return
      const params = new URLSearchParams(window.location.search)
      const showId = params.get('show')
      const songId = params.get('song')
      if (songId) {
        const loc = findSongGlobal(cat, songId)
        if (loc) {
          setCurrentId(songId)
          enterShow(loc.show.id)
          return
        }
      }
      if (showId && findShow(cat, showId)) enterShow(showId)
    }).catch(() => {})
  }, [])

  // Keep ?show=&song= in sync with what's on screen, so the URL can be
  // bookmarked/shared/refreshed back to the same place. Uses replaceState
  // (not pushState) to avoid interfering with the back-button handling
  // already wired up for bookmark/mashup overlays below.
  useEffect(() => {
    const params = new URLSearchParams()
    if (browsingShowId) params.set('show', browsingShowId)
    if (currentId) params.set('song', currentId)
    const qs = params.toString()
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    window.history.replaceState(window.history.state, '', url)
  }, [browsingShowId, currentId])

  useEffect(() => {
    initDebugConsole()
    logAudioEvents(vocalsRef.current, 'vocals')
    logAudioEvents(noVocalsRef.current, 'no-vocals')
    logAudioEvents(vocalsSecRef.current, 'vocals-sec')
    logAudioEvents(noVocalsSecRef.current, 'no-vocals-sec')
  }, [])

  // Reflect whether the current song is already fully cached (from a prior
  // manual download, or just from having been opportunistically cached by
  // the service worker on a previous full listen).
  useEffect(() => {
    if (!currentSong || !('caches' in window)) return
    const id = currentSong.id
    let cancelled = false
    ;(async () => {
      const cache = await caches.open(AUDIO_CACHE)
      const matches = await Promise.all(songUrls(currentSong).map(url => cache.match(url)))
      if (!cancelled) setDownloadStatus(s => (s[id] ? s : { ...s, [id]: matches.every(Boolean) ? 'done' : 'idle' }))
    })()
    return () => { cancelled = true }
  }, [currentSong])

  // Same, but for every row in the show currently being browsed (which may
  // differ from the song actually playing) so each row's download icon
  // reflects real cache state rather than always starting at 'idle'.
  useEffect(() => {
    if (!browsingShowId || browsingShowSongs.length === 0 || !('caches' in window)) return
    let cancelled = false
    ;(async () => {
      const cache = await caches.open(AUDIO_CACHE)
      const results = await Promise.all(browsingShowSongs.map(async song => {
        const matches = await Promise.all(songUrls(song).map(url => cache.match(url)))
        return [song.id, matches.length > 0 && matches.every(Boolean)]
      }))
      if (cancelled) return
      setDownloadStatus(s => {
        const next = { ...s }
        for (const [id, done] of results) if (!next[id]) next[id] = done ? 'done' : 'idle'
        return next
      })
    })()
    return () => { cancelled = true }
  }, [browsingShowId, browsingShowSongs])

  useEffect(() => {
    const sw = navigator.serviceWorker
    if (!sw) return
    const handler = (e) => {
      if (e.data?.type === 'sw-activated') {
        if (_hadController) {
          if (vocalsRef.current && !vocalsRef.current.paused) {
            pendingSwReload.current = true // defer until music stops
          } else {
            doReloadRef.current()
          }
        }
      }
    }
    sw.addEventListener('message', handler)
    return () => sw.removeEventListener('message', handler)
  }, [])

  // Back button dismisses whichever overlay is on top
  useEffect(() => {
    const handler = () => {
      if (editBookmarkPushedRef.current) {
        editBookmarkPushedRef.current = false
        setEditingBookmark(null)
      } else if (bookmarkMenuPushedRef.current) {
        bookmarkMenuPushedRef.current = false
        setBookmarkMenu(null)
      } else if (mashupPanelPushedRef.current) {
        mashupPanelPushedRef.current = false
        setMashupPanelOpen(false)
        setCreatingMashup(false)
      } else if (browsingShowPushedRef.current) {
        browsingShowPushedRef.current = false
        setBrowsingShowId(null)
      }
    }
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  // Load audio elements when song changes (also re-runs once the catalog
  // finishes its initial async load, so a restored currentId resolves)
  useEffect(() => {
    const va = vocalsRef.current
    const nv = noVocalsRef.current
    if (!va || !nv || !currentSong) return
    // Crossfade already loaded & started the new song — just update metadata
    if (crossfadeCompleteRef.current) {
      crossfadeCompleteRef.current = false
      va.dataset.songId = currentId
      return
    }
    const pending = pendingSeek.current
    pendingSeek.current = null
    va.pause(); nv.pause()
    va.dataset.songId = currentId
    va.src = vocalsUrl(currentSong)
    nv.src = noVocalsUrl(currentSong) ?? vocalsUrl(currentSong)
    va.load(); nv.load()
    if (pending) {
      let vaReady = false, nvReady = false
      const tryStart = () => {
        if (!vaReady || !nvReady) return
        va.currentTime = pending.time
        nv.currentTime = pending.time
        if (pending.play) {
          va.play().catch(() => {})
          nv.play().catch(() => {})
        }
      }
      va.addEventListener('canplay', () => { vaReady = true; tryStart() }, { once: true })
      nv.addEventListener('canplay', () => { nvReady = true; tryStart() }, { once: true })
      nv.addEventListener('error',   () => { nvReady = true; tryStart() }, { once: true })
    }
  }, [currentId, catalog])

  // Switch which element is audible — no seeking needed
  useEffect(() => {
    if (crossfadingRef.current) return // RAF tick manages volumes during crossfade
    const va = vocalsRef.current
    const nv = noVocalsRef.current
    if (!va || !nv) return
    va.muted = mode !== 'vocals';    va.volume = mode === 'vocals'    ? 1 : 0
    nv.muted = mode !== 'no-vocals'; nv.volume = mode === 'no-vocals' ? 1 : 0
  }, [mode])

  // Audio events — drive state from vocals element (master)
  useEffect(() => {
    const vaA = vocalsRef.current
    const nvA = noVocalsRef.current
    const vaB = vocalsSecRef.current
    const nvB = noVocalsSecRef.current
    if (!vaA || !nvA || !vaB || !nvB) return

    // Handlers check e.target === vocalsRef.current so they work correctly
    // after ref swaps (where vocalsRef.current changes to point to the other deck).
    const onTime = (e) => {
      if (e.target !== vocalsRef.current) return
      const t = e.target.currentTime
      setCurrentTime(t)
      if (mashupPlayingRef.current) {
        const cues = mashupCuesRef.current
        const cue = cues[mashupCueIdxRef.current]
        if (cue?.endTime != null) {
          const remaining = cue.endTime - t
          const fadeSecs = fadeDurationRef.current / 1000
          const nextIdx = mashupCueIdxRef.current + 1
          if (crossfadeEnabledRef.current && !crossfadingRef.current && remaining > 0 && remaining <= fadeSecs) {
            if (nextIdx < cues.length) beginCrossfadeRef.current(nextIdx)
            else beginFadeToSilenceRef.current()
          }
          if (t >= cue.endTime && !crossfadingRef.current) advanceMashupRef.current?.()
        }
      } else {
        const va = vocalsRef.current
        const nv = noVocalsRef.current
        if (loopActiveRef.current &&
            loopStartRef.current !== null && loopEndRef.current !== null &&
            loopEndRef.current > loopStartRef.current &&
            va.currentTime >= loopEndRef.current) {
          va.currentTime = loopStartRef.current
          nv.currentTime = loopStartRef.current
        }
      }
    }
    const setPositionState = (el) => {
      if (!('mediaSession' in navigator)) return
      try {
        navigator.mediaSession.setPositionState?.({
          duration: isFinite(el.duration) ? el.duration : 0,
          playbackRate: el.playbackRate ?? 1,
          position: Math.min(el.currentTime, isFinite(el.duration) ? el.duration : el.currentTime),
        })
      } catch {}
    }
    const onDuration = (e) => {
      if (e.target !== vocalsRef.current) return
      const el = e.target
      const d = isFinite(el.duration) ? el.duration : 0
      setDuration(d)
      if (d > 0) { const id = el.dataset.songId; if (id) songDurationsRef.current[id] = d }
      setPositionState(el)
    }
    const onPlay = (e) => {
      if (e.target !== vocalsRef.current) return
      isPlayingRef.current = true
      setIsPlaying(true)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'
      setPositionState(e.target)
    }
    const onPause = (e) => {
      if (e.target !== vocalsRef.current) return
      isPlayingRef.current = false
      setIsPlaying(false)
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'
      if (pendingSwReload.current) doReloadRef.current()
    }
    const onEnded = (e) => {
      if (e.target !== vocalsRef.current) return
      noVocalsRef.current?.pause()
      if (pendingSwReload.current) { doReloadRef.current(); return }
      if (mashupPlayingRef.current) { advanceMashupRef.current?.(); return }
      setCurrentId(prev => {
        const list = playingShowSongsRef.current
        const idx = list.findIndex(s => s.id === prev)
        if (idx >= 0 && idx < list.length - 1) {
          pendingSeek.current = { time: 0, play: true }
          setMode('vocals')
          return list[idx + 1].id
        }
        return prev
      })
    }

    const onLoadStart = (e) => {
      if (e.target !== vocalsRef.current) return
      setBuffering(true)
      setTrackError(false)
      setTrackErrorInfo(null)
    }
    const onWaiting = (e) => {
      if (e.target !== vocalsRef.current) return
      setBuffering(true)
    }
    const onReady = (e) => {
      if (e.target !== vocalsRef.current) return
      setBuffering(false)
    }
    const onError = (e) => {
      if (e.target !== vocalsRef.current) return

      const el = e.target
      const nv = noVocalsRef.current
      const mediaError = el.error

      // MEDIA_ERR_NETWORK ("FFmpegDemuxer: data source error" etc) is
      // typically a transient mid-stream read failure — mobile network
      // hiccup, background tab throttling — rather than a broken resource
      // (a HEAD probe right after almost always comes back healthy). Retry
      // a few times with backoff, reloading in place and resuming from the
      // same position, before giving up and surfacing the manual retry UI.
      if (mediaError?.code === 2 && errorRetryCountRef.current < MAX_AUTO_RETRIES) {
        const attempt = errorRetryCountRef.current
        errorRetryCountRef.current = attempt + 1
        setBuffering(true)
        const t = el.currentTime || 0
        const resume = isPlayingRef.current
        setTimeout(() => {
          if (el !== vocalsRef.current) return
          el.load()
          nv?.load()
          const onCanPlay = () => {
            el.currentTime = t
            if (nv) nv.currentTime = t
            if (resume) { el.play().catch(() => {}); nv?.play().catch(() => {}) }
          }
          el.addEventListener('canplay', onCanPlay, { once: true })
        }, 500 * (attempt + 1))
        return
      }

      setBuffering(false)
      setTrackError(true)

      const info = {
        time: new Date().toISOString(),
        src: el.currentSrc,
        errorCode: mediaError?.code ?? null,
        errorName: MEDIA_ERROR_NAMES[mediaError?.code] ?? null,
        errorMessage: mediaError?.message || null,
        networkState: el.networkState,
        readyState: el.readyState,
        autoRetries: errorRetryCountRef.current,
        userAgent: navigator.userAgent,
      }
      setTrackErrorInfo(info)

      if (info.src) {
        fetch(info.src, { method: 'HEAD' })
          .then(res => setTrackErrorInfo(cur => cur === info ? {
            ...info,
            headProbe: {
              status: res.status,
              contentType: res.headers.get('content-type'),
              contentLength: res.headers.get('content-length'),
              acceptRanges: res.headers.get('accept-ranges'),
            },
          } : cur))
          .catch(err => setTrackErrorInfo(cur => cur === info ? { ...info, headProbe: { error: String(err) } } : cur))
      }
    }

    const decks = [vaA, vaB]
    for (const el of decks) {
      el.addEventListener('timeupdate', onTime)
      el.addEventListener('loadedmetadata', onDuration)
      el.addEventListener('durationchange', onDuration)
      el.addEventListener('play', onPlay)
      el.addEventListener('pause', onPause)
      el.addEventListener('ended', onEnded)
      el.addEventListener('loadstart', onLoadStart)
      el.addEventListener('waiting', onWaiting)
      el.addEventListener('stalled', onWaiting)
      el.addEventListener('canplay', onReady)
      el.addEventListener('playing', onReady)
      el.addEventListener('error', onError)
    }
    return () => {
      for (const el of decks) {
        el.removeEventListener('timeupdate', onTime)
        el.removeEventListener('loadedmetadata', onDuration)
        el.removeEventListener('durationchange', onDuration)
        el.removeEventListener('play', onPlay)
        el.removeEventListener('pause', onPause)
        el.removeEventListener('ended', onEnded)
        el.removeEventListener('loadstart', onLoadStart)
        el.removeEventListener('waiting', onWaiting)
        el.removeEventListener('stalled', onWaiting)
        el.removeEventListener('canplay', onReady)
        el.removeEventListener('playing', onReady)
        el.removeEventListener('error', onError)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Periodic drift correction — keep no-vocals locked to vocals
  useEffect(() => {
    const interval = setInterval(() => {
      const va = vocalsRef.current
      const nv = noVocalsRef.current
      if (!va || va.paused) return
      if (nv && Math.abs(va.currentTime - nv.currentTime) > 0.03) nv.currentTime = va.currentTime
    }, 500)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    loopStartRef.current = null
    loopEndRef.current = null
    loopActiveRef.current = false
    errorRetryCountRef.current = 0
    setLoopStart(null)
    setLoopEnd(null)
    setLoopActive(false)
    return () => {
      if (pendingDeleteRef.current) {
        clearTimeout(pendingDeleteRef.current.timer)
        deleteBookmark(pendingDeleteRef.current.bookmark)
        pendingDeleteRef.current = null
      }
    }
  }, [currentId])

  const playSong = (song) => {
    if (song.id === currentId) {
      vocalsRef.current?.play().catch(() => {})
      noVocalsRef.current?.play().catch(() => {})
      return
    }
    cancelCrossfade()
    stopMashup()
    pendingSeek.current = { time: 0, play: true }
    setCurrentId(song.id)
    setMode('vocals')
    setCurrentTime(0)
    setDuration(0)
  }

  const togglePlay = () => {
    const va = vocalsRef.current
    const nv = noVocalsRef.current
    if (!va || !currentSong) return
    if (trackError) { retryTrack(); return }
    if (va.paused) {
      va.play().catch(() => {})
      nv?.play().catch(() => {})
    } else {
      va.pause()
      nv?.pause()
    }
  }

  const retryTrack = () => {
    const va = vocalsRef.current
    const nv = noVocalsRef.current
    if (!va || !nv || !currentSong) return
    setTrackError(false)
    setTrackErrorInfo(null)
    const t = va.currentTime || 0
    va.src = vocalsUrl(currentSong)
    nv.src = noVocalsUrl(currentSong) ?? vocalsUrl(currentSong)
    va.load(); nv.load()
    va.addEventListener('canplay', () => {
      va.currentTime = t; nv.currentTime = t
      va.play().catch(() => {}); nv.play().catch(() => {})
    }, { once: true })
  }

  const downloadSong = async (song) => {
    if (!song || !('caches' in window)) return
    const id = song.id
    setDownloadStatus(s => ({ ...s, [id]: 'downloading' }))
    try {
      const cache = await caches.open(AUDIO_CACHE)
      const urls = songUrls(song)
      const results = await Promise.all(urls.map(async url => {
        const res = await fetch(url)
        if (!res.ok) return false
        await cache.put(url, res)
        return true
      }))
      setDownloadStatus(s => ({ ...s, [id]: results.every(Boolean) ? 'done' : 'error' }))
    } catch {
      setDownloadStatus(s => ({ ...s, [id]: 'error' }))
    }
  }

  const downloadShow = async (e, show) => {
    e.stopPropagation()
    if (!('caches' in window) || showDownloadStatus[show.id]?.state === 'downloading') return
    const total = show.songs.length
    setShowDownloadStatus(s => ({ ...s, [show.id]: { state: 'downloading', done: 0, total } }))
    try {
      const cache = await caches.open(AUDIO_CACHE)
      let ok = true
      let done = 0
      // Sequential, not Promise.all — downloading a whole show's worth of
      // tracks concurrently would recreate the same kind of self-inflicted
      // bandwidth contention just fixed in the service worker's audio fetch.
      for (const song of show.songs) {
        const results = await Promise.all(songUrls(song).map(async url => {
          const res = await fetch(url)
          if (!res.ok) return false
          await cache.put(url, res)
          return true
        }))
        if (!results.every(Boolean)) ok = false
        done++
        setShowDownloadStatus(s => ({ ...s, [show.id]: { state: 'downloading', done, total } }))
      }
      setShowDownloadStatus(s => ({ ...s, [show.id]: { state: ok ? 'done' : 'error', done, total } }))
    } catch {
      setShowDownloadStatus(s => ({ ...s, [show.id]: { state: 'error', done: 0, total } }))
    }
  }

  const handleTitleTap = () => {
    clearTimeout(titleTapTimerRef.current)
    titleTapCountRef.current++
    if (titleTapCountRef.current >= 5) {
      titleTapCountRef.current = 0
      setBuildDateLabel(cur => cur ? null : BUILD_DATE_LABEL)
      return
    }
    titleTapTimerRef.current = setTimeout(() => { titleTapCountRef.current = 0 }, 2000)
  }

  const copyDiagnostics = async () => {
    if (!trackErrorInfo) return
    try {
      await navigator.clipboard.writeText(JSON.stringify({ song: currentSong?.title, ...trackErrorInfo }, null, 2))
      setDiagCopied(true)
      setTimeout(() => setDiagCopied(false), 1500)
    } catch {}
  }

  const shareSong = async (song, show) => {
    const url = new URL(window.location.href)
    url.search = ''
    if (show) url.searchParams.set('show', show.id)
    url.searchParams.set('song', song.id)
    try {
      await navigator.clipboard.writeText(url.toString())
      setCopiedSongId(song.id)
      setTimeout(() => setCopiedSongId(cur => cur === song.id ? null : cur), 1500)
    } catch {}
  }

  const seek = (time) => {
    if (vocalsRef.current) vocalsRef.current.currentTime = time
    if (noVocalsRef.current) noVocalsRef.current.currentTime = time
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setPositionState?.({
          duration: isFinite(vocalsRef.current?.duration) ? vocalsRef.current.duration : 0,
          playbackRate: 1,
          position: time,
        })
      } catch {}
    }
  }

  // advanceMashupRef updated every render so it always captures current closures
  advanceMashupRef.current = () => {
    if (crossfadingRef.current) return // crossfade is handling the advance
    const cues = mashupCuesRef.current
    const nextIdx = mashupCueIdxRef.current + 1
    if (nextIdx >= cues.length) {
      mashupPlayingRef.current = false
      setMashupPlaying(false)
      mashupCueIdxRef.current = 0
      setMashupCueIdx(0)
      vocalsRef.current?.pause()
      noVocalsRef.current?.pause()
      return
    }
    const next = cues[nextIdx]
    mashupCueIdxRef.current = nextIdx
    setMashupCueIdx(nextIdx)
    if (next.songId === currentId) {
      seek(next.time)
    } else {
      pendingSeek.current = { time: next.time, play: true }
      setCurrentId(next.songId)
      setMode('vocals')
      setCurrentTime(0)
      setDuration(0)
    }
  }

  // Refs for crossfade functions (assigned later, needed by onTime above)
  const beginCrossfadeRef = useRef(null)
  const beginFadeToSilenceRef = useRef(null)

  const seekInMashupRef = useRef(null)
  seekInMashupRef.current = (delta) => {
    const cues = mashupCuesRef.current
    const idx = mashupCueIdxRef.current
    const cue = cues[idx]
    if (!cue) return
    const currentT = vocalsRef.current?.currentTime ?? cue.time
    const wasPlaying = !vocalsRef.current?.paused

    const jumpTo = (cueIdx, time) => {
      const target = cues[cueIdx]
      if (!target) return
      mashupCueIdxRef.current = cueIdx
      setMashupCueIdx(cueIdx)
      if (target.songId === currentId) {
        seek(time)
      } else {
        pendingSeek.current = { time, play: wasPlaying }
        setCurrentId(target.songId)
        setMode('vocals')
        setCurrentTime(0)
        setDuration(0)
      }
    }

    if (delta < 0) {
      const availBefore = currentT - cue.time
      if (-delta <= availBefore) {
        seek(currentT + delta)
      } else {
        const prev = cues[idx - 1]
        if (!prev) { seek(cue.time); return }
        const remainder = -delta - availBefore
        const prevEnd = prev.endTime ?? songDurationsRef.current[prev.songId] ?? null
        const landTime = prevEnd != null ? Math.max(prev.time, prevEnd - remainder) : prev.time
        jumpTo(idx - 1, landTime)
      }
    } else {
      if (cue.endTime == null) { seek(currentT + delta); return }
      const availAfter = cue.endTime - currentT
      if (delta <= availAfter) {
        seek(currentT + delta)
      } else {
        const next = cues[idx + 1]
        if (!next) { advanceMashupRef.current?.(); return }
        jumpTo(idx + 1, next.time + (delta - availAfter))
      }
    }
  }

  const switchMode = (newMode) => {
    if (newMode === mode || !currentSong) return
    if (newMode === 'no-vocals' && !currentSong.noVocalsFile) return
    setMode(newMode)
  }

  const prevSong = () => {
    if (currentIdx <= 0) return
    cancelCrossfade()
    stopMashup()
    pendingSeek.current = { time: 0, play: !vocalsRef.current?.paused }
    setCurrentId(playingShowSongs[currentIdx - 1].id)
    setMode('vocals')
  }

  const nextSong = () => {
    if (currentIdx >= playingShowSongs.length - 1) return
    cancelCrossfade()
    stopMashup()
    pendingSeek.current = { time: 0, play: !vocalsRef.current?.paused }
    setCurrentId(playingShowSongs[currentIdx + 1].id)
    setMode('vocals')
  }

  const handleDeleteBookmark = (bm) => {
    if (pendingDeleteRef.current) {
      clearTimeout(pendingDeleteRef.current.timer)
      deleteBookmark(pendingDeleteRef.current.bookmark)
    }
    const timer = setTimeout(() => {
      deleteBookmark(bm)
      pendingDeleteRef.current = null
      setPendingDeleteId(null)
    }, 5000)
    pendingDeleteRef.current = { bookmark: bm, timer }
    setPendingDeleteId(bm._id)
  }

  const handleUndoDelete = () => {
    if (!pendingDeleteRef.current) return
    clearTimeout(pendingDeleteRef.current.timer)
    pendingDeleteRef.current = null
    setPendingDeleteId(null)
  }

  const handleAddBookmark = async () => {
    if (!currentId || !labelInput.trim()) return
    await addBookmark(currentId, vocalsRef.current?.currentTime ?? 0, labelInput.trim())
    setLabelInput('')
    setAddingBookmark(false)
  }

  const handleBookmarkKeyDown = (e) => {
    if (e.key === 'Enter') handleAddBookmark()
    if (e.key === 'Escape') { setAddingBookmark(false); setLabelInput('') }
  }

  const openGestureMenu = (bm, anchorX, anchorY) => {
    setBookmarkMenu(null)
    const bottomOffset = window.innerHeight - anchorY + 12
    setGestureMenu({ bookmark: bm, anchorX, touchOrigin: { x: anchorX, y: anchorY }, bottomOffset })
  }

  const closeGestureMenu = () => setGestureMenu(null)

  const openBookmarkMenu = (bm) => {
    setGestureMenu(null)
    history.pushState({ bookmarkMenu: true }, '')
    bookmarkMenuPushedRef.current = true
    setBookmarkMenu(bm)
  }

  const closeBookmarkMenu = () => {
    setBookmarkMenu(null)
    if (bookmarkMenuPushedRef.current) {
      bookmarkMenuPushedRef.current = false
      history.back()
    }
  }

  const openEditBookmark = (bm) => {
    history.pushState({ editBookmark: true }, '')
    editBookmarkPushedRef.current = true
    setEditingBookmark(bm)
    setEditLabel(bm.label)
    setEditTime(bm.time)
  }

  const openEditFromMenu = (bm) => {
    setBookmarkMenu(null)
    if (bookmarkMenuPushedRef.current) {
      history.replaceState({ editBookmark: true }, '')
      bookmarkMenuPushedRef.current = false
    } else {
      history.pushState({ editBookmark: true }, '')
    }
    editBookmarkPushedRef.current = true
    setEditingBookmark(bm)
    setEditLabel(bm.label)
    setEditTime(bm.time)
  }

  const closeEditBookmark = () => {
    setEditingBookmark(null)
    if (editBookmarkPushedRef.current) {
      editBookmarkPushedRef.current = false
      history.back()
    }
  }

  const handleSaveBookmark = async () => {
    if (!editingBookmark || !editLabel.trim()) return
    await updateBookmark(editingBookmark, { label: editLabel.trim(), time: editTime })
    closeEditBookmark()
  }

  const nudgeTime = (delta) => {
    setEditTime(t => Math.max(0, Math.min(duration, t + delta)))
  }

  const handleEditKeyDown = (e) => {
    if (e.key === 'Enter') handleSaveBookmark()
    if (e.key === 'Escape') closeEditBookmark()
  }

  const clearLoop = () => {
    loopStartRef.current = null
    loopEndRef.current = null
    loopActiveRef.current = false
    setLoopStart(null)
    setLoopEnd(null)
    setLoopActive(false)
  }

  const setLoopA = (bm) => {
    loopStartRef.current = bm.time
    setLoopStart(bm.time)
    loopActiveRef.current = true
    setLoopActive(true)
  }

  const setLoopB = (bm) => {
    loopEndRef.current = bm.time
    setLoopEnd(bm.time)
    loopActiveRef.current = true
    setLoopActive(true)
  }

  useEffect(() => {
    if (mashupPlaying) activeCueRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [mashupCueIdx, mashupPlaying])

  // ── Mashup handlers ────────────────────────────────────────────────────────

  const cancelCrossfade = () => {
    if (crossfadeRafRef.current) { cancelAnimationFrame(crossfadeRafRef.current); crossfadeRafRef.current = null }
    crossfadingRef.current = false
    const vS = vocalsSecRef.current; const nvS = noVocalsSecRef.current
    // removeAttribute rather than src = '' — an empty-string src is an
    // invalid URI per the spec, and Firefox (unlike Chrome) surfaces it as
    // "Invalid URI. Load of media resource ... failed."
    if (vS) { vS.pause(); vS.removeAttribute('src'); vS.volume = 0 }
    if (nvS) { nvS.pause(); nvS.removeAttribute('src'); nvS.volume = 0 }
    const m = modeRef.current
    const vP = vocalsRef.current; const nvP = noVocalsRef.current
    if (vP) { vP.volume = m === 'vocals' ? 1 : 0; vP.muted = m !== 'vocals' }
    if (nvP) { nvP.volume = m === 'no-vocals' ? 1 : 0; nvP.muted = m !== 'no-vocals' }
  }

  // completeCrossfadeTransition: called at t=1 from the RAF loop.
  // Swaps primary/secondary refs so all existing code transparently uses the new deck.
  const completeCrossfadeTransition = (nextCueIdx) => {
    const outV = vocalsRef.current; const outNv = noVocalsRef.current
    outV.pause(); outNv.pause()
    outV.volume = 0; outNv.volume = 0

    // Swap refs — after this, vocalsRef.current is the incoming (now playing) element
    ;[vocalsRef.current, vocalsSecRef.current] = [vocalsSecRef.current, vocalsRef.current]
    ;[noVocalsRef.current, noVocalsSecRef.current] = [noVocalsSecRef.current, noVocalsRef.current]

    const m = modeRef.current
    vocalsRef.current.volume = m === 'vocals' ? 1 : 0; vocalsRef.current.muted = m !== 'vocals'
    noVocalsRef.current.volume = m === 'no-vocals' ? 1 : 0; noVocalsRef.current.muted = m !== 'no-vocals'

    crossfadingRef.current = false
    crossfadeRafRef.current = null

    const newVa = vocalsRef.current
    const d = isFinite(newVa.duration) ? newVa.duration : 0
    setDuration(d)
    if (d > 0 && newVa.dataset.songId) songDurationsRef.current[newVa.dataset.songId] = d

    const cues = mashupCuesRef.current
    const next = cues[nextCueIdx]
    mashupCueIdxRef.current = nextCueIdx
    setMashupCueIdx(nextCueIdx)

    if (next && next.songId !== currentIdRef.current) {
      crossfadeCompleteRef.current = true // tell currentId effect to skip audio reload
      setCurrentId(next.songId)
    }
  }

  // beginCrossfade: loads next cue into secondary deck and starts the gain ramp
  beginCrossfadeRef.current = (nextCueIdx) => {
    if (crossfadingRef.current) return
    crossfadingRef.current = true

    const cues = mashupCuesRef.current
    const next = cues[nextCueIdx]
    if (!next) { crossfadingRef.current = false; return }

    const nextSongObj = findSongGlobal(catalog, next.songId)?.song
    if (!nextSongObj) { crossfadingRef.current = false; return }

    const inV = vocalsSecRef.current; const inNv = noVocalsSecRef.current
    const outV = vocalsRef.current;   const outNv = noVocalsRef.current

    inV.src = vocalsUrl(nextSongObj)
    inNv.src = noVocalsUrl(nextSongObj) ?? vocalsUrl(nextSongObj)
    inV.muted = false; inNv.muted = false
    inV.volume = 0; inNv.volume = 0
    inV.dataset.songId = next.songId
    inV.load(); inNv.load()

    let started = false
    const fallbackTimer = setTimeout(() => {
      if (!started) { crossfadingRef.current = false; inV.removeAttribute('src'); inNv.removeAttribute('src') }
    }, fadeDurationRef.current + 3000)

    const startFade = () => {
      if (started) return
      started = true
      clearTimeout(fallbackTimer)

      inV.currentTime = next.time; inNv.currentTime = next.time

      const wasPlaying = !outV.paused
      if (wasPlaying) {
        inV.play().catch(() => {}); inNv.play().catch(() => {})
      }

      const dur = fadeDurationRef.current
      const t0 = performance.now()

      const tick = (now) => {
        const p = Math.min(1, (now - t0) / dur)
        const m = modeRef.current
        outV.volume = m === 'vocals' ? (1 - p) : 0
        outNv.volume = m === 'no-vocals' ? (1 - p) : 0
        inV.volume = m === 'vocals' ? p : 0
        inNv.volume = m === 'no-vocals' ? p : 0
        if (p < 1) crossfadeRafRef.current = requestAnimationFrame(tick)
        else completeCrossfadeTransition(nextCueIdx)
      }
      crossfadeRafRef.current = requestAnimationFrame(tick)
    }

    if (inV.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) startFade()
    else inV.addEventListener('canplay', startFade, { once: true })
  }

  // beginFadeToSilence: for the last cue — fades out then stops
  beginFadeToSilenceRef.current = () => {
    if (crossfadingRef.current) return
    crossfadingRef.current = true
    const outV = vocalsRef.current; const outNv = noVocalsRef.current
    const dur = fadeDurationRef.current
    const t0 = performance.now()
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur)
      const m = modeRef.current
      outV.volume = m === 'vocals' ? (1 - p) : 0
      outNv.volume = m === 'no-vocals' ? (1 - p) : 0
      if (p < 1) {
        crossfadeRafRef.current = requestAnimationFrame(tick)
      } else {
        outV.pause(); outNv.pause()
        const m2 = modeRef.current
        outV.volume = m2 === 'vocals' ? 1 : 0; outV.muted = m2 !== 'vocals'
        outNv.volume = m2 === 'no-vocals' ? 1 : 0; outNv.muted = m2 !== 'no-vocals'
        crossfadingRef.current = false; crossfadeRafRef.current = null
        mashupPlayingRef.current = false; setMashupPlaying(false)
        mashupCueIdxRef.current = 0; setMashupCueIdx(0)
      }
    }
    crossfadeRafRef.current = requestAnimationFrame(tick)
  }

  const stopMashup = () => {
    cancelCrossfade()
    mashupPlayingRef.current = false
    setMashupPlaying(false)
    mashupCueIdxRef.current = 0
    setMashupCueIdx(0)
  }

  const playMashupFromStart = () => {
    if (!activeMashup || activeMashup.cues.length === 0) return
    cancelCrossfade()
    const cue = activeMashup.cues[0]
    mashupCueIdxRef.current = 0
    setMashupCueIdx(0)
    mashupPlayingRef.current = true
    setMashupPlaying(true)
    if (cue.songId === currentId) {
      seek(cue.time)
      vocalsRef.current?.play().catch(() => {})
      noVocalsRef.current?.play().catch(() => {})
    } else {
      pendingSeek.current = { time: cue.time, play: true }
      setCurrentId(cue.songId)
      setMode('vocals')
    }
  }

  const jumpToMashupCue = (idx) => {
    cancelCrossfade()
    const cues = activeMashup?.cues ?? []
    const cue = cues[idx]
    if (!cue) return
    mashupCueIdxRef.current = idx
    setMashupCueIdx(idx)
    const wasPlaying = !vocalsRef.current?.paused
    if (cue.songId === currentId) {
      seek(cue.time)
    } else {
      pendingSeek.current = { time: cue.time, play: wasPlaying }
      setCurrentId(cue.songId)
      setMode('vocals')
    }
  }

  // Manual cue marking — captures the live playback position as a new cue.
  // Works uniformly across every year since it doesn't depend on bookmarks,
  // isolated stems, or any Whisper-derived data.
  const markCueHere = async () => {
    if (!activeMashup || !currentId) return
    const time = vocalsRef.current?.currentTime ?? 0
    const label = currentSong?.title ?? currentId
    const newCue = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, songId: currentId, time, endTime: null, label }
    await updateMashupCues(activeMashup, [...(activeMashup.cues ?? []), newCue])
  }

  const openEditCue = (cue) => {
    setEditingCue(cue)
    setEditCueLabel(cue.label)
    setEditCueStart(cue.time)
    setEditCueEnd(cue.endTime)
  }

  const closeEditCue = () => setEditingCue(null)

  const handleSaveCue = async () => {
    if (!activeMashup || !editingCue || !editCueLabel.trim()) return
    const newCues = activeMashup.cues.map(c =>
      c.id === editingCue.id
        ? { ...c, label: editCueLabel.trim(), time: editCueStart, endTime: editCueEnd }
        : c
    )
    await updateMashupCues(activeMashup, newCues)
    closeEditCue()
  }

  const nudgeCueStart = (delta) => {
    setEditCueStart(t => {
      const next = Math.max(0, t + delta)
      return editCueEnd !== null && next >= editCueEnd ? t : next
    })
  }

  const nudgeCueEnd = (delta) => {
    setEditCueEnd(t => t === null ? null : Math.max(editCueStart + 1, t + delta))
  }

  const handleEditCueKeyDown = (e) => {
    if (e.key === 'Enter') handleSaveCue()
    if (e.key === 'Escape') closeEditCue()
  }

  const saveMashupUndo = (prevCues, msg) => {
    if (mashupUndoRef.current) clearTimeout(mashupUndoRef.current.timer)
    const timer = setTimeout(() => { mashupUndoRef.current = null; setMashupUndoMsg(null) }, 5000)
    mashupUndoRef.current = { prevCues, timer }
    setMashupUndoMsg(msg)
  }

  const handleUndoMashupAction = async () => {
    const u = mashupUndoRef.current
    const mashup = activeMashupRef.current
    if (!u || !mashup) return
    clearTimeout(u.timer)
    mashupUndoRef.current = null
    setMashupUndoMsg(null)
    await updateMashupCues(mashup, u.prevCues)
  }

  const removeMashupCue = async (cueId) => {
    if (!activeMashup) return
    saveMashupUndo(activeMashup.cues, 'Cue removed')
    const newCues = activeMashup.cues.filter(c => c.id !== cueId)
    await updateMashupCues(activeMashup, newCues)
    if (mashupCueIdxRef.current >= newCues.length) {
      const next = Math.max(0, newCues.length - 1)
      mashupCueIdxRef.current = next
      setMashupCueIdx(next)
    }
  }

  const handleCreateMashup = async () => {
    const name = newMashupName.trim()
    const author = newMashupAuthor.trim() || 'Unknown'
    if (!name) return
    localStorage.setItem('mashup-author', author)
    const mashup = await createMashup(name, author)
    setActiveMashupId(mashup._id)
    localStorage.setItem('mashup-active-id', mashup._id)
    setCreatingMashup(false)
    setNewMashupName('')
  }

  const handleCreateKeyDown = (e) => {
    if (e.key === 'Enter') handleCreateMashup()
    if (e.key === 'Escape') setCreatingMashup(false)
  }

  const clearMashupUndo = () => {
    if (mashupUndoRef.current) { clearTimeout(mashupUndoRef.current.timer); mashupUndoRef.current = null }
    setMashupUndoMsg(null)
  }

  const selectMashup = (id) => {
    setActiveMashupId(id)
    localStorage.setItem('mashup-active-id', id)
    stopMashup()
    clearMashupUndo()
  }

  const handleDeleteMashup = async (mashup) => {
    await deleteMashupDoc(mashup)
    if (activeMashupId === mashup._id) {
      setActiveMashupId(null)
      localStorage.removeItem('mashup-active-id')
      stopMashup()
    }
  }

  const startCueDrag = (fromIdx, e) => {
    e.preventDefault()
    const state = { fromIdx, dropIdx: fromIdx }
    draggingRef.current = state
    setDragging({ ...state })

    const onMove = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const row = el?.closest('[data-cueidx]')
      let di = draggingRef.current?.dropIdx ?? fromIdx
      if (row) {
        const idx = parseInt(row.dataset.cueidx, 10)
        if (!isNaN(idx)) {
          const r = row.getBoundingClientRect()
          di = ev.clientY < r.top + r.height / 2 ? idx : idx + 1
        }
      }
      if (draggingRef.current) draggingRef.current.dropIdx = di
      setDragging(d => d ? { ...d, dropIdx: di } : null)
    }

    const onUp = async () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      const s = draggingRef.current
      draggingRef.current = null
      setDragging(null)
      const mashup = activeMashupRef.current
      if (!s || !mashup) return
      const { fromIdx: from, dropIdx: to } = s
      if (from === to || from + 1 === to) return
      const prevCues = [...mashup.cues]
      const cues = [...mashup.cues]
      const [item] = cues.splice(from, 1)
      cues.splice(to > from ? to - 1 : to, 0, item)
      saveMashupUndo(prevCues, 'Cue reordered')
      await updateMashupCues(mashup, cues)
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  }

  const startRenameMashup = () => {
    setRenameInput(activeMashup?.name ?? '')
    setRenamingMashup(true)
  }

  const handleRenameMashup = async () => {
    const name = renameInput.trim()
    if (!name || !activeMashup) return
    setRenamingMashup(false)
    await renameMashup(activeMashup, name)
  }

  const handleRenameKeyDown = (e) => {
    if (e.key === 'Enter') handleRenameMashup()
    if (e.key === 'Escape') setRenamingMashup(false)
  }

  const openMashupPanel = () => {
    history.pushState({ mashupPanel: true }, '')
    mashupPanelPushedRef.current = true
    setMashupPanelOpen(true)
  }

  const closeMashupPanel = () => {
    setMashupPanelOpen(false)
    setCreatingMashup(false)
    if (mashupPanelPushedRef.current) {
      mashupPanelPushedRef.current = false
      history.back()
    }
  }

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    if (mashupPlaying && activeMashup) {
      const cue = activeMashup.cues[mashupCueIdx]
      ms.metadata = new MediaMetadata({
        title: activeMashup.name,
        artist: cue?.label ?? '',
        album: 'Camberwell Showtime Music Archive',
      })
    } else if (currentSong) {
      ms.metadata = new MediaMetadata({
        title: currentSong.title,
        album: playingShow?.title ?? 'Camberwell Showtime Music Archive',
      })
    } else {
      ms.metadata = null
    }
  }, [currentId, mashupPlaying, activeMashupId, mashupCueIdx]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    ms.setActionHandler('play', () => {
      vocalsRef.current?.play().catch(() => {})
      noVocalsRef.current?.play().catch(() => {})
    })
    ms.setActionHandler('pause', () => {
      vocalsRef.current?.pause()
      noVocalsRef.current?.pause()
    })
    ms.setActionHandler('previoustrack', () => {
      if (mashupPlayingRef.current) jumpToMashupCue(mashupCueIdxRef.current - 1)
      else prevSong()
    })
    ms.setActionHandler('nexttrack', () => {
      if (mashupPlayingRef.current) advanceMashupRef.current?.()
      else nextSong()
    })
    ms.setActionHandler('seekbackward', (d) => {
      const skip = d.seekOffset ?? 5
      if (mashupPlayingRef.current) seekInMashupRef.current(-skip)
      else seek(Math.max(0, (vocalsRef.current?.currentTime ?? 0) - skip))
    })
    ms.setActionHandler('seekforward', (d) => {
      const skip = d.seekOffset ?? 5
      if (mashupPlayingRef.current) seekInMashupRef.current(skip)
      else seek(Math.min(vocalsRef.current?.duration ?? 0, (vocalsRef.current?.currentTime ?? 0) + skip))
    })
    return () => {
      for (const a of ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward']) {
        try { ms.setActionHandler(a, null) } catch {}
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = playerBarRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const h = entries[0].borderBoxSize?.[0]?.blockSize ?? entries[0].contentRect.height
      setPlayerHeight(h)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const acquireWakeLock = async () => {
    if (!('wakeLock' in navigator)) return
    try {
      wakeLockRef.current = await navigator.wakeLock.request('screen')
      wakeLockRef.current.addEventListener('release', () => {
        wakeLockRef.current = null
        setWakeLockActive(false)
      })
      setWakeLockActive(true)
    } catch {}
  }

  const toggleWakeLock = async () => {
    if (wakeLockRef.current) {
      await wakeLockRef.current.release()
    } else {
      await acquireWakeLock()
    }
  }

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible' && wakeLockActive && !wakeLockRef.current) {
        acquireWakeLock()
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [wakeLockActive])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className='min-h-screen bg-gray-950 text-gray-100 flex flex-col'>
      <audio ref={vocalsRef} preload='metadata' playsInline />
      <audio ref={noVocalsRef} preload='metadata' playsInline />
      {/* Secondary deck for crossfade */}
      <audio ref={vocalsSecRef} preload='metadata' playsInline />
      <audio ref={noVocalsSecRef} preload='metadata' playsInline />

      {bookmarkMenu && (
        <div className='fixed inset-0 z-50 flex flex-col justify-end' onClick={closeBookmarkMenu}>
          <div className='bg-gray-800 rounded-t-2xl shadow-2xl' onClick={e => e.stopPropagation()}>
            <div className='px-5 pt-5 pb-3 border-b border-gray-700/60'>
              <div className='text-sm font-semibold text-white'>{bookmarkMenu.label}</div>
              <div className='text-xs text-gray-400 tabular-nums mt-0.5'>{fmt(bookmarkMenu.time)}</div>
            </div>
            <div className='py-1'>
              <button onClick={() => { seek(bookmarkMenu.time); closeBookmarkMenu() }} className='w-full text-left px-5 py-4 text-sm text-gray-200 active:bg-gray-700'>
                Seek to {bookmarkMenu.label} ({fmt(bookmarkMenu.time)})
              </button>
              <button onClick={() => { setLoopA(bookmarkMenu); closeBookmarkMenu() }} className={`w-full text-left px-5 py-4 text-sm active:bg-gray-700 ${loopStart === bookmarkMenu.time ? 'text-green-400' : 'text-gray-200'}`}>
                {loopStart === bookmarkMenu.time ? '✓ Loop start' : 'Set loop start'}
              </button>
              <button onClick={() => { setLoopB(bookmarkMenu); closeBookmarkMenu() }} className={`w-full text-left px-5 py-4 text-sm active:bg-gray-700 ${loopEnd === bookmarkMenu.time ? 'text-orange-400' : 'text-gray-200'}`}>
                {loopEnd === bookmarkMenu.time ? '✓ Loop end' : 'Set loop end'}
              </button>
              <button onClick={() => openEditFromMenu(bookmarkMenu)} className='w-full text-left px-5 py-4 text-sm text-gray-200 active:bg-gray-700'>
                Edit
              </button>
              <button onClick={() => { handleDeleteBookmark(bookmarkMenu); closeBookmarkMenu() }} className='w-full text-left px-5 py-4 text-sm text-red-400 active:bg-gray-700'>
                Delete
              </button>
            </div>
            <div className='pb-8' />
          </div>
        </div>
      )}

      {gestureMenu && (
        <GestureMenu
          bookmark={gestureMenu.bookmark}
          anchorX={gestureMenu.anchorX}
          touchOrigin={gestureMenu.touchOrigin}
          bottomOffset={gestureMenu.bottomOffset}
          mode='gesture'
          loopStart={loopStart}
          loopEnd={loopEnd}
          onLoopA={(bm) => setLoopA(bm)}
          onLoopB={(bm) => setLoopB(bm)}
          onEdit={(bm) => openEditBookmark(bm)}
          onDelete={(bm) => handleDeleteBookmark(bm)}
          onClose={closeGestureMenu}
        />
      )}

      {editingBookmark && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/60' onClick={closeEditBookmark}>
          <div className='bg-gray-800 rounded-xl p-5 w-72 shadow-2xl' onClick={e => e.stopPropagation()}>
            <h3 className='text-sm font-semibold text-white mb-4'>Edit bookmark</h3>
            <input
              autoFocus
              value={editLabel}
              onChange={e => setEditLabel(e.target.value)}
              onKeyDown={handleEditKeyDown}
              placeholder='Label…'
              className='w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-500 outline-none focus:border-gray-400 mb-4'
            />
            <div className='flex items-center gap-2 mb-5'>
              <span className='text-xs text-gray-400 shrink-0'>Time</span>
              <div className='flex items-center gap-1 flex-1 justify-center'>
                {[-5, -1, 1, 5].map(d => (
                  <button
                    key={d}
                    onClick={() => nudgeTime(d)}
                    className='text-xs px-2 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors tabular-nums'
                  >{d > 0 ? `+${d}s` : `${d}s`}</button>
                ))}
              </div>
              <span className='text-xs text-white tabular-nums w-8 text-right'>{fmt(editTime)}</span>
            </div>
            <div className='flex gap-2'>
              <button onClick={closeEditBookmark} className='flex-1 text-sm py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors'>Cancel</button>
              <button onClick={handleSaveBookmark} className='flex-1 text-sm py-2 rounded-lg bg-white text-gray-900 hover:bg-gray-200 font-medium transition-colors'>Save</button>
            </div>
          </div>
        </div>
      )}

      {editingCue && (
        <div className='fixed inset-0 z-[60] flex items-center justify-center bg-black/60' onClick={closeEditCue}>
          <div className='bg-gray-800 rounded-xl p-5 w-80 shadow-2xl' onClick={e => e.stopPropagation()}>
            <h3 className='text-sm font-semibold text-white mb-4'>Edit cue</h3>
            <input
              autoFocus
              value={editCueLabel}
              onChange={e => setEditCueLabel(e.target.value)}
              onKeyDown={handleEditCueKeyDown}
              placeholder='Label…'
              className='w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-500 outline-none focus:border-gray-400 mb-4'
            />
            <div className='flex items-center gap-2 mb-3'>
              <span className='text-xs text-gray-400 w-8 shrink-0'>Start</span>
              <div className='flex items-center gap-1 flex-1 justify-center'>
                {[-5, -1, 1, 5].map(d => (
                  <button key={d} onClick={() => nudgeCueStart(d)} className='text-xs px-2 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors tabular-nums'>
                    {d > 0 ? `+${d}s` : `${d}s`}
                  </button>
                ))}
              </div>
              <span className='text-xs text-white tabular-nums w-10 text-right'>{fmt(editCueStart)}</span>
            </div>
            <div className='flex items-center gap-2 mb-5'>
              <span className='text-xs text-gray-400 w-8 shrink-0'>End</span>
              {editCueEnd === null ? (
                <div className='flex-1 flex items-center gap-2'>
                  <span className='text-xs text-gray-500 flex-1 italic'>until song ends</span>
                  <button onClick={() => setEditCueEnd(editCueStart + 30)} className='text-xs px-2 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors'>Set</button>
                </div>
              ) : (
                <>
                  <div className='flex items-center gap-1 flex-1 justify-center'>
                    {[-5, -1, 1, 5].map(d => (
                      <button key={d} onClick={() => nudgeCueEnd(d)} className='text-xs px-2 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors tabular-nums'>
                        {d > 0 ? `+${d}s` : `${d}s`}
                      </button>
                    ))}
                  </div>
                  <span className='text-xs text-white tabular-nums w-10 text-right'>{fmt(editCueEnd)}</span>
                  <button onClick={() => setEditCueEnd(null)} className='text-xs text-gray-500 hover:text-white transition-colors leading-none' title='Clear end time'>✕</button>
                </>
              )}
            </div>
            <div className='flex gap-2'>
              <button onClick={closeEditCue} className='flex-1 text-sm py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors'>Cancel</button>
              <button onClick={handleSaveCue} disabled={!editCueLabel.trim()} className='flex-1 text-sm py-2 rounded-lg bg-white text-gray-900 hover:bg-gray-200 font-medium transition-colors disabled:opacity-40'>Save</button>
            </div>
          </div>
        </div>
      )}

      {mashupPanelOpen && (
        <div className='fixed inset-0 z-50 flex flex-col justify-end' onClick={closeMashupPanel}>
          <div className='bg-gray-800 rounded-t-2xl shadow-2xl max-h-[80vh] flex flex-col' onClick={e => e.stopPropagation()}>
            <div className='px-5 pt-5 pb-3 border-b border-gray-700/60 flex items-center justify-between shrink-0'>
              <h2 className='text-sm font-semibold text-white'>Mashups</h2>
              <button onClick={closeMashupPanel} className='text-gray-500 hover:text-white text-lg leading-none px-1'>✕</button>
            </div>

            {creatingMashup ? (
              <div className='px-5 py-4 space-y-3'>
                <p className='text-xs text-gray-400 font-medium uppercase tracking-wide'>New mashup</p>
                {!localStorage.getItem('mashup-author') && (
                  <input
                    autoFocus
                    value={newMashupAuthor}
                    onChange={e => setNewMashupAuthor(e.target.value)}
                    onKeyDown={handleCreateKeyDown}
                    placeholder='Your name…'
                    className='w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-500 outline-none focus:border-gray-400'
                  />
                )}
                <input
                  autoFocus={!!localStorage.getItem('mashup-author')}
                  value={newMashupName}
                  onChange={e => setNewMashupName(e.target.value)}
                  onKeyDown={handleCreateKeyDown}
                  placeholder='Mashup name…'
                  className='w-full text-sm bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-white placeholder-gray-500 outline-none focus:border-gray-400'
                />
                <div className='flex gap-2 pt-1'>
                  <button onClick={() => setCreatingMashup(false)} className='flex-1 text-sm py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors'>Cancel</button>
                  <button onClick={handleCreateMashup} disabled={!newMashupName.trim()} className='flex-1 text-sm py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-medium transition-colors disabled:opacity-40'>Create</button>
                </div>
              </div>
            ) : (
              <div className='overflow-y-auto flex-1'>
                {activeMashup && (
                  <div className='px-5 py-4 border-b border-gray-700/40'>
                    <div className='flex items-start justify-between mb-3 gap-3'>
                      <div className='min-w-0 flex-1'>
                        {renamingMashup ? (
                          <div className='flex items-center gap-1.5'>
                            <input
                              autoFocus
                              value={renameInput}
                              onChange={e => setRenameInput(e.target.value)}
                              onKeyDown={handleRenameKeyDown}
                              className='flex-1 min-w-0 text-sm bg-gray-700 border border-gray-500 rounded-lg px-2 py-1 text-white outline-none focus:border-gray-300'
                            />
                            <button onClick={handleRenameMashup} disabled={!renameInput.trim()} className='text-xs text-green-400 hover:text-green-300 disabled:opacity-40 shrink-0'>✓</button>
                            <button onClick={() => setRenamingMashup(false)} className='text-xs text-gray-500 hover:text-gray-300 shrink-0'>✕</button>
                          </div>
                        ) : (
                          <button onClick={startRenameMashup} className='text-left group w-full min-w-0'>
                            <div className='text-sm font-semibold text-white truncate group-hover:text-gray-200'>
                              {activeMashup.name} <span className='text-gray-600 group-hover:text-gray-400 font-normal text-xs'>✎</span>
                            </div>
                            <div className='text-xs text-gray-400'>by {activeMashup.author}</div>
                          </button>
                        )}
                      </div>
                      <div className='flex gap-2 shrink-0'>
                        {mashupPlaying ? (
                          <button onClick={stopMashup} className='text-xs px-3 py-1.5 rounded-lg border border-red-800/60 bg-red-900/30 text-red-400 transition-colors'>Stop</button>
                        ) : (
                          <button
                            onClick={() => { playMashupFromStart(); closeMashupPanel() }}
                            disabled={activeMashup.cues.length === 0}
                            className='text-xs px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors disabled:opacity-40'
                          >Play</button>
                        )}
                        <button onClick={() => handleDeleteMashup(activeMashup)} className='text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-500 hover:text-red-400 hover:border-red-800/60 transition-colors'>Delete</button>
                      </div>
                    </div>
                    {activeMashup.cues.length === 0 ? (
                      <p className='text-xs text-gray-500 py-1'>No cues yet — play a song and tap "Mark cue" below the player.</p>
                    ) : (
                      <div className='flex flex-col gap-1.5'>
                        {dragging?.dropIdx === 0 && <div className='h-0.5 bg-purple-500 rounded mx-1 shrink-0' />}
                        {activeMashup.cues.map((cue, i) => {
                          const isDragging = dragging?.fromIdx === i
                          return (
                            <Fragment key={cue.id}>
                              <div
                                data-cueidx={i}
                                className={[
                                  'flex items-center gap-2 text-xs rounded-lg px-2 py-2 select-none',
                                  mashupPlaying && mashupCueIdx === i ? 'bg-purple-900/50 ring-1 ring-purple-700/60' : 'bg-gray-700/60',
                                  isDragging ? 'opacity-30 pointer-events-none' : '',
                                ].join(' ')}
                              >
                                <span
                                  className='text-gray-600 hover:text-gray-400 px-1 shrink-0 cursor-grab active:cursor-grabbing text-sm leading-none'
                                  style={{ touchAction: 'none' }}
                                  onPointerDown={e => startCueDrag(i, e)}
                                >⠿</span>
                                <span className='text-gray-500 w-4 tabular-nums shrink-0'>{i + 1}</span>
                                <span className={`flex-1 truncate ${mashupPlaying && mashupCueIdx === i ? 'text-purple-200' : 'text-gray-300'}`}>{cue.label}</span>
                                <span className='text-gray-500 tabular-nums shrink-0'>
                                  {fmt(cue.time)}{cue.endTime != null ? `–${fmt(cue.endTime)}` : ''}
                                </span>
                                <button onClick={() => { jumpToMashupCue(i); closeMashupPanel() }} className='text-gray-500 hover:text-white px-1 shrink-0' aria-label='Jump to cue'>▶</button>
                                <button onClick={() => openEditCue(cue)} className='text-gray-500 hover:text-white px-1 shrink-0' aria-label='Edit cue'>✎</button>
                                <button onClick={() => removeMashupCue(cue.id)} className='text-gray-600 hover:text-red-400 px-1 shrink-0' aria-label='Remove cue'>✕</button>
                              </div>
                              {dragging?.dropIdx === i + 1 && <div className='h-0.5 bg-purple-500 rounded mx-1 shrink-0' />}
                            </Fragment>
                          )
                        })}
                        {mashupUndoMsg && (
                          <div className='flex items-center justify-center gap-2 pt-1 text-xs text-gray-400'>
                            <span>{mashupUndoMsg}</span>
                            <button onClick={handleUndoMashupAction} className='text-blue-400 hover:text-blue-300 font-medium'>Undo</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className='px-5 py-3 border-b border-gray-700/40'>
                  <div className='flex items-center justify-between'>
                    <span className='text-xs text-gray-400 font-medium uppercase tracking-wide'>Crossfade</span>
                    <button
                      onClick={() => { const next = !crossfadeEnabled; setCrossfadeEnabled(next); localStorage.setItem('mashup-fade-enabled', String(next)) }}
                      className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${crossfadeEnabled ? 'border-purple-600 text-purple-400' : 'border-gray-600 text-gray-500'}`}
                    >{crossfadeEnabled ? 'On' : 'Off'}</button>
                  </div>
                  {crossfadeEnabled && (
                    <div className='mt-2.5 flex items-center gap-3'>
                      <input
                        type='range' min={300} max={5000} step={100}
                        value={fadeDuration}
                        onChange={e => { const v = parseInt(e.target.value); setFadeDuration(v); localStorage.setItem('mashup-fade-ms', String(v)) }}
                        className='flex-1 h-1 accent-purple-500 cursor-pointer'
                      />
                      <span className='text-xs text-gray-400 tabular-nums w-10 text-right'>{(fadeDuration / 1000).toFixed(1)}s</span>
                    </div>
                  )}
                </div>

                <div className='px-5 py-4'>
                  <div className='flex items-center justify-between mb-3'>
                    <p className='text-xs text-gray-400 font-medium uppercase tracking-wide'>
                      {activeMashup ? 'Other mashups' : 'Saved mashups'}
                    </p>
                    <button onClick={() => setCreatingMashup(true)} className='text-xs text-purple-400 hover:text-purple-300 transition-colors'>+ New</button>
                  </div>
                  {mashups.filter(m => m._id !== activeMashupId).length === 0 ? (
                    <p className='text-xs text-gray-500'>{activeMashup ? 'No other mashups.' : 'No mashups yet.'}</p>
                  ) : (
                    <div className='space-y-0.5'>
                      {mashups.filter(m => m._id !== activeMashupId).map(m => (
                        <div key={m._id} className='flex items-center gap-3 py-2.5 border-b border-gray-700/30 last:border-0'>
                          <button onClick={() => selectMashup(m._id)} className='flex-1 text-left min-w-0'>
                            <div className='text-sm text-gray-200 truncate'>{m.name}</div>
                            <div className='text-xs text-gray-500'>by {m.author} · {m.cues.length} cue{m.cues.length !== 1 ? 's' : ''}</div>
                          </button>
                          <button onClick={() => handleDeleteMashup(m)} className='text-xs text-gray-600 hover:text-red-400 transition-colors shrink-0 px-1'>Delete</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className='pb-8 shrink-0' />
          </div>
        </div>
      )}

      <header className='sticky top-0 z-10 bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center justify-between gap-3'>
        <h1 onClick={handleTitleTap} className='text-base font-bold text-white shrink-0 select-none'>
          {buildDateLabel ?? 'Camberwell Showtime Music Archive'}
        </h1>
        <div className='flex items-center gap-2'>
          {'wakeLock' in navigator && (
            <button
              onClick={toggleWakeLock}
              title={wakeLockActive ? 'Screen stay-on: on' : 'Screen stay-on: off'}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${wakeLockActive ? 'border-amber-500 text-amber-400' : 'border-gray-600 text-gray-500 hover:text-white hover:border-gray-400'}`}
            >☀</button>
          )}
          <button
            onClick={() => mashupPanelOpen ? closeMashupPanel() : openMashupPanel()}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${(mashupPanelOpen || mashupPlaying) ? 'border-purple-500 text-purple-400' : 'border-gray-600 text-gray-500 hover:text-white hover:border-gray-400'}`}
          >
            Mashups
          </button>
        </div>
      </header>

      <main className='flex-1 overflow-y-auto' style={{ paddingBottom: currentSong ? playerHeight : 0 }}>
        {!browsingShowId ? (
          <div>
            {catalog === null ? (
              <p className='text-gray-500 text-sm px-4 py-6'>Loading catalog…</p>
            ) : (
              catalog.shows.map(show => {
                const dl = showDownloadStatus[show.id]
                return (
                  <div
                    key={show.id}
                    className='flex items-center gap-3 px-4 py-3.5 border-b border-gray-800/60 cursor-pointer select-none hover:bg-gray-900 transition-colors'
                    onClick={() => enterShow(show.id)}
                  >
                    <span className='text-gray-500 text-sm w-14 shrink-0 tabular-nums'>{show.year ?? '—'}</span>
                    <span className='flex-1 text-sm text-gray-200'>{show.title}</span>
                    <span className='text-gray-600 text-xs shrink-0'>{show.songs.length}</span>
                    {'caches' in window && (
                      <button
                        onClick={e => downloadShow(e, show)}
                        disabled={dl?.state === 'downloading'}
                        aria-label={`Download all songs from ${show.title}`}
                        title={
                          dl?.state === 'downloading' ? `Downloading… ${dl.done}/${dl.total}`
                          : dl?.state === 'done' ? 'All songs downloaded'
                          : dl?.state === 'error' ? 'Some downloads failed — tap to retry'
                          : `Download all ${show.songs.length} songs`
                        }
                        className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs transition-colors ${dl?.state === 'error' ? 'text-red-400 hover:text-red-300' : 'text-gray-500 hover:text-white hover:bg-gray-800'}`}
                      >
                        {dl?.state === 'downloading' ? (
                          <span className='w-3 h-3 rounded-full border-2 border-gray-500 border-t-white animate-spin' />
                        ) : dl?.state === 'done' ? '✓' : dl?.state === 'error' ? '⚠' : '⬇'}
                      </button>
                    )}
                  </div>
                )
              })
            )}
          </div>
        ) : (
          <div>
            <div className='flex items-center gap-3 px-4 py-3 border-b border-gray-800/60 sticky top-0 bg-gray-950'>
              <button onClick={exitShow} className='text-gray-400 hover:text-white transition-colors text-sm shrink-0'>← Shows</button>
              <span className='text-sm text-gray-300 font-medium truncate'>{browsingShow?.title}</span>
            </div>
            {browsingShowSongs.map(song => {
              const isActive = song.id === currentId
              const status = downloadStatus[song.id]
              return (
                <div
                  key={song.id}
                  className={`flex items-center gap-3 px-4 py-3.5 border-b border-gray-800/60 cursor-pointer select-none transition-colors ${isActive ? 'bg-gray-800' : 'hover:bg-gray-900'}`}
                  onClick={() => playSong(song)}
                >
                  <span className={`flex-1 text-sm ${isActive ? 'text-white font-medium' : 'text-gray-200'}`}>
                    {song.title}
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); shareSong(song, browsingShow) }}
                    className='text-gray-500 hover:text-white transition-colors text-base leading-none shrink-0'
                    aria-label={copiedSongId === song.id ? 'Link copied' : 'Copy link to this track'}
                    title={copiedSongId === song.id ? 'Link copied!' : 'Copy link to this track'}
                  >
                    {copiedSongId === song.id ? '✓' : '🔗'}
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); downloadSong(song) }}
                    disabled={status === 'downloading' || status === 'done'}
                    className='text-gray-500 hover:text-white disabled:hover:text-gray-500 transition-colors text-base leading-none shrink-0'
                    aria-label={status === 'done' ? 'Downloaded for offline playback' : 'Download for offline playback'}
                    title={
                      status === 'done' ? 'Downloaded for offline playback'
                      : status === 'downloading' ? 'Downloading…'
                      : status === 'error' ? 'Download failed — tap to retry'
                      : 'Download for offline playback'
                    }
                  >
                    {status === 'downloading' ? (
                      <span className='inline-block w-3.5 h-3.5 rounded-full border-2 border-gray-500 border-t-white animate-spin align-middle' />
                    ) : status === 'done' ? '✓'
                      : status === 'error' ? '⚠'
                      : '⬇'}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </main>

      {mashupPlaying && activeMashup && (() => {
        const cues = activeMashup.cues
        let totalSecs = 0, hasUnknown = false
        for (const c of cues) {
          if (c.endTime != null) {
            totalSecs += c.endTime - c.time
          } else {
            const songDur = songDurationsRef.current[c.songId]
            if (songDur) totalSecs += songDur - c.time
            else hasUnknown = true
          }
        }
        const durStr = (cues.length > 0 && totalSecs > 0) ? (hasUnknown ? `~${fmt(totalSecs)}+` : fmt(totalSecs)) : null
        return (
        <div className='fixed inset-0 z-20 bg-gray-950 flex flex-col' style={{ paddingBottom: playerHeight }}>
          <div className='px-4 py-3 bg-gray-900 border-b border-purple-900/50 flex items-center gap-3 shrink-0'>
            <div className='flex-1 min-w-0'>
              <div className='text-[10px] text-purple-400 font-medium uppercase tracking-widest'>Mashup</div>
              {renamingMashup ? (
                <div className='flex items-center gap-1.5 mt-0.5'>
                  <input
                    autoFocus
                    value={renameInput}
                    onChange={e => setRenameInput(e.target.value)}
                    onKeyDown={handleRenameKeyDown}
                    className='flex-1 min-w-0 text-sm bg-gray-800 border border-gray-600 rounded-lg px-2 py-1 text-white outline-none focus:border-gray-400'
                  />
                  <button onClick={handleRenameMashup} disabled={!renameInput.trim()} className='text-xs text-green-400 hover:text-green-300 disabled:opacity-40 shrink-0'>✓</button>
                  <button onClick={() => setRenamingMashup(false)} className='text-xs text-gray-500 hover:text-gray-300 shrink-0'>✕</button>
                </div>
              ) : (
                <button onClick={startRenameMashup} className='text-left group w-full min-w-0'>
                  <div className='text-white font-bold text-base leading-tight truncate group-hover:text-gray-200'>
                    {activeMashup.name} <span className='text-gray-600 group-hover:text-gray-400 font-normal text-xs'>✎</span>
                  </div>
                </button>
              )}
              <div className='text-xs text-gray-500 leading-tight'>
                by {activeMashup.author}{durStr ? <span className='ml-2 tabular-nums'>{durStr}</span> : null}
              </div>
            </div>
            <button
              onClick={stopMashup}
              className='shrink-0 text-xs px-3 py-1.5 rounded-lg border border-red-800/60 bg-red-900/20 text-red-400 hover:bg-red-900/40 transition-colors'
            >Stop</button>
          </div>
          <div className='flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-1.5'>
            {dragging?.dropIdx === 0 && <div className='h-0.5 bg-purple-500 rounded mx-1 shrink-0' />}
            {activeMashup.cues.map((cue, i) => {
              const isActive = mashupCueIdx === i
              const isPast = i < mashupCueIdx
              const isDragging = dragging?.fromIdx === i
              return (
                <Fragment key={cue.id}>
                  <div
                    data-cueidx={i}
                    ref={isActive ? activeCueRef : null}
                    onClick={() => !dragging && jumpToMashupCue(i)}
                    className={[
                      'flex items-center gap-2 px-2 py-2.5 rounded-xl transition-colors cursor-pointer select-none',
                      isActive ? 'bg-purple-900/50 ring-1 ring-purple-700/60' : isPast ? 'bg-gray-800/20 opacity-40' : 'bg-gray-800/40 hover:bg-gray-700/50',
                      isDragging ? 'opacity-30 pointer-events-none' : '',
                    ].join(' ')}
                  >
                    <span
                      className='text-gray-600 hover:text-gray-400 px-1 shrink-0 cursor-grab active:cursor-grabbing text-base leading-none'
                      style={{ touchAction: 'none' }}
                      onPointerDown={e => startCueDrag(i, e)}
                      onClick={e => e.stopPropagation()}
                    >⠿</span>
                    <span className={`text-xs tabular-nums w-5 shrink-0 text-right ${isActive ? 'text-purple-400 font-bold' : 'text-gray-600'}`}>{i + 1}</span>
                    <span className={`flex-1 text-sm truncate ${isActive ? 'text-white font-medium' : 'text-gray-400'}`}>{cue.label}</span>
                    <span className={`text-xs tabular-nums shrink-0 ${isActive ? 'text-purple-300' : 'text-gray-600'}`}>
                      {fmt(cue.time)}{cue.endTime != null ? `–${fmt(cue.endTime)}` : ''}
                    </span>
                    <button onClick={e => { e.stopPropagation(); openEditCue(cue) }} className='text-gray-600 hover:text-white px-1 shrink-0 transition-colors' aria-label='Edit cue'>✎</button>
                    <button onClick={e => { e.stopPropagation(); removeMashupCue(cue.id) }} className='text-gray-600 hover:text-red-400 px-1 shrink-0 transition-colors' aria-label='Remove cue'>✕</button>
                  </div>
                  {dragging?.dropIdx === i + 1 && <div className='h-0.5 bg-purple-500 rounded mx-1 shrink-0' />}
                </Fragment>
              )
            })}
            {mashupUndoMsg && (
              <div className='flex items-center justify-center gap-2 py-2 text-xs text-gray-400'>
                <span>{mashupUndoMsg}</span>
                <button onClick={handleUndoMashupAction} className='text-blue-400 hover:text-blue-300 font-medium'>Undo</button>
              </div>
            )}
          </div>
        </div>
        )
      })()}

      {currentSong && (
        <div ref={playerBarRef} className='fixed bottom-0 left-0 right-0 z-30 bg-gray-900 border-t border-gray-700 shadow-2xl'>
        <div className='px-4 pt-3 pb-[max(20px,env(safe-area-inset-bottom))] space-y-2.5'>
          <div className='flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3'>
            {mashupPlaying && activeMashup ? (
              <div className='min-w-0'>
                <div className='text-[10px] text-purple-400 font-medium uppercase tracking-widest'>Mashup</div>
                <div className='text-white font-semibold text-sm leading-tight truncate'>{activeMashup.name}</div>
              </div>
            ) : (
              <div className='min-w-0'>
                <div className='text-xs text-gray-500 truncate'>{playingShow?.title}</div>
                <div className='text-white font-semibold text-sm leading-tight truncate'>{currentSong.title}</div>
              </div>
            )}
            <div className='flex items-center gap-2 shrink-0'>
              {activeMashup && !mashupPlaying && (
                <button
                  onClick={markCueHere}
                  className='text-xs px-2.5 py-1.5 rounded-lg border border-purple-600 text-purple-400 hover:bg-purple-900/30 transition-colors whitespace-nowrap'
                  title={`Mark cue here in "${activeMashup.name}"`}
                >
                  + Mark cue
                </button>
              )}
              <div className='flex rounded-lg overflow-hidden border border-gray-600 text-xs'>
                <button
                  onClick={() => switchMode('vocals')}
                  className={`px-2 py-1.5 sm:px-3 transition-colors ${mode === 'vocals' ? 'bg-white text-gray-900 font-semibold' : 'text-gray-400 hover:text-white'}`}
                >
                  Vocals
                </button>
                <button
                  onClick={() => switchMode('no-vocals')}
                  disabled={!currentSong.noVocalsFile}
                  title={currentSong.noVocalsFile ? undefined : 'No instrumental version available for this song'}
                  className={`px-2 py-1.5 sm:px-3 transition-colors ${mode === 'no-vocals' ? 'bg-white text-gray-900 font-semibold' : currentSong.noVocalsFile ? 'text-gray-400 hover:text-white' : 'text-gray-600 cursor-not-allowed'}`}
                >
                  No vocals
                </button>
              </div>
            </div>
          </div>

          {trackError && (
            <div className='flex items-center justify-center gap-2 -mt-1'>
              <span className='text-xs text-red-400'>Playback failed</span>
              <button onClick={copyDiagnostics} className='text-xs text-gray-500 hover:text-white transition-colors leading-none underline'>
                {diagCopied ? 'Copied!' : 'Copy details'}
              </button>
            </div>
          )}

          <div className='flex items-center gap-2'>
            <span className='text-xs text-gray-500 tabular-nums w-9 text-right'>{fmt(currentTime)}</span>
            <input
              type='range'
              min={0}
              max={duration || 0}
              step={0.1}
              value={currentTime}
              onChange={e => seek(Number(e.target.value))}
              className='flex-1 h-1 accent-white cursor-pointer'
            />
            <span className='text-xs text-gray-500 tabular-nums w-9'>{fmt(duration)}</span>
          </div>

          {mashupPlaying && activeMashup && (
            <div className='flex items-center justify-center gap-2 -mt-1'>
              <span className='text-xs text-purple-400 tabular-nums shrink-0'>{mashupCueIdx + 1}/{activeMashup.cues.length}</span>
              <span className='text-xs text-purple-300 truncate max-w-[180px]'>{activeMashup.cues[mashupCueIdx]?.label ?? ''}</span>
              <button onClick={stopMashup} className='text-xs text-gray-500 hover:text-white transition-colors leading-none shrink-0'>✕</button>
            </div>
          )}

          {loopActive && !mashupPlaying && (
            <div className='flex items-center justify-center gap-2 -mt-1'>
              <span className='text-xs text-blue-400 tabular-nums'>
                ↺ {loopStart !== null ? (loopStartLabel ?? fmt(loopStart)) : '?'} → {loopEnd !== null ? (loopEndLabel ?? fmt(loopEnd)) : '?'}
              </span>
              <button onClick={clearLoop} className='text-xs text-gray-500 hover:text-white transition-colors leading-none'>✕</button>
            </div>
          )}

          <div className='flex items-center gap-4'>
            <div className='flex items-center gap-3 shrink-0'>
              <button
                onClick={mashupPlaying ? () => jumpToMashupCue(mashupCueIdx - 1) : prevSong}
                disabled={mashupPlaying ? mashupCueIdx <= 0 : currentIdx <= 0}
                className='text-gray-400 hover:text-white disabled:opacity-25 transition-colors' aria-label='Previous'>⏮</button>
              <button
                onClick={mashupPlaying ? () => seekInMashupRef.current(-5) : () => seek(Math.max(0, currentTime - 5))}
                disabled={!currentSong}
                className='text-gray-400 hover:text-white disabled:opacity-25 transition-colors text-xs tabular-nums'
                aria-label='Rewind 5 seconds'
              >−5s</button>
              <button
                onClick={togglePlay}
                className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${trackError ? 'bg-red-600 text-white hover:bg-red-500' : 'bg-white text-gray-900 hover:bg-gray-200'}`}
                aria-label={trackError ? 'Retry' : isPlaying ? 'Pause' : 'Play'}
                title={trackError ? 'Failed to load — tap to retry' : undefined}
              >
                {trackError ? '↻' : buffering ? (
                  <span className='w-3.5 h-3.5 rounded-full border-2 border-gray-400 border-t-gray-900 animate-spin' />
                ) : isPlaying ? '⏸' : '▶'}
              </button>
              <button
                onClick={mashupPlaying ? () => seekInMashupRef.current(5) : () => seek(Math.min(duration, currentTime + 5))}
                disabled={!currentSong}
                className='text-gray-400 hover:text-white disabled:opacity-25 transition-colors text-xs tabular-nums'
                aria-label='Skip forward 5 seconds'
              >+5s</button>
              <button
                onClick={mashupPlaying ? () => jumpToMashupCue(mashupCueIdx + 1) : nextSong}
                disabled={mashupPlaying ? mashupCueIdx >= (activeMashup?.cues.length ?? 1) - 1 : currentIdx >= playingShowSongs.length - 1}
                className='text-gray-400 hover:text-white disabled:opacity-25 transition-colors' aria-label='Next'>⏭</button>
              <button onClick={clearLoop} className={`text-base transition-colors ${loopActive ? 'text-blue-400' : 'text-gray-500 hover:text-white'}`} aria-label='Clear loop'>↺</button>
            </div>

            <div className='flex-1 flex items-center gap-1.5 overflow-x-auto min-w-0' style={{ scrollbarWidth: 'none' }}>
              {bookmarks.map(bm => (
                <BookmarkPill
                  key={bm._id}
                  bm={bm}
                  loopStart={loopStart}
                  loopEnd={loopEnd}
                  onSeek={seek}
                  onMenu={openBookmarkMenu}
                  onGesture={openGestureMenu}
                />
              ))}
              {pendingDeleteId ? (
                <span className='flex items-center gap-1.5 text-xs text-gray-400'>
                  <span>Removed</span>
                  <button onClick={handleUndoDelete} className='text-blue-400 hover:text-blue-300 font-medium'>Undo</button>
                </span>
              ) : addingBookmark ? (
                <div className='flex items-center gap-1'>
                  <input
                    autoFocus
                    value={labelInput}
                    onChange={e => setLabelInput(e.target.value)}
                    onKeyDown={handleBookmarkKeyDown}
                    placeholder='Name…'
                    className='text-xs bg-gray-800 border border-gray-600 rounded px-2 py-1 w-24 text-white placeholder-gray-500 outline-none focus:border-gray-400'
                  />
                  <button onClick={handleAddBookmark} className='text-xs text-green-400 hover:text-green-300 px-1'>✓</button>
                  <button onClick={() => { setAddingBookmark(false); setLabelInput('') }} className='text-xs text-gray-500 hover:text-gray-300 px-1'>✕</button>
                </div>
              ) : (
                <button onClick={() => setAddingBookmark(true)} className='text-xs text-gray-600 hover:text-gray-300 transition-colors whitespace-nowrap'>
                  + bookmark
                </button>
              )}
            </div>
          </div>
        </div>
        </div>
      )}
    </div>
  )
}
