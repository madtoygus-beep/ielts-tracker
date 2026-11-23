import { mockSpeakingSummary } from '../../services/mockSpeakingSummary'

export default function MockSpeakingReviewCard({ attempt, config }) {
  const summary = mockSpeakingSummary(attempt, config)
  return <section aria-label="Speaking review summary" className="rounded-2xl bg-emerald-50 p-5">
    <h3 className="mb-1 text-xs font-normal text-gray-500">Speaking</h3>
    <p className="text-xl font-bold text-emerald-700">{summary.recorded}/{summary.total}</p>
    <p className="mt-1 text-xs text-gray-500">{summary.submitted
      ? summary.missing ? `${summary.missing} question(s) without a recording` : 'All recordings saved'
      : 'Speaking not completed'}</p>
    {summary.interrupted > 0 && <p className="mt-2 text-xs text-amber-800">{summary.interrupted} interrupted recording(s) · teacher review recommended</p>}
    {summary.submitted && <p className="mt-2 text-xs font-medium text-emerald-700">Submitted · recordings locked</p>}
  </section>
}
