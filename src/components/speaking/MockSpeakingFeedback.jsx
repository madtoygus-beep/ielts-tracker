import { useState } from 'react'
import { useStudentSpeakingLibrary } from '../../hooks/useStudentSpeakingLibrary'
import SpeakingReport from './SpeakingReport'

export default function MockSpeakingFeedback({ user, attemptId, api }) {
  const [open, setOpen] = useState(false)
  const speaking = useStudentSpeakingLibrary(user?.uid, api, false)
  return <details className="mt-5 overflow-hidden rounded-2xl border border-gray-100 bg-white"
    onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open) }}>
    <summary aria-label="Speaking feedback and recordings" className="cursor-pointer px-5 py-4 font-semibold text-gray-900">Speaking feedback and recordings</summary>
    {open && <div className="border-t border-gray-100 p-4 sm:p-5">
      <SpeakingReport key={attemptId} attemptId={attemptId} api={speaking.api} aiAvailable={speaking.aiAvailable}/>
    </div>}
  </details>
}
