// Mobile debugging aid, opt-in only via ?debug=1 — adds an on-page DevTools
// (eruda) and logs <audio> element lifecycle events, since neither is
// otherwise visible without plugging the phone into a computer.
export const DEBUG = new URLSearchParams(location.search).has('debug')

export function initDebugConsole() {
  if (!DEBUG || document.getElementById('eruda-script')) return
  const script = document.createElement('script')
  script.id = 'eruda-script'
  script.src = 'https://cdn.jsdelivr.net/npm/eruda'
  script.onload = () => window.eruda?.init()
  document.head.appendChild(script)
}

const EVENTS = ['loadstart', 'waiting', 'stalled', 'canplay', 'playing', 'error', 'abort', 'emptied']

export function logAudioEvents(el, label) {
  if (!DEBUG || !el || el.dataset.debugWired) return
  el.dataset.debugWired = '1'
  for (const type of EVENTS) {
    el.addEventListener(type, () => {
      const info = { readyState: el.readyState, networkState: el.networkState, src: el.currentSrc }
      if (type === 'error' && el.error) info.error = { code: el.error.code, message: el.error.message }
      if (type === 'error') console.error(`[audio:${label}] ${type}`, info)
      else console.log(`[audio:${label}] ${type}`, info)
    })
  }
}
