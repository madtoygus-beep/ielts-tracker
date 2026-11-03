// Read-only presentation. Never change grades, credits or attempt identity.
export function partialWritingSummary(submission, report = null) {
  const writing = submission?.result?.writing || {}
  const mode = writing.writingMode || submission?.writingMode || report?.writingMode
  if (writing.aiFeedbackOnly !== true && report?.feedbackOnly !== true) return null
  if (writing.enabled === false || submission?.enabledSections?.writing === false) return null
  const included = n => writing[`task${n}Enabled`] ?? (mode === 'full_writing' || mode === `task${n}_only`)
  const tasks = [1, 2].filter(included).map(n => {
    const task = report?.[`task${n}`]
    const answer = submission?.writingAnswers?.[`task${n}`] || submission?.writing?.[`task${n}`] || submission?.[`task${n}Answer`]
    const stored = writing[`task${n}WordCount`] ?? task?.wordCount
    const count = stored == null ? (typeof answer === 'string' ? answer.trim().split(/\s+/).filter(Boolean).length : null) : Number(stored)
    const band = typeof task?.estimatedBand === 'number' && Number.isFinite(task.estimatedBand) && task.estimatedBand >= 1 && task.estimatedBand <= 9 ? task.estimatedBand : null
    return { number: n, missing: count === 0, band,
      label: count === 0 ? `Task ${n}: no answer submitted` : band !== null ? `Task ${n}: AI estimate ${band.toFixed(1)}` : `Task ${n}: saved AI feedback available` }
  })
  const missing = tasks.filter(t => t.missing).map(t => `Task ${t.number}`)
  return { title: 'Partial AI Writing feedback ready', tasks,
    explanation: missing.length ? `${missing.join(' and ')} has no answer. A combined AI Writing band is unavailable.` : 'A combined AI Writing band is unavailable. Open the saved report for individual task feedback.' }
}

export function objectiveOnlyAverage(submission) {
  const result = submission?.result || {}
  const sections = submission?.enabledSections || result.enabledSections || {}
  const bands = ['listening','reading'].filter(key => sections[key] !== false && result[key]?.enabled !== false).map(key => result[key]?.band).filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 9)
  return bands.length ? Math.round((bands.reduce((a,b) => a+b,0) / bands.length) * 2) / 2 : null
}
