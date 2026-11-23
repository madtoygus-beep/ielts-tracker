import { useNavigate } from 'react-router-dom'
import { useStudentSpeakingLibrary } from '../../hooks/useStudentSpeakingLibrary'
import { openSpeakingHomework } from '../../services/speakingHomework'
import StudentSpeakingAssignments from './StudentSpeakingAssignments'

export default function SpeakingHomeworkSection({ user, api, onOpen, onReport, onLibrary, mode = 'all' }) {
  const navigate = useNavigate()
  const data = useStudentSpeakingLibrary(user?.uid, api)
  return <StudentSpeakingAssignments data={data} mode={mode}
    onStart={item => onOpen ? onOpen(item) : openSpeakingHomework(item, user.uid, navigate)}
    onReport={id => onReport ? onReport(id) : navigate(`/speaking?report=${encodeURIComponent(id)}`)}>
    <button type="button" onClick={() => onLibrary ? onLibrary() : navigate('/speaking')} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs text-slate-600 hover:text-indigo-700">All Speaking &amp; feedback →</button>
  </StudentSpeakingAssignments>
}
