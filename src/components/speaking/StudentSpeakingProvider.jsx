import { useEffect, useMemo, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from '../../firebase'
import { StudentSpeakingContext } from '../../contexts/StudentSpeakingContext'
import { createStudentSpeakingLibrary } from '../../services/studentSpeakingLibrary'

export default function StudentSpeakingProvider({ children, accountId }) {
  const [authenticatedId, setAuthenticatedId] = useState(() => auth.currentUser?.uid || '')
  useEffect(() => {
    if (accountId !== undefined) return
    return onAuthStateChanged(auth, user => setAuthenticatedId(user?.uid || ''))
  }, [accountId])
  const owner = accountId ?? authenticatedId
  const scope = useMemo(() => {
    const libraries = new WeakMap()
    return { accountId: owner, getLibrary(api) {
      if (!libraries.has(api)) libraries.set(api, createStudentSpeakingLibrary(api, {
        accountId: owner, isCurrent: () => accountId !== undefined || auth.currentUser?.uid === owner
      }))
      return libraries.get(api)
    } }
  }, [owner, accountId])
  return <StudentSpeakingContext.Provider value={scope}>{children}</StudentSpeakingContext.Provider>
}
