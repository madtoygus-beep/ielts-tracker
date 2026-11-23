import { useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import { StudentSpeakingContext } from '../contexts/StudentSpeakingContext'
import { speakingApi } from '../services/speakingApi'
import { createStudentSpeakingLibrary } from '../services/studentSpeakingLibrary'

export function useStudentSpeakingLibrary(uid, api = speakingApi, enabled = true) {
  const scope = useContext(StudentSpeakingContext)
  const resource = useMemo(() => scope?.accountId === uid ? scope.getLibrary(api) : createStudentSpeakingLibrary(api, {
    accountId: uid, isCurrent: () => !scope
  }), [scope, uid, api])
  const data = useSyncExternalStore(resource.subscribe, resource.getSnapshot)
  useEffect(() => {
    if (uid && enabled && (!scope || scope.accountId === uid)) return resource.watch(window)
  }, [resource, uid, enabled, scope])
  return { ...data, refresh: resource.refresh, api: resource.api, setView: resource.setView }
}
