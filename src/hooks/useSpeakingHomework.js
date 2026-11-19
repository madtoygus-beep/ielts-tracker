import { useEffect, useState } from 'react'
import { speakingApi } from '../services/speakingApi'
import { loadSpeakingHomework } from '../services/speakingHomework'

export function useSpeakingHomework(uid, api = speakingApi) {
  const [state, setState] = useState({ pending: [], total: 0, completed: 0, uid: '', loading: true, error: '' })
  useEffect(() => {
    if (!uid) return
    let active = true, running = false
    const refresh = async () => {
      if (running || document.visibilityState === 'hidden') return
      running = true
      try {
        const result = await loadSpeakingHomework(api)
        if (active) setState({ ...result, uid, loading: false, error: '' })
      } catch (e) {
        if (active) setState(old => ({ ...(old.uid === uid ? old : { pending: [], total: 0, completed: 0 }), uid, loading: false, error: e.message || 'Speaking homework could not be loaded.' }))
      } finally { running = false }
    }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const timer = setInterval(refresh, 60000)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [uid, api])
  return state.uid === uid ? state : { pending: [], total: 0, completed: 0, loading: Boolean(uid), error: '' }
}
