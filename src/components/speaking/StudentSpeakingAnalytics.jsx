import { useNavigate } from 'react-router-dom'
import { useStudentSpeakingLibrary } from '../../hooks/useStudentSpeakingLibrary'
import SpeakingAnalytics from './SpeakingAnalytics'
export default function StudentSpeakingAnalytics({ user, api }) {
  const navigate = useNavigate()
  const data = useStudentSpeakingLibrary(user?.uid, api)
  return <SpeakingAnalytics data={{ ...data, loading: !data.attemptsLoaded && !data.attemptsError }} onOpen={attempt => navigate(`/speaking?report=${encodeURIComponent(attempt.id)}`)}/>
}
