export default function AttemptOptionsActions({ state, saving, onSelect, reopenDescription }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
    <button type="button" onClick={() => onSelect('reopen_answers')}
      disabled={saving || !state?.hasSubmission}
      className="text-left border border-purple-200 bg-purple-50 hover:bg-purple-100 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl p-4">
      <span className="block text-sm font-semibold text-purple-700">Reopen Answers</span>
      <span className="block text-xs text-purple-600/80 mt-1 leading-relaxed">{reopenDescription}</span>
    </button>
    <button type="button" onClick={() => onSelect('start_fresh')} disabled={saving || !state}
      className="text-left border border-blue-200 bg-blue-50 hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl p-4">
      <span className="block text-sm font-semibold text-blue-700">Start Fresh</span>
      <span className="block text-xs text-blue-600/80 mt-1 leading-relaxed">Restart with blank answers and a new timer, even if the student has already started. Saved results and recordings are kept.</span>
    </button>
  </div>
}
