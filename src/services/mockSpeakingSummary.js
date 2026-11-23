export function mockSpeakingSummary(attempt, config) {
  const total = (attempt?.questions || config?.questions || []).length
  const answers = [...new Map((attempt?.answers || []).map(answer => [answer.questionId, answer])).values()]
  const recorded = Math.min(total, answers.filter(answer => Number(answer.duration) > 0).length)
  return {
    total, recorded, missing: Math.max(0, total - recorded),
    interrupted: answers.filter(answer => answer.interrupted === true).length,
    submitted: ['submitted', 'reviewed'].includes(attempt?.status)
  }
}
