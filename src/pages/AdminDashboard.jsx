import { useState, useEffect } from 'react'

import { auth, db, functions, storage } from '../firebase'

import {

  collection,

  onSnapshot,

  doc,

  getDoc,

  updateDoc,

  deleteDoc,

  getDocs,

  query,

  where

} from 'firebase/firestore'

import { signOut, onAuthStateChanged } from 'firebase/auth'

import { sendActivationEmail, sendPasswordResetEmail } from '../services/authEmailService'

import { httpsCallable } from 'firebase/functions'

import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'

import { useNavigate } from 'react-router-dom'



const DEFAULT_SCHOOL_ID = 'maxima'
const ALL_SCHOOLS_ID = 'all'
const INDIVIDUAL_SCHOOL_ID = '__individual__'
const PLATFORM_SCHOOL_ID = '__platform__'
const SELF_STUDY_MANAGER_ROLE = 'selfStudyManager'
const SELF_STUDY_SCOPE = 'selfStudy'
const DEFAULT_SCHOOL_PRIMARY_COLOR = '#7c3aed'
const DEFAULT_SCHOOL_ACCENT_COLOR = '#f97316'
const SCHOOL_LOGO_MAX_BYTES = 2 * 1024 * 1024

function isIndividualAccount(user) {
  return user?.accountType === 'individual' || user?.schoolId === INDIVIDUAL_SCHOOL_ID
}

function isSelfStudyManagerAccount(user) {
  return user?.role === SELF_STUDY_MANAGER_ROLE &&
    user?.accountType === 'platform' &&
    user?.scope === SELF_STUDY_SCOPE &&
    user?.schoolId === PLATFORM_SCHOOL_ID
}

function usesEmailOnlyAccount(user) {
  return isIndividualAccount(user) || isSelfStudyManagerAccount(user)
}

function roleLabel(role) {
  if (role === SELF_STUDY_MANAGER_ROLE) return 'Self-Study Manager'
  if (role === 'student') return 'Student'
  if (role === 'teacher') return 'Teacher'
  if (role === 'admin') return 'Admin'
  return role || 'Account'
}

const SCHOOL_LOGO_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
}



const setStudentAssignmentVisibilityCall = httpsCallable(

  functions,

  'setStudentAssignmentVisibility'

)

const getManagedSchoolsCall = httpsCallable(

  functions,

  'getManagedSchools'

)

const saveManagedSchoolCall = httpsCallable(

  functions,

  'saveManagedSchool'

)

const getManagedSchoolDeletionPreviewCall = httpsCallable(functions, 'getManagedSchoolDeletionPreview')

const deleteManagedSchoolCall = httpsCallable(functions, 'deleteManagedSchool')

const createManagedUserCall = httpsCallable(functions, 'createManagedUser')

const createSelfStudyManagerCall = httpsCallable(functions, 'createSelfStudyManager')

const approveManagedUserCall = httpsCallable(functions, 'approveManagedUser')

const rejectManagedUserCall = httpsCallable(functions, 'rejectManagedUser')

const updateManagedUserCall = httpsCallable(functions, 'updateManagedUser')

const setManagedUserPasswordCall = httpsCallable(functions, 'setManagedUserPassword')

const deleteManagedUserCall = httpsCallable(functions, 'deleteManagedUser')

const restoreManagedUserCall = httpsCallable(functions, 'restoreManagedUser')

const getManagedUserDeletionPreviewCall = httpsCallable(functions, 'getManagedUserDeletionPreview')

const permanentlyDeleteManagedUserCall = httpsCallable(functions, 'permanentlyDeleteManagedUser')




// Simple, dependency-free icons. No additional UI package or runtime dependency.
function AdminIcon({ name, className = 'h-5 w-5' }) {
  const common = { className, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  const paths = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/></>,
    schools: <><path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6M9 10h.01M15 10h.01"/></>,
    users: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"/></>,
    selfstudy: <><path d="M4 19.5V5.9c2.8-1.2 5.5-1 8 .5 2.5-1.5 5.2-1.7 8-.5v13.6c-2.8-1.2-5.5-1-8 .5-2.5-1.5-5.2-1.7-8-.5ZM12 6.4V20"/></>,
    classes: <><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18M8 2v6M16 2v6"/></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>,
    exit: <><path d="M10 17l5-5-5-5M15 12H3M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    shield: <><path d="m12 3 8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6l8-3ZM9 12l2 2 4-4"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.5"/><path d="m16 16 4.2 4.2"/></>,
  }
  return <svg {...common}>{paths[name] || paths.overview}</svg>
}

const ADMIN_NAV_ITEMS = [
  { id: 'overview', label: 'Overview', icon: 'overview', description: 'A clear view of your platform and priorities' },
  { id: 'schools', label: 'Institutions', icon: 'schools', description: 'School identity, seat limits, branding and status' },
  { id: 'users', label: 'Users', icon: 'users', description: 'Institution accounts, approvals and academic history' },
  { id: 'selfstudy', label: 'Self-Study', icon: 'selfstudy', description: 'Individual accounts and platform managers' },
]

export default function AdminDashboard() {

  const [users, setUsers] = useState([])

  const [scores, setScores] = useState({})

  const [search, setSearch] = useState('')

  const [editUser, setEditUser] = useState(null)

  const [editName, setEditName] = useState('')

  const [editEmail, setEditEmail] = useState('')

  const [editUsername, setEditUsername] = useState('')

  const [editRole, setEditRole] = useState('')

  const [editTargetBand, setEditTargetBand] = useState('')

  const [editNewPassword, setEditNewPassword] = useState('')

  const [editSaving, setEditSaving] = useState(false)

  const [passwordSaving, setPasswordSaving] = useState(false)

  const [editScore, setEditScore] = useState(null)

  const [editScoreForm, setEditScoreForm] = useState({})

  const [selectedStudent, setSelectedStudent] = useState(null)

  const [permanentDeleteBusyId, setPermanentDeleteBusyId] = useState('')

  const [restoreBusyId, setRestoreBusyId] = useState('')

  const [accountListView, setAccountListView] = useState('active')

  const [accountAudienceView, setAccountAudienceView] = useState('institution')

  const [authChecking, setAuthChecking] = useState(true)

  const [schools, setSchools] = useState([])

  const [selectedSchoolId, setSelectedSchoolId] = useState(DEFAULT_SCHOOL_ID)

  const [schoolsLoading, setSchoolsLoading] = useState(true)

  const [schoolsError, setSchoolsError] = useState('')

  const [schoolSaving, setSchoolSaving] = useState(false)

  const [schoolNotice, setSchoolNotice] = useState('')

  const [editingSchoolId, setEditingSchoolId] = useState(null)

  const [schoolForm, setSchoolForm] = useState({

    schoolId: DEFAULT_SCHOOL_ID,

    name: 'Maxima Eğitim',

    status: 'active',

    studentSeatLimit: '',

    teacherSeatLimit: '',

    logoPath: null,

    primaryColor: DEFAULT_SCHOOL_PRIMARY_COLOR,

    accentColor: DEFAULT_SCHOOL_ACCENT_COLOR,

    loginPreference: 'both'

  })

  const [schoolLogoFile, setSchoolLogoFile] = useState(null)

  const [schoolLogoUrl, setSchoolLogoUrl] = useState('')

  const [schoolLogoRemove, setSchoolLogoRemove] = useState(false)

  const [accountCreating, setAccountCreating] = useState(false)

  const [accountError, setAccountError] = useState('')

  const [accountNotice, setAccountNotice] = useState('')

  const [accountForm, setAccountForm] = useState({

    name: '',

    email: '',

    username: '',

    role: 'student',

    schoolId: '',

    targetBand: ''

  })

  const [managerCreating, setManagerCreating] = useState(false)

  const [managerError, setManagerError] = useState('')

  const [managerNotice, setManagerNotice] = useState('')

  const [managerForm, setManagerForm] = useState({

    name: '',

    email: ''

  })

  const [pendingSchoolSelections, setPendingSchoolSelections] = useState({})

  // UI-only navigation. No permissions, account boundaries or database APIs change.
  const [adminSection, setAdminSection] = useState('overview')
  const [userTab, setUserTab] = useState('students')
  const [selfStudyTab, setSelfStudyTab] = useState('learners')
  const [institutionScope, setInstitutionScope] = useState(DEFAULT_SCHOOL_ID)
  const [schoolEditorOpen, setSchoolEditorOpen] = useState(false)
  const [schoolEditorTab, setSchoolEditorTab] = useState('identity')
  const [accountCreatorOpen, setAccountCreatorOpen] = useState(false)
  const [managerCreatorOpen, setManagerCreatorOpen] = useState(false)

  const navigate = useNavigate()



  const loadSchools = async (preferredSchoolId = null) => {

    setSchoolsLoading(true)

    setSchoolsError('')

    try {

      const result = await getManagedSchoolsCall({})

      const managedSchools = Array.isArray(result.data?.schools)

        ? result.data.schools

        : []

      setSchools(managedSchools)

      const requestedSchoolId = preferredSchoolId || selectedSchoolId
      const requestedExists = requestedSchoolId === ALL_SCHOOLS_ID || managedSchools.some(
        school => school.schoolId === requestedSchoolId
      )
      const fallbackSchoolId = managedSchools.some(school => school.schoolId === DEFAULT_SCHOOL_ID)
        ? DEFAULT_SCHOOL_ID
        : managedSchools[0]?.schoolId || ALL_SCHOOLS_ID
      const nextSelectedSchoolId = requestedExists ? requestedSchoolId : fallbackSchoolId

      if (nextSelectedSchoolId !== selectedSchoolId) {
        setSelectedSchoolId(nextSelectedSchoolId)
      }

      setAccountForm(previous => {
        if (nextSelectedSchoolId !== ALL_SCHOOLS_ID) {
          return {
            ...previous,
            schoolId: nextSelectedSchoolId
          }
        }

        const selectedIsActive = managedSchools.some(
          school => school.schoolId === previous.schoolId && school.status === 'active'
        )

        return selectedIsActive
          ? previous
          : {
              ...previous,
              schoolId: ''
            }
      })

    } catch (error) {

      console.error(error)

      setSchoolsError(error?.message || 'Could not load schools.')

    } finally {

      setSchoolsLoading(false)

    }

  }


  useEffect(() => {

    let unsubUsers = null

    let unsubScores = null

    let active = true



    const cleanup = () => {

      if (unsubUsers) {

        unsubUsers()

        unsubUsers = null

      }

      if (unsubScores) {

        unsubScores()

        unsubScores = null

      }

    }



    const unsubAuth = onAuthStateChanged(auth, async currentUser => {

      cleanup()



      if (!currentUser) {

        navigate('/login')

        return

      }



      try {

        const userSnap = await getDoc(doc(db, 'users', currentUser.uid))



        if (!active) return



        if (!userSnap.exists()) {

          await signOut(auth)

          navigate('/login')

          return

        }



        const profile = userSnap.data()



        if (

          profile.deleted ||

          profile.status !== 'approved' ||

          profile.role !== 'admin'

        ) {

          await signOut(auth)

          navigate('/login')

          return

        }



        setAuthChecking(false)

        loadSchools()

        unsubUsers = onSnapshot(collection(db, 'users'), snap => {

          const list = snap.docs

            .map(d => ({ id: d.id, ...d.data() }))




          setUsers(list)

        })



        unsubScores = onSnapshot(collection(db, 'scores'), snap => {

          const groupedScores = {}



          snap.docs.forEach(scoreDoc => {

            const score = {

              id: scoreDoc.id,

              ...scoreDoc.data()

            }



            if (!score.uid || score.archived === true) return



            if (!groupedScores[score.uid]) {

              groupedScores[score.uid] = []

            }



            groupedScores[score.uid].push(score)

          })



          Object.keys(groupedScores).forEach(studentId => {

            groupedScores[studentId].sort(

              (a, b) => new Date(b.date || 0) - new Date(a.date || 0)

            )

          })



          setScores(groupedScores)

        })

      } catch (error) {

        console.error(error)



        if (active) {

          await signOut(auth)

          navigate('/login')

        }

      }

    })



    return () => {

      active = false

      unsubAuth()

      cleanup()

    }

  }, [navigate])



  const normalizeSchoolIdInput = value =>

    value

      .toLowerCase()

      .trimStart()

      .replace(/\s+/g, '-')

      .replace(/[^a-z0-9-]/g, '')

      .slice(0, 63)



  const normalizeSeatLimitInput = value => {

    const raw = String(value ?? '').trim()

    if (!raw) return ''

    const digits = raw.replace(/[^0-9]/g, '')

    if (!digits) return ''

    return String(Math.min(100000, Number(digits)))

  }



  const parseSeatLimit = (value, label) => {

    const raw = String(value ?? '').trim()

    if (!raw) return { ok: true, value: null }



    const limit = Number(raw)

    if (!Number.isInteger(limit) || limit < 0 || limit > 100000) {

      return { ok: false, message: `${label} must be a whole number from 0 to 100000, or left blank for Unlimited.` }

    }



    return { ok: true, value: limit }

  }



  const seatLimitLabel = limit => (limit === null || limit === undefined ? 'Unlimited' : String(limit))

  const validBrandColor = value => /^#[0-9a-fA-F]{6}$/.test(String(value || '').trim())

  const loadSchoolLogoPreview = async logoPath => {
    if (!logoPath) {
      setSchoolLogoUrl('')
      return
    }

    try {
      const url = await getDownloadURL(storageRef(storage, logoPath))
      setSchoolLogoUrl(url)
    } catch (error) {
      console.warn('Could not load school logo preview:', error)
      setSchoolLogoUrl('')
    }
  }

  const clearSchoolLogoDraft = () => {
    setSchoolLogoFile(null)
    setSchoolLogoUrl('')
    setSchoolLogoRemove(false)
  }

  const handleSchoolLogoFileChange = event => {
    const file = event.target.files?.[0] || null
    event.target.value = ''
    setSchoolsError('')

    if (!file) return

    if (!SCHOOL_LOGO_EXTENSIONS[file.type]) {
      setSchoolsError('School logo must be a PNG, JPG/JPEG or WebP image.')
      return
    }

    if (file.size <= 0 || file.size > SCHOOL_LOGO_MAX_BYTES) {
      setSchoolsError('School logo must be larger than 0 bytes and no more than 2 MB.')
      return
    }

    setSchoolLogoFile(file)
    setSchoolLogoRemove(false)

    const reader = new FileReader()
    reader.onload = () => setSchoolLogoUrl(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => setSchoolLogoUrl('')
    reader.readAsDataURL(file)
  }

  const removeStoredSchoolLogo = () => {
    setSchoolLogoFile(null)
    setSchoolLogoUrl('')
    setSchoolLogoRemove(true)
    setSchoolsError('')
  }

  const restoreStoredSchoolLogo = () => {
    setSchoolLogoFile(null)
    setSchoolLogoRemove(false)
    loadSchoolLogoPreview(schoolForm.logoPath)
  }



  const resetSchoolForm = () => {

    setEditingSchoolId(null)

    setSchoolForm({

      schoolId: '',

      name: '',

      status: 'active',

      studentSeatLimit: '',

      teacherSeatLimit: '',

      logoPath: null,

      primaryColor: DEFAULT_SCHOOL_PRIMARY_COLOR,

      accentColor: DEFAULT_SCHOOL_ACCENT_COLOR,

      loginPreference: 'both'

    })

    clearSchoolLogoDraft()

    setSchoolNotice('')

    setSchoolsError('')

  }



  const prepareMaximaSchool = () => {

    setEditingSchoolId(null)

    setSchoolForm({

      schoolId: DEFAULT_SCHOOL_ID,

      name: 'Maxima Eğitim',

      status: 'active',

      studentSeatLimit: '',

      teacherSeatLimit: '',

      logoPath: null,

      primaryColor: DEFAULT_SCHOOL_PRIMARY_COLOR,

      accentColor: DEFAULT_SCHOOL_ACCENT_COLOR,

      loginPreference: 'both'

    })

    clearSchoolLogoDraft()

    setSchoolNotice('')

    setSchoolsError('')

  }



  const handleEditSchool = school => {

    setEditingSchoolId(school.schoolId)

    setSchoolForm({

      schoolId: school.schoolId,

      name: school.name || '',

      status: school.status === 'inactive' ? 'inactive' : 'active',

      studentSeatLimit: school.studentSeatLimit === null || school.studentSeatLimit === undefined

        ? ''

        : String(school.studentSeatLimit),

      teacherSeatLimit: school.teacherSeatLimit === null || school.teacherSeatLimit === undefined

        ? ''

        : String(school.teacherSeatLimit),

      logoPath: school.logoPath || null,

      primaryColor: school.primaryColor || DEFAULT_SCHOOL_PRIMARY_COLOR,

      accentColor: school.accentColor || DEFAULT_SCHOOL_ACCENT_COLOR,

      loginPreference: ['email', 'username', 'both'].includes(school.loginPreference)

        ? school.loginPreference

        : 'both'

    })

    setSchoolLogoFile(null)

    setSchoolLogoRemove(false)

    loadSchoolLogoPreview(school.logoPath || null)

    setSchoolNotice('')

    setSchoolsError('')

  }



  const handleSaveSchool = async () => {

    const schoolId = normalizeSchoolIdInput(schoolForm.schoolId)

    const name = schoolForm.name.trim()

    const studentSeat = parseSeatLimit(schoolForm.studentSeatLimit, 'Student seat limit')

    const teacherSeat = parseSeatLimit(schoolForm.teacherSeatLimit, 'Teacher seat limit')

    const primaryColor = String(schoolForm.primaryColor || '').trim().toLowerCase()

    const accentColor = String(schoolForm.accentColor || '').trim().toLowerCase()

    const loginPreference = ['email', 'username', 'both'].includes(schoolForm.loginPreference)

      ? schoolForm.loginPreference

      : 'both'



    if (schoolId.length < 2) {

      setSchoolsError('School ID must be at least 2 characters.')

      return

    }



    if (name.length < 2) {

      setSchoolsError('School name must be at least 2 characters.')

      return

    }



    if (!studentSeat.ok) {

      setSchoolsError(studentSeat.message)

      return

    }



    if (!teacherSeat.ok) {

      setSchoolsError(teacherSeat.message)

      return

    }



    if (!validBrandColor(primaryColor) || !validBrandColor(accentColor)) {

      setSchoolsError('Brand colors must be valid 6-digit hex colors.')

      return

    }



    if (schoolLogoFile && (!SCHOOL_LOGO_EXTENSIONS[schoolLogoFile.type] || schoolLogoFile.size > SCHOOL_LOGO_MAX_BYTES)) {

      setSchoolsError('School logo must be a PNG, JPG/JPEG or WebP image no larger than 2 MB.')

      return

    }



    setSchoolSaving(true)

    setSchoolsError('')

    setSchoolNotice('')



    const oldLogoPath = schoolForm.logoPath || null

    const basePayload = {

      schoolId,

      name,

      status: schoolForm.status,

      studentSeatLimit: studentSeat.value,

      teacherSeatLimit: teacherSeat.value,

      primaryColor,

      accentColor,

      loginPreference

    }

    let metadataSaved = false

    let cleanupWarning = false



    try {

      const initialLogoPath = schoolLogoRemove ? null : oldLogoPath

      const initialResult = await saveManagedSchoolCall({

        ...basePayload,

        logoPath: initialLogoPath

      })

      metadataSaved = true

      const wasCreated = initialResult.data?.created === true

      let finalResult = initialResult

      let finalLogoPath = initialLogoPath



      if (schoolLogoFile) {

        const extension = SCHOOL_LOGO_EXTENSIONS[schoolLogoFile.type]

        const newLogoPath = `school-branding/${schoolId}/logo.${extension}`

        const newLogoRef = storageRef(storage, newLogoPath)



        await uploadBytes(newLogoRef, schoolLogoFile, {

          contentType: schoolLogoFile.type,

          cacheControl: 'public,max-age=3600'

        })



        if (newLogoPath !== oldLogoPath) {

          try {

            finalResult = await saveManagedSchoolCall({

              ...basePayload,

              logoPath: newLogoPath

            })

          } catch (error) {

            await deleteObject(newLogoRef).catch(() => {})

            throw error

          }

        }



        finalLogoPath = newLogoPath

        if (oldLogoPath && oldLogoPath !== newLogoPath) {

          try {

            await deleteObject(storageRef(storage, oldLogoPath))

          } catch (error) {

            if (error?.code !== 'storage/object-not-found') {

              console.warn('Old school logo cleanup failed:', error)

              cleanupWarning = true

            }

          }

        }



        try {

          setSchoolLogoUrl(await getDownloadURL(newLogoRef))

        } catch (error) {

          console.warn('Could not load uploaded school logo preview:', error)

          setSchoolLogoUrl('')

        }

      } else if (schoolLogoRemove && oldLogoPath) {

        try {

          await deleteObject(storageRef(storage, oldLogoPath))

        } catch (error) {

          if (error?.code !== 'storage/object-not-found') {

            console.warn('School logo cleanup failed:', error)

            cleanupWarning = true

          }

        }

        finalLogoPath = null

        setSchoolLogoUrl('')

      } else if (finalLogoPath) {

        await loadSchoolLogoPreview(finalLogoPath)

      }



      await loadSchools(schoolId)



      const savedSchool = finalResult.data?.school || {}

      setEditingSchoolId(schoolId)

      setSchoolForm({

        schoolId,

        name,

        status: schoolForm.status,

        studentSeatLimit: savedSchool.studentSeatLimit === null || savedSchool.studentSeatLimit === undefined

          ? ''

          : String(savedSchool.studentSeatLimit),

        teacherSeatLimit: savedSchool.teacherSeatLimit === null || savedSchool.teacherSeatLimit === undefined

          ? ''

          : String(savedSchool.teacherSeatLimit),

        logoPath: finalLogoPath,

        primaryColor: savedSchool.primaryColor || primaryColor,

        accentColor: savedSchool.accentColor || accentColor,

        loginPreference: savedSchool.loginPreference || loginPreference

      })

      setSchoolLogoFile(null)

      setSchoolLogoRemove(false)
      setSchoolEditorOpen(false)



      const actionText = wasCreated ? `${name} was created.` : `${name} was updated.`

      setSchoolNotice(

        cleanupWarning

          ? `${actionText} Branding saved, but an old logo file could not be cleaned up.`

          : `${actionText} Institution branding is ready.`

      )

    } catch (error) {

      console.error(error)

      if (metadataSaved && schoolLogoFile) {

        setSchoolsError('School settings were saved, but the logo update failed. The previous logo remains active; retry the logo upload.')

        await loadSchools(schoolId).catch(() => {})

      } else {

        setSchoolsError(error?.message || 'Could not save school.')

      }

    } finally {

      setSchoolSaving(false)

    }

  }


  const handleToggleSchoolStatus = async school => {

    const nextStatus = school.status === 'active' ? 'inactive' : 'active'

    const action = nextStatus === 'active' ? 'activate' : 'deactivate'



    if (!window.confirm(`${action.charAt(0).toUpperCase() + action.slice(1)} ${school.name}?`)) return



    setSchoolSaving(true)

    setSchoolsError('')

    setSchoolNotice('')



    try {

      await saveManagedSchoolCall({

        schoolId: school.schoolId,

        name: school.name,

        status: nextStatus

      })



      await loadSchools()

      setSchoolNotice(`${school.name} is now ${nextStatus}.`)

    } catch (error) {

      console.error(error)

      setSchoolsError(error?.message || 'Could not update school status.')

    } finally {

      setSchoolSaving(false)

    }

  }



  const handleSchoolScopeChange = schoolId => {

    setSelectedSchoolId(schoolId)
    setInstitutionScope(schoolId)
    setSearch('')
    setSelectedStudent(null)
    setAccountAudienceView('institution')
    setPendingSchoolSelections({})
    setAccountError('')
    setAccountNotice('')

    setAccountForm(previous => ({
      ...previous,
      schoolId: schoolId === ALL_SCHOOLS_ID ? '' : schoolId
    }))

  }



  const handleDeleteSchool = async school => {

    if (school.schoolId === DEFAULT_SCHOOL_ID) {

      setSchoolsError('The default Maxima school cannot be permanently deleted.')

      return

    }

    if (school.status !== 'inactive') {

      setSchoolsError('Deactivate this school before permanently deleting it.')

      return

    }

    setSchoolSaving(true)
    setSchoolsError('')
    setSchoolNotice('')

    try {

      const previewResult = await getManagedSchoolDeletionPreviewCall({
        schoolId: school.schoolId
      })
      const preview = previewResult.data || {}
      const userSummary = preview.users || {}
      const totalUsers = Number(userSummary.total) || 0
      const studentCount = Number(userSummary.students) || 0
      const teacherCount = Number(userSummary.teachers) || 0
      const deletedUserCount = Number(userSummary.deleted) || 0
      const totalFirestoreRecords = Number(preview.totalFirestoreRecords) || 0
      const storageObjectsReferenced = Number(preview.storageObjectsReferenced) || 0

      const ok = window.confirm(
        `DELETE ${school.name} AND ALL OF ITS DATA?

` +
        `This will permanently delete:
` +
        `• ${totalUsers} user profile(s) (${studentCount} student(s), ${teacherCount} teacher(s), ${deletedUserCount} already removed account(s))
` +
        `• ${totalFirestoreRecords} Firestore record(s) tied to this school
` +
        `• ${storageObjectsReferenced} directly referenced Storage object(s), plus user-owned school files
` +
        `• Firebase Auth accounts for this school's managed users

` +
        `This cannot be undone.`
      )

      if (!ok) return

      const typedSchoolId = window.prompt(
        `Final confirmation: type the school ID "${school.schoolId}" to permanently delete this institution and all of its data.`
      )

      if ((typedSchoolId || '').trim().toLowerCase() !== school.schoolId) {
        setSchoolsError('Permanent deletion cancelled because the school ID confirmation did not match.')
        return
      }

      const result = await deleteManagedSchoolCall({
        schoolId: school.schoolId,
        confirmCascadeDelete: true,
        confirmSchoolId: school.schoolId
      })

      if (editingSchoolId === school.schoolId) {
        resetSchoolForm()
      }

      setPendingSchoolSelections({})
      setSelectedStudent(null)
      setSearch('')
      setSelectedSchoolId(DEFAULT_SCHOOL_ID)
      await loadSchools(DEFAULT_SCHOOL_ID)

      const deletedUsers = Number(result.data?.deletedUsers) || totalUsers
      setSchoolNotice(
        `${school.name} and its institution data were permanently deleted. Removed ${deletedUsers} user profile(s).`
      )

    } catch (error) {

      console.error(error)

      setSchoolsError(error?.message || 'Could not permanently delete this school and its data.')

    } finally {

      setSchoolSaving(false)

    }

  }


  const schoolMembers = schoolId =>

    users.filter(user =>
      (user.schoolId || DEFAULT_SCHOOL_ID) === schoolId &&
      user.deleted !== true &&
      user.status !== 'deleted'
    )



  const schoolLabel = schoolId => {

    const id = schoolId || DEFAULT_SCHOOL_ID

    if (id === INDIVIDUAL_SCHOOL_ID) return 'Self-Study / Individual'
    if (id === PLATFORM_SCHOOL_ID) return 'Self-Study Platform'

    const school = schools.find(item => item.schoolId === id)

    return school ? school.name : id

  }



  const handleCreateManagedUser = async () => {

    const name = accountForm.name.trim()

    const email = accountForm.email.trim().toLowerCase()

    const username = accountForm.username.trim().toLowerCase()

    const schoolId = accountForm.schoolId

    const targetBand = accountForm.targetBand === '' ? null : Number(accountForm.targetBand)



    setAccountError('')

    setAccountNotice('')



    if (name.length < 2 || !email || !schoolId) {

      setAccountError('Full name, email and school are required.')

      return

    }

    if (username && !/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) {

      setAccountError('Username must be 3-40 characters and use lowercase letters, numbers, dot, underscore or hyphen.')

      return

    }



    if (

      accountForm.role === 'student' &&

      accountForm.targetBand !== '' &&

      (

        Number.isNaN(targetBand) ||

        targetBand < 0 ||

        targetBand > 9 ||

        Math.round(targetBand * 2) !== targetBand * 2

      )

    ) {

      setAccountError('Target Band must be between 0 and 9 in 0.5 increments.')

      return

    }



    setAccountCreating(true)



    try {

      await createManagedUserCall({

        name,

        email,

        username: username || null,

        role: accountForm.role,

        schoolId,

        targetBand: accountForm.role === 'student' ? targetBand : null

      })



      await loadSchools()



      let resetSent = false

      try {

        await sendActivationEmail(email)

        resetSent = true

      } catch (resetError) {

        console.error('Account created but account setup email failed:', resetError)

      }



      const usernameNotice = username ? ` Username: ${username}.` : ''

      setAccountNotice(

        resetSent

          ? `${name} was created in ${schoolLabel(schoolId)}.${usernameNotice} Account setup email sent to ${email}.`

          : `${name} was created in ${schoolLabel(schoolId)}.${usernameNotice} The account setup email could not be sent. Use Edit to set a password if this email is not reachable.`

      )



      setAccountCreatorOpen(false)
      setAccountForm(previous => ({

        ...previous,

        name: '',

        email: '',

        username: '',

        schoolId: selectedSchoolId === ALL_SCHOOLS_ID ? '' : selectedSchoolId,

        targetBand: ''

      }))

    } catch (error) {

      console.error(error)

      setAccountError(error?.message || 'Could not create account.')

    } finally {

      setAccountCreating(false)

    }

  }



  const handleCreateSelfStudyManager = async () => {

    const name = managerForm.name.trim()
    const email = managerForm.email.trim().toLowerCase()

    setManagerError('')
    setManagerNotice('')

    if (name.length < 2 || !email || !email.includes('@')) {
      setManagerError('Full name and a valid email are required.')
      return
    }

    setManagerCreating(true)

    try {
      await createSelfStudyManagerCall({ name, email })

      let resetSent = false
      try {
        await sendActivationEmail(email)
        resetSent = true
      } catch (resetError) {
        console.error('Self-Study Manager created but account setup email failed:', resetError)
      }

      setManagerNotice(
        resetSent
          ? `${name} was created as a Self-Study Manager. Account setup email sent to ${email}.`
          : `${name} was created as a Self-Study Manager. The setup email could not be sent; use Edit to set a password.`
      )
      setManagerForm({ name: '', email: '' })
      setManagerCreatorOpen(false)
    } catch (error) {
      console.error(error)
      setManagerError(error?.message || 'Could not create Self-Study Manager account.')
    } finally {
      setManagerCreating(false)
    }

  }


  const approveUser = async (userId, roleType) => {

    const schoolId = pendingSchoolSelections[userId] || (
      selectedSchoolId === ALL_SCHOOLS_ID ? '' : selectedSchoolId
    )



    if (!schoolId) {

      alert('Select an active school before approving this account.')

      return

    }



    try {

      await approveManagedUserCall({ userId, role: roleType, schoolId })

      await loadSchools()



      setPendingSchoolSelections(previous => {

        const next = { ...previous }

        delete next[userId]

        return next

      })

    } catch (error) {

      console.error(error)

      alert(error?.message || 'Could not approve this account.')

    }

  }



  const rejectUser = async (userId) => {

    if (!window.confirm('Reject this request?')) return



    try {

      await rejectManagedUserCall({ userId })

    } catch (error) {

      console.error(error)

      alert(error?.message || 'Could not reject this account.')

    }

  }



  const handleDelete = async (id) => {

    if (!window.confirm('Archive this account and disable Firebase Auth login? Existing history will be preserved.')) return



    try {

      await deleteManagedUserCall({ userId: id })

      await loadSchools()

    } catch (error) {

      console.error(error)

      alert(error?.message || 'Could not archive this account.')

    }

  }



  const handleRestoreManagedUser = async user => {
    if (!user?.id || restoreBusyId) return

    const role = (user.role || user.requestedRole || '').toLowerCase()
    if (!['student', 'teacher', 'selfstudymanager'].includes(role)) {
      alert('This archived account has no restorable managed role. It can only be permanently deleted.')
      return
    }

    if (!window.confirm(`Restore ${user.name || user.email || 'this account'} and re-enable Firebase Auth login?`)) return

    setRestoreBusyId(user.id)
    try {
      await restoreManagedUserCall({ userId: user.id })
      await loadSchools()
      alert(`${user.name || user.email || 'Account'} was restored.`)
    } catch (error) {
      console.error(error)
      alert(error?.message || 'Could not restore this account.')
    } finally {
      setRestoreBusyId('')
    }
  }


  const handlePermanentDeleteUser = async user => {

    if (!user?.id) return
    if (permanentDeleteBusyId) return

    setPermanentDeleteBusyId(user.id)

    try {
      const previewResult = await getManagedUserDeletionPreviewCall({ userId: user.id })
      const preview = previewResult.data || {}
      const previewRole = preview.user?.role || user.role || user.requestedRole || 'account'
      const linkedFirestoreRecords = Number(preview.linkedFirestoreRecords) || 0
      const legacyReferenceDocuments = Number(preview.legacyReferenceDocuments) || 0
      const teacherReferenceDocuments = Number(preview.teacherReferenceDocuments) || 0
      const storageObjects = Number(preview.storageObjects) || 0
      const totalFirestoreDocuments = Number(preview.totalFirestoreDocumentsToDelete) || (linkedFirestoreRecords + 1)
      const preservesHistory = preview.preservesHistoricalAcademicRecords === true
      const preservesSharedContent = preview.preservesSharedSchoolContent === true

      const preservedLines = [
        preservesSharedContent ? '• Shared school content will be preserved.' : '',
        preservesHistory ? '• Historical academic records will be preserved.' : ''
      ].filter(Boolean).join('\n')

      const ok = window.confirm(
        `PERMANENTLY DELETE ${user.name || user.email || 'THIS ACCOUNT'}?\n\n` +
        `Role: ${previewRole}\n\n` +
        `This will permanently remove:\n` +
        `• Firebase Auth account\n` +
        `• ${totalFirestoreDocuments} Firestore document(s), including the user profile\n` +
        `• ${legacyReferenceDocuments} student reference document(s)\n` +
        `• ${teacherReferenceDocuments} teacher ownership/reference document(s)\n` +
        `• ${storageObjects} user-owned Storage object(s)\n` +
        (preservedLines ? `\n${preservedLines}\n` : '\n') +
        `\nThis cannot be undone.`
      )

      if (!ok) return

      const expectedEmail = (preview.user?.email || user.email || '').trim().toLowerCase()
      const typedEmail = window.prompt(
        `Final confirmation: type the account email "${expectedEmail}" to permanently delete this account.`
      )

      if ((typedEmail || '').trim().toLowerCase() !== expectedEmail) {
        alert('Permanent deletion cancelled because the email confirmation did not match.')
        return
      }

      await permanentlyDeleteManagedUserCall({
        userId: user.id,
        confirmPermanentDelete: true,
        confirmEmail: expectedEmail
      })

      await loadSchools()

      if (selectedStudent === user.id) setSelectedStudent(null)
      alert(`${user.name || user.email || 'Account'} was permanently deleted.`)
    } catch (error) {
      console.error(error)
      alert(error?.message || 'Could not permanently delete this account.')
    } finally {
      setPermanentDeleteBusyId('')
    }

  }



  const handleDeleteScore = async (scoreId) => {

    if (!window.confirm('Delete this score?')) return

    await deleteDoc(doc(db, 'scores', scoreId))

  }



  const updateResultDocumentsByStudent = async (collectionName, uid, data, shouldInclude = () => true) => {

    const possibleFields = ['uid', 'userId', 'studentId']

    const updatedDocumentIds = new Set()



    for (const field of possibleFields) {

      const q = query(

        collection(db, collectionName),

        where(field, '==', uid)

      )



      const snap = await getDocs(q)



      for (const item of snap.docs) {

        if (updatedDocumentIds.has(item.id)) continue



        const itemData = {

          id: item.id,

          ...item.data()

        }



        if (!shouldInclude(itemData)) continue



        await updateDoc(doc(db, collectionName, item.id), {

          ...data,

          updatedAt: new Date().toISOString()

        })



        updatedDocumentIds.add(item.id)

      }

    }



    return updatedDocumentIds.size

  }



  const deleteResultDocumentsByStudent = async (collectionName, uid, shouldInclude = () => true) => {

    const possibleFields = ['uid', 'userId', 'studentId']

    const deletedDocumentIds = new Set()



    for (const field of possibleFields) {

      const q = query(

        collection(db, collectionName),

        where(field, '==', uid)

      )



      const snap = await getDocs(q)



      for (const item of snap.docs) {

        if (deletedDocumentIds.has(item.id)) continue



        const itemData = {

          id: item.id,

          ...item.data()

        }



        if (!shouldInclude(itemData)) continue



        await deleteDoc(doc(db, collectionName, item.id))

        deletedDocumentIds.add(item.id)

      }

    }



    return deletedDocumentIds.size

  }



  const isMockScore = item =>

    item.source === 'mock_test' ||

    item.source === 'mock' ||

    Boolean(item.mockTestId) ||

    Boolean(item.mockId)



  const updateAssignmentsVisibilityForStudent = async (student, scope, hidden) => {

    if (!student?.id) return 0



    const result = await setStudentAssignmentVisibilityCall({

      studentId: student.id,

      scope,

      hidden

    })



    const affectedAssignments = Number(result.data?.affectedAssignments)

    return Number.isFinite(affectedAssignments) ? affectedAssignments : 0

  }



  const updateHomeworkAssignmentsVisibility = async (student, hidden) => {

    return updateAssignmentsVisibilityForStudent(student, 'homework', hidden)

  }



  const updateMockAssignmentsVisibility = async (student, hidden) => {

    return updateAssignmentsVisibilityForStudent(student, 'mock', hidden)

  }



  const hideStudentRecords = async (student, type) => {

    const isMock = type === 'mock'

    const label = isMock ? 'mock test results' : 'homework results'



    const ok = window.confirm(

      `Hide ${label} for ${student.name || student.email}?\n\nThis will NOT permanently delete data.\nYou can restore it later.`

    )



    if (!ok) return



    try {

      let archivedCount = 0



      if (isMock) {

        archivedCount += await updateResultDocumentsByStudent(

          'mockSubmissions',

          student.id,

          {

            archived: true,

            archivedAt: new Date().toISOString()

          }

        )



        archivedCount += await updateResultDocumentsByStudent(

          'scores',

          student.id,

          {

            archived: true,

            archivedAt: new Date().toISOString()

          },

          isMockScore

        )



        archivedCount += await updateMockAssignmentsVisibility(student, true)

      } else {

        const homeworkCollections = [

          'readingSubmissions',

          'listeningSubmissions',

          'writingSubmissions',

          'vocabularySubmissions'

        ]



        for (const collectionName of homeworkCollections) {

          archivedCount += await updateResultDocumentsByStudent(collectionName, student.id, {

            archived: true,

            archivedAt: new Date().toISOString()

          })

        }



        archivedCount += await updateHomeworkAssignmentsVisibility(student, true)

      }



      alert(`${student.name || student.email}'s ${label} were hidden. Updated ${archivedCount} record(s).`)

    } catch (error) {

      console.error(error)

      alert(`Could not hide ${label}.`)

    }

  }



  const restoreStudentRecords = async (student, type) => {

    const isMock = type === 'mock'

    const label = isMock ? 'mock test results' : 'homework results'



    const ok = window.confirm(

      `Restore hidden ${label} for ${student.name || student.email}?`

    )



    if (!ok) return



    try {

      let restoredCount = 0



      if (isMock) {

        restoredCount += await updateResultDocumentsByStudent(

          'mockSubmissions',

          student.id,

          {

            archived: false,

            restoredAt: new Date().toISOString()

          }

        )



        restoredCount += await updateResultDocumentsByStudent(

          'scores',

          student.id,

          {

            archived: false,

            restoredAt: new Date().toISOString()

          },

          isMockScore

        )



        restoredCount += await updateMockAssignmentsVisibility(student, false)

      } else {

        const homeworkCollections = [

          'readingSubmissions',

          'listeningSubmissions',

          'writingSubmissions',

          'vocabularySubmissions'

        ]



        for (const collectionName of homeworkCollections) {

          restoredCount += await updateResultDocumentsByStudent(collectionName, student.id, {

            archived: false,

            restoredAt: new Date().toISOString()

          })

        }



        restoredCount += await updateHomeworkAssignmentsVisibility(student, false)

      }



      alert(`${student.name || student.email}'s ${label} were restored. Restored/updated ${restoredCount} record(s).`)

    } catch (error) {

      console.error(error)

      alert(`Could not restore ${label}.`)

    }

  }



  const hardDeleteStudentRecords = async (student, type) => {

    const isMock = type === 'mock'

    const label = isMock ? 'mock test results' : 'homework results'



    const ok = window.confirm(

      `PERMANENTLY DELETE ${label} for ${student.name || student.email}?\n\nThis cannot be undone.`

    )



    if (!ok) return



    try {

      let deletedCount = 0



      if (isMock) {

        deletedCount += await deleteResultDocumentsByStudent('mockSubmissions', student.id)

        deletedCount += await deleteResultDocumentsByStudent('scores', student.id, isMockScore)

      } else {

        const homeworkCollections = [

          'readingSubmissions',

          'listeningSubmissions',

          'writingSubmissions',

          'vocabularySubmissions'

        ]



        for (const collectionName of homeworkCollections) {

          deletedCount += await deleteResultDocumentsByStudent(collectionName, student.id)

        }

      }



      alert(`${student.name || student.email}'s ${label} were permanently deleted. Deleted ${deletedCount} record(s).`)

    } catch (error) {

      console.error(error)

      alert(`Could not permanently delete ${label}.`)

    }

  }





  const handleSendPasswordReset = async user => {

    if (!user?.email) {

      alert('This user does not have an email address.')

      return

    }



    const ok = window.confirm(`Send a password reset email to ${user.email}?`)

    if (!ok) return



    try {

      await sendPasswordResetEmail(user.email)

      alert(`Password reset email sent to ${user.email}.`)

    } catch (error) {

      console.error(error)

      alert('Could not send password reset email. Please check Firebase Auth settings.')

    }

  }



  const handleEdit = (u) => {

    setEditUser(u)

    setEditName(u.name || '')

    setEditEmail(u.email || '')

    setEditUsername(usesEmailOnlyAccount(u) ? '' : (u.username || ''))

    setEditRole(u.role || 'student')

    setEditTargetBand(

      u.targetBand !== undefined && u.targetBand !== null

        ? String(u.targetBand)

        : ''

    )

    setEditNewPassword('')

  }



  const handleSaveEdit = async () => {

    const cleanEmail = editEmail.trim().toLowerCase()

    const cleanUsername = usesEmailOnlyAccount(editUser) ? '' : editUsername.trim().toLowerCase()

    const cleanTargetBand = editTargetBand === ''

      ? null

      : Number(editTargetBand)



    if (!cleanEmail || !cleanEmail.includes('@')) {

      alert('Please enter a valid email address.')

      return

    }

    if (cleanUsername && !/^[a-z0-9][a-z0-9._-]{2,39}$/.test(cleanUsername)) {

      alert('Username must be 3-40 characters and use lowercase letters, numbers, dot, underscore or hyphen.')

      return

    }



    if (

      editRole === 'student' &&

      editTargetBand !== '' &&

      (

        Number.isNaN(cleanTargetBand) ||

        cleanTargetBand < 0 ||

        cleanTargetBand > 9 ||

        Math.round(cleanTargetBand * 2) !== cleanTargetBand * 2

      )

    ) {

      alert('Target Band must be between 0 and 9 in 0.5 increments.')

      return

    }



    setEditSaving(true)

    try {

      await updateManagedUserCall({

        userId: editUser.id,

        name: editName,

        email: cleanEmail,

        username: cleanUsername || null,

        targetBand: editRole === 'student' ? cleanTargetBand : null

      })

      setEditUser(null)

      setEditEmail('')

      setEditUsername('')

      setEditTargetBand('')

      setEditNewPassword('')

    } catch (error) {

      console.error(error)

      alert(error?.message || 'Could not update this account.')

    } finally {

      setEditSaving(false)

    }

  }



  const handleSetManagedPassword = async () => {

    if (!editUser) return

    if (editNewPassword.length < 8 || editNewPassword.length > 128) {

      alert('New password must be 8-128 characters.')

      return

    }

    const ok = window.confirm(`Set a new password for ${editUser.name || editUser.email}? The current password cannot be viewed or recovered.`)

    if (!ok) return

    setPasswordSaving(true)

    try {

      await setManagedUserPasswordCall({

        userId: editUser.id,

        password: editNewPassword

      })

      setEditNewPassword('')

      alert('New password set successfully. It was stored only in Firebase Auth.')

    } catch (error) {

      console.error(error)

      alert(error?.message || 'Could not set the new password.')

    } finally {

      setPasswordSaving(false)

    }

  }



  const handleEditScore = (s) => {

    setEditScore(s)

    setEditScoreForm({

      listening: s.listening,

      reading: s.reading,

      writing: s.writing,

      speaking: s.speaking,

      date: s.date

    })

  }



  const normalizeBandInput = value => {

    if (value === '' || value === null || value === undefined) return null



    const numberValue = Number(value)



    if (Number.isNaN(numberValue)) return null



    return numberValue

  }



  const roundToIELTSBand = value => {

    return (Math.round(value * 2) / 2).toFixed(1)

  }



  const handleSaveScore = async () => {

    const scoreFields = ['listening', 'reading', 'writing', 'speaking']



    const normalizedScores = scoreFields.reduce((acc, field) => {

      const value = normalizeBandInput(editScoreForm[field])

      acc[field] = value

      return acc

    }, {})



    const validScores = Object.values(normalizedScores).filter(

      value => value !== null

    )



    if (validScores.length === 0) {

      alert('Please enter at least one score before saving.')

      return

    }



    const invalidScore = validScores.find(value => value < 0 || value > 9)



    if (invalidScore !== undefined) {

      alert('Scores must be between 0 and 9.')

      return

    }



    const avg = validScores.reduce((sum, value) => sum + value, 0) / validScores.length

    const overall = roundToIELTSBand(avg)



    await updateDoc(doc(db, 'scores', editScore.id), {

      ...editScoreForm,

      ...normalizedScores,

      overall

    })



    setEditScore(null)

  }



  const handleLogout = async () => {

    await signOut(auth)

    navigate('/')

  }



  const selectedSchool = selectedSchoolId === ALL_SCHOOLS_ID
    ? null
    : schools.find(school => school.schoolId === selectedSchoolId) || null

  const selfStudyManagers = users.filter(user => isSelfStudyManagerAccount(user))
  const activeSelfStudyManagers = selfStudyManagers.filter(
    user => user.deleted !== true && user.status !== 'deleted'
  )
  const archivedSelfStudyManagers = selfStudyManagers.filter(
    user => user.deleted === true || user.status === 'deleted'
  )

  const nonPlatformUsers = users.filter(user => !isSelfStudyManagerAccount(user))
  const schoolScopedUsers = selectedSchoolId === ALL_SCHOOLS_ID
    ? nonPlatformUsers
    : nonPlatformUsers.filter(user => (user.schoolId || DEFAULT_SCHOOL_ID) === selectedSchoolId)

  const institutionAccountCount = schoolScopedUsers.filter(user => !isIndividualAccount(user)).length
  const individualAccountCount = schoolScopedUsers.filter(user => isIndividualAccount(user)).length
  const showingIndividualAccounts = selectedSchoolId === ALL_SCHOOLS_ID && accountAudienceView === 'individual'

  const accountAudienceScopedUsers = selectedSchoolId !== ALL_SCHOOLS_ID
    ? schoolScopedUsers
    : schoolScopedUsers.filter(user => (
      accountAudienceView === 'individual'
        ? isIndividualAccount(user)
        : !isIndividualAccount(user)
    ))

  const activeSchoolScopedUsers = accountAudienceScopedUsers.filter(
    user => user.deleted !== true && user.status !== 'deleted'
  )

  const archivedSchoolScopedUsers = accountAudienceScopedUsers.filter(
    user => user.deleted === true || user.status === 'deleted'
  )

  const searchTerm = search.toLowerCase()

  const filtered = activeSchoolScopedUsers.filter(u =>

    u.name?.toLowerCase().includes(searchTerm) ||

    u.email?.toLowerCase().includes(searchTerm) ||

    u.username?.toLowerCase().includes(searchTerm)

  )

  const archivedUsers = archivedSchoolScopedUsers.filter(u =>

    u.name?.toLowerCase().includes(searchTerm) ||

    u.email?.toLowerCase().includes(searchTerm) ||

    u.username?.toLowerCase().includes(searchTerm)

  )



  const pendingUsers = filtered.filter(u => u.status === 'pending')

  const rejectedUsers = filtered.filter(u => u.status === 'rejected')



  const students = filtered.filter(

    u => u.role === 'student' && (u.status === 'approved' || !u.status)

  )



  const teachers = filtered.filter(

    u => u.role === 'teacher' && (u.status === 'approved' || !u.status)

  )

  const scopedPendingCount = activeSchoolScopedUsers.filter(u => u.status === 'pending').length
  const scopedStudentCount = activeSchoolScopedUsers.filter(
    u => u.role === 'student' && (u.status === 'approved' || !u.status)
  ).length
  const scopedTeacherCount = activeSchoolScopedUsers.filter(
    u => u.role === 'teacher' && (u.status === 'approved' || !u.status)
  ).length

  const selectedSchoolIsActive = selectedSchoolId === ALL_SCHOOLS_ID
    ? true
    : selectedSchool?.status === 'active'

  const selectedSchoolLabel = selectedSchoolId === ALL_SCHOOLS_ID
    ? (accountAudienceView === 'individual' ? 'Self-Study accounts' : 'All institutions')
    : selectedSchool?.name || selectedSchoolId

  const accountSchool = schools.find(school => school.schoolId === accountForm.schoolId) || null
  const accountSeatLimit = accountForm.role === 'student'
    ? accountSchool?.studentSeatLimit
    : accountSchool?.teacherSeatLimit
  const accountSeatsUsed = accountForm.role === 'student'
    ? Number(accountSchool?.studentSeatsUsed) || 0
    : Number(accountSchool?.teacherSeatsUsed) || 0
  const accountSeatFull = Boolean(
    accountSchool &&
    accountSeatLimit !== null &&
    accountSeatLimit !== undefined &&
    accountSeatsUsed >= Number(accountSeatLimit)
  )

  const approvalSchoolIdFor = userId => pendingSchoolSelections[userId] || (
    selectedSchoolId === ALL_SCHOOLS_ID ? '' : selectedSchoolId
  )

  const approvalSchoolIsActive = userId => {
    const schoolId = approvalSchoolIdFor(userId)
    return Boolean(schoolId) && schools.some(
      school => school.schoolId === schoolId && school.status === 'active'
    )
  }



  // Keep institution scoping completely separate from B2C account scope.
  const openSection = section => {
    setAdminSection(section)
    setSearch('')
    setSelectedStudent(null)
    if (section === 'selfstudy') {
      setSelectedSchoolId(ALL_SCHOOLS_ID)
      setAccountAudienceView('individual')
      setAccountListView(selfStudyTab === 'archived' ? 'archived' : 'active')
    } else if (section === 'users') {
      const validSchool = institutionScope === ALL_SCHOOLS_ID || schools.some(s => s.schoolId === institutionScope)
      const nextSchool = validSchool ? institutionScope : (schools.find(s => s.schoolId === DEFAULT_SCHOOL_ID)?.schoolId || schools[0]?.schoolId || ALL_SCHOOLS_ID)
      setSelectedSchoolId(nextSchool)
      setAccountAudienceView('institution')
      setAccountListView(userTab === 'archived' ? 'archived' : 'active')
      setAccountForm(previous => ({ ...previous, schoolId: nextSchool === ALL_SCHOOLS_ID ? '' : nextSchool }))
    }
  }

  const changeUserTab = tab => {
    setUserTab(tab)
    setAccountListView(tab === 'archived' ? 'archived' : 'active')
    setSelectedStudent(null)
    setSearch('')
  }

  const changeSelfStudyTab = tab => {
    setSelfStudyTab(tab)
    setAccountListView(tab === 'archived' ? 'archived' : 'active')
    setSelectedStudent(null)
    setSearch('')
  }

  const openSchoolEditor = school => {
    if (school) handleEditSchool(school)
    else resetSchoolForm()
    setSchoolEditorTab('identity')
    setSchoolEditorOpen(true)
  }

  const openSchoolUsers = schoolId => {
    handleSchoolScopeChange(schoolId)
    setAdminSection('users')
    changeUserTab('students')
  }

  const allInstitutionUsers = users.filter(u => !isIndividualAccount(u) && !isSelfStudyManagerAccount(u))
  const currentlyActive = u => u.deleted !== true && u.status !== 'deleted' && (u.status === 'approved' || !u.status)
  const totalInstitutionStudents = allInstitutionUsers.filter(u => u.role === 'student' && currentlyActive(u)).length
  const totalInstitutionTeachers = allInstitutionUsers.filter(u => u.role === 'teacher' && currentlyActive(u)).length
  const totalPending = allInstitutionUsers.filter(u => u.deleted !== true && u.status === 'pending').length
  const totalIndividualLearners = users.filter(u => isIndividualAccount(u) && u.role === 'student' && currentlyActive(u)).length
  const activeInstitutions = schools.filter(s => s.status === 'active').length
  const page = ADMIN_NAV_ITEMS.find(item => item.id === adminSection) || ADMIN_NAV_ITEMS[0]

  if (authChecking) {

    return (

      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center">

        <p className="text-gray-400">Checking permissions...</p>

      </div>

    )

  }


  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="min-h-screen lg:flex">
        <aside className="hidden lg:flex lg:w-64 xl:w-72 shrink-0 flex-col border-r border-slate-200 bg-white sticky top-0 h-screen">
          <div className="px-6 py-7 border-b border-slate-100">
            <div className="flex items-center gap-3">
              <img src="/1.png" alt="Maxima" className="h-9 w-auto max-w-[120px] object-contain" />
              <div className="border-l border-slate-200 pl-3">
                <p className="text-xs font-bold tracking-wider text-slate-800">MAXIMA</p>
                <p className="text-[11px] text-slate-500">Administration</p>
              </div>
            </div>
          </div>
          <div className="px-4 py-6 flex-1">
            <p className="px-3 text-[11px] font-semibold uppercase tracking-[.16em] text-slate-400 mb-3">Workspace</p>
            <nav className="space-y-1" aria-label="Admin navigation">
              {ADMIN_NAV_ITEMS.map(item => (
                <button key={item.id} type="button" onClick={() => openSection(item.id)}
                  aria-current={adminSection === item.id ? 'page' : undefined}
                  className={`w-full flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium text-left transition-colors ${adminSection === item.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}>
                  <AdminIcon name={item.icon} />
                  {item.label}
                  {item.id === 'users' && totalPending > 0 && (
                    <span className="ml-auto text-[11px] rounded-md bg-amber-100 px-2 py-0.5 text-amber-800">{totalPending}</span>
                  )}
                </button>
              ))}
            </nav>
            <div className="mt-7 border-t border-slate-100 pt-5">
              <p className="px-3 text-[11px] font-semibold uppercase tracking-[.16em] text-slate-400 mb-3">Tools</p>
              <button type="button" onClick={() => navigate(`/admin/classes?school=${encodeURIComponent(institutionScope)}`)}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900 text-left">
                <AdminIcon name="classes" /> Manage classes <AdminIcon name="arrow" className="w-4 h-4 ml-auto" />
              </button>
            </div>
          </div>
          <div className="px-6 py-5 border-t border-slate-100">
            <div className="flex items-center gap-2 text-xs text-slate-500"><AdminIcon name="shield" className="w-4 h-4" /> Platform admin access</div>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
            <div className="px-4 sm:px-7 lg:px-9 py-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 min-w-0">
                <img src="/1.png" alt="Maxima" className="h-8 w-auto max-w-[105px] object-contain lg:hidden" />
                <span className="text-sm font-semibold text-slate-800 truncate hidden sm:block">Platform administration</span>
                <span className="rounded-md bg-indigo-50 px-2 py-1 text-[11px] font-semibold text-indigo-700">ADMIN</span>
              </div>
              <button type="button" onClick={handleLogout} className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-lg px-2 py-1">
                <AdminIcon name="exit" className="w-4 h-4" /> Sign out
              </button>
            </div>
            <nav className="lg:hidden flex gap-1 px-3 pb-3 overflow-x-auto" aria-label="Mobile admin navigation">
              {ADMIN_NAV_ITEMS.map(item => (
                <button key={item.id} type="button" onClick={() => openSection(item.id)} aria-current={adminSection === item.id ? 'page' : undefined}
                  className={`shrink-0 flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium ${adminSection === item.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}`}>
                  <AdminIcon name={item.icon} className="h-4 w-4" />{item.label}
                </button>
              ))}
              <button type="button" onClick={() => navigate(`/admin/classes?school=${encodeURIComponent(institutionScope)}`)} className="shrink-0 px-3 py-2.5 rounded-lg text-xs text-slate-600 hover:bg-slate-100">Classes</button>
            </nav>
          </header>

          <main className="max-w-[1480px] mx-auto px-4 sm:px-7 lg:px-9 py-7 sm:py-9 pb-20">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
              <div>
                <p className="text-xs font-medium text-indigo-700 mb-2 uppercase tracking-[.12em]">Maxima / Administration</p>
                <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-slate-900">{page.label}</h1>
                <p className="text-sm text-slate-500 mt-2 max-w-2xl">{page.description}</p>
              </div>
              {adminSection === 'users' && (
                <button type="button" onClick={() => setAccountCreatorOpen(v => !v)}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm text-sm font-medium">
                  <AdminIcon name="plus" className="w-4 h-4" /> {accountCreatorOpen ? 'Close form' : 'Create account'}
                </button>
              )}
              {adminSection === 'schools' && (
                <button type="button" onClick={() => openSchoolEditor(null)}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm text-sm font-medium">
                  <AdminIcon name="plus" className="w-4 h-4" /> Add institution
                </button>
              )}
              {adminSection === 'selfstudy' && selfStudyTab === 'managers' && (
                <button type="button" onClick={() => setManagerCreatorOpen(v => !v)}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm text-sm font-medium">
                  <AdminIcon name="plus" className="w-4 h-4" /> {managerCreatorOpen ? 'Close form' : 'Create manager'}
                </button>
              )}
            </div>

            {adminSection === 'overview' && (
              <div className="space-y-7">
                <section className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4" aria-label="Platform statistics">
                  {[
                    { label: 'Active institutions', value: activeInstitutions, detail: `${schools.length} institutions total`, icon: 'schools' },
                    { label: 'Institution students', value: totalInstitutionStudents, detail: 'Active approved accounts', icon: 'users' },
                    { label: 'Institution teachers', value: totalInstitutionTeachers, detail: 'Active approved accounts', icon: 'classes' },
                    { label: 'Pending requests', value: totalPending, detail: 'Requires account review', icon: 'bell' },
                  ].map(metric => (
                    <div key={metric.label} className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-sm min-w-0">
                      <div className="flex justify-between items-center gap-2 text-slate-500"><span className="text-xs font-medium">{metric.label}</span><AdminIcon name={metric.icon} className="h-4 w-4 shrink-0" /></div>
                      <p className="text-3xl font-semibold tracking-tight text-slate-900 mt-4">{metric.value}</p>
                      <p className="text-[11px] sm:text-xs text-slate-500 mt-1">{metric.detail}</p>
                    </div>
                  ))}
                </section>

                <div className="grid grid-cols-1 xl:grid-cols-5 gap-5">
                  <section className="xl:col-span-3 bg-white border border-slate-200 shadow-sm rounded-2xl p-5 sm:p-6">
                    <div className="flex items-start justify-between gap-3 mb-5">
                      <div><h2 className="text-base font-semibold text-slate-900">Quick actions</h2><p className="text-sm text-slate-500 mt-1">The tasks you use most often</p></div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <button type="button" onClick={() => { openSection('users'); setAccountCreatorOpen(true) }}
                        className="text-left flex items-start gap-3 p-4 border border-slate-200 rounded-xl hover:border-indigo-300 hover:bg-indigo-50/50 transition-colors">
                        <div className="rounded-lg bg-indigo-50 text-indigo-700 p-2"><AdminIcon name="plus" /></div>
                        <div><p className="font-medium text-sm text-slate-900">Create an account</p><p className="text-xs text-slate-500 mt-1">Student or teacher</p></div>
                      </button>
                      <button type="button" onClick={() => { openSection('users'); handleSchoolScopeChange(ALL_SCHOOLS_ID); changeUserTab('pending') }}
                        className="text-left flex items-start gap-3 p-4 border border-slate-200 rounded-xl hover:border-indigo-300 hover:bg-indigo-50/50 transition-colors">
                        <div className="rounded-lg bg-amber-50 text-amber-700 p-2"><AdminIcon name="bell" /></div>
                        <div><p className="font-medium text-sm text-slate-900">Review requests</p><p className="text-xs text-slate-500 mt-1">{totalPending} pending across institutions</p></div>
                      </button>
                      <button type="button" onClick={() => openSection('schools')}
                        className="text-left flex items-start gap-3 p-4 border border-slate-200 rounded-xl hover:border-indigo-300 hover:bg-indigo-50/50 transition-colors">
                        <div className="rounded-lg bg-slate-100 text-slate-700 p-2"><AdminIcon name="schools" /></div>
                        <div><p className="font-medium text-sm text-slate-900">Manage institutions</p><p className="text-xs text-slate-500 mt-1">Branding, seats and status</p></div>
                      </button>
                      <button type="button" onClick={() => navigate(`/admin/classes?school=${encodeURIComponent(institutionScope)}`)}
                        className="text-left flex items-start gap-3 p-4 border border-slate-200 rounded-xl hover:border-indigo-300 hover:bg-indigo-50/50 transition-colors">
                        <div className="rounded-lg bg-slate-100 text-slate-700 p-2"><AdminIcon name="classes" /></div>
                        <div><p className="font-medium text-sm text-slate-900">Manage classes</p><p className="text-xs text-slate-500 mt-1">School-scoped class management</p></div>
                      </button>
                    </div>
                  </section>
                  <section className="xl:col-span-2 bg-white border border-slate-200 shadow-sm rounded-2xl p-5 sm:p-6">
                    <div className="flex items-center justify-between gap-3"><h2 className="font-semibold text-slate-900">Self-Study</h2><span className="text-[11px] rounded-md bg-amber-50 text-amber-700 px-2 py-1">Practice paused</span></div>
                    <p className="text-sm text-slate-500 mt-2">Individual practice is temporarily postponed, not cancelled. Accounts and package data remain intact.</p>
                    <div className="grid grid-cols-2 gap-3 mt-5">
                      <div className="rounded-xl border border-slate-100 bg-slate-50 p-4"><p className="text-2xl font-semibold">{totalIndividualLearners}</p><p className="text-xs text-slate-500 mt-1">Individual learners</p></div>
                      <div className="rounded-xl border border-slate-100 bg-slate-50 p-4"><p className="text-2xl font-semibold">{activeSelfStudyManagers.length}</p><p className="text-xs text-slate-500 mt-1">Platform managers</p></div>
                    </div>
                    <button type="button" onClick={() => openSection('selfstudy')} className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-indigo-700 hover:text-indigo-900">View accounts <AdminIcon name="arrow" className="w-4 h-4" /></button>
                  </section>
                </div>
                <section className="rounded-2xl border border-slate-200 bg-white shadow-sm p-5 sm:p-6">
                  <div className="flex items-center justify-between mb-4"><h2 className="font-semibold text-slate-900">Institutions</h2><button type="button" className="text-xs font-medium text-indigo-700 hover:underline" onClick={() => openSection('schools')}>Manage all</button></div>
                  {schoolsLoading ? <p className="text-sm text-slate-500">Loading institutions...</p> : schools.length === 0 ? <p className="text-sm text-slate-500">No institutions configured yet.</p> : (
                    <div className="divide-y divide-slate-100">
                      {schools.map(school => (
                        <div key={school.schoolId} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 py-3 first:pt-0 last:pb-0">
                          <div className="min-w-0"><p className="text-sm font-medium text-slate-800">{school.name}</p><p className="text-xs text-slate-500 mt-0.5">{Number(school.studentSeatsUsed) || 0} students · {Number(school.teacherSeatsUsed) || 0} teachers</p></div>
                          <div className="flex items-center gap-3"><span className={`text-xs ${school.status === 'active' ? 'text-emerald-700' : 'text-slate-500'}`}>{school.status === 'active' ? 'Active' : 'Inactive'}</span><button type="button" onClick={() => openSchoolUsers(school.schoolId)} className="text-xs font-medium text-indigo-700 hover:underline">View users →</button></div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}

            {adminSection === 'schools' && (
              <div className="space-y-5">
                {schoolsError && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 text-red-700 p-4 text-sm">{schoolsError}</div>}
                {schoolNotice && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 p-4 text-sm">{schoolNotice}</div>}
                {schools.length === 0 && !schoolsLoading && (
                  <button type="button" onClick={() => { prepareMaximaSchool(); setSchoolEditorTab('identity'); setSchoolEditorOpen(true) }}
                    className="text-sm rounded-xl bg-indigo-50 text-indigo-700 px-4 py-3 border border-indigo-200">Prepare default Maxima institution</button>
                )}
                {schoolEditorOpen && (
                  <section className="rounded-2xl bg-white border border-indigo-200 shadow-sm p-5 sm:p-6">
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-5">
                      <div><h2 className="font-semibold text-slate-900">{editingSchoolId ? `Edit ${schoolForm.name || editingSchoolId}` : 'New institution'}</h2><p className="text-sm text-slate-500 mt-1">Change details and seats separately from branding and login settings.</p></div>
                      <button type="button" onClick={() => setSchoolEditorOpen(false)} className="text-xs border border-slate-200 px-3 py-2 rounded-lg text-slate-600 hover:bg-slate-50">Close</button>
                    </div>
                    <div role="tablist" aria-label="Institution settings" className="flex flex-wrap gap-2 border-b border-slate-100 pb-4 mb-5">
                      <button type="button" role="tab" aria-selected={schoolEditorTab === 'identity'} onClick={() => setSchoolEditorTab('identity')}
                        className={`text-sm px-4 py-2 rounded-lg ${schoolEditorTab === 'identity' ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-slate-600 hover:bg-slate-50'}`}>Institution & seats</button>
                      <button type="button" role="tab" aria-selected={schoolEditorTab === 'branding'} onClick={() => setSchoolEditorTab('branding')}
                        className={`text-sm px-4 py-2 rounded-lg ${schoolEditorTab === 'branding' ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-slate-600 hover:bg-slate-50'}`}>Branding & login</button>
                    </div>
                    {schoolEditorTab === 'identity' && (
                      <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
          <div className="md:col-span-3">

            <label className="text-xs text-gray-400 mb-1 block">School ID</label>

            <input

              type="text"

              value={schoolForm.schoolId}

              disabled={Boolean(editingSchoolId)}

              onChange={e => setSchoolForm(previous => ({

                ...previous,

                schoolId: normalizeSchoolIdInput(e.target.value)

              }))}

              placeholder="example-college"

              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 disabled:bg-gray-100 disabled:text-gray-400"

            />

          </div>



          <div className="md:col-span-5">

            <label className="text-xs text-gray-400 mb-1 block">School name</label>

            <input

              type="text"

              value={schoolForm.name}

              onChange={e => setSchoolForm(previous => ({

                ...previous,

                name: e.target.value

              }))}

              placeholder="Example College"

              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400"

            />

          </div>



          <div className="md:col-span-2">

            <label className="text-xs text-gray-400 mb-1 block">Status</label>

            <select

              value={schoolForm.status}

              onChange={e => setSchoolForm(previous => ({

                ...previous,

                status: e.target.value

              }))}

              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"

            >

              <option value="active">Active</option>

              <option value="inactive">Inactive</option>

            </select>

          </div>
          <div className="md:col-span-3">

            <label className="text-xs text-gray-400 mb-1 block">Student seat limit</label>

            <input

              inputMode="numeric"

              value={schoolForm.studentSeatLimit}

              onChange={e => setSchoolForm(previous => ({

                ...previous,

                studentSeatLimit: normalizeSeatLimitInput(e.target.value)

              }))}

              placeholder="Unlimited"

              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400"

            />

          </div>



          <div className="md:col-span-3">

            <label className="text-xs text-gray-400 mb-1 block">Teacher seat limit</label>

            <input

              inputMode="numeric"

              value={schoolForm.teacherSeatLimit}

              onChange={e => setSchoolForm(previous => ({

                ...previous,

                teacherSeatLimit: normalizeSeatLimitInput(e.target.value)

              }))}

              placeholder="Unlimited"

              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400"

            />

          </div>



          <div className="md:col-span-6 text-xs text-gray-400 pb-2">
            Blank = Unlimited. Active approved accounts consume seats; Archived, Pending and Rejected accounts do not.
          </div>
                      </div>
                    )}
                    {schoolEditorTab === 'branding' && (
                      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
          <div className="md:col-span-4">
            <label className="text-xs text-gray-400 mb-1 block">Institution logo</label>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleSchoolLogoFileChange}
              className="w-full text-xs border border-gray-200 rounded-xl px-3 py-2 bg-white file:mr-3 file:border-0 file:bg-purple-50 file:text-purple-700 file:px-3 file:py-1.5 file:rounded-lg"
            />
            <p className="text-[11px] text-gray-400 mt-1">PNG, JPG/JPEG or WebP. Maximum 2 MB.</p>
            {(schoolLogoUrl || schoolLogoRemove || schoolForm.logoPath) && (
              <div className="mt-2 flex items-center gap-3 flex-wrap">
                {schoolLogoUrl && !schoolLogoRemove && (
                  <div className="h-14 w-28 border border-gray-100 rounded-lg bg-white p-2 flex items-center justify-center">
                    <img src={schoolLogoUrl} alt="Institution logo preview" className="max-h-full max-w-full object-contain" />
                  </div>
                )}
                {schoolLogoRemove ? (
                  <button type="button" onClick={restoreStoredSchoolLogo} className="text-xs text-purple-600 hover:text-purple-700">Undo logo removal</button>
                ) : schoolForm.logoPath ? (
                  <button type="button" onClick={removeStoredSchoolLogo} className="text-xs text-red-500 hover:text-red-600">Remove current logo</button>
                ) : null}
              </div>
            )}
          </div>

          <div className="md:col-span-2">
            <label className="text-xs text-gray-400 mb-1 block">Primary color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={schoolForm.primaryColor}
                onChange={e => setSchoolForm(previous => ({ ...previous, primaryColor: e.target.value }))}
                className="h-10 w-12 border border-gray-200 rounded-lg bg-white p-1"
              />
              <span className="text-xs font-mono text-gray-500">{schoolForm.primaryColor}</span>
            </div>
          </div>

          <div className="md:col-span-2">
            <label className="text-xs text-gray-400 mb-1 block">Accent color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={schoolForm.accentColor}
                onChange={e => setSchoolForm(previous => ({ ...previous, accentColor: e.target.value }))}
                className="h-10 w-12 border border-gray-200 rounded-lg bg-white p-1"
              />
              <span className="text-xs font-mono text-gray-500">{schoolForm.accentColor}</span>
            </div>
          </div>

          <div className="md:col-span-4">
            <label className="text-xs text-gray-400 mb-1 block">Login preference</label>
            <select
              value={schoolForm.loginPreference}
              onChange={e => setSchoolForm(previous => ({ ...previous, loginPreference: e.target.value }))}
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"
            >
              <option value="both">Both methods · Email first</option>
              <option value="email">Prefer email</option>
              <option value="username">Prefer school username</option>
            </select>
            <p className="text-[11px] text-gray-400 mt-1">Preference controls the branded login experience; it does not disable the other Firebase sign-in method.</p>
          </div>
                      </div>
                    )}
                    <div className="flex flex-wrap justify-end gap-3 mt-6 border-t border-slate-100 pt-5">
                      <button type="button" onClick={() => setSchoolEditorOpen(false)} disabled={schoolSaving} className="px-4 py-2.5 text-sm text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50">Cancel</button>
                      <button type="button" onClick={handleSaveSchool} disabled={schoolSaving} className="px-5 py-2.5 text-sm font-medium bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-50">{schoolSaving ? 'Saving...' : editingSchoolId ? 'Save changes' : 'Create institution'}</button>
                    </div>
                  </section>
                )}
                <section className="rounded-2xl bg-white border border-slate-200 shadow-sm p-5 sm:p-6">
                  <div className="flex items-center justify-between gap-2 mb-4"><div><h2 className="text-base font-semibold">Institution directory</h2><p className="text-sm text-slate-500 mt-1">{schools.length} institution(s). Manage accounts and settings without leaving this area.</p></div></div>
                  {schoolsLoading ? <p className="py-8 text-sm text-slate-500 text-center">Loading institutions...</p> : schools.length === 0 ? <p className="py-8 text-sm text-slate-500 text-center">No institutions have been added.</p> : (
                    <div className="divide-y divide-slate-100">
                      {schools.map(school => (
                        <div key={school.schoolId} className="grid lg:grid-cols-[minmax(0,1fr)_auto] gap-3 lg:items-center py-5 first:pt-1 last:pb-1">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium text-slate-900">{school.name}</h3><span className={`text-[11px] rounded-md px-2 py-0.5 ${school.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{school.status === 'active' ? 'Active' : 'Inactive'}</span></div>
                            <p className="text-xs text-slate-500 mt-1">ID: <span className="font-mono">{school.schoolId}</span></p>
                            <p className="text-xs text-slate-600 mt-2">Students <strong>{Number(school.studentSeatsUsed) || 0}</strong> / {seatLimitLabel(school.studentSeatLimit)} <span className="mx-2 text-slate-300">·</span> Teachers <strong>{Number(school.teacherSeatsUsed) || 0}</strong> / {seatLimitLabel(school.teacherSeatLimit)}</p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                            <button type="button" onClick={() => openSchoolUsers(school.schoolId)} className="text-xs font-medium px-3 py-2 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100">View users</button>
                            <button type="button" onClick={() => openSchoolEditor(school)} className="text-xs font-medium px-3 py-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50">Settings</button>
                            <details className="relative">
                              <summary className="cursor-pointer list-none text-xs px-3 py-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50">More ▾</summary>
                              <div className="absolute right-0 z-30 mt-2 min-w-48 bg-white border border-slate-200 shadow-xl rounded-xl p-2 flex flex-col gap-1">
                                <button type="button" disabled={schoolSaving} onClick={() => handleToggleSchoolStatus(school)} className="text-left px-3 py-2 rounded-lg text-xs hover:bg-slate-50 disabled:opacity-50">{school.status === 'active' ? 'Deactivate institution' : 'Activate institution'}</button>
                                {school.status === 'inactive' && school.schoolId !== DEFAULT_SCHOOL_ID && <button type="button" disabled={schoolSaving} onClick={() => handleDeleteSchool(school)} className="text-left px-3 py-2 rounded-lg text-xs text-red-700 hover:bg-red-50 disabled:opacity-50">Delete institution & all data</button>}
                              </div>
                            </details>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}

            {adminSection === 'users' && (
              <div className="space-y-5">
                <div className="bg-white border border-slate-200 shadow-sm rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div className="min-w-0"><p className="text-sm font-medium text-slate-800">Institution scope</p><p className="text-xs text-slate-500 mt-1">Account lists and approvals follow this selection. Individual learners are managed separately.</p></div>
                  <div className="w-full sm:w-72 shrink-0">
                    <label htmlFor="admin-institution-scope" className="sr-only">Select institution</label>
                    <select id="admin-institution-scope" value={selectedSchoolId} disabled={schoolsLoading} onChange={e => handleSchoolScopeChange(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2.5 text-sm bg-white focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 outline-none">
                      {schools.map(school => <option key={school.schoolId} value={school.schoolId}>{school.name}{school.status !== 'active' ? ' (Inactive)' : ''}</option>)}
                      <option value={ALL_SCHOOLS_ID}>All institutions</option>
                    </select>
                  </div>
                </div>
                {selectedSchool && selectedSchool.status !== 'active' && <div role="status" className="border border-amber-200 bg-amber-50 text-amber-800 text-sm rounded-xl p-4">This institution is inactive. Account creation and approvals are unavailable until it is reactivated.</div>}
                {accountNotice && !accountCreatorOpen && <div role="status" className="border border-emerald-200 bg-emerald-50 text-emerald-700 p-4 text-sm rounded-xl">{accountNotice}</div>}
                {accountCreatorOpen && (
                  <section className="rounded-2xl border border-indigo-200 bg-white shadow-sm p-5 sm:p-6">
                    <div className="flex justify-between items-start gap-3 mb-5"><div><h2 className="text-base font-semibold">Create institution account</h2><p className="text-sm text-slate-500 mt-1">Create a student or teacher account in an active institution.</p></div><button type="button" onClick={() => setAccountCreatorOpen(false)} className="text-xs rounded-lg px-3 py-2 border border-slate-200">Close</button></div>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">

          <div className="md:col-span-3">

            <label className="text-xs text-gray-400 mb-1 block">Full name</label>

            <input

              value={accountForm.name}

              onChange={e => setAccountForm(previous => ({ ...previous, name: e.target.value }))}

              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400"

              placeholder="Student or teacher name"

            />

          </div>



          <div className="md:col-span-3">

            <label className="text-xs text-gray-400 mb-1 block">Email</label>

            <input

              type="email"

              value={accountForm.email}

              onChange={e => setAccountForm(previous => ({ ...previous, email: e.target.value }))}

              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400"

              placeholder="name@example.com"

            />

          </div>



          <div className="md:col-span-2">

            <label className="text-xs text-gray-400 mb-1 block">Username (optional)</label>

            <input

              value={accountForm.username}

              onChange={e => setAccountForm(previous => ({ ...previous, username: e.target.value.toLowerCase() }))}

              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400"

              placeholder="student01"

              autoCapitalize="none"

              autoCorrect="off"

            />

          </div>



          <div className="md:col-span-2">

            <label className="text-xs text-gray-400 mb-1 block">School</label>

            <select

              value={accountForm.schoolId}

              onChange={e => setAccountForm(previous => ({ ...previous, schoolId: e.target.value }))}

              disabled={selectedSchoolId !== ALL_SCHOOLS_ID}

              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white disabled:bg-gray-100 disabled:text-gray-500"

            >

              <option value="" disabled>Select school</option>

              {schools.map(school => (

                <option key={school.schoolId} value={school.schoolId} disabled={school.status !== 'active'}>

                  {school.name}{school.status !== 'active' ? ' (Inactive)' : ''}

                </option>

              ))}

            </select>

          </div>



          <div className="md:col-span-2">

            <label className="text-xs text-gray-400 mb-1 block">Role</label>

            <select

              value={accountForm.role}

              onChange={e => setAccountForm(previous => ({ ...previous, role: e.target.value }))}

              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"

            >

              <option value="student">Student</option>

              <option value="teacher">Teacher</option>

            </select>

          </div>



          <div className="md:col-span-2">

            <label className="text-xs text-gray-400 mb-1 block">Target Band</label>

            <input

              type="number"

              min="0"

              max="9"

              step="0.5"

              disabled={accountForm.role !== 'student'}

              value={accountForm.targetBand}

              onChange={e => setAccountForm(previous => ({ ...previous, targetBand: e.target.value }))}

              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 disabled:bg-gray-100 disabled:text-gray-400"

              placeholder="6.5"

            />

          </div>

        </div>



        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mt-4">

          <div className="min-h-5">

            {accountSchool && (
              <p className={`text-xs ${accountSeatFull ? 'text-amber-700' : 'text-gray-500'}`}>
                {accountForm.role === 'student' ? 'Student' : 'Teacher'} seats: {accountSeatsUsed} / {seatLimitLabel(accountSeatLimit)}
                {accountSeatFull ? ' — quota full' : ''}
              </p>
            )}

            {accountError && <p className="text-xs text-red-600 mt-1">{accountError}</p>}

            {accountNotice && <p className="text-xs text-green-700 mt-1">{accountNotice}</p>}

          </div>

          <button

            onClick={handleCreateManagedUser}

            disabled={
              accountCreating ||
              schoolsLoading ||
              !accountForm.schoolId ||
              accountSeatFull ||
              !schools.some(school => school.schoolId === accountForm.schoolId && school.status === 'active')
            }

            className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white px-5 py-2.5 rounded-xl text-sm font-medium"

          >

            {accountCreating ? 'Creating...' : 'Create account'}

          </button>

        </div>
                  </section>
                )}
                <section className="bg-white border border-slate-200 shadow-sm rounded-2xl p-4 sm:p-5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
                    <div><h2 className="font-semibold">Institution accounts</h2><p className="text-sm text-slate-500 mt-1">{selectedSchoolLabel} · {scopedStudentCount} students · {scopedTeacherCount} teachers</p></div>
                    <div className="relative w-full sm:w-80">
                      <AdminIcon name="search" className="w-4 h-4 absolute top-3.5 left-3 text-slate-400" />
                      <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, email or username" aria-label="Search institution accounts" className="w-full pl-9 pr-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:border-indigo-400" />
                    </div>
                  </div>
                  <div role="tablist" aria-label="Institution account categories" className="flex flex-wrap gap-2">
                    {[
                      { id: 'students', label: 'Students', count: scopedStudentCount },
                      { id: 'teachers', label: 'Teachers', count: scopedTeacherCount },
                      { id: 'pending', label: 'Approvals', count: scopedPendingCount },
                      { id: 'archived', label: 'Archive', count: archivedSchoolScopedUsers.length },
                    ].map(tab => <button key={tab.id} type="button" role="tab" aria-selected={userTab === tab.id} onClick={() => changeUserTab(tab.id)}
                      className={`px-3 sm:px-4 py-2 text-xs sm:text-sm font-medium rounded-lg border ${userTab === tab.id ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>{tab.label} <span className="ml-1 text-xs opacity-70">{tab.count}</span></button>)}
                  </div>
                </section>
                {userTab === 'pending' && (
                  <div className="space-y-5">
        {!showingIndividualAccounts && (
        <div className={accountListView === 'active' ? 'mb-8' : 'hidden'}>

          <h2 className="font-semibold text-orange-600 mb-3">Pending Approvals ({pendingUsers.length})</h2>

          <div className="bg-white border border-gray-100 rounded-2xl overflow-hidden">

            {pendingUsers.length === 0 ? (

              <p className="text-gray-400 text-sm text-center py-8">No pending approvals.</p>

            ) : pendingUsers.map(u => (

              <div key={u.id} className="flex items-center justify-between px-5 py-4 border-b border-gray-50 last:border-0">

                <div>

                  <p className="text-sm font-medium text-gray-800">{u.name}</p>

                  <p className="text-xs text-gray-400">{u.email}</p>
                  {u.username && <p className="text-[11px] text-purple-500 mt-0.5">Username: {u.username}</p>}

                  {u.role === 'student' && (

                    <p className="text-xs text-blue-500 mt-0.5">

                      Target Band: {u.targetBand !== undefined && u.targetBand !== null ? Number(u.targetBand).toFixed(1) : 'Not set'}

                    </p>

                  )}

                  <p className="text-xs text-orange-500 mt-1">Requested role: {u.requestedRole}</p>

                </div>



                <div className="flex gap-2 items-center flex-wrap justify-end">

                  <select

                    value={approvalSchoolIdFor(u.id)}

                    onChange={e => setPendingSchoolSelections(previous => ({ ...previous, [u.id]: e.target.value }))}

                    disabled={selectedSchoolId !== ALL_SCHOOLS_ID}

                    className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white disabled:bg-gray-100 disabled:text-gray-500"

                  >

                    <option value="" disabled>Select school</option>

                    {schools.map(school => (

                      <option key={school.schoolId} value={school.schoolId} disabled={school.status !== 'active'}>

                        {school.name}{school.status !== 'active' ? ' (Inactive)' : ''}

                      </option>

                    ))}

                  </select>

                  <button disabled={!approvalSchoolIsActive(u.id)} onClick={() => approveUser(u.id, 'student')} className="text-xs bg-purple-100 hover:bg-purple-200 disabled:bg-gray-100 disabled:text-gray-400 text-purple-700 px-3 py-1.5 rounded-lg">Approve Student</button>

                  <button disabled={!approvalSchoolIsActive(u.id)} onClick={() => approveUser(u.id, 'teacher')} className="text-xs bg-green-100 hover:bg-green-200 disabled:bg-gray-100 disabled:text-gray-400 text-green-700 px-3 py-1.5 rounded-lg">Approve Teacher</button>

                  <button onClick={() => rejectUser(u.id)} className="text-xs bg-red-50 hover:bg-red-100 text-red-500 px-3 py-1.5 rounded-lg">Reject</button>

                </div>

              </div>

            ))}

          </div>

        </div>
        )}

        {!showingIndividualAccounts && accountListView === 'active' && rejectedUsers.length > 0 && (

          <div className="mb-8">

            <h2 className="font-semibold text-red-500 mb-3">Rejected Users ({rejectedUsers.length})</h2>

            <div className="bg-white border border-gray-100 rounded-2xl overflow-hidden">

              {rejectedUsers.map(u => (

                <div key={u.id} className="flex items-center justify-between px-5 py-4 border-b border-gray-50 last:border-0">

                  <div>

                    <p className="text-sm font-medium text-gray-800">{u.name}</p>

                    <p className="text-xs text-gray-400">{u.email}</p>
                  {u.username && <p className="text-[11px] text-purple-500 mt-0.5">Username: {u.username}</p>}

                  {u.role === 'student' && (

                    <p className="text-xs text-blue-500 mt-0.5">

                      Target Band: {u.targetBand !== undefined && u.targetBand !== null ? Number(u.targetBand).toFixed(1) : 'Not set'}

                    </p>

                  )}

                  </div>



                  <div className="flex gap-2 items-center flex-wrap justify-end">

                    <select

                      value={approvalSchoolIdFor(u.id)}

                      onChange={e => setPendingSchoolSelections(previous => ({ ...previous, [u.id]: e.target.value }))}

                      disabled={selectedSchoolId !== ALL_SCHOOLS_ID}

                      className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white disabled:bg-gray-100 disabled:text-gray-500"

                    >

                      <option value="" disabled>Select school</option>

                      {schools.map(school => (

                        <option key={school.schoolId} value={school.schoolId} disabled={school.status !== 'active'}>

                          {school.name}{school.status !== 'active' ? ' (Inactive)' : ''}

                        </option>

                      ))}

                    </select>

                    <button disabled={!approvalSchoolIsActive(u.id)} onClick={() => approveUser(u.id, 'student')} className="text-xs bg-purple-100 hover:bg-purple-200 disabled:bg-gray-100 disabled:text-gray-400 text-purple-700 px-3 py-1.5 rounded-lg">Approve Student</button>

                    <button disabled={!approvalSchoolIsActive(u.id)} onClick={() => approveUser(u.id, 'teacher')} className="text-xs bg-green-100 hover:bg-green-200 disabled:bg-gray-100 disabled:text-gray-400 text-green-700 px-3 py-1.5 rounded-lg">Approve Teacher</button>

                    <button onClick={() => handleDelete(u.id)} className="text-xs bg-amber-50 hover:bg-amber-100 text-amber-700 px-3 py-1.5 rounded-lg">Archive</button>

                  </div>

                </div>

              ))}

            </div>

          </div>

        )}
                  </div>
                )}
                {userTab === 'archived' && (
                  <>
        {accountListView === 'archived' && archivedUsers.length > 0 && (

          <div className="mb-8">

            <h2 className="font-semibold text-gray-600 mb-3">Archived Accounts ({archivedUsers.length})</h2>

            <div className="bg-white border border-gray-100 rounded-2xl overflow-hidden">

              {archivedUsers.map(u => (

                <div key={u.id} className="flex items-center justify-between gap-4 px-5 py-4 border-b border-gray-50 last:border-0">

                  <div className="min-w-0">

                    <div className="flex items-center gap-2 flex-wrap">

                      <p className="text-sm font-medium text-gray-700">{u.name || 'Unnamed account'}</p>

                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">Archived</span>

                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-600">{u.role || u.requestedRole || 'account'}</span>

                    </div>

                    <p className="text-xs text-gray-400 truncate">{u.email}</p>

                    {u.username && <p className="text-[11px] text-purple-500 mt-0.5">Username: {u.username}</p>}

                    <p className="text-[11px] text-gray-400 mt-0.5">{isIndividualAccount(u) ? 'Account: Self-Study / Individual' : `School: ${schoolLabel(u.schoolId)}`}</p>

                  </div>

                  <div className="flex items-center gap-2 flex-wrap justify-end">

                    {['student', 'teacher'].includes((u.role || u.requestedRole || '').toLowerCase()) ? (
                      <button
                        disabled={restoreBusyId === u.id || permanentDeleteBusyId === u.id}
                        onClick={() => handleRestoreManagedUser(u)}
                        className="text-xs bg-green-100 hover:bg-green-200 disabled:bg-gray-100 disabled:text-gray-400 text-green-700 px-3 py-1.5 rounded-lg"
                      >
                        {restoreBusyId === u.id ? 'Restoring...' : 'Restore Account'}
                      </button>
                    ) : (
                      <span className="text-xs text-gray-400">Restore unavailable: role unknown</span>
                    )}

                    {(u.role || u.requestedRole) === 'admin' ? (

                      <span className="text-xs text-gray-400">Admin accounts cannot be permanently deleted here</span>

                    ) : (

                      <button
                        disabled={permanentDeleteBusyId === u.id}
                        onClick={() => handlePermanentDeleteUser(u)}
                        className="text-xs bg-red-100 hover:bg-red-200 disabled:bg-gray-100 disabled:text-gray-400 text-red-700 px-3 py-1.5 rounded-lg"
                      >
                        {permanentDeleteBusyId === u.id ? 'Deleting...' : 'Delete Permanently'}
                      </button>

                    )}

                  </div>

                </div>

              ))}

            </div>

          </div>

        )}



        {accountListView === 'archived' && archivedUsers.length === 0 && (
          <div className="mb-8 bg-white border border-gray-100 rounded-2xl p-8 text-center text-gray-400 text-sm">
            No archived accounts found.
          </div>
        )}
                  </>
                )}
                {userTab === 'teachers' && (
                  <>
        {!showingIndividualAccounts && (
        <div className={accountListView === 'active' ? 'mb-8' : 'hidden'}>

          <h2 className="font-semibold text-gray-700 mb-3">Teachers ({teachers.length})</h2>

          <div className="bg-white border border-slate-200 rounded-2xl overflow-visible shadow-sm">

            {teachers.length === 0 ? (

              <p className="text-gray-400 text-sm text-center py-8">No teachers found.</p>

            ) : teachers.map(u => (

              <div key={u.id} className="flex items-center justify-between px-5 py-4 border-b border-gray-50 last:border-0">

                <div className="flex items-center gap-3">

                  <div className="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center text-green-600 font-semibold text-sm">

                    {u.name?.charAt(0).toUpperCase()}

                  </div>

                  <div>

                    <p className="text-sm font-medium text-gray-800">{u.name}</p>

                    <p className="text-xs text-gray-400">{u.email}</p>
                  {u.username && <p className="text-[11px] text-purple-500 mt-0.5">Username: {u.username}</p>}

                  <p className="text-[11px] text-gray-400 mt-0.5">{isIndividualAccount(u) ? 'Account: Self-Study / Individual' : `School: ${schoolLabel(u.schoolId)}`}</p>

                  {u.role === 'student' && (

                    <p className="text-xs text-blue-500 mt-0.5">

                      Target Band: {u.targetBand !== undefined && u.targetBand !== null ? Number(u.targetBand).toFixed(1) : 'Not set'}

                    </p>

                  )}

                  </div>

                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={() => handleEdit(u)} className="text-xs px-3 py-2 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100">Edit</button>
                  <details className="relative">
                    <summary className="cursor-pointer list-none text-xs px-3 py-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50">More ▾</summary>
                    <div className="absolute right-0 z-20 mt-2 w-48 rounded-xl border border-slate-200 bg-white p-2 shadow-xl flex flex-col gap-1">
                      <button onClick={() => handleSendPasswordReset(u)} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-slate-50">Password reset</button>
                      <button onClick={() => handleDelete(u.id)} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-amber-50 text-amber-700">Archive account</button>
                    </div>
                  </details>
                </div>

              </div>

            ))}

          </div>

        </div>
        )}
                  </>
                )}
                {userTab === 'students' && (
        <div className={accountListView === 'active' ? '' : 'hidden'}>

          <h2 className="font-semibold text-gray-700 mb-3">{showingIndividualAccounts ? 'Self-Study Learners' : 'Students'} ({students.length})</h2>

          <div className="flex flex-col gap-3">

            {students.length === 0 ? (

              <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center text-gray-400 text-sm">{showingIndividualAccounts ? 'No self-study accounts found.' : 'No students found.'}</div>

            ) : students.map(u => (

              <div key={u.id} className="bg-white border border-slate-200 rounded-2xl overflow-visible shadow-sm">

                <div

                  className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 px-5 py-4 hover:bg-slate-50"

                >

                  <div className="flex items-center gap-3">

                    <div className="w-9 h-9 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 font-semibold text-sm">

                      {u.name?.charAt(0).toUpperCase()}

                    </div>

                    <div>

                      <p className="text-sm font-medium text-gray-800">{u.name}</p>

                      <p className="text-xs text-gray-400">{u.email}</p>
                  {u.username && <p className="text-[11px] text-purple-500 mt-0.5">Username: {u.username}</p>}

                    <p className="text-[11px] text-gray-400 mt-0.5">{isIndividualAccount(u) ? 'Account: Self-Study / Individual' : `School: ${schoolLabel(u.schoolId)}`}</p>

                  {u.role === 'student' && (

                    <p className="text-xs text-blue-500 mt-0.5">

                      Target Band: {u.targetBand !== undefined && u.targetBand !== null ? Number(u.targetBand).toFixed(1) : 'Not set'}

                    </p>

                  )}

                    </div>

                  </div>

                  <div className="flex items-center gap-2 flex-wrap lg:justify-end">
                    <button type="button" onClick={() => setSelectedStudent(selectedStudent === u.id ? null : u.id)}
                      aria-expanded={selectedStudent === u.id}
                      className="text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-700 hover:bg-slate-100">
                      {selectedStudent === u.id ? 'Hide mock history' : 'Mock history'}
                    </button>
                    <button type="button" onClick={() => handleEdit(u)}
                      className="text-xs border border-indigo-200 rounded-lg px-3 py-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-medium">Edit</button>
                    <details className="relative" onClick={e => e.stopPropagation()}>
                      <summary className="cursor-pointer list-none text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-700 hover:bg-slate-100 select-none">More actions ▾</summary>
                      <div className="absolute right-0 z-30 mt-2 w-56 max-h-[65vh] overflow-auto rounded-xl border border-slate-200 bg-white shadow-xl p-2 flex flex-col gap-1">
                        <button type="button" onClick={() => handleSendPasswordReset(u)} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-slate-50 text-slate-700">Send password reset</button>
                        {!isIndividualAccount(u) && (
                          <>
                            <p className="px-3 pt-2 text-[11px] font-semibold text-slate-400 uppercase">Mock results</p>
                            <button type="button" onClick={() => hideStudentRecords(u, 'mock')} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-slate-50">Hide mock results</button>
                            <button type="button" onClick={() => restoreStudentRecords(u, 'mock')} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-slate-50">Restore mock results</button>
                            <button type="button" onClick={() => hardDeleteStudentRecords(u, 'mock')} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-red-50 text-red-700">Delete mock results</button>
                            <p className="px-3 pt-2 text-[11px] font-semibold text-slate-400 uppercase">Homework</p>
                            <button type="button" onClick={() => hideStudentRecords(u, 'homework')} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-slate-50">Hide homework</button>
                            <button type="button" onClick={() => restoreStudentRecords(u, 'homework')} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-slate-50">Restore homework</button>
                            <button type="button" onClick={() => hardDeleteStudentRecords(u, 'homework')} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-red-50 text-red-700">Delete homework records</button>
                          </>
                        )}
                        <div className="border-t border-slate-100 mt-1 pt-1 flex flex-col gap-1">
                          <button type="button" onClick={() => handleDelete(u.id)} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-amber-50 text-amber-700">Archive account</button>
                          <button type="button" disabled={permanentDeleteBusyId === u.id} onClick={() => handlePermanentDeleteUser(u)}
                            className="text-left text-xs px-3 py-2 rounded-lg hover:bg-red-50 text-red-700 disabled:opacity-40">{permanentDeleteBusyId === u.id ? 'Deleting...' : 'Permanently delete account'}</button>
                        </div>
                      </div>
                    </details>
                  </div>

                </div>



                {selectedStudent === u.id && (

                  <div className="border-t border-gray-100 px-5 py-4">

                    <h3 className="text-sm font-semibold text-gray-700 mb-1">Mock history</h3>

                    <p className="text-xs text-gray-400 mb-3">

                      Manual IELTS score logging is no longer used. This area shows mock scores only.

                    </p>

                    {(() => {

                      const mockScores = (scores[u.id] || []).filter(isMockScore)



                      if (mockScores.length === 0) {

                        return (

                          <p className="text-xs text-gray-400">

                            No visible mock scores yet. Use More actions to restore hidden results.

                          </p>

                        )

                      }



                      return (

                        <div className="flex flex-col gap-2">

                          {mockScores.map(s => (

                            <div key={s.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">

                              <div>

                                <p className="text-sm text-gray-700">{s.date || 'No date'}</p>
                                {s.excludedFromStats === true && (
                                  <span className="text-[10px] font-semibold text-amber-700">Excluded from statistics</span>
                                )}

                                <p className="text-xs text-gray-400">

                                  L:{s.listening || '-'} R:{s.reading || '-'} W:{s.writing || 'Pending'} Overall:{s.overall || '-'}

                                </p>

                              </div>

                              <div className="flex items-center gap-2">

                                <p className="text-lg font-bold text-purple-600">{s.overall || '-'}</p>

                                <button onClick={() => handleEditScore(s)} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-2 py-1 rounded-lg">Edit</button>

                                <button onClick={() => handleDeleteScore(s.id)} className="text-xs bg-red-50 hover:bg-red-100 text-red-500 px-2 py-1 rounded-lg">Delete</button>

                              </div>

                            </div>

                          ))}

                        </div>

                      )

                    })()}

                  </div>

                )}

              </div>

            ))}

          </div>

        </div>
                )}
              </div>
            )}

            {adminSection === 'selfstudy' && (
              <div className="space-y-5">
                <div className="rounded-2xl border border-amber-200 bg-amber-50/70 px-5 py-4">
                  <div className="flex gap-3 items-start"><AdminIcon name="shield" className="w-5 h-5 shrink-0 text-amber-700 mt-0.5" /><div><p className="text-sm font-semibold text-amber-900">Individual practice temporarily postponed</p><p className="text-sm text-amber-800 mt-1">The learner practice interface is paused, not cancelled. Account management, packages and existing data are preserved.</p></div></div>
                </div>
                <section className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4 sm:p-5">
                  <div className="flex justify-between items-start gap-3 mb-4"><div><h2 className="font-semibold">Self-Study administration</h2><p className="text-xs text-slate-500 mt-1">Individual users never consume institution seats.</p></div><span className="text-xs rounded-lg bg-slate-100 text-slate-600 px-2 py-1">Separate scope</span></div>
                  <div role="tablist" aria-label="Self-Study accounts" className="flex flex-wrap gap-2">
                    {[
                      { id: 'learners', label: 'Individual learners', count: totalIndividualLearners },
                      { id: 'managers', label: 'Platform managers', count: activeSelfStudyManagers.length },
                      { id: 'archived', label: 'Learner archive', count: archivedSchoolScopedUsers.length }
                    ].map(tab => <button key={tab.id} type="button" role="tab" aria-selected={selfStudyTab === tab.id} onClick={() => changeSelfStudyTab(tab.id)} className={`px-3 sm:px-4 py-2 rounded-lg text-sm border font-medium ${selfStudyTab === tab.id ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'text-slate-600 border-slate-200 hover:bg-slate-50'}`}>{tab.label} <span className="text-xs ml-1 opacity-70">{tab.count}</span></button>)}
                  </div>
                  {selfStudyTab !== 'managers' && <div className="relative mt-4"><AdminIcon name="search" className="absolute left-3 top-3.5 w-4 h-4 text-slate-400" /><input type="search" aria-label="Search individual learners" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search individuals by name or email" className="w-full pl-9 pr-3 py-2.5 text-sm border border-slate-200 rounded-xl outline-none focus:border-indigo-400" /></div>}
                </section>
                {selfStudyTab === 'managers' && (
                  <section className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 sm:p-6">
                    <div className="flex justify-between gap-2 items-start mb-4"><div><h2 className="font-semibold">Platform managers</h2><p className="text-sm text-slate-500 mt-1">Email-only management accounts without institution membership.</p></div><span className="text-xs text-slate-500">{activeSelfStudyManagers.length} active · {archivedSelfStudyManagers.length} archived</span></div>
                    {managerNotice && !managerCreatorOpen && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm p-3 mb-4">{managerNotice}</div>}
                    {managerCreatorOpen && (
                      <div className="rounded-xl border border-indigo-200 bg-slate-50 p-4 mb-5">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end bg-[#faf9f6] border border-gray-100 rounded-xl p-4 mb-4">
          <div className="md:col-span-5">
            <label className="text-xs text-gray-400 mb-1 block">Full name</label>
            <input
              value={managerForm.name}
              onChange={e => setManagerForm(previous => ({ ...previous, name: e.target.value }))}
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400"
              placeholder="Self-Study Manager name"
            />
          </div>
          <div className="md:col-span-5">
            <label className="text-xs text-gray-400 mb-1 block">Email</label>
            <input
              type="email"
              value={managerForm.email}
              onChange={e => setManagerForm(previous => ({ ...previous, email: e.target.value }))}
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400"
              placeholder="manager@example.com"
            />
          </div>
          <div className="md:col-span-2">
            <button
              onClick={handleCreateSelfStudyManager}
              disabled={managerCreating}
              className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-purple-300 text-white px-3 py-2.5 rounded-xl text-sm font-medium"
            >
              {managerCreating ? 'Creating...' : 'Create manager'}
            </button>
          </div>
        </div>
        {managerError && (
          <div className="mb-3 text-xs bg-red-50 border border-red-100 text-red-600 rounded-xl px-3 py-2">{managerError}</div>
        )}
        {managerNotice && (
          <div className="mb-3 text-xs bg-green-50 border border-green-100 text-green-700 rounded-xl px-3 py-2">{managerNotice}</div>
        )}
                      </div>
                    )}
        <div className="flex flex-col gap-2">
          {activeSelfStudyManagers.length === 0 && archivedSelfStudyManagers.length === 0 && (
            <div className="border border-dashed border-purple-200 rounded-xl p-5 text-center text-sm text-gray-400">
              No Self-Study Manager account exists yet.
            </div>
          )}

          {activeSelfStudyManagers.map(manager => (
            <div key={manager.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border border-gray-100 rounded-xl px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-gray-800">{manager.name || 'Unnamed manager'}</p>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-50 text-green-700">Active</span>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-purple-50 text-purple-700">Self-Study Manager</span>
                </div>
                <p className="text-xs text-gray-400 truncate mt-0.5">{manager.email}</p>
                <p className="text-[11px] text-gray-400 mt-0.5">Platform scope · Email login only · No institution seat</p>
              </div>
              <div className="flex gap-2 flex-wrap">
                <button onClick={() => handleEdit(manager)} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-1.5 rounded-lg">Edit</button>
                <button onClick={() => handleSendPasswordReset(manager)} className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-600 px-3 py-1.5 rounded-lg">Email Reset</button>
                <button onClick={() => handleDelete(manager.id)} className="text-xs bg-amber-50 hover:bg-amber-100 text-amber-700 px-3 py-1.5 rounded-lg">Archive</button>
              </div>
            </div>
          ))}

          {archivedSelfStudyManagers.map(manager => (
            <div key={manager.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border border-gray-100 rounded-xl px-4 py-3 bg-gray-50/60">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-gray-700">{manager.name || 'Unnamed manager'}</p>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-200 text-gray-600">Archived</span>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-purple-50 text-purple-700">Self-Study Manager</span>
                </div>
                <p className="text-xs text-gray-400 truncate mt-0.5">{manager.email}</p>
              </div>
              <div className="flex gap-2 flex-wrap">
                <button
                  disabled={restoreBusyId === manager.id || permanentDeleteBusyId === manager.id}
                  onClick={() => handleRestoreManagedUser(manager)}
                  className="text-xs bg-green-100 hover:bg-green-200 disabled:bg-gray-100 disabled:text-gray-400 text-green-700 px-3 py-1.5 rounded-lg"
                >
                  {restoreBusyId === manager.id ? 'Restoring...' : 'Restore Account'}
                </button>
                <button
                  disabled={permanentDeleteBusyId === manager.id}
                  onClick={() => handlePermanentDeleteUser(manager)}
                  className="text-xs bg-red-100 hover:bg-red-200 disabled:bg-gray-100 disabled:text-gray-400 text-red-700 px-3 py-1.5 rounded-lg"
                >
                  {permanentDeleteBusyId === manager.id ? 'Deleting...' : 'Delete Permanently'}
                </button>
              </div>
            </div>
          ))}
        </div>
                  </section>
                )}
                {selfStudyTab === 'learners' && (
        <div className={accountListView === 'active' ? '' : 'hidden'}>

          <h2 className="font-semibold text-gray-700 mb-3">{showingIndividualAccounts ? 'Self-Study Learners' : 'Students'} ({students.length})</h2>

          <div className="flex flex-col gap-3">

            {students.length === 0 ? (

              <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center text-gray-400 text-sm">{showingIndividualAccounts ? 'No self-study accounts found.' : 'No students found.'}</div>

            ) : students.map(u => (

              <div key={u.id} className="bg-white border border-slate-200 rounded-2xl overflow-visible shadow-sm">

                <div

                  className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 px-5 py-4 hover:bg-slate-50"

                >

                  <div className="flex items-center gap-3">

                    <div className="w-9 h-9 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 font-semibold text-sm">

                      {u.name?.charAt(0).toUpperCase()}

                    </div>

                    <div>

                      <p className="text-sm font-medium text-gray-800">{u.name}</p>

                      <p className="text-xs text-gray-400">{u.email}</p>
                  {u.username && <p className="text-[11px] text-purple-500 mt-0.5">Username: {u.username}</p>}

                    <p className="text-[11px] text-gray-400 mt-0.5">{isIndividualAccount(u) ? 'Account: Self-Study / Individual' : `School: ${schoolLabel(u.schoolId)}`}</p>

                  {u.role === 'student' && (

                    <p className="text-xs text-blue-500 mt-0.5">

                      Target Band: {u.targetBand !== undefined && u.targetBand !== null ? Number(u.targetBand).toFixed(1) : 'Not set'}

                    </p>

                  )}

                    </div>

                  </div>

                  <div className="flex items-center gap-2 flex-wrap lg:justify-end">
                    <button type="button" onClick={() => setSelectedStudent(selectedStudent === u.id ? null : u.id)}
                      aria-expanded={selectedStudent === u.id}
                      className="text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-700 hover:bg-slate-100">
                      {selectedStudent === u.id ? 'Hide mock history' : 'Mock history'}
                    </button>
                    <button type="button" onClick={() => handleEdit(u)}
                      className="text-xs border border-indigo-200 rounded-lg px-3 py-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-medium">Edit</button>
                    <details className="relative" onClick={e => e.stopPropagation()}>
                      <summary className="cursor-pointer list-none text-xs border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-700 hover:bg-slate-100 select-none">More actions ▾</summary>
                      <div className="absolute right-0 z-30 mt-2 w-56 max-h-[65vh] overflow-auto rounded-xl border border-slate-200 bg-white shadow-xl p-2 flex flex-col gap-1">
                        <button type="button" onClick={() => handleSendPasswordReset(u)} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-slate-50 text-slate-700">Send password reset</button>
                        {!isIndividualAccount(u) && (
                          <>
                            <p className="px-3 pt-2 text-[11px] font-semibold text-slate-400 uppercase">Mock results</p>
                            <button type="button" onClick={() => hideStudentRecords(u, 'mock')} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-slate-50">Hide mock results</button>
                            <button type="button" onClick={() => restoreStudentRecords(u, 'mock')} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-slate-50">Restore mock results</button>
                            <button type="button" onClick={() => hardDeleteStudentRecords(u, 'mock')} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-red-50 text-red-700">Delete mock results</button>
                            <p className="px-3 pt-2 text-[11px] font-semibold text-slate-400 uppercase">Homework</p>
                            <button type="button" onClick={() => hideStudentRecords(u, 'homework')} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-slate-50">Hide homework</button>
                            <button type="button" onClick={() => restoreStudentRecords(u, 'homework')} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-slate-50">Restore homework</button>
                            <button type="button" onClick={() => hardDeleteStudentRecords(u, 'homework')} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-red-50 text-red-700">Delete homework records</button>
                          </>
                        )}
                        <div className="border-t border-slate-100 mt-1 pt-1 flex flex-col gap-1">
                          <button type="button" onClick={() => handleDelete(u.id)} className="text-left text-xs px-3 py-2 rounded-lg hover:bg-amber-50 text-amber-700">Archive account</button>
                          <button type="button" disabled={permanentDeleteBusyId === u.id} onClick={() => handlePermanentDeleteUser(u)}
                            className="text-left text-xs px-3 py-2 rounded-lg hover:bg-red-50 text-red-700 disabled:opacity-40">{permanentDeleteBusyId === u.id ? 'Deleting...' : 'Permanently delete account'}</button>
                        </div>
                      </div>
                    </details>
                  </div>

                </div>



                {selectedStudent === u.id && (

                  <div className="border-t border-gray-100 px-5 py-4">

                    <h3 className="text-sm font-semibold text-gray-700 mb-1">Mock history</h3>

                    <p className="text-xs text-gray-400 mb-3">

                      Manual IELTS score logging is no longer used. This area shows mock scores only.

                    </p>

                    {(() => {

                      const mockScores = (scores[u.id] || []).filter(isMockScore)



                      if (mockScores.length === 0) {

                        return (

                          <p className="text-xs text-gray-400">

                            No visible mock scores yet. Use More actions to restore hidden results.

                          </p>

                        )

                      }



                      return (

                        <div className="flex flex-col gap-2">

                          {mockScores.map(s => (

                            <div key={s.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">

                              <div>

                                <p className="text-sm text-gray-700">{s.date || 'No date'}</p>
                                {s.excludedFromStats === true && (
                                  <span className="text-[10px] font-semibold text-amber-700">Excluded from statistics</span>
                                )}

                                <p className="text-xs text-gray-400">

                                  L:{s.listening || '-'} R:{s.reading || '-'} W:{s.writing || 'Pending'} Overall:{s.overall || '-'}

                                </p>

                              </div>

                              <div className="flex items-center gap-2">

                                <p className="text-lg font-bold text-purple-600">{s.overall || '-'}</p>

                                <button onClick={() => handleEditScore(s)} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-2 py-1 rounded-lg">Edit</button>

                                <button onClick={() => handleDeleteScore(s.id)} className="text-xs bg-red-50 hover:bg-red-100 text-red-500 px-2 py-1 rounded-lg">Delete</button>

                              </div>

                            </div>

                          ))}

                        </div>

                      )

                    })()}

                  </div>

                )}

              </div>

            ))}

          </div>

        </div>
                )}
                {selfStudyTab === 'archived' && (
                  <>
        {accountListView === 'archived' && archivedUsers.length > 0 && (

          <div className="mb-8">

            <h2 className="font-semibold text-gray-600 mb-3">Archived Accounts ({archivedUsers.length})</h2>

            <div className="bg-white border border-gray-100 rounded-2xl overflow-hidden">

              {archivedUsers.map(u => (

                <div key={u.id} className="flex items-center justify-between gap-4 px-5 py-4 border-b border-gray-50 last:border-0">

                  <div className="min-w-0">

                    <div className="flex items-center gap-2 flex-wrap">

                      <p className="text-sm font-medium text-gray-700">{u.name || 'Unnamed account'}</p>

                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">Archived</span>

                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-600">{u.role || u.requestedRole || 'account'}</span>

                    </div>

                    <p className="text-xs text-gray-400 truncate">{u.email}</p>

                    {u.username && <p className="text-[11px] text-purple-500 mt-0.5">Username: {u.username}</p>}

                    <p className="text-[11px] text-gray-400 mt-0.5">{isIndividualAccount(u) ? 'Account: Self-Study / Individual' : `School: ${schoolLabel(u.schoolId)}`}</p>

                  </div>

                  <div className="flex items-center gap-2 flex-wrap justify-end">

                    {['student', 'teacher'].includes((u.role || u.requestedRole || '').toLowerCase()) ? (
                      <button
                        disabled={restoreBusyId === u.id || permanentDeleteBusyId === u.id}
                        onClick={() => handleRestoreManagedUser(u)}
                        className="text-xs bg-green-100 hover:bg-green-200 disabled:bg-gray-100 disabled:text-gray-400 text-green-700 px-3 py-1.5 rounded-lg"
                      >
                        {restoreBusyId === u.id ? 'Restoring...' : 'Restore Account'}
                      </button>
                    ) : (
                      <span className="text-xs text-gray-400">Restore unavailable: role unknown</span>
                    )}

                    {(u.role || u.requestedRole) === 'admin' ? (

                      <span className="text-xs text-gray-400">Admin accounts cannot be permanently deleted here</span>

                    ) : (

                      <button
                        disabled={permanentDeleteBusyId === u.id}
                        onClick={() => handlePermanentDeleteUser(u)}
                        className="text-xs bg-red-100 hover:bg-red-200 disabled:bg-gray-100 disabled:text-gray-400 text-red-700 px-3 py-1.5 rounded-lg"
                      >
                        {permanentDeleteBusyId === u.id ? 'Deleting...' : 'Delete Permanently'}
                      </button>

                    )}

                  </div>

                </div>

              ))}

            </div>

          </div>

        )}



        {accountListView === 'archived' && archivedUsers.length === 0 && (
          <div className="mb-8 bg-white border border-gray-100 rounded-2xl p-8 text-center text-gray-400 text-sm">
            No archived accounts found.
          </div>
        )}
                  </>
                )}
              </div>
            )}
          </main>
        </div>
      </div>
      {editUser && (

        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4 py-6 overflow-y-auto">

          <div className="bg-white rounded-2xl p-6 w-full max-w-lg my-auto">

            <h2 className="font-semibold text-gray-800 mb-1">Edit account</h2>

            <p className="text-xs text-gray-400 mb-4">Email, login identity and password controls are managed server-side.</p>

            <div className="flex flex-col gap-3 mb-4">

              <div>

                <label className="text-xs text-gray-400 mb-1 block">Full name</label>

                <input className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400" value={editName} onChange={e => setEditName(e.target.value)} />

              </div>

              <div>

                <label className="text-xs text-gray-400 mb-1 block">Email</label>

                <input

                  type="email"

                  className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"

                  value={editEmail}

                  onChange={e => setEditEmail(e.target.value)}

                  placeholder="name@example.com"

                />

                <p className="text-[11px] text-gray-400 mt-1">Changing this updates both Firebase Auth and the user profile. The current password is preserved.</p>

              </div>

              {!usesEmailOnlyAccount(editUser) ? (
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">School username (optional)</label>
                  <input
                    className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"
                    value={editUsername}
                    onChange={e => setEditUsername(e.target.value.toLowerCase())}
                    placeholder="student01"
                    autoCapitalize="none"
                    autoCorrect="off"
                  />
                  <p className="text-[11px] text-gray-400 mt-1">Unique inside {schoolLabel(editUser.schoolId)}. Leave empty to remove username login.</p>
                </div>
              ) : (
                <div className="bg-purple-50 border border-purple-100 text-purple-700 rounded-xl px-4 py-3 text-xs leading-5">
                  {isSelfStudyManagerAccount(editUser)
                    ? 'Self-Study Manager accounts use email login only and are not attached to an institution.'
                    : 'Self-study learner accounts use email login only. School username is not available.'}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">

                <div>

                  <label className="text-xs text-gray-400 mb-1 block">Role</label>

                  <div className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm bg-gray-50 text-gray-500 capitalize">

                    {roleLabel(editRole)}

                  </div>

                </div>

                <div>

                  <label className="text-xs text-gray-400 mb-1 block">{usesEmailOnlyAccount(editUser) ? 'Account type' : 'School'}</label>

                  <div className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm bg-gray-50 text-gray-500 truncate">

                    {isSelfStudyManagerAccount(editUser)
                      ? 'Platform / Self-Study Management'
                      : isIndividualAccount(editUser)
                        ? 'Individual / Self-Study'
                        : schoolLabel(editUser.schoolId)}

                  </div>

                </div>

              </div>

              <p className="text-[11px] text-amber-600">

                Role and account boundary are locked after account creation to protect assignment and submission history.

              </p>



              {!isSelfStudyManagerAccount(editUser) && (
                <div>

                  <label className="text-xs text-gray-400 mb-1 block">Target Band</label>

                  <input

                    type="number"

                    min="0"

                    max="9"

                    step="0.5"

                    disabled={editRole !== 'student'}

                    placeholder="Example: 6.5"

                    className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400 disabled:bg-gray-100 disabled:text-gray-400"

                    value={editTargetBand}

                    onChange={e => setEditTargetBand(e.target.value)}

                  />

                  <p className="text-[11px] text-gray-400 mt-1">

                    Leave empty if no target band is set.

                  </p>

                </div>
              )}

              <div className="border-t border-gray-100 pt-4 mt-1">

                <label className="text-xs text-gray-500 mb-1 block">Admin set new password</label>

                <div className="flex flex-col sm:flex-row gap-2">

                  <input

                    type="password"

                    value={editNewPassword}

                    onChange={e => setEditNewPassword(e.target.value)}

                    placeholder="8-128 characters"

                    autoComplete="new-password"

                    className="flex-1 border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"

                  />

                  <button

                    type="button"

                    onClick={handleSetManagedPassword}

                    disabled={passwordSaving || editSaving || editNewPassword.length < 8}

                    className="px-4 py-2.5 rounded-xl bg-amber-100 hover:bg-amber-200 disabled:bg-gray-100 disabled:text-gray-400 text-amber-800 text-sm font-medium"

                  >

                    {passwordSaving ? 'Setting...' : 'Set password'}

                  </button>

                </div>

                <p className="text-[11px] text-gray-400 mt-1">The current password is never visible to Admin and the new password is never stored in Firestore.</p>

              </div>

            </div>

            <div className="flex gap-2">

              <button disabled={editSaving || passwordSaving} onClick={() => setEditUser(null)} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-500 disabled:opacity-50">Cancel</button>

              <button disabled={editSaving || passwordSaving} onClick={handleSaveEdit} className="flex-1 py-2.5 rounded-xl bg-purple-600 disabled:bg-purple-300 text-white text-sm font-medium">{editSaving ? 'Saving...' : 'Save account'}</button>

            </div>

          </div>

        </div>

      )}



      {editScore && (

        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">

          <div className="bg-white rounded-2xl p-6 w-full max-w-sm">

            <h2 className="font-semibold text-gray-800 mb-4">Edit mock score</h2>

            <div className="grid grid-cols-2 gap-3 mb-3">

              {['listening', 'reading', 'writing', 'speaking'].map(s => (

                <div key={s}>

                  <label className="text-xs text-gray-400 capitalize mb-1 block">{s}</label>

                  <input

                    type="number"

                    min="0"

                    max="9"

                    step="0.5"

                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"

                    value={editScoreForm[s]}

                    onChange={e => setEditScoreForm(p => ({ ...p, [s]: e.target.value }))}

                  />

                </div>

              ))}

            </div>

            <div className="mb-4">

              <label className="text-xs text-gray-400 mb-1 block">Date</label>

              <input

                type="date"

                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"

                value={editScoreForm.date}

                onChange={e => setEditScoreForm(p => ({ ...p, date: e.target.value }))}

              />

            </div>

            <div className="flex gap-2">

              <button onClick={() => setEditScore(null)} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-500">Cancel</button>

              <button onClick={handleSaveScore} className="flex-1 py-2.5 rounded-xl bg-purple-600 text-white text-sm font-medium">Save</button>

            </div>

          </div>

        </div>

      )}
    </div>
  )
}
