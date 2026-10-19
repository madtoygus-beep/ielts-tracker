import {
  eligibleAiSponsoredStudents,
  aiSponsoredStudentIneligibilityReason,
  MAX_AI_SPONSORED_STUDENTS
} from '../services/aiWritingSponsoredAssignmentPolicy'

// Display only. The server-side P5B-3A policy callable is the authorization boundary.
export default function AiWritingSponsoredAssignmentPanel({
  contentType, students, assignedIds, selection, onChange,
  activeClassStudentIds = null, managerRole = 'admin',
  status = 'ready', hasWriting = true, disabled = false,
  errorMessage = ''
}) {
  const isMock = contentType === 'mock'
  const availableStudents = eligibleAiSponsoredStudents(students, assignedIds, activeClassStudentIds)
  const eligibleIds = new Set(availableStudents.map(student => student.id))
  const selectedIds = (selection?.studentIds || []).filter(id => eligibleIds.has(id))
  const unavailableSelected = (selection?.studentIds || []).filter(id => !eligibleIds.has(id)).length
  const ineligibleAssigned = (Array.isArray(students) ? students : [])
    .filter(student => Array.isArray(assignedIds) && assignedIds.includes(student?.id) &&
      !eligibleIds.has(student.id))
    .map(student => ({
      ...student,
      reason: aiSponsoredStudentIneligibilityReason(student, assignedIds, activeClassStudentIds)
    }))
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
            {isMock ? (
              <p className="mt-1 text-xs leading-5 text-indigo-800">
                For selected students, a submitted Mock with Writing may start a school-funded AI
                assessment automatically when the school pilot and provider flags are enabled.
                Mock submission has no Check with AI choice. Personal student credits are not used.
              </p>
            ) : (
              <p className="mt-1 text-xs leading-5 text-indigo-800">
                Selected students may choose Check with AI when submitting Writing homework.
                Choosing Send to Teacher never starts a paid AI check. A school-funded check uses
                the institution quota, not the student's personal credits.
              </p>
            )}
          </div>
          <input
            type="checkbox"
            aria-label={isMock
              ? 'Enable automatic school-funded AI for selected Mock students'
              : 'Allow institution-funded AI choice for selected Writing students'}
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
            The AI assignment settings could not be verified. AI settings cannot be changed here.
            Regular student assignments can still be saved without changing AI rights.
            {errorMessage ? ` ${errorMessage}` : ''}
          </p>
        )}
        {enabled && hasWriting && status === 'ready' && (
          <div className="mt-4 border-t border-indigo-200 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <p className="text-xs font-semibold text-indigo-950">
                Students eligible for funded AI ({selectedIds.length}/{availableStudents.length})
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
            {unavailableSelected > 0 && (
              <p className="mb-3 text-xs text-amber-900 rounded-lg bg-amber-50 p-2" role="status">
                {unavailableSelected} previously selected student(s) are no longer eligible
                in the current draft. Review the assignments before saving AI rights.
              </p>
            )}
            {availableStudents.length === 0 ? (
              <p className="text-xs text-amber-800">
                {managerRole === 'teacher'
                  ? 'No eligible students in your active assigned classes. Ask the school admin to verify that you are the class teacher (teacherId) and that the student belongs to that active class. Turn off AI to save normal homework without enabling funded assessment.'
                  : 'Assign institution students to this test above first.'}
              </p>
            ) : (
              <div className="max-h-44 overflow-y-auto space-y-2 pr-1">
                {availableStudents.map(student => (
                  <label key={student.id} className="flex items-center gap-2 p-2 rounded-lg bg-white border border-indigo-100 cursor-pointer">
                    <input type="checkbox" checked={selectedIds.includes(student.id)}
                      disabled={locked} onChange={() => toggleStudent(student.id)}
                      className="accent-indigo-700" />
                    <span className="min-w-0 flex-1 text-xs text-gray-800 truncate" title={student.email || ''}>
                      {student.name || student.email || student.id}
                    </span>
                    <span className={`shrink-0 text-[10px] font-medium ${selectedIds.includes(student.id) ? 'text-emerald-700' : 'text-gray-500'}`}>
                      {selectedIds.includes(student.id) ? 'School AI selected' : 'Not selected'}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {ineligibleAssigned.length > 0 && (
              <details className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <summary className="cursor-pointer text-xs font-medium text-amber-900">
                  {ineligibleAssigned.length} assigned student(s) cannot receive school-funded AI - view reasons
                </summary>
                <div className="mt-2 max-h-36 overflow-y-auto space-y-2">
                  {ineligibleAssigned.map(student => (
                    <div key={student.id} className="text-[11px] text-amber-950">
                      <span className="font-semibold">{student.name || student.email || student.id}:</span>{' '}
                      {student.reason || 'Server eligibility verification required.'}
                    </div>
                  ))}
                </div>
              </details>
            )}
            <p className="mt-2 text-[11px] text-indigo-800">
              Maximum {MAX_AI_SPONSORED_STUDENTS} funded students across managers for this item.
              Only current institution assignments qualify{managerRole === 'teacher' ? ' in your active primary-teacher classes' : ''}.
              {managerRole === 'teacher'
                ? " Other managers' grants outside your class scope are preserved when saving."
                : ' School admins can manage funded students across their institution.'}
              {' '}Final grant and assignment eligibility is checked on the server.
            </p>
          </div>
        )}
        <p className="mt-3 text-[11px] leading-4 text-gray-600">
          {isMock
            ? 'Setting a Mock AI grant does not spend money by itself. When the institution pilot and server flags are on, an eligible submitted Mock Writing attempt can trigger an automatic school-funded request.'
            : 'Permission alone never spends AI credits. The student must choose Check with AI on Writing submission, and the institution pilot and server feature flags must be enabled.'}
        </p>
      </div>
    </section>
  )
}
