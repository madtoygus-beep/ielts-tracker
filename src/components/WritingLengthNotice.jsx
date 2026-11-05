// A presentation-only notice: never changes a saved or estimated band.
export default function WritingLengthNotice({ taskNumber, wordCount }) {
  if (![1, 2].includes(taskNumber) || !Number.isInteger(wordCount) || wordCount < 0) return null
  const minimum = taskNumber === 1 ? 150 : 250
  if (wordCount >= minimum) return null
  return (
    <aside role="note" aria-label={`Task ${taskNumber} underlength response`} className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
      <p className="font-semibold">Below the IELTS minimum length: {wordCount} / {minimum} words</p>
      <p className="mt-1">Review task coverage, development and the evidence for each criterion carefully. Length alone does not determine a band; this AI estimate is not an official IELTS result.</p>
    </aside>
  )
}
