export function speakingExamMinutes(config) {
  if (!config?.enabled || !Array.isArray(config.questions)) return 0
  return Math.ceil(config.questions.reduce((sum, question) =>
    sum + (question.part === 2 ? 188 : (Number(question.seconds) || 40) + 8), 0) / 60)
}

export const speakingPartLabels = {
  1: 'Introduction and interview',
  2: 'Individual long turn',
  3: 'Discussion'
}

export function speakingParts(questions = []) {
  return [...new Set(questions.map(question => question.part))].sort((a, b) => a - b)
}
