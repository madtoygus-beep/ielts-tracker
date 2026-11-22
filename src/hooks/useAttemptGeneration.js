import { createContext, useContext } from 'react'

export const AttemptGenerationContext = createContext('')
export const useAttemptGeneration = () => useContext(AttemptGenerationContext)
export const generationSuffix = generation => generation ? `:restart_${generation}` : ''
export const vocabularyDraftId = (uid, contentId, generation = '') => `${uid}_${contentId}${generation ? `_restart_${generation}` : ''}`
