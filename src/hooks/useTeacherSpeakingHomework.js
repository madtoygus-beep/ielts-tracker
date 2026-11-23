import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { speakingApi } from '../services/speakingApi'
import { createTeacherSpeakingLibrary } from '../services/teacherSpeakingLibrary'
export function useTeacherSpeakingHomework(uid, api = speakingApi, enabled = true) {
  // Changing accounts creates a fresh store before rendering any previous account's rows.
  const resource = useMemo(() => createTeacherSpeakingLibrary(api, uid), [uid, api])
  const state = useSyncExternalStore(resource.subscribe, resource.getSnapshot)
  useEffect(() => {
    if (uid && enabled) void resource.ensure()
  }, [uid, enabled, resource])
  return { ...state, refresh: resource.refresh, upsertTask: resource.upsertTask }
}
