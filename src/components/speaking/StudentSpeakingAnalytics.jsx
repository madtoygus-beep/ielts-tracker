import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { speakingApi } from '../../services/speakingApi'
import { loadTeacherSpeakingHomework } from '../../services/teacherSpeakingHomework'
import SpeakingAnalytics from './SpeakingAnalytics'
export default function StudentSpeakingAnalytics({ user }) {
  const navigate = useNavigate()
  const [data, setData] = useState({ tasks: [], attempts: [], uid: '', loading: true, error: '' })
  useEffect(() => {
    let active = true
    if (!user?.uid) return
    loadTeacherSpeakingHomework(speakingApi, false).then(result => {
      if (active) setData({ ...result, uid: user.uid, loading: false, error: '' })
    }).catch(() => {
      if (active) setData({ tasks: [], attempts: [], uid: user.uid, loading: false, error: 'Speaking analytics could not be loaded. Refresh to retry.' })
    })
    return () => { active = false }
  }, [user?.uid])
  const visible = data.uid === user?.uid ? data : { tasks: [], attempts: [], loading: true, error: '' }
  return <SpeakingAnalytics data={visible} onOpen={attempt => navigate(`/speaking?report=${encodeURIComponent(attempt.id)}`)}/>
}
