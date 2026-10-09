import { useState, useEffect } from 'react'

import { auth, db, functions } from '../firebase'

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

import { signOut, onAuthStateChanged, sendPasswordResetEmail } from 'firebase/auth'

import { httpsCallable } from 'firebase/functions'

import { useNavigate } from 'react-router-dom'



const DEFAULT_SCHOOL_ID = 'maxima'



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

const deleteManagedSchoolCall = httpsCallable(functions, 'deleteManagedSchool')

const createManagedUserCall = httpsCallable(functions, 'createManagedUser')

const approveManagedUserCall = httpsCallable(functions, 'approveManagedUser')

const rejectManagedUserCall = httpsCallable(functions, 'rejectManagedUser')

const updateManagedUserCall = httpsCallable(functions, 'updateManagedUser')

const deleteManagedUserCall = httpsCallable(functions, 'deleteManagedUser')



export default function AdminDashboard() {

  const [users, setUsers] = useState([])

  const [scores, setScores] = useState({})

  const [search, setSearch] = useState('')

  const [editUser, setEditUser] = useState(null)

  const [editName, setEditName] = useState('')

  const [editRole, setEditRole] = useState('')

  const [editTargetBand, setEditTargetBand] = useState('')

  const [editScore, setEditScore] = useState(null)

  const [editScoreForm, setEditScoreForm] = useState({})

  const [selectedStudent, setSelectedStudent] = useState(null)

  const [authChecking, setAuthChecking] = useState(true)

  const [schools, setSchools] = useState([])

  const [schoolsLoading, setSchoolsLoading] = useState(true)

  const [schoolsError, setSchoolsError] = useState('')

  const [schoolSaving, setSchoolSaving] = useState(false)

  const [schoolNotice, setSchoolNotice] = useState('')

  const [editingSchoolId, setEditingSchoolId] = useState(null)

  const [schoolForm, setSchoolForm] = useState({

    schoolId: DEFAULT_SCHOOL_ID,

    name: 'Maxima Eğitim',

    status: 'active'

  })

  const [accountCreating, setAccountCreating] = useState(false)

  const [accountError, setAccountError] = useState('')

  const [accountNotice, setAccountNotice] = useState('')

  const [accountForm, setAccountForm] = useState({

    name: '',

    email: '',

    role: 'student',

    schoolId: '',

    targetBand: ''

  })

  const [pendingSchoolSelections, setPendingSchoolSelections] = useState({})

  const navigate = useNavigate()



  const loadSchools = async () => {

    setSchoolsLoading(true)

    setSchoolsError('')

    try {

      const result = await getManagedSchoolsCall({})

      const managedSchools = Array.isArray(result.data?.schools)

        ? result.data.schools

        : []

      setSchools(managedSchools)

      setAccountForm(previous => {

        const selectedIsActive = managedSchools.some(

          school => school.schoolId === previous.schoolId && school.status === 'active'

        )

        if (selectedIsActive) return previous

        return {

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

            .filter(u => !u.deleted && u.status !== 'deleted')



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



  const resetSchoolForm = () => {

    setEditingSchoolId(null)

    setSchoolForm({

      schoolId: '',

      name: '',

      status: 'active'

    })

    setSchoolNotice('')

    setSchoolsError('')

  }



  const prepareMaximaSchool = () => {

    setEditingSchoolId(null)

    setSchoolForm({

      schoolId: DEFAULT_SCHOOL_ID,

      name: 'Maxima Eğitim',

      status: 'active'

    })

    setSchoolNotice('')

    setSchoolsError('')

  }



  const handleEditSchool = school => {

    setEditingSchoolId(school.schoolId)

    setSchoolForm({

      schoolId: school.schoolId,

      name: school.name || '',

      status: school.status === 'inactive' ? 'inactive' : 'active'

    })

    setSchoolNotice('')

    setSchoolsError('')

  }



  const handleSaveSchool = async () => {

    const schoolId = normalizeSchoolIdInput(schoolForm.schoolId)

    const name = schoolForm.name.trim()



    if (schoolId.length < 2) {

      setSchoolsError('School ID must be at least 2 characters.')

      return

    }



    if (name.length < 2) {

      setSchoolsError('School name must be at least 2 characters.')

      return

    }



    setSchoolSaving(true)

    setSchoolsError('')

    setSchoolNotice('')



    try {

      const result = await saveManagedSchoolCall({

        schoolId,

        name,

        status: schoolForm.status

      })



      await loadSchools()



      setSchoolNotice(

        result.data?.created

          ? `${name} was created.`

          : `${name} was updated.`

      )



      setEditingSchoolId(schoolId)

      setSchoolForm({

        schoolId,

        name,

        status: schoolForm.status

      })

    } catch (error) {

      console.error(error)

      setSchoolsError(error?.message || 'Could not save school.')

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



  const handleDeleteSchool = async school => {

    if (school.schoolId === DEFAULT_SCHOOL_ID) {

      setSchoolsError('The default Maxima school cannot be permanently deleted.')

      return

    }

    if (school.status !== 'inactive') {

      setSchoolsError('Deactivate this school before permanently deleting it.')

      return

    }

    const ok = window.confirm(

      `Permanently delete ${school.name}?\n\nThis cannot be undone. The server will refuse deletion if any users, classes, content, submissions or history still reference this school.`

    )

    if (!ok) return



    setSchoolSaving(true)

    setSchoolsError('')

    setSchoolNotice('')



    try {

      await deleteManagedSchoolCall({ schoolId: school.schoolId })



      if (editingSchoolId === school.schoolId) {

        resetSchoolForm()

      }



      await loadSchools()

      setSchoolNotice(`${school.name} was permanently deleted.`)

    } catch (error) {

      console.error(error)

      setSchoolsError(error?.message || 'Could not permanently delete this school.')

    } finally {

      setSchoolSaving(false)

    }

  }



  const schoolMembers = schoolId =>

    users.filter(user => (user.schoolId || DEFAULT_SCHOOL_ID) === schoolId)



  const schoolLabel = schoolId => {

    const id = schoolId || DEFAULT_SCHOOL_ID

    const school = schools.find(item => item.schoolId === id)

    return school ? school.name : id

  }



  const handleCreateManagedUser = async () => {

    const name = accountForm.name.trim()

    const email = accountForm.email.trim().toLowerCase()

    const schoolId = accountForm.schoolId

    const targetBand = accountForm.targetBand === '' ? null : Number(accountForm.targetBand)



    setAccountError('')

    setAccountNotice('')



    if (name.length < 2 || !email || !schoolId) {

      setAccountError('Full name, email and school are required.')

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

        role: accountForm.role,

        schoolId,

        targetBand: accountForm.role === 'student' ? targetBand : null

      })



      let resetSent = false

      try {

        await sendPasswordResetEmail(auth, email)

        resetSent = true

      } catch (resetError) {

        console.error('Account created but password setup email failed:', resetError)

      }



      setAccountNotice(

        resetSent

          ? `${name} was created in ${schoolLabel(schoolId)}. Password setup email sent to ${email}.`

          : `${name} was created in ${schoolLabel(schoolId)}, but the password setup email could not be sent. Use Reset Password from the user list.`

      )



      setAccountForm(previous => ({

        ...previous,

        name: '',

        email: '',

        schoolId: '',

        targetBand: ''

      }))

    } catch (error) {

      console.error(error)

      setAccountError(error?.message || 'Could not create account.')

    } finally {

      setAccountCreating(false)

    }

  }



  const approveUser = async (userId, roleType) => {

    const schoolId = pendingSchoolSelections[userId] || ''



    if (!schoolId) {

      alert('Select an active school before approving this account.')

      return

    }



    try {

      await approveManagedUserCall({ userId, role: roleType, schoolId })



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

    if (!window.confirm('Remove this account and disable Firebase Auth login? Existing history will be preserved.')) return



    try {

      await deleteManagedUserCall({ userId: id })

    } catch (error) {

      console.error(error)

      alert(error?.message || 'Could not remove this account.')

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

      await sendPasswordResetEmail(auth, user.email)

      alert(`Password reset email sent to ${user.email}.`)

    } catch (error) {

      console.error(error)

      alert('Could not send password reset email. Please check Firebase Auth settings.')

    }

  }



  const handleEdit = (u) => {

    setEditUser(u)

    setEditName(u.name || '')

    setEditRole(u.role || 'student')

    setEditTargetBand(

      u.targetBand !== undefined && u.targetBand !== null

        ? String(u.targetBand)

        : ''

    )

  }



  const handleSaveEdit = async () => {

    const cleanTargetBand = editTargetBand === ''

      ? null

      : Number(editTargetBand)



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



    try {

      await updateManagedUserCall({

        userId: editUser.id,

        name: editName,

        targetBand: editRole === 'student' ? cleanTargetBand : null

      })

      setEditUser(null)

      setEditTargetBand('')

    } catch (error) {

      console.error(error)

      alert(error?.message || 'Could not update this account.')

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



  const filtered = users.filter(u =>

    u.name?.toLowerCase().includes(search.toLowerCase()) ||

    u.email?.toLowerCase().includes(search.toLowerCase())

  )



  const pendingUsers = filtered.filter(u => u.status === 'pending')

  const rejectedUsers = filtered.filter(u => u.status === 'rejected')



  const students = filtered.filter(

    u => u.role === 'student' && (u.status === 'approved' || !u.status)

  )



  const teachers = filtered.filter(

    u => u.role === 'teacher' && (u.status === 'approved' || !u.status)

  )



  if (authChecking) {

    return (

      <div className="min-h-screen bg-[#faf9f6] flex items-center justify-center">

        <p className="text-gray-400">Checking permissions...</p>

      </div>

    )

  }



  return (

    <div className="min-h-screen bg-[#faf9f6]">

      <nav className="flex justify-between items-center px-8 py-4 bg-white border-b border-gray-100">

        <div className="flex items-center gap-3">

          <img src="/1.png" alt="Maxima" className="h-10 object-contain" />

          <span className="text-xs bg-purple-100 text-purple-600 px-2 py-1 rounded-full font-medium">Admin</span>

        </div>

        <button onClick={handleLogout} className="text-sm text-gray-400 hover:text-gray-600">Logout</button>

      </nav>



      <div className="max-w-4xl mx-auto px-6 py-10">

        <div className="flex items-start justify-between gap-4 mb-6">

          <div>

            <h1 className="text-2xl font-bold text-gray-900 mb-1">Admin Panel</h1>

            <p className="text-gray-400 text-sm">Manage schools, institution accounts, mock history and classes</p>

          </div>



          <button

            onClick={() => navigate('/admin/classes')}

            className="bg-white border border-purple-200 text-purple-600 px-4 py-2 rounded-xl text-sm font-medium hover:bg-purple-50"

          >

            🏫 Manage Classes

          </button>

        </div>



        <div className="bg-white border border-gray-100 rounded-2xl p-5 mb-8">

        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-5">

          <div>

            <div className="flex items-center gap-2">

              <h2 className="font-semibold text-gray-800">Schools</h2>

              <span className="text-xs bg-purple-50 text-purple-600 px-2 py-1 rounded-full">Stage 17B</span>

            </div>

            <p className="text-xs text-gray-400 mt-1">

              School records are saved through admin-only server functions. License seats are not enabled yet.

            </p>

          </div>

          <div className="flex gap-2">

            {schools.length === 0 && (

              <button

                onClick={prepareMaximaSchool}

                className="text-xs bg-purple-50 hover:bg-purple-100 text-purple-700 px-3 py-2 rounded-lg font-medium"

              >

                Prepare Maxima

              </button>

            )}

            <button

              onClick={resetSchoolForm}

              className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-2 rounded-lg font-medium"

            >

              + New School

            </button>

          </div>

        </div>



        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end bg-[#faf9f6] border border-gray-100 rounded-xl p-4 mb-4">

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



          <div className="md:col-span-2">

            <button

              onClick={handleSaveSchool}

              disabled={schoolSaving}

              className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-purple-300 text-white px-3 py-2.5 rounded-xl text-sm font-medium"

            >

              {schoolSaving ? 'Saving...' : editingSchoolId ? 'Save School' : 'Create School'}

            </button>

          </div>

        </div>



        {schoolsError && (

          <div className="mb-4 text-xs bg-red-50 border border-red-100 text-red-600 rounded-xl px-3 py-2">

            {schoolsError}

          </div>

        )}



        {schoolNotice && (

          <div className="mb-4 text-xs bg-green-50 border border-green-100 text-green-700 rounded-xl px-3 py-2">

            {schoolNotice}

          </div>

        )}



        {schoolsLoading ? (

          <p className="text-sm text-gray-400 py-4 text-center">Loading schools...</p>

        ) : schools.length === 0 ? (

          <div className="border border-dashed border-purple-200 rounded-xl p-5 text-center">

            <p className="text-sm font-medium text-gray-700">No school record exists yet.</p>

            <p className="text-xs text-gray-400 mt-1">

              Keep School ID as <span className="font-mono">maxima</span>, School name as Maxima Eğitim, then click Create School.

            </p>

          </div>

        ) : (

          <div className="flex flex-col gap-2">

            {schools.map(school => {

              const members = schoolMembers(school.schoolId)

              const studentCount = members.filter(member => member.role === 'student').length

              const teacherCount = members.filter(member => member.role === 'teacher').length



              return (

                <div key={school.schoolId} className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border border-gray-100 rounded-xl px-4 py-3">

                  <div className="min-w-0">

                    <div className="flex items-center gap-2 flex-wrap">

                      <p className="text-sm font-semibold text-gray-800">{school.name}</p>

                      <span className={`text-[11px] px-2 py-0.5 rounded-full ${school.status === 'active' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>

                        {school.status === 'active' ? 'Active' : 'Inactive'}

                      </span>

                    </div>

                    <p className="text-xs text-gray-400 mt-1">

                      ID: <span className="font-mono">{school.schoolId}</span> · {studentCount} student{studentCount === 1 ? '' : 's'} · {teacherCount} teacher{teacherCount === 1 ? '' : 's'}

                    </p>

                  </div>



                  <div className="flex gap-2 flex-wrap">

                    <button

                      onClick={() => handleEditSchool(school)}

                      className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-1.5 rounded-lg"

                    >

                      Edit

                    </button>

                    <button

                      onClick={() => handleToggleSchoolStatus(school)}

                      disabled={schoolSaving}

                      className={`text-xs px-3 py-1.5 rounded-lg ${school.status === 'active' ? 'bg-amber-50 hover:bg-amber-100 text-amber-700' : 'bg-green-50 hover:bg-green-100 text-green-700'}`}

                    >

                      {school.status === 'active' ? 'Deactivate' : 'Activate'}

                    </button>

                    {school.status === 'inactive' && school.schoolId !== DEFAULT_SCHOOL_ID && (

                      <button

                        onClick={() => handleDeleteSchool(school)}

                        disabled={schoolSaving}

                        className="text-xs bg-red-50 hover:bg-red-100 disabled:text-red-300 text-red-600 px-3 py-1.5 rounded-lg"

                      >

                        Delete

                      </button>

                    )}

                  </div>

                </div>

              )

            })}

          </div>

        )}

      </div>



      <div className="bg-white border border-gray-100 rounded-2xl p-5 mb-8">

        <div className="flex items-start justify-between gap-4 mb-4">

          <div>

            <div className="flex items-center gap-2">

              <h2 className="font-semibold text-gray-800">Create account</h2>

              <span className="text-xs bg-blue-50 text-blue-600 px-2 py-1 rounded-full">Stage 18B</span>

            </div>

            <p className="text-xs text-gray-400 mt-1">

              Create an approved Student or Teacher directly in an active school. The user receives a Firebase password setup email.

            </p>

          </div>

        </div>



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

            <label className="text-xs text-gray-400 mb-1 block">School</label>

            <select

              value={accountForm.schoolId}

              onChange={e => setAccountForm(previous => ({ ...previous, schoolId: e.target.value }))}

              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-purple-400 bg-white"

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

            {accountError && <p className="text-xs text-red-600">{accountError}</p>}

            {accountNotice && <p className="text-xs text-green-700">{accountNotice}</p>}

          </div>

          <button

            onClick={handleCreateManagedUser}

            disabled={accountCreating || schoolsLoading || !schools.some(school => school.status === 'active')}

            className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white px-5 py-2.5 rounded-xl text-sm font-medium"

          >

            {accountCreating ? 'Creating...' : 'Create account'}

          </button>

        </div>

      </div>



      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">

          <div className="bg-white border border-gray-100 rounded-2xl p-5 text-center">

            <p className="text-3xl font-bold text-gray-900">{users.length}</p>

            <p className="text-sm text-gray-400 mt-1">Total users</p>

          </div>

          <div className="bg-white border border-gray-100 rounded-2xl p-5 text-center">

            <p className="text-3xl font-bold text-orange-500">{pendingUsers.length}</p>

            <p className="text-sm text-gray-400 mt-1">Pending</p>

          </div>

          <div className="bg-white border border-gray-100 rounded-2xl p-5 text-center">

            <p className="text-3xl font-bold text-purple-600">{students.length}</p>

            <p className="text-sm text-gray-400 mt-1">Students</p>

          </div>

          <div className="bg-white border border-gray-100 rounded-2xl p-5 text-center">

            <p className="text-3xl font-bold text-green-600">{teachers.length}</p>

            <p className="text-sm text-gray-400 mt-1">Teachers</p>

          </div>

        </div>



        <div className="mb-6">

          <input

            type="text"

            placeholder="Search by name or email..."

            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"

            value={search}

            onChange={e => setSearch(e.target.value)}

          />

        </div>



        <div className="mb-8">

          <h2 className="font-semibold text-orange-600 mb-3">Pending Approvals ({pendingUsers.length})</h2>

          <div className="bg-white border border-gray-100 rounded-2xl overflow-hidden">

            {pendingUsers.length === 0 ? (

              <p className="text-gray-400 text-sm text-center py-8">No pending approvals.</p>

            ) : pendingUsers.map(u => (

              <div key={u.id} className="flex items-center justify-between px-5 py-4 border-b border-gray-50 last:border-0">

                <div>

                  <p className="text-sm font-medium text-gray-800">{u.name}</p>

                  <p className="text-xs text-gray-400">{u.email}</p>

                  {u.role === 'student' && (

                    <p className="text-xs text-blue-500 mt-0.5">

                      Target Band: {u.targetBand !== undefined && u.targetBand !== null ? Number(u.targetBand).toFixed(1) : 'Not set'}

                    </p>

                  )}

                  <p className="text-xs text-orange-500 mt-1">Requested role: {u.requestedRole}</p>

                </div>



                <div className="flex gap-2 items-center flex-wrap justify-end">

                  <select

                    value={pendingSchoolSelections[u.id] || ''}

                    onChange={e => setPendingSchoolSelections(previous => ({ ...previous, [u.id]: e.target.value }))}

                    className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white"

                  >

                    <option value="" disabled>Select school</option>

                    {schools.map(school => (

                      <option key={school.schoolId} value={school.schoolId} disabled={school.status !== 'active'}>

                        {school.name}{school.status !== 'active' ? ' (Inactive)' : ''}

                      </option>

                    ))}

                  </select>

                  <button onClick={() => approveUser(u.id, 'student')} className="text-xs bg-purple-100 hover:bg-purple-200 text-purple-700 px-3 py-1.5 rounded-lg">Approve Student</button>

                  <button onClick={() => approveUser(u.id, 'teacher')} className="text-xs bg-green-100 hover:bg-green-200 text-green-700 px-3 py-1.5 rounded-lg">Approve Teacher</button>

                  <button onClick={() => rejectUser(u.id)} className="text-xs bg-red-50 hover:bg-red-100 text-red-500 px-3 py-1.5 rounded-lg">Reject</button>

                </div>

              </div>

            ))}

          </div>

        </div>



        {rejectedUsers.length > 0 && (

          <div className="mb-8">

            <h2 className="font-semibold text-red-500 mb-3">Rejected Users ({rejectedUsers.length})</h2>

            <div className="bg-white border border-gray-100 rounded-2xl overflow-hidden">

              {rejectedUsers.map(u => (

                <div key={u.id} className="flex items-center justify-between px-5 py-4 border-b border-gray-50 last:border-0">

                  <div>

                    <p className="text-sm font-medium text-gray-800">{u.name}</p>

                    <p className="text-xs text-gray-400">{u.email}</p>

                  {u.role === 'student' && (

                    <p className="text-xs text-blue-500 mt-0.5">

                      Target Band: {u.targetBand !== undefined && u.targetBand !== null ? Number(u.targetBand).toFixed(1) : 'Not set'}

                    </p>

                  )}

                  </div>



                  <div className="flex gap-2 items-center flex-wrap justify-end">

                    <select

                      value={pendingSchoolSelections[u.id] || ''}

                      onChange={e => setPendingSchoolSelections(previous => ({ ...previous, [u.id]: e.target.value }))}

                      className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white"

                    >

                      <option value="" disabled>Select school</option>

                      {schools.map(school => (

                        <option key={school.schoolId} value={school.schoolId} disabled={school.status !== 'active'}>

                          {school.name}{school.status !== 'active' ? ' (Inactive)' : ''}

                        </option>

                      ))}

                    </select>

                    <button onClick={() => approveUser(u.id, 'student')} className="text-xs bg-purple-100 hover:bg-purple-200 text-purple-700 px-3 py-1.5 rounded-lg">Approve Student</button>

                    <button onClick={() => approveUser(u.id, 'teacher')} className="text-xs bg-green-100 hover:bg-green-200 text-green-700 px-3 py-1.5 rounded-lg">Approve Teacher</button>

                    <button onClick={() => handleDelete(u.id)} className="text-xs bg-red-50 hover:bg-red-100 text-red-500 px-3 py-1.5 rounded-lg">Delete</button>

                  </div>

                </div>

              ))}

            </div>

          </div>

        )}



        <div className="mb-8">

          <h2 className="font-semibold text-gray-700 mb-3">Teachers ({teachers.length})</h2>

          <div className="bg-white border border-gray-100 rounded-2xl overflow-hidden">

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

                  <p className="text-[11px] text-gray-400 mt-0.5">School: {schoolLabel(u.schoolId)}</p>

                  {u.role === 'student' && (

                    <p className="text-xs text-blue-500 mt-0.5">

                      Target Band: {u.targetBand !== undefined && u.targetBand !== null ? Number(u.targetBand).toFixed(1) : 'Not set'}

                    </p>

                  )}

                  </div>

                </div>

                <div className="flex gap-2">

                  <button onClick={() => handleEdit(u)} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-1.5 rounded-lg">Edit</button>

                  <button onClick={() => handleSendPasswordReset(u)} className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-600 px-3 py-1.5 rounded-lg">Reset Password</button>

                  <button onClick={() => handleDelete(u.id)} className="text-xs bg-red-50 hover:bg-red-100 text-red-500 px-3 py-1.5 rounded-lg">Delete</button>

                </div>

              </div>

            ))}

          </div>

        </div>



        <div>

          <h2 className="font-semibold text-gray-700 mb-3">Students ({students.length})</h2>

          <div className="flex flex-col gap-3">

            {students.length === 0 ? (

              <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center text-gray-400 text-sm">No students found.</div>

            ) : students.map(u => (

              <div key={u.id} className="bg-white border border-gray-100 rounded-2xl overflow-hidden">

                <div

                  className="flex items-center justify-between px-5 py-4 cursor-pointer hover:bg-gray-50"

                  onClick={() => setSelectedStudent(selectedStudent === u.id ? null : u.id)}

                >

                  <div className="flex items-center gap-3">

                    <div className="w-9 h-9 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 font-semibold text-sm">

                      {u.name?.charAt(0).toUpperCase()}

                    </div>

                    <div>

                      <p className="text-sm font-medium text-gray-800">{u.name}</p>

                      <p className="text-xs text-gray-400">{u.email}</p>

                    <p className="text-[11px] text-gray-400 mt-0.5">School: {schoolLabel(u.schoolId)}</p>

                  {u.role === 'student' && (

                    <p className="text-xs text-blue-500 mt-0.5">

                      Target Band: {u.targetBand !== undefined && u.targetBand !== null ? Number(u.targetBand).toFixed(1) : 'Not set'}

                    </p>

                  )}

                    </div>

                  </div>

                  <div className="flex gap-2 items-center flex-wrap justify-end">

                    <button onClick={e => { e.stopPropagation(); handleEdit(u) }} className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-3 py-1.5 rounded-lg">Edit</button>

                    <button onClick={e => { e.stopPropagation(); handleSendPasswordReset(u) }} className="text-xs bg-blue-50 hover:bg-blue-100 text-blue-600 px-3 py-1.5 rounded-lg">Reset Password</button>



                    <button onClick={e => { e.stopPropagation(); hideStudentRecords(u, 'mock') }} className="text-xs bg-purple-50 hover:bg-purple-100 text-purple-600 px-3 py-1.5 rounded-lg">Hide Mock</button>

                    <button onClick={e => { e.stopPropagation(); restoreStudentRecords(u, 'mock') }} className="text-xs bg-green-50 hover:bg-green-100 text-green-600 px-3 py-1.5 rounded-lg">Restore Mock</button>

                    <button onClick={e => { e.stopPropagation(); hardDeleteStudentRecords(u, 'mock') }} className="text-xs bg-red-50 hover:bg-red-100 text-red-600 px-3 py-1.5 rounded-lg">Delete Mock</button>



                    <button onClick={e => { e.stopPropagation(); hideStudentRecords(u, 'homework') }} className="text-xs bg-amber-50 hover:bg-amber-100 text-amber-600 px-3 py-1.5 rounded-lg">Hide Homework</button>

                    <button onClick={e => { e.stopPropagation(); restoreStudentRecords(u, 'homework') }} className="text-xs bg-emerald-50 hover:bg-emerald-100 text-emerald-600 px-3 py-1.5 rounded-lg">Restore Homework</button>

                    <button onClick={e => { e.stopPropagation(); hardDeleteStudentRecords(u, 'homework') }} className="text-xs bg-rose-50 hover:bg-rose-100 text-rose-600 px-3 py-1.5 rounded-lg">Delete Homework</button>



                    <button onClick={e => { e.stopPropagation(); handleDelete(u.id) }} className="text-xs bg-red-100 hover:bg-red-200 text-red-700 px-3 py-1.5 rounded-lg">Delete User</button>

                    <div className="text-gray-300">{selectedStudent === u.id ? '▲' : '▼'}</div>

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

                            No visible mock scores yet. Hidden results can be restored with the Restore button.

                          </p>

                        )

                      }



                      return (

                        <div className="flex flex-col gap-2">

                          {mockScores.map(s => (

                            <div key={s.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">

                              <div>

                                <p className="text-sm text-gray-700">{s.date || 'No date'}</p>

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

      </div>



      {editUser && (

        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">

          <div className="bg-white rounded-2xl p-6 w-full max-w-sm">

            <h2 className="font-semibold text-gray-800 mb-4">Edit account</h2>

            <div className="flex flex-col gap-3 mb-4">

              <div>

                <label className="text-xs text-gray-400 mb-1 block">Full name</label>

                <input className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400" value={editName} onChange={e => setEditName(e.target.value)} />

              </div>

              <div className="grid grid-cols-2 gap-3">

                <div>

                  <label className="text-xs text-gray-400 mb-1 block">Role</label>

                  <div className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm bg-gray-50 text-gray-500 capitalize">

                    {editRole}

                  </div>

                </div>

                <div>

                  <label className="text-xs text-gray-400 mb-1 block">School</label>

                  <div className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm bg-gray-50 text-gray-500 truncate">

                    {schoolLabel(editUser.schoolId)}

                  </div>

                </div>

              </div>

              <p className="text-[11px] text-amber-600">

                Role and school are locked after account creation to protect assignment and submission history.

              </p>



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

            </div>

            <div className="flex gap-2">

              <button onClick={() => setEditUser(null)} className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-500">Cancel</button>

              <button onClick={handleSaveEdit} className="flex-1 py-2.5 rounded-xl bg-purple-600 text-white text-sm font-medium">Save</button>

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