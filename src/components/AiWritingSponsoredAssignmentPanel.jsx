import {
  eligibleAiSponsoredStudents,
  MAX_AI_SPONSORED_STUDENTS
} from '../services/aiWritingSponsoredAssignmentPolicy'

// Display only. The server-side P5B-3A policy callable is the authorization boundary.
export default function AiWritingSponsoredAssignmentPanel({
  contentType, students, assignedIds, selection, onChange,
  status = 'ready', hasWriting = true, disabled = false
}) {
  const availableStudents = eligibleAiSponsoredStudents(students, assignedIds)
  const eligibleIds = new Set(availableStudents.map(student => student.id))
  const selectedIds = (selection?.studentIds || []).filter(id => eligibleIds.has(id))
  const enabled = selection?.enabled === true
  const locked = disabled || status !== 'ready' || !hasWriting

  const changeEnabled = next => {
    if (locked) return
    onChange({ ...selection, enabled: next })
  }
  const toggleStudent = studentId => {
    if (locked || !enabled) return
    const next = selectedIds.includes(studentId)
      ? selectedIds.filter(id => id !== studentId)
      : [...selectedIds, studentId]
    if (next.length > MAX_AI_SPONSORED_STUDENTS) return
    onChange({ ...selection, studentIds: next })
  }
  const selectAll = () => {
    if (locked || !enabled) return
    onChange({
      ...selection,
      studentIds: availableStudents.slice(0, MAX_AI_SPONSORED_STUDENTS).map(student => student.id)
    })
  }

  return (
    <section data-testid={`sponsored-ai-${contentType}`} className="border-t border-gray-100 mt-5 pt-5">
      <div className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-semibold text-sm text-indigo-950">Institution-Sponsored AI Writing</p>
            <p className="mt-1 text-xs leading-5 text-indigo-800">
              Selected institution students receive IELTS Writing AI feedback as part of their course.
              No student credits are deducted; costs count against the school quota.
            </p>
          </div>
          <input
            type="checkbox"
            aria-label="Enable automatic AI assessment"
            checked={enabled && hasWriting}
            onChange={event => changeEnabled(event.target.checked)}
            disabled={locked}
            className="mt-1 h-5 w-5 accent-indigo-700 disabled:opacity-40"
          />
        </div>
        {!hasWriting && (
          <p className="mt-3 text-xs text-amber-800">Enable Mock Writing and select a Writing resource to offer AI assessment.</p>
        )}
        {status === 'loading' && (
          <p className="mt-3 text-xs text-gray-600" role="status">Loading existing AI assignment settings...</p>
        )}
        {status === 'unavailable' && (
          <p className="mt-3 text-xs text-red-700" role="alert">
            The AI assignment service is unavailable. AI settings cannot be changed here.
            Regular homework assignments can still be saved.
          </p>
        )}
        {enabled && hasWriting && status === 'ready' && (
          <div className="mt-4 border-t border-indigo-200 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <p className="text-xs font-semibold text-indigo-950">
                Students receiving AI assessment ({selectedIds.length}/{availableStudents.length})
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={selectAll} disabled={locked || availableStudents.length === 0}
                  className="text-[11px] text-indigo-700 underline disabled:opacity-40">
                  Select all
                </button>
                <button type="button" onClick={() => onChange({ ...selection, studentIds: [] })}
                  disabled={locked} className="text-[11px] text-indigo-700 underline disabled:opacity-40">
                  Clear
                </button>
              </div>
            </div>
            {availableStudents.length === 0 ? (
              <p className="text-xs text-amber-800">Assign institution students to this test above first.</p>
            ) : (
              <div className="max-h-44 overflow-y-auto space-y-2 pr-1">
                {availableStudents.map(student => (
                  <label key={student.id} className="flex items-center gap-2 p-2 rounded-lg bg-white border border-indigo-100 cursor-pointer">
                    <input type="checkbox" checked={selectedIds.includes(student.id)}
                      disabled={locked} onChange={() => toggleStudent(student.id)}
                      className="accent-indigo-700" />
                    <span className="min-w-0 text-xs text-gray-800 truncate" title={student.email || ''}>
                      {student.name || student.email || student.id}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <p className="mt-2 text-[11px] text-indigo-800">
              Maximum {MAX_AI_SPONSORED_STUDENTS} students. Only currently assigned students are eligible.
            </p>
          </div>
        )}
        <p className="mt-3 text-[11px] leading-4 text-gray-600">
          Automatic AI assessment requires the institution pilot and server-side feature flags to be enabled. Saving these settings alone does not start an AI assessment.
        </p>
      </div>
    </section>
  )
}
