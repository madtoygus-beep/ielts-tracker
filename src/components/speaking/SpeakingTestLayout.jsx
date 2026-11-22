import { speakingPartLabels, speakingParts } from '../../services/speakingExam'

export default function SpeakingTestLayout({
  title, questions = [], question, questionIndex = 0, isMock = false,
  status = 'Microphone check', timer, recording = false, onSelectQuestion,
  rightTitle = 'Your answer', children, complete = false, footer, timedPart2 = false
}) {
  const parts = questions.length ? speakingParts(questions) : isMock ? [1, 2, 3] : []
  const saved = complete ? questions.length : questionIndex

  return <section className="space-y-6" aria-label="Speaking test">
    <div className="rounded-2xl border border-gray-100 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-gray-900">{isMock ? 'Mock Speaking' : 'Speaking practice'}</h2>
          {title && <p className="mt-1 break-words text-sm text-gray-500">{title}</p>}
          <p className="mt-2 text-sm text-gray-500">{isMock
            ? 'Complete Parts 1–3 in order. Questions and recording advance automatically.'
            : 'Read the question, record your answer, then listen back before continuing.'}</p>
        </div>
        <div className={`rounded-xl px-4 py-3 ${recording ? 'bg-red-50 text-red-700' : 'bg-purple-50 text-purple-700'}`}>
          <p className="text-xs font-semibold" role="status">{status}</p>
          {timer != null && <p role="timer" aria-live="off" aria-label="Time remaining" className="mt-1 font-mono text-2xl font-bold tabular-nums">{timer}</p>}
        </div>
      </div>

      {parts.length > 0 && <ol aria-label="Speaking parts" className="mt-5 grid gap-2 sm:grid-cols-3">
        {parts.map(part => {
          const first = questions.findIndex(item => item.part === part)
          const active = question?.part === part && !complete
          const finished = complete || (question && questions.every((item, index) => item.part !== part || index < questionIndex))
          const content = <><span className="block text-xs font-semibold">Part {part}</span><span className="mt-1 block text-xs">{speakingPartLabels[part]}</span></>
          return <li key={part} aria-current={active ? 'step' : undefined} className={`rounded-xl border ${active ? 'border-purple-600 bg-purple-600 text-white' : finished ? 'border-green-100 bg-green-50 text-green-700' : 'border-gray-100 bg-gray-50 text-gray-500'}`}>
            {onSelectQuestion && first >= 0
              ? <button type="button" onClick={() => onSelectQuestion(first)} className="w-full rounded-xl p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500">{content}</button>
              : <div className="p-3">{content}</div>}
          </li>
        })}
      </ol>}
    </div>

    <div className="grid items-start gap-6 lg:grid-cols-2">
      <div className="min-w-0 rounded-2xl border border-gray-100 bg-white p-5 sm:p-6">
        {question ? <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold text-gray-900">{question.part === 2 ? 'Cue card' : 'Question'} {questionIndex + 1}</h3>
            <span className="rounded-full bg-purple-50 px-3 py-1 text-xs font-semibold text-purple-700">PART {question.part}</span>
          </div>
          <div className="min-h-48 rounded-xl border border-gray-100 bg-gray-50 p-5 sm:p-6">
            <p className="whitespace-pre-wrap break-words text-lg leading-8 text-gray-800">{question.text}</p>
          </div>
          <p className="mt-4 text-sm leading-6 text-gray-500">{question.part === 2
            ? isMock || timedPart2
              ? 'You have one minute to prepare. Speak for one to two minutes, covering the points on the cue card.'
              : 'Use the points on the cue card to plan your answer. Record when you are ready, then listen back before saving.'
            : question.part === 3
              ? 'Discuss the question in detail. Explain your ideas and support them with reasons or examples.'
              : 'Answer the question about yourself. Give a reason or a short example where you can.'}</p>
        </> : <>
          <h3 className="font-semibold text-gray-900">{complete ? 'Speaking complete' : 'Before you start'}</h3>
          <p className="mt-3 text-sm leading-6 text-gray-500">{complete
            ? 'Your answers have been saved. You can listen to the recordings in your Speaking report.'
            : 'Choose a quiet place and check your microphone. Once you start, the current question and your recording controls appear here.'}</p>
          <div className="mt-5 space-y-3">
            {parts.map(part => <div key={part} className="rounded-xl border border-gray-100 bg-gray-50 p-4">
              <p className="text-sm font-semibold text-gray-800">Part {part} · {speakingPartLabels[part]}</p>
              <p className="mt-1 text-xs leading-5 text-gray-500">{part === 2
                ? isMock || timedPart2 ? '1 minute preparation · 1–2 minutes speaking' : 'Plan and record your answer using a cue card'
                : part === 1 ? 'Short questions about familiar topics' : 'A discussion of wider ideas and opinions'}</p>
            </div>)}
          </div>
        </>}
      </div>

      <div className="min-w-0 rounded-2xl border border-gray-100 bg-white p-5 sm:p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold text-gray-900">{rightTitle}</h3>
          {questions.length > 0 && <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600">{question ? `Question ${questionIndex + 1} of ${questions.length}` : `${questions.length} questions`}</span>}
        </div>
        {children}
      </div>
    </div>

    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-100 bg-white px-5 py-4 text-xs text-gray-500">
      <span>{onSelectQuestion ? 'Read-only question preview' : questions.length > 0 ? `${saved} of ${questions.length} answers saved` : 'Your microphone test stays on this device.'}</span>
      <span>{footer || (complete ? 'Open your Speaking report to listen back and view feedback.' : isMock ? 'The next question opens automatically after your answer is saved.' : 'Save each answer to move to the next question.')}</span>
    </div>
  </section>
}
