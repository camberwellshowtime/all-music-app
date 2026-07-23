import { useEffect, useRef, useState } from 'react'

const ACTIONS = [
  { id: 'edit',   symbol: '✎', label: 'Edit',       colClass: 'text-blue-400',   activeClass: 'bg-blue-500/20 ring-2 ring-blue-400/60'    },
  { id: 'delete', symbol: '✕', label: 'Delete',     colClass: 'text-red-400',    activeClass: 'bg-red-500/20 ring-2 ring-red-400/60'     },
  { id: 'loopA',  symbol: 'A', label: 'Loop start', colClass: 'text-green-400',  activeClass: 'bg-green-500/20 ring-2 ring-green-400/60'  },
  { id: 'loopB',  symbol: 'B', label: 'Loop end',   colClass: 'text-orange-400', activeClass: 'bg-orange-500/20 ring-2 ring-orange-400/60' },
]

export default function GestureMenu({
  bookmark, anchorX, touchOrigin, bottomOffset, mode,
  loopStart, loopEnd,
  onLoopA, onLoopB, onEdit, onDelete, onClose,
}) {
  const [activeId, setActiveId] = useState(null)
  const activeIdRef = useRef(null)
  const btnRefs = useRef({})
  const cbRef = useRef({})
  cbRef.current = { onLoopA, onLoopB, onEdit, onDelete, onClose }
  const bmRef = useRef(bookmark)
  bmRef.current = bookmark

  const updateActive = (id) => { activeIdRef.current = id; setActiveId(id) }

  const fire = (id) => {
    const { onClose: close, onLoopA: la, onLoopB: lb, onEdit: ed, onDelete: del } = cbRef.current
    close()
    const bm = bmRef.current
    if (id === 'loopA') la(bm)
    else if (id === 'loopB') lb(bm)
    else if (id === 'edit') ed(bm)
    else if (id === 'delete') del(bm)
  }

  useEffect(() => {
    if (mode !== 'gesture') return

    const onMove = (e) => {
      let best = null, bestDist = Infinity
      for (const [id, el] of Object.entries(btnRefs.current)) {
        if (!el) continue
        const r = el.getBoundingClientRect()
        const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2))
        if (d < bestDist) { bestDist = d; best = id }
      }
      const moved = touchOrigin ? Math.hypot(e.clientX - touchOrigin.x, e.clientY - touchOrigin.y) : 0
      updateActive(moved > 25 && bestDist < 80 ? best : null)
    }

    const onUp = () => {
      const id = activeIdRef.current
      if (id) fire(id)
      else cbRef.current.onClose()
    }

    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
    }
  }, [mode, touchOrigin]) // eslint-disable-line react-hooks/exhaustive-deps

  const menuW = 168
  const left = Math.max(8, Math.min((window.innerWidth ?? 400) - menuW - 8, (anchorX ?? 200) - menuW / 2))

  return (
    <>
      {mode === 'tap' && (
        <div className='fixed inset-0 z-40' onClick={onClose} onTouchEnd={onClose} />
      )}
      <div className='fixed z-50' style={{ bottom: bottomOffset ?? 200, left }}>
        <div className='bg-gray-800/95 backdrop-blur-sm border border-gray-700 rounded-2xl shadow-2xl p-2' style={{ width: menuW }}>
          <div className='text-center text-xs text-gray-400 font-medium px-2 py-1.5 border-b border-gray-700/60 mb-2 truncate'>
            {bookmark.label}
          </div>
          {/* Row 1: Edit, Delete (less common, further from finger) */}
          {/* Row 2: Loop A, Loop B (most common, closer to player) */}
          <div className='grid grid-cols-2 gap-1.5'>
            {ACTIONS.map(a => {
              const isActive = activeId === a.id
              const isSet = (a.id === 'loopA' && loopStart === bookmark.time) ||
                            (a.id === 'loopB' && loopEnd === bookmark.time)
              return (
                <button
                  key={a.id}
                  ref={el => { btnRefs.current[a.id] = el }}
                  onClick={mode === 'tap' ? () => fire(a.id) : undefined}
                  className={[
                    'flex flex-col items-center justify-center gap-0.5 h-[60px] rounded-xl transition-all duration-75 select-none',
                    isActive
                      ? `${a.activeClass} scale-105`
                      : `bg-gray-700/60 ring-1 ring-gray-600/50`,
                    isSet && !isActive ? 'ring-1 ring-white/25' : '',
                    mode === 'tap' ? 'active:scale-95' : '',
                  ].join(' ')}
                >
                  <span className={`text-base font-semibold leading-none ${isActive ? 'text-white' : a.colClass}`}>
                    {a.symbol}
                  </span>
                  <span className={`text-[10px] leading-none mt-0.5 ${isActive ? 'text-white' : 'text-gray-500'}`}>
                    {a.label}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
        {/* Down-pointing arrow toward pill */}
        <div className='flex justify-center -mt-px'>
          <div
            className='w-3 h-3 bg-gray-800 border-r border-b border-gray-700 rotate-45'
            style={{ marginTop: -6 }}
          />
        </div>
      </div>
    </>
  )
}
