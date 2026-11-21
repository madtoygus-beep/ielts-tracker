import { useEffect, useState } from 'react'
import { speakingApi } from '../services/speakingApi'
import { loadTeacherSpeakingHomework } from '../services/teacherSpeakingHomework'
export function useTeacherSpeakingHomework(uid) {
  const [state, setState] = useState({ tasks: [], attempts: [], loading: true, error: '' })
  useEffect(() => {
    let active = true
    if (!uid) return
    loadTeacherSpeakingHomework(speakingApi).then(data => {
      if (active) setState({ ...data, loading: false, error: '' })
    }).catch(() => {
      if (active) setState({ tasks: [], attempts: [], loading: false, error: 'Speaking homework could not be loaded. Refresh to retry.' })
    })
    return () => { active = false }
  }, [uid])
  return state
}
