import { useAttemptGeneration } from '../../hooks/useAttemptGeneration'
import { useStudentSpeakingLibrary } from '../../hooks/useStudentSpeakingLibrary'
import SpeakingSession from './SpeakingSession'

export default function MockSpeakingSection({ user, mockId, title, config, onComplete, api, runtime, encode }) {
  const generation = useAttemptGeneration()
  // Reuse the signed-in student's API without fetching their homework/history during the Mock.
  const speaking = useStudentSpeakingLibrary(user?.uid, api, false)
  return <SpeakingSession key={`${mockId}:${generation}`} mockId={mockId} title={title}
    config={config} mode="mock" api={speaking.api} runtime={runtime} encode={encode} onComplete={onComplete}/>
}
