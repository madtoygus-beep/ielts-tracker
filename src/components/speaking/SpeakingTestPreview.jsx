import { useState } from 'react'
import SpeakingTestLayout from './SpeakingTestLayout'
import { speakingTime } from '../../services/speakingApi'

export default function SpeakingTestPreview({ config, title }) {
  const [index, setIndex] = useState(0)
  const questions = Array.isArray(config?.questions) ? config.questions : []
  const question = questions[index] || questions[0]
  if (!question) return <p className="rounded-2xl border border-gray-100 bg-white p-6 text-sm text-gray-500">No Speaking questions are available.</p>

  return <SpeakingTestLayout
    title={title} questions={questions} question={question} questionIndex={index}
    isMock status="Teacher preview" timer={speakingTime(question.seconds || 120)}
    onSelectQuestion={setIndex} rightTitle="Recording area"
    footer="Preview only · no microphone, recordings or submissions."
  >
    <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-5 py-10 text-center">
      <p className="font-semibold text-gray-800">Your answer</p>
      <p className="mt-3 text-sm leading-6 text-gray-500">In the student test, the microphone and recording controls appear here. Questions progress automatically.</p>
      <p className="mt-4 text-sm font-medium text-purple-700">{question.part === 2 ? '60 seconds preparation · 60–120 seconds recording' : `${question.seconds} seconds recording`}</p>
    </div>
    <div className="mt-5 flex flex-wrap justify-between gap-3">
      <button type="button" disabled={index === 0} onClick={() => setIndex(value => value - 1)} className="rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-600 disabled:opacity-40">← Previous question</button>
      <button type="button" disabled={index === questions.length - 1} onClick={() => setIndex(value => value + 1)} className="rounded-xl bg-purple-600 px-4 py-3 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-40">Next question →</button>
    </div>
  </SpeakingTestLayout>
}
