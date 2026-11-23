import { useStudentSpeakingLibrary } from './useStudentSpeakingLibrary'

export function useSpeakingHomework(uid, api) {
  const data = useStudentSpeakingLibrary(uid, api)
  return { ...data, loading: Boolean(uid) && !data.tasksLoaded && !data.tasksError, error: data.tasksError }
}
