import { partialWritingSummary, objectiveOnlyAverage } from '../services/partialWritingPresentation'
export default function PartialWritingNotice({ submission, report = null }) {
  const summary = partialWritingSummary(submission, report)
  if (!summary) return null
  const objectiveAverage = objectiveOnlyAverage(submission)
  return <section aria-label="Partial AI Writing result" className="my-3 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-left">
    <p className="text-sm font-semibold text-indigo-900">{summary.title}</p>
    <ul className="mt-2 space-y-1 text-sm text-indigo-900">{summary.tasks.map(task => <li key={task.number}>{task.label}</li>)}</ul>
    <p className="mt-2 text-xs text-indigo-800">{summary.explanation}</p>
    {objectiveAverage !== null && <p className="mt-2 text-xs text-indigo-800">Objective sections average: {objectiveAverage.toFixed(1)} · Writing excluded; this is not the complete Mock Overall.</p>}
  </section>
}
