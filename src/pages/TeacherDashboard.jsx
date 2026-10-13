import { useState, useEffect, useRef, useMemo } from 'react'
import { auth, db, storage, functions } from '../firebase'
import {
  collection,
  addDoc,
  query,
  where,
  onSnapshot,
  doc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  setDoc
} from 'firebase/firestore'
import { signOut, onAuthStateChanged, updatePassword } from 'firebase/auth'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { useNavigate } from 'react-router-dom'
import { httpsCallable } from 'firebase/functions'

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

const DEFAULT_SCHOOL_ID = 'maxima'

const getContentStudentAccessCall = httpsCallable(functions, 'getContentStudentAccess')
const getManagedContentStudentAccessSnapshotCall = httpsCallable(
  functions,
  'getManagedContentStudentAccessSnapshot'
)
const setContentStudentAccessCall = httpsCallable(functions, 'setContentStudentAccess')
const setContentArchivedStateCall = httpsCallable(functions, 'setContentArchivedState')
const getManagedSubmissionAttemptStateCall = httpsCallable(
  functions,
  'getManagedSubmissionAttemptState'
)
const getManagedSubmissionAttemptHistoryCall = httpsCallable(
  functions,
  'getManagedSubmissionAttemptHistory'
)
const setSubmissionAttemptControlCall = httpsCallable(
  functions,
  'setSubmissionAttemptControl'
)
const setManagedSubmissionStatsExclusionCall = httpsCallable(
  functions,
  'setManagedSubmissionStatsExclusion'
)
const previewManagedSubmissionPermanentDeleteCall = httpsCallable(
  functions,
  'previewManagedSubmissionPermanentDelete'
)
const previewLegacyContentPurgeCall = httpsCallable(functions, 'previewLegacyContentPurge')
const purgeLegacyContentCall = httpsCallable(functions, 'purgeLegacyContent')

const permanentlyDeleteManagedSubmissionResultCall = httpsCallable(
  functions,
  'permanentlyDeleteManagedSubmissionResult'
)

function assignmentAccessKey(contentType, contentId) {
  return `${contentType}:${contentId}`
}

function getSchoolId(item) {
  return item?.schoolId || DEFAULT_SCHOOL_ID
}

function isAssignedToTeacher(entity, teacherId) {
  if (!entity || !teacherId) return false

  return (
    entity.teacherId === teacherId ||
    entity.createdBy === teacherId ||
    (Array.isArray(entity.teacherIds) && entity.teacherIds.includes(teacherId))
  )
}

function getLibraryVisibility(item) {
  return item?.visibility || item?.libraryVisibility || 'private'
}

function isTeacherLibraryVisible(item, teacherId, schoolId) {
  if (!item || getSchoolId(item) !== schoolId) return false

  const visibility = getLibraryVisibility(item)

  return isAssignedToTeacher(item, teacherId) || visibility === 'school'
}

function chunkValues(values, size = 10) {
  const clean = Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .filter(value => value !== undefined && value !== null)
        .map(value => value.toString().trim())
        .filter(Boolean)
    )
  )

  const chunks = []

  for (let index = 0; index < clean.length; index += size) {
    chunks.push(clean.slice(index, index + size))
  }

  return chunks
}

function listenMergedQueries(
  queryList,
  onItems,
  label = 'Firestore query',
  onError = null
) {
  if (!Array.isArray(queryList) || queryList.length === 0) {
    onItems([])
    return () => {}
  }

  let active = true
  const buckets = new Map()

  const emit = () => {
    if (!active) return

    const merged = new Map()

    buckets.forEach(items => {
      items.forEach(item => merged.set(item.id, item))
    })

    onItems(Array.from(merged.values()))
  }

  const unsubscribers = queryList.map((queryRef, index) =>
    onSnapshot(
      queryRef,
      snapshot => {
        buckets.set(
          index,
          snapshot.docs.map(item => ({ id: item.id, ...item.data() }))
        )
        emit()
      },
      error => {
        console.warn(`${label} failed`, error)

        // Keep the last successful bucket instead of turning a transient
        // Firestore error into an empty dashboard.
        if (typeof onError === 'function') {
          onError(error, label)
        }

        emit()
      }
    )
  )

  return () => {
    active = false
    unsubscribers.forEach(unsubscribe => unsubscribe())
  }
}

function buildOwnedContentQueries(collectionName, teacherId) {
  const source = collection(db, collectionName)

  return [
    query(source, where('teacherIds', 'array-contains', teacherId)),
    query(source, where('teacherId', '==', teacherId)),
    query(source, where('createdBy', '==', teacherId))
  ]
}

function buildTeacherLibraryQueries(collectionName, teacherId, schoolId) {
  const source = collection(db, collectionName)

  return [
    ...buildOwnedContentQueries(collectionName, teacherId),
    query(
      source,
      where('schoolId', '==', schoolId),
      where('visibility', '==', 'school')
    ),
    query(
      source,
      where('schoolId', '==', schoolId),
      where('libraryVisibility', '==', 'school')
    )
  ]
}

async function getOwnedContentIds(collectionName, teacherId) {
  const snapshots = await Promise.all(
    buildOwnedContentQueries(collectionName, teacherId).map(queryRef =>
      getDocs(queryRef)
    )
  )

  return Array.from(
    new Set(
      snapshots.flatMap(snapshot => snapshot.docs.map(item => item.id))
    )
  )
}

function buildTeacherSubmissionQueries(
  collectionName,
  teacherId,
  _parentFields,
  _parentIds
) {
  const source = collection(db, collectionName)

  // Secure and recent legacy submissions already carry teacherId / teacherIds.
  // Do not add parent-ID `in` fallback listeners here: Firestore Rules may need
  // one parent-document access per returned submission, which can exceed the
  // rules access-call budget and surface as `permission-denied` on busy classes.
  return [
    query(source, where('teacherIds', 'array-contains', teacherId)),
    query(source, where('teacherId', '==', teacherId))
  ]
}


// MAXIMA Teacher Workspace V2 - presentation-only components.
// All academic data, assignment, review and content operations remain in this module.
function TeacherIcon({ name, className = 'h-5 w-5' }) {
  const base = { className, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  const glyphs = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1.3"/><rect x="14" y="3" width="7" height="7" rx="1.3"/><rect x="3" y="14" width="7" height="7" rx="1.3"/><rect x="14" y="14" width="7" height="7" rx="1.3"/></>,
    students: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"/></>,
    library: <><path d="M4 19.5V5.9c2.8-1.2 5.5-1 8 .5 2.5-1.5 5.2-1.7 8-.5v13.6c-2.8-1.2-5.5-1-8 .5-2.5-1.5-5.2-1.7-8-.5ZM12 6.4V20"/></>,
    reviews: <><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5M9 11l2 2 4-4M9 17h6"/></>,
    analytics: <><path d="M3 21h18M6 17V9M12 17V4M18 17v-6"/></>,
    communication: <><path d="M20 11.5c0 4.2-3.6 7.5-8 7.5-1.1 0-2.2-.2-3.2-.6L4 21l1.3-4.3A7.2 7.2 0 0 1 4 12c0-4.2 3.6-7.5 8-7.5s8 3.3 8 7.5ZM8 11.5h8M8 14.5h5"/></>,
    classes: <><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18M8 2v6M16 2v6"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    down: <path d="m6 9 6 6 6-6"/>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
    exit: <><path d="M10 17l5-5-5-5M15 12H3M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    check: <path d="m5 12 5 5L20 7"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.5"/><path d="m16 16 4.2 4.2"/></>,
    filter: <path d="M4 7h16M7 12h10M10 17h4"/>,
    book: <path d="M4 19V6c3-1.5 5.5-1.5 8 0 2.5-1.5 5-1.5 8 0v13c-3-1.5-5.5-1.5-8 0-2.5-1.5-5-1.5-8 0Z"/>,
  }
  return <svg {...base}>{glyphs[name] || glyphs.overview}</svg>
}

const TEACHER_NAV_ITEMS = [
  { id: 'overview', label: 'Overview', icon: 'overview', description: 'Your daily priorities, assignments and teaching activity' },
  { id: 'students', label: 'Students & Classes', icon: 'students', description: 'Student progress, assignments, attempts and class management' },
  { id: 'library', label: 'Content Library', icon: 'library', description: 'Create, preview, assign and reuse your IELTS content' },
  { id: 'reviews', label: 'Reviews', icon: 'reviews', description: 'Grade Writing and Mock Writing submissions' },
  { id: 'analytics', label: 'Analytics', icon: 'analytics', description: 'Explore reading, listening and vocabulary performance' },
  { id: 'communication', label: 'Messages & Materials', icon: 'communication', description: 'Send messages and share teaching materials' },
]

const TEACHER_CONTENT_TABS = [
  { id: 'reading', label: 'Reading' },
  { id: 'listening', label: 'Listening' },
  { id: 'writing', label: 'Writing' },
  { id: 'vocabulary', label: 'Vocabulary' },
  { id: 'mock', label: 'Mock Tests' },
]

const TEACHER_CREATION_ROUTES = [
  { label: 'Reading homework', path: '/create-reading', icon: 'book' },
  { label: 'Listening homework', path: '/create-listening', icon: 'book' },
  { label: 'Writing homework', path: '/create-writing', icon: 'book' },
  { label: 'Vocabulary test', path: '/create-vocabulary', icon: 'book' },
  { label: 'Mock test', path: '/create-mock', icon: 'book' },
]

// Q1A performance: keep reason typing state inside this small dialog.
// Typing must not re-render the large Teacher Dashboard or its live data views.
function StatsModerationDialog({ mode, saving, error, onCancel, onConfirm, onClearError }) {
  const [reason, setReason] = useState('')
  const [localError, setLocalError] = useState('')
  const excluding = mode === 'exclude'
  const reasonIsValid = !excluding || (reason.trim().length >= 5 && reason.length <= 400)

  const submit = event => {
    event.preventDefault()
    if (saving) return
    if (!reasonIsValid) {
      setLocalError('Please provide a reason between 5 and 400 characters.')
      return
    }
    onConfirm(excluding, excluding ? reason : '')
  }

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/60 px-4 py-6">
      <div role="dialog" aria-modal="true" aria-labelledby="q1a-stats-dialog-title"
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-blue-700">Result management</p>
            <h3 id="q1a-stats-dialog-title" className="mt-1 text-lg font-bold text-slate-900">
              {excluding ? 'Exclude from statistics' : 'Restore to statistics'}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              {excluding
                ? 'The submitted result will remain in the student history, but it will not count towards performance statistics.'
                : 'The saved result will count towards performance statistics again.'}
            </p>
          </div>
          <button type="button" onClick={onCancel} disabled={saving}
            aria-label="Close result management dialog"
            className="rounded-lg px-2 py-1 text-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50">
            ×
          </button>
        </div>
        <form className="mt-5 space-y-4" onSubmit={submit}>
          {excluding && (
            <div>
              <label htmlFor="q1a-stats-reason" className="block text-sm font-semibold text-slate-800">
                Reason for excluding this result
              </label>
              <textarea id="q1a-stats-reason" required minLength={5} maxLength={400} rows={4}
                value={reason} onChange={event => {
                  setReason(event.target.value)
                  if (localError) setLocalError('')
                  if (error) onClearError()
                }} autoFocus disabled={saving}
                placeholder="Example: This was a trial attempt and must not affect the student's average."
                className="mt-2 w-full resize-y rounded-xl border border-slate-300 px-3 py-3 text-sm leading-relaxed text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-60" />
              <p className="mt-1 text-xs text-slate-500">{reason.length}/400 characters · at least 5 required</p>
            </div>
          )}
          {(localError || error) && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {localError || error}
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" onClick={onCancel} disabled={saving}
              className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              Cancel
            </button>
            <button type="submit" disabled={saving || !reasonIsValid}
              className={`rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 ${excluding ? 'bg-amber-700 hover:bg-amber-800' : 'bg-emerald-700 hover:bg-emerald-800'}`}>
              {saving ? 'Saving...' : excluding ? 'Exclude result' : 'Restore result'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Q1B: the confirmation input must stay local; each keystroke should not
// re-render the entire teacher workspace (same principle as Q1A's reason box).
function ResultPermanentDeleteDialog({ loading, preview, saving, error, studentName, contentTitle, onCancel, onConfirm }) {
  const [confirmation, setConfirmation] = useState('')
  const valid = confirmation.trim() === 'DELETE RESULTS'
  const available = !loading && preview?.totalRecords > 0
  const submit = event => {
    event.preventDefault()
    if (!available || saving || !valid) return
    onConfirm()
  }

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/70 px-4 py-6">
      <div role="dialog" aria-modal="true" aria-labelledby="q1b-delete-title"
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-red-200 bg-white p-6 shadow-2xl">
        <h3 id="q1b-delete-title" className="text-lg font-bold text-red-800">Permanently delete results</h3>
        <p className="mt-2 text-sm font-semibold text-slate-900">{studentName} · {contentTitle}</p>
        <p className="mt-3 text-sm text-slate-700 leading-relaxed">
          This deletes the selected student's submissions, previous attempts, attempt controls and matching
          Mock scores or Vocabulary drafts for <strong>this one test</strong>. It does not delete the student,
          the test content, assignments, or other students' results.
        </p>
        <p className="mt-2 text-sm font-semibold text-red-700">This cannot be undone.</p>
        {loading ? (
          <p className="mt-4 text-sm text-slate-500">Checking linked records securely...</p>
        ) : preview ? (
          <div className="mt-4 rounded-xl bg-red-50 border border-red-100 p-3 text-sm text-red-900">
            <p><strong>{preview.totalRecords}</strong> Firestore record(s) will be removed.</p>
            <p className="mt-1 text-xs">Current/legacy submissions: {preview.counts?.submissions || 0} · Previous attempts: {preview.counts?.attemptHistory || 0} · Mock scores: {preview.counts?.mockScores || 0} · Attempt controls: {preview.counts?.attemptControls || 0} · Vocabulary drafts: {preview.counts?.vocabularyDrafts || 0}</p>
            <p className="mt-2 text-xs text-slate-600">A minimal, staff-only deletion audit is retained without student answers.</p>
          </div>
        ) : null}
        {error && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <form onSubmit={submit} className="mt-5 space-y-4">
          <div>
            <label htmlFor="q1b-delete-confirm" className="block text-sm font-semibold text-slate-800">
              Type DELETE RESULTS to confirm
            </label>
            <input id="q1b-delete-confirm" type="text" autoComplete="off" autoCapitalize="off"
              value={confirmation} onChange={event => setConfirmation(event.target.value)}
              disabled={loading || saving || !available}
              className="mt-2 w-full rounded-xl border border-red-200 px-3 py-3 text-sm outline-none focus:border-red-500 focus:ring-2 focus:ring-red-100 disabled:opacity-50" />
          </div>
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" onClick={onCancel} disabled={saving}
              className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={saving || !available || !valid}
              className="rounded-xl bg-red-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-800 disabled:opacity-50">
              {saving ? 'Deleting...' : 'Permanently delete all results'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Q1B-B: keep the confirmation input local. Typing must not re-render an
// entire Admin/Teacher Dashboard (the Q1A performance regression).
function LegacyCascadeDialog({ state, onCancel, onConfirm }) {
  const [phrase, setPhrase] = useState('')
  if (!state) return null
  const expectedPhrase = state.mode === 'content' ? 'DELETE CONTENT' : 'DELETE RESULTS'
  const ready = state.preview?.ready !== false && (state.preview?.totalRecords || 0) > 0
  const disabled = state.loading || state.saving || !ready || phrase !== expectedPhrase
  const counts = Object.entries(state.preview?.counts || {}).filter(([, count]) => count > 0)
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 px-4" role="dialog" aria-modal="true" aria-label="Permanent deletion confirmation">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-red-200 bg-white p-6 shadow-2xl">
        <h2 className="text-lg font-bold text-red-800">Permanently delete — cannot be undone</h2>
        <p className="mt-2 break-words text-sm font-semibold text-slate-800">{state.label}</p>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">{state.description}</p>
        {state.loading ? (
          <p className="mt-4 text-sm text-slate-500" role="status">Checking every linked Firestore record...</p>
        ) : state.preview ? (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="font-semibold text-slate-900">{state.preview.totalRecords || 0} linked Firestore document(s)</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {counts.map(([name, count]) => (
                <span key={name} className="rounded-md bg-white border border-slate-200 px-2 py-1 text-xs text-slate-700">
                  {name}: {count}
                </span>
              ))}
            </div>
            {state.preview.blockingReason && (
              <p className="mt-3 text-sm font-medium text-amber-800" role="alert">{state.preview.blockingReason}</p>
            )}
            {!state.preview.blockingReason && state.preview.totalRecords === 0 && (
              <p className="mt-3 text-xs text-slate-600">No matching records were found; nothing can be deleted.</p>
            )}
          </div>
        ) : null}
        {state.error && <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">{state.error}</p>}
        {ready && !state.loading && (
          <label className="mt-4 block text-xs font-semibold text-slate-700">
            To permanently delete, type <strong>{expectedPhrase}</strong>
            <input autoComplete="off" spellCheck={false} value={phrase}
              onChange={e => setPhrase(e.target.value)} disabled={state.saving}
              className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-red-500"
              placeholder={expectedPhrase} />
          </label>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={state.saving}
            className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-40">Cancel</button>
          <button type="button" onClick={() => onConfirm(phrase)} disabled={disabled}
            className="rounded-xl bg-red-700 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40">
            {state.saving ? 'Deleting...' : 'Permanently delete'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function TeacherDashboard() {
  const [students, setStudents] = useState([])
  const [classes, setClasses] = useState([])
  const [legacyCascadeDialog, setLegacyCascadeDialog] = useState(null)
  const [scores, setScores] = useState({})

  const [readings, setReadings] = useState([])
  const [submissions, setSubmissions] = useState([])

  const [writings, setWritings] = useState([])
  const [writingSubmissions, setWritingSubmissions] = useState([])

  const [listenings, setListenings] = useState([])
  const [listeningSubmissions, setListeningSubmissions] = useState([])

  const [mockTests, setMockTests] = useState([])
  const [mockSubmissions, setMockSubmissions] = useState([])

  const [vocabularyTests, setVocabularyTests] = useState([])
  const [vocabularySubmissions, setVocabularySubmissions] = useState([])
  const [assignmentStudentIdsByContent, setAssignmentStudentIdsByContent] = useState({})
  const assignmentSnapshotRequestRef = useRef(0)
  const assignmentRemovalQueueRef = useRef(new Map())

  const [teacherMessages, setTeacherMessages] = useState([])
  const [teacherMaterials, setTeacherMaterials] = useState([])
  const [communicationMode, setCommunicationMode] = useState('message')
  const [communicationAudience, setCommunicationAudience] = useState('student')
  const [communicationStudentId, setCommunicationStudentId] = useState('')
  const [communicationClassId, setCommunicationClassId] = useState('')
  const [communicationTitle, setCommunicationTitle] = useState('')
  const [communicationBody, setCommunicationBody] = useState('')
  const [materialFile, setMaterialFile] = useState(null)
  const [communicationSaving, setCommunicationSaving] = useState(false)
  const [communicationStatus, setCommunicationStatus] = useState('')

  const [materialShareTarget, setMaterialShareTarget] = useState(null)
  const [materialShareAudience, setMaterialShareAudience] = useState('class')
  const [materialShareStudentId, setMaterialShareStudentId] = useState('')
  const [materialShareClassId, setMaterialShareClassId] = useState('')
  const [materialShareSaving, setMaterialShareSaving] = useState(false)
  const [materialShareStatus, setMaterialShareStatus] = useState('')
  
  const [readingLibraryFilter, setReadingLibraryFilter] = useState('active')
  const [writingLibraryFilter, setWritingLibraryFilter] = useState('active')
  const [listeningLibraryFilter, setListeningLibraryFilter] = useState('active')
  const [vocabularyLibraryFilter, setVocabularyLibraryFilter] = useState('active')

  const [readingVisibilityFilter, setReadingVisibilityFilter] = useState('all')
  const [writingVisibilityFilter, setWritingVisibilityFilter] = useState('all')
  const [listeningVisibilityFilter, setListeningVisibilityFilter] = useState('all')
  const [vocabularyVisibilityFilter, setVocabularyVisibilityFilter] = useState('all')
  const [mockVisibilityFilter, setMockVisibilityFilter] = useState('all')

  const [mockContentTypeFilter, setMockContentTypeFilter] = useState('all')

  const [readingContentTypeFilter, setReadingContentTypeFilter] = useState('all')
  const [writingContentTypeFilter, setWritingContentTypeFilter] = useState('all')
  const [listeningContentTypeFilter, setListeningContentTypeFilter] = useState('all')
  const [vocabularyContentTypeFilter, setVocabularyContentTypeFilter] = useState('all')

  const [selected, setSelected] = useState(null)
  const [selectedStudentSection, setSelectedStudentSection] = useState('mock')
  const [selectedReview, setSelectedReview] = useState(null)
  const [selectedVocabularyReview, setSelectedVocabularyReview] = useState(null)

  const [selectedHomework, setSelectedHomework] = useState(null)
  const [selectedHomeworkType, setSelectedHomeworkType] = useState(null)
  const [assignmentDraft, setAssignmentDraft] = useState([])

  const [selectedWritingReview, setSelectedWritingReview] = useState(null)
  const [selectedMockWritingReview, setSelectedMockWritingReview] = useState(null)
  const [attemptManager, setAttemptManager] = useState(null)
  const [attemptManagerLoading, setAttemptManagerLoading] = useState(false)
  const [attemptManagerSaving, setAttemptManagerSaving] = useState(false)
  const [attemptManagerError, setAttemptManagerError] = useState('')
  const [attemptManagerNotice, setAttemptManagerNotice] = useState('')
  const [attemptManagerWarning, setAttemptManagerWarning] = useState('')
  const [statsDialogMode, setStatsDialogMode] = useState(null)
  const [statsDialogError, setStatsDialogError] = useState('')
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteDialogLoading, setDeleteDialogLoading] = useState(false)
  const [deleteDialogPreview, setDeleteDialogPreview] = useState(null)
  const [deleteDialogError, setDeleteDialogError] = useState('')
  const deletePreviewRequestRef = useRef(0)
  const [attemptHistory, setAttemptHistory] = useState([])
  const [attemptHistoryLoading, setAttemptHistoryLoading] = useState(false)
  const [attemptHistoryError, setAttemptHistoryError] = useState('')
  const [writingReviewForm, setWritingReviewForm] = useState({
    task1Band: '',
    task2Band: '',
    task1TA: '',
    task1CC: '',
    task1LR: '',
    task1GRA: '',
    task2TR: '',
    task2CC: '',
    task2LR: '',
    task2GRA: '',
    task1Feedback: '',
    task2Feedback: '',
    overall: '',
    generalFeedback: ''
  })

  const [form, setForm] = useState({
    listening: '',
    reading: '',
    writing: '',
    speaking: '',
    date: ''
  })

  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [newPassword, setNewPassword] = useState('')
  const [passwordMsg, setPasswordMsg] = useState('')
  const [activeTab, setActiveTab] = useState(() => {
    try {
      const storedTab = window.sessionStorage.getItem('maxima_teacher_dashboard_active_tab')
      const allowedTabs = [
        'overview',
        'students',
        'reading',
        'listening',
        'vocabulary',
        'writing',
        'mock',
        'analytics',
        'communication',
        'reviews'
      ]

      return allowedTabs.includes(storedTab) ? storedTab : 'overview'
    } catch {
      return 'overview'
    }
  })
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const [studentSearchTerm, setStudentSearchTerm] = useState('')
  const [studentClassId, setStudentClassId] = useState('all')
  const [reviewView, setReviewView] = useState('pending')
  const [librarySearchTerm, setLibrarySearchTerm] = useState('')
  const [lastLibraryTab, setLastLibraryTab] = useState(() =>
    TEACHER_CONTENT_TABS.some(item => item.id === activeTab) ? activeTab : 'reading'
  )
  const [analyticsStudentId, setAnalyticsStudentId] = useState('all')
  const [dashboardDataError, setDashboardDataError] = useState('')

  const navigate = useNavigate()

  useEffect(() => {
    try {
      window.sessionStorage.setItem('maxima_teacher_dashboard_active_tab', activeTab)
    } catch {
      // Browser storage can be unavailable in restricted/private contexts.
    }
  }, [activeTab])

  const openTeacherSection = id => {
    setCreateMenuOpen(false)
    if (id === 'library') {
      setActiveTab(lastLibraryTab)
    } else {
      setActiveTab(id)
    }
  }

  const openTeacherContentTab = id => {
    setLastLibraryTab(id)
    setActiveTab(id)
  }

  const openTeacherPreview = (type, contentId) => {
    navigate(`/preview/${type}/${contentId}`)
  }

  const reportLiveQueryError = (error, label = 'Dashboard data') => {
    console.warn(`${label} failed`, error)
    setDashboardDataError(
      'Some dashboard data could not be refreshed. Existing data is being kept on screen. Firestore listeners will retry automatically.'
    )
  }

  const refreshCanonicalAssignmentSnapshot = async () => {
    if (!user || !profile) return

    const requestId = ++assignmentSnapshotRequestRef.current
    const items = [
      ...readings.map(item => ({ contentType: 'reading', contentId: item.id })),
      ...writings.map(item => ({ contentType: 'writing', contentId: item.id })),
      ...listenings.map(item => ({ contentType: 'listening', contentId: item.id })),
      ...vocabularyTests.map(item => ({ contentType: 'vocabulary', contentId: item.id })),
      ...mockTests.map(item => ({ contentType: 'mock', contentId: item.id }))
    ].filter(item => item.contentId)

    if (items.length === 0) {
      if (requestId === assignmentSnapshotRequestRef.current) {
        setAssignmentStudentIdsByContent({})
      }
      return
    }

    try {
      const result = await getManagedContentStudentAccessSnapshotCall({ items })
      if (requestId !== assignmentSnapshotRequestRef.current) return

      const next = {}
      const assignments = Array.isArray(result.data?.assignments)
        ? result.data.assignments
        : []

      assignments.forEach(assignment => {
        if (!assignment?.contentType || !assignment?.contentId) return
        next[assignmentAccessKey(assignment.contentType, assignment.contentId)] = Array.from(
          new Set(
            (Array.isArray(assignment.studentIds) ? assignment.studentIds : [])
              .filter(Boolean)
          )
        )
      })

      setAssignmentStudentIdsByContent(next)
    } catch (error) {
      if (requestId !== assignmentSnapshotRequestRef.current) return
      console.error('Could not refresh canonical assignment snapshot:', error)
      setDashboardDataError(
        'Assignment data could not be refreshed. Existing assignment information is being kept on screen.'
      )
    }
  }

  const queueAssignmentRemoval = (assignmentKey, task) => {
    const previous = assignmentRemovalQueueRef.current.get(assignmentKey) || Promise.resolve()
    const next = previous.catch(() => {}).then(task)

    assignmentRemovalQueueRef.current.set(assignmentKey, next)

    void next
      .finally(() => {
        if (assignmentRemovalQueueRef.current.get(assignmentKey) !== next) return

        assignmentRemovalQueueRef.current.delete(assignmentKey)
        void refreshCanonicalAssignmentSnapshot()
      })
      .catch(() => {})

    return next
  }

  useEffect(() => {
    if (!user || !profile) {
      assignmentSnapshotRequestRef.current += 1
      setAssignmentStudentIdsByContent({})
      return undefined
    }

    const timer = window.setTimeout(() => {
      refreshCanonicalAssignmentSnapshot()
    }, 120)

    return () => window.clearTimeout(timer)
  }, [user, profile, readings, writings, listenings, vocabularyTests, mockTests])

  useEffect(() => {
    let isActive = true
    const liveUnsubscribers = []

    const clearLiveUnsubscribers = () => {
      while (liveUnsubscribers.length > 0) {
        const unsubscribe = liveUnsubscribers.pop()

        if (typeof unsubscribe === 'function') {
          unsubscribe()
        }
      }
    }

    const trackSnapshot = unsubscribe => {
      liveUnsubscribers.push(unsubscribe)
      return unsubscribe
    }

    const unsubAuth = onAuthStateChanged(auth, async currentUser => {
      clearLiveUnsubscribers()
      setDashboardDataError('')

      if (!currentUser) {
        navigate('/login')
        return
      }

      try {
        const profileSnap = await getDoc(doc(db, 'users', currentUser.uid))

        if (!isActive) return

        if (!profileSnap.exists()) {
          await signOut(auth)
          navigate('/login')
          return
        }

        const profile = profileSnap.data()

        if (
          profile.deleted === true ||
          profile.status !== 'approved' ||
          (profile.role !== 'teacher' && profile.role !== 'admin')
        ) {
          await signOut(auth)
          navigate('/login')
          return
        }

        setUser(currentUser)
        setProfile(profile)

        const isAdminUser = profile.role === 'admin'
        const teacherSchoolId = profile.schoolId || DEFAULT_SCHOOL_ID

        const studentsQuery = isAdminUser
          ? query(collection(db, 'users'), where('role', '==', 'student'))
          : query(
              collection(db, 'users'),
              where('role', '==', 'student'),
              where('teacherIds', 'array-contains', currentUser.uid)
            )

        trackSnapshot(
          onSnapshot(
            studentsQuery,
            snap => {
              const list = snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .filter(u => {
                  if (u.deleted || u.status !== 'approved') return false
                  if (u.accountType === 'individual' || u.schoolId === '__individual__') return false
                  if (isAdminUser) return true

                  return getSchoolId(u) === teacherSchoolId
                })
                .sort((a, b) =>
                  (a.name || a.email || '').localeCompare(b.name || b.email || '')
                )

              setStudents(list)
            },
            error => reportLiveQueryError(error, 'Student list query')
          )
        )

        const classesQuery = isAdminUser
          ? query(collection(db, 'classes'))
          : query(
              collection(db, 'classes'),
              where('teacherId', '==', currentUser.uid)
            )

        trackSnapshot(
          onSnapshot(
            classesQuery,
            snap => {
              const list = snap.docs
                .map(d => ({ id: d.id, ...d.data() }))
                .filter(classItem => {
                  if (classItem.archived === true) return false
                  if (isAdminUser) return true

                  return getSchoolId(classItem) === teacherSchoolId
                })
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''))

              setClasses(list)
            },
            error => reportLiveQueryError(error, 'Class list query')
          )
        )

        const [
          ownedReadingIds,
          ownedWritingIds,
          ownedListeningIds,
          ownedMockIds,
          ownedVocabularyIds
        ] = isAdminUser
          ? [[], [], [], [], []]
          : await Promise.all([
              getOwnedContentIds('readings', currentUser.uid),
              getOwnedContentIds('writingHomeworks', currentUser.uid),
              getOwnedContentIds('listenings', currentUser.uid),
              getOwnedContentIds('mockTests', currentUser.uid),
              getOwnedContentIds('vocabularyTests', currentUser.uid)
            ])

        if (!isActive) return

        const contentQueries = collectionName =>
          isAdminUser
            ? [query(collection(db, collectionName))]
            : buildTeacherLibraryQueries(
                collectionName,
                currentUser.uid,
                teacherSchoolId
              )

        const setSortedLibraryItems = setter => items => {
          const list = items
            .filter(item => {
              if (isAdminUser) return true
              return isTeacherLibraryVisible(
                item,
                currentUser.uid,
                teacherSchoolId
              )
            })
            .sort(
              (a, b) =>
                new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
            )

          setter(list)
        }

        trackSnapshot(
          listenMergedQueries(
            contentQueries('readings'),
            setSortedLibraryItems(setReadings),
            'Reading library query',
            reportLiveQueryError
          )
        )

        trackSnapshot(
          listenMergedQueries(
            contentQueries('writingHomeworks'),
            setSortedLibraryItems(setWritings),
            'Writing library query',
            reportLiveQueryError
          )
        )

        trackSnapshot(
          listenMergedQueries(
            contentQueries('listenings'),
            setSortedLibraryItems(setListenings),
            'Listening library query',
            reportLiveQueryError
          )
        )

        trackSnapshot(
          listenMergedQueries(
            contentQueries('mockTests'),
            setSortedLibraryItems(setMockTests),
            'Mock library query',
            reportLiveQueryError
          )
        )

        trackSnapshot(
          listenMergedQueries(
            contentQueries('vocabularyTests'),
            setSortedLibraryItems(setVocabularyTests),
            'Vocabulary library query',
            reportLiveQueryError
          )
        )

        const submissionQueries = (
          collectionName,
          parentFields,
          parentIds
        ) =>
          isAdminUser
            ? [query(collection(db, collectionName))]
            : buildTeacherSubmissionQueries(
                collectionName,
                currentUser.uid,
                parentFields,
                parentIds
              )

        trackSnapshot(
          listenMergedQueries(
            submissionQueries(
              'readingSubmissions',
              ['readingId'],
              ownedReadingIds
            ),
            setSubmissions,
            'Reading submission query',
            reportLiveQueryError
          )
        )

        trackSnapshot(
          listenMergedQueries(
            submissionQueries(
              'writingSubmissions',
              ['writingId'],
              ownedWritingIds
            ),
            setWritingSubmissions,
            'Writing submission query',
            reportLiveQueryError
          )
        )

        trackSnapshot(
          listenMergedQueries(
            submissionQueries(
              'listeningSubmissions',
              ['listeningId'],
              ownedListeningIds
            ),
            setListeningSubmissions,
            'Listening submission query',
            reportLiveQueryError
          )
        )

        trackSnapshot(
          listenMergedQueries(
            submissionQueries(
              'mockSubmissions',
              ['mockTestId'],
              ownedMockIds
            ),
            setMockSubmissions,
            'Mock submission query',
            reportLiveQueryError
          )
        )

        trackSnapshot(
          listenMergedQueries(
            submissionQueries(
              'vocabularySubmissions',
              ['vocabularyTestId', 'vocabularyId', 'testId', 'homeworkId'],
              ownedVocabularyIds
            ),
            setVocabularySubmissions,
            'Vocabulary submission query',
            reportLiveQueryError
          )
        )

        const communicationQueries = collectionName =>
          isAdminUser
            ? [query(collection(db, collectionName))]
            : [
                query(
                  collection(db, collectionName),
                  where('teacherIds', 'array-contains', currentUser.uid)
                ),
                query(
                  collection(db, collectionName),
                  where('teacherId', '==', currentUser.uid)
                )
              ]

        trackSnapshot(
          listenMergedQueries(
            communicationQueries('messages'),
            items =>
              setTeacherMessages(
                [...items].sort(
                  (a, b) =>
                    new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
                )
              ),
            'Message query',
            reportLiveQueryError
          )
        )

        trackSnapshot(
          listenMergedQueries(
            communicationQueries('materials'),
            items =>
              setTeacherMaterials(
                [...items].sort(
                  (a, b) =>
                    new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
                )
              ),
            'Material query',
            reportLiveQueryError
          )
        )

        const scoreQueries = isAdminUser
          ? [query(collection(db, 'scores'))]
          : [
              query(
                collection(db, 'scores'),
                where('teacherIds', 'array-contains', currentUser.uid)
              ),
              query(
                collection(db, 'scores'),
                where('teacherId', '==', currentUser.uid)
              ),
              query(
                collection(db, 'scores'),
                where('addedBy', '==', currentUser.uid)
              )
            ]

        trackSnapshot(
          listenMergedQueries(
            scoreQueries,
            scoreItems => {
              const groupedScores = {}

              scoreItems.forEach(score => {
                if (!score.uid) return

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
            },
            'Score query',
            reportLiveQueryError
          )
        )
      } catch (error) {
        console.error(error)

        if (isActive) {
          // A transient Firestore/network problem should not log a valid
          // teacher out of the application or replace the dashboard with
          // the login page.
          setUser(currentUser)
          setDashboardDataError(
            'The dashboard could not finish loading all data. Check your connection and retry. Your account has not been signed out.'
          )
        }
      }
    })

    return () => {
      isActive = false
      unsubAuth()
      clearLiveUnsubscribers()
    }
  }, [navigate])

  const activeReadings = readings.filter(r => !r.archived)
  const archivedReadings = readings.filter(r => r.archived)

  const activeWritings = writings.filter(w => !w.archived)
  const archivedWritings = writings.filter(w => w.archived)

  const activeListenings = listenings.filter(l => !l.archived)
  const archivedListenings = listenings.filter(l => l.archived)

  const activeMockTests = mockTests.filter(mock => !mock.archived)
  const archivedMockTests = mockTests.filter(mock => mock.archived)

  const activeVocabularyTests = vocabularyTests.filter(vocabulary => !vocabulary.archived)
  const archivedVocabularyTests = vocabularyTests.filter(vocabulary => vocabulary.archived)
  

  const overall = score => {
    const avg =
      (+score.listening +
        +score.reading +
        +score.writing +
        +score.speaking) /
      4

    return (Math.round(avg * 2) / 2).toFixed(1)
  }

  const normalizeAssignmentId = value =>
    value === undefined || value === null
      ? ''
      : value.toString().trim().toLowerCase()

  const uniqueCleanValues = values =>
    Array.from(
      new Set(
        values
          .filter(value => value !== undefined && value !== null)
          .map(value => value.toString().trim())
          .filter(Boolean)
      )
    )

  const getStudentPrimaryAssignmentId = student =>
    student?.uid || student?.authUid || student?.id || ''

  const getStudentAssignmentValues = student =>
    uniqueCleanValues([
      student?.id,
      student?.uid,
      student?.authUid,
      student?.email,
      student?.email?.toLowerCase()
    ])

  const getCanonicalAssignmentStudentIds = (contentType, contentId) => {
    if (!contentType || !contentId) return []
    const value = assignmentStudentIdsByContent[assignmentAccessKey(contentType, contentId)]
    return Array.isArray(value) ? value : []
  }

  const getCanonicalAssignmentCount = (contentType, contentId) =>
    getCanonicalAssignmentStudentIds(contentType, contentId).length

  const isHomeworkAssignedToStudent = (homework, student, contentType) => {
    if (!homework || !student || !contentType) return false

    const canonicalValues = getCanonicalAssignmentStudentIds(contentType, homework.id)
      .map(normalizeAssignmentId)
    const studentValues = getStudentAssignmentValues(student).map(normalizeAssignmentId)

    return studentValues.some(value => canonicalValues.includes(value))
  }

  const getStudentByAnyId = studentId => {
    const normalized = normalizeAssignmentId(studentId)

    return students.find(student =>
      getStudentAssignmentValues(student)
        .map(normalizeAssignmentId)
        .includes(normalized)
    )
  }

  const submissionBelongsToStudent = (submission, student) => {
    if (!submission || !student) return false

    const studentValues = getStudentAssignmentValues(student).map(normalizeAssignmentId)
    const submissionValues = uniqueCleanValues([
      submission.uid,
      submission.studentId,
      submission.studentEmail,
      submission.email
    ]).map(normalizeAssignmentId)

    return submissionValues.some(value => studentValues.includes(value))
  }


  const submissionTimeMillis = submission => {
    const value = submission?.submittedAt || submission?.createdAt || submission?.date
    if (!value) return 0
    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      return Number.isFinite(parsed) ? parsed : 0
    }
    if (value instanceof Date) return value.getTime()
    if (typeof value?.toMillis === 'function') return value.toMillis()
    if (typeof value?.toDate === 'function') return value.toDate().getTime()
    return 0
  }

  const submissionAttemptNumber = submission => {
    const value = Number(submission?.attemptNumber)
    return Number.isInteger(value) && value >= 1 ? value : 1
  }

  const hasMeaningfulSubmissionValue = value => {
    if (value === undefined || value === null) return false
    if (typeof value === 'string') return value.trim().length > 0
    if (typeof value === 'number' || typeof value === 'boolean') return true
    if (Array.isArray(value)) return value.some(hasMeaningfulSubmissionValue)
    if (typeof value === 'object') return Object.values(value).some(hasMeaningfulSubmissionValue)
    return false
  }

  const submissionHasMeaningfulAnswers = submission =>
    hasMeaningfulSubmissionValue(submission?.answers) ||
    hasMeaningfulSubmissionValue(submission?.task1Answer) ||
    hasMeaningfulSubmissionValue(submission?.task2Answer) ||
    hasMeaningfulSubmissionValue(submission?.listeningAnswers) ||
    hasMeaningfulSubmissionValue(submission?.readingAnswers) ||
    hasMeaningfulSubmissionValue(submission?.writingAnswers)

  const chooseCurrentSubmission = records => {
    const cleanRecords = (records || []).filter(Boolean)
    if (cleanRecords.length === 0) return null

    return [...cleanRecords].sort((a, b) => {
      const attemptDifference = submissionAttemptNumber(b) - submissionAttemptNumber(a)
      if (attemptDifference !== 0) return attemptDifference

      const aMeaningful = submissionHasMeaningfulAnswers(a)
      const bMeaningful = submissionHasMeaningfulAnswers(b)
      if (aMeaningful !== bMeaningful) return aMeaningful ? -1 : 1

      const timeDifference = submissionTimeMillis(b) - submissionTimeMillis(a)
      if (timeDifference !== 0) return timeDifference

      if ((a?.autoSubmitted === true) !== (b?.autoSubmitted === true)) {
        return a?.autoSubmitted === true ? 1 : -1
      }

      return (a?.id || '').localeCompare(b?.id || '')
    })[0]
  }

  const dedupeSubmissionHeadsByStudent = (records, getContentId) => {
    const groups = new Map()

    ;(records || []).forEach(submission => {
      const studentKey = normalizeAssignmentId(
        submission?.uid || submission?.studentId || submission?.studentEmail
      )
      const rawContentId = getContentId(submission)
      const contentId = rawContentId === undefined || rawContentId === null
        ? ''
        : rawContentId.toString()

      if (!studentKey || !contentId) return

      const key = `${studentKey}:${contentId}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(submission)
    })

    return Array.from(groups.values())
      .map(chooseCurrentSubmission)
      .filter(Boolean)
  }

  const currentReadingSubmissions = dedupeSubmissionHeadsByStudent(
    submissions,
    submission => submission.readingId
  )
  const currentWritingSubmissions = dedupeSubmissionHeadsByStudent(
    writingSubmissions,
    submission => submission.writingId
  )
  const currentListeningSubmissions = dedupeSubmissionHeadsByStudent(
    listeningSubmissions,
    submission => submission.listeningId
  )
  const currentVocabularySubmissions = dedupeSubmissionHeadsByStudent(
    vocabularySubmissions,
    submission =>
      submission.vocabularyTestId || submission.vocabularyId || submission.testId || submission.homeworkId
  )
  const currentMockSubmissions = dedupeSubmissionHeadsByStudent(
    mockSubmissions,
    submission => submission.mockTestId
  )

  // Q1A: completion/review lists keep every saved result; only performance
  // metrics drop submissions explicitly excluded by an authorized manager.
  const analyticsReadingSubmissions = currentReadingSubmissions.filter(
    submission => submission.excludedFromStats !== true
  )
  const analyticsListeningSubmissions = currentListeningSubmissions.filter(
    submission => submission.excludedFromStats !== true
  )

  const handleAddScore = async () => {
    if (
      !form.listening ||
      !form.reading ||
      !form.writing ||
      !form.speaking ||
      !form.date
    ) {
      return
    }

    const scoreTeacherIds = profile?.role === 'teacher'
      ? [user.uid]
      : selected.teacherIds || []

    await addDoc(collection(db, 'scores'), {
      ...form,
      uid: getStudentPrimaryAssignmentId(selected),
      studentId: getStudentPrimaryAssignmentId(selected),
      overall: overall(form),
      addedBy: user.uid,
      teacherId: scoreTeacherIds[0] || '',
      teacherIds: scoreTeacherIds,
      schoolId: profile?.schoolId || getSchoolId(selected)
    })

    setForm({
      listening: '',
      reading: '',
      writing: '',
      speaking: '',
      date: ''
    })
  }

  const latestScore = studentId => {
    const student = getStudentByAnyId(studentId)
    const scoreKey = getStudentPrimaryAssignmentId(student) || studentId

    return scores[scoreKey]?.[0] || scores[studentId]?.[0]
  }

  const mergeUniqueById = (...groups) => {
    const map = new Map()

    groups.flat().forEach(item => {
      if (!item?.id) return
      map.set(item.id, item)
    })

    return Array.from(map.values()).sort(
      (a, b) => new Date(b.createdAt || b.updatedAt || 0) - new Date(a.createdAt || a.updatedAt || 0)
    )
  }

  const getStudentReadings = studentId => {
    const student = getStudentByAnyId(studentId)

    const assignedReadings = activeReadings.filter(reading =>
      isHomeworkAssignedToStudent(reading, student, 'reading')
    )

    const submittedReadingIds = new Set(
      submissions
        .filter(submission => submissionBelongsToStudent(submission, student))
        .map(submission => normalizeAssignmentId(submission.readingId))
        .filter(Boolean)
    )

    const submittedReadings = readings.filter(reading =>
      submittedReadingIds.has(normalizeAssignmentId(reading.id))
    )

    return mergeUniqueById(assignedReadings, submittedReadings)
  }

  const getStudentWritings = studentId => {
    const student = getStudentByAnyId(studentId)

    const assignedWritings = activeWritings.filter(writing =>
      isHomeworkAssignedToStudent(writing, student, 'writing')
    )

    const submittedWritingIds = new Set(
      writingSubmissions
        .filter(submission => submissionBelongsToStudent(submission, student))
        .map(submission => normalizeAssignmentId(submission.writingId))
        .filter(Boolean)
    )

    const submittedWritings = writings.filter(writing =>
      submittedWritingIds.has(normalizeAssignmentId(writing.id))
    )

    return mergeUniqueById(assignedWritings, submittedWritings)
  }

  const getStudentListenings = studentId => {
    const student = getStudentByAnyId(studentId)

    const assignedListenings = activeListenings.filter(listening =>
      isHomeworkAssignedToStudent(listening, student, 'listening')
    )

    const submittedListeningIds = new Set(
      listeningSubmissions
        .filter(submission => submissionBelongsToStudent(submission, student))
        .map(submission => normalizeAssignmentId(submission.listeningId))
        .filter(Boolean)
    )

    const submittedListenings = listenings.filter(listening =>
      submittedListeningIds.has(normalizeAssignmentId(listening.id))
    )

    return mergeUniqueById(assignedListenings, submittedListenings)
  }

  const getStudentVocabularyTests = studentId => {
    const student = getStudentByAnyId(studentId)

    const assignedVocabularyTests = activeVocabularyTests.filter(vocabularyTest =>
      isHomeworkAssignedToStudent(vocabularyTest, student, 'vocabulary')
    )

    const submittedVocabularyTests = vocabularyTests.filter(vocabularyTest =>
      vocabularySubmissions.some(submission =>
        submissionBelongsToStudent(submission, student) &&
        isVocabularySubmissionForTest(submission, vocabularyTest.id)
      )
    )

    return mergeUniqueById(assignedVocabularyTests, submittedVocabularyTests)
  }

  const isVocabularySubmissionForTest = (submission, vocabularyTestId) => {
    if (!submission || !vocabularyTestId) return false

    return [
      submission.vocabularyTestId,
      submission.vocabularyId,
      submission.testId,
      submission.homeworkId
    ]
      .map(normalizeAssignmentId)
      .includes(normalizeAssignmentId(vocabularyTestId))
  }

  const getSubmission = (studentId, readingId) => {
    const student = getStudentByAnyId(studentId)

    return chooseCurrentSubmission(
      currentReadingSubmissions.filter(
        sub => submissionBelongsToStudent(sub, student) && sub.readingId === readingId
      )
    )
  }

  const getWritingSubmission = (studentId, writingId) => {
    const student = getStudentByAnyId(studentId)

    return chooseCurrentSubmission(
      currentWritingSubmissions.filter(
        sub => submissionBelongsToStudent(sub, student) && sub.writingId === writingId
      )
    )
  }

  const getListeningSubmission = (studentId, listeningId) => {
    const student = getStudentByAnyId(studentId)

    return chooseCurrentSubmission(
      currentListeningSubmissions.filter(
        sub => submissionBelongsToStudent(sub, student) && sub.listeningId === listeningId
      )
    )
  }

  const getVocabularySubmission = (studentId, vocabularyTestId) => {
    const student = getStudentByAnyId(studentId)

    return chooseCurrentSubmission(
      currentVocabularySubmissions.filter(
        sub =>
          submissionBelongsToStudent(sub, student) &&
          isVocabularySubmissionForTest(sub, vocabularyTestId)
      )
    )
  }


  const getMockSubmission = (studentId, mockTestId) => {
    const student = getStudentByAnyId(studentId)

    return chooseCurrentSubmission(
      currentMockSubmissions.filter(
        submission =>
          submissionBelongsToStudent(submission, student) &&
          submission.mockTestId === mockTestId
      )
    )
  }

  const isPastDue = homework => {
    if (!homework?.dueDate) return false

    const due = new Date(homework.dueDate)
    if (Number.isNaN(due.getTime())) return false

    due.setHours(23, 59, 59, 999)
    return due.getTime() < Date.now()
  }

  const getStudentHomeworkProgress = studentId => {
    const student = getStudentByAnyId(studentId)

    const typeGroups = [
      {
        key: 'reading',
        label: 'Reading',
        items: activeReadings.filter(item =>
          isHomeworkAssignedToStudent(item, student, 'reading')
        ),
        isDone: item => Boolean(getSubmission(studentId, item.id))
      },
      {
        key: 'listening',
        label: 'Listening',
        items: activeListenings.filter(item =>
          isHomeworkAssignedToStudent(item, student, 'listening')
        ),
        isDone: item => Boolean(getListeningSubmission(studentId, item.id))
      },
      {
        key: 'vocabulary',
        label: 'Vocabulary',
        items: activeVocabularyTests.filter(item =>
          isHomeworkAssignedToStudent(item, student, 'vocabulary')
        ),
        isDone: item => Boolean(getVocabularySubmission(studentId, item.id))
      },
      {
        key: 'writing',
        label: 'Writing',
        items: activeWritings.filter(item =>
          isHomeworkAssignedToStudent(item, student, 'writing')
        ),
        isDone: item => Boolean(getWritingSubmission(studentId, item.id))
      },
      {
        key: 'mock',
        label: 'Mock Tests',
        items: activeMockTests.filter(item =>
          isHomeworkAssignedToStudent(item, student, 'mock')
        ),
        isDone: item =>
          getStudentMockSubmissions(studentId).some(
            submission => submission.mockTestId === item.id
          )
      }
    ]

    const summary = {
      assigned: 0,
      completed: 0,
      notCompleted: 0,
      overdue: 0,
      rate: 0,
      types: {}
    }

    typeGroups.forEach(group => {
      const completed = group.items.filter(group.isDone).length
      const assigned = group.items.length
      const overdue = group.items.filter(
        item => !group.isDone(item) && isPastDue(item)
      ).length

      summary.types[group.key] = {
        label: group.label,
        assigned,
        completed,
        notCompleted: Math.max(assigned - completed, 0),
        overdue,
        rate: assigned ? Math.round((completed / assigned) * 100) : 0
      }

      summary.assigned += assigned
      summary.completed += completed
      summary.overdue += overdue
    })

    summary.notCompleted = Math.max(summary.assigned - summary.completed, 0)
    summary.rate = summary.assigned
      ? Math.round((summary.completed / summary.assigned) * 100)
      : 0

    return summary
  }

  const getCommunicationRecipients = () => {
    if (communicationAudience === 'student') {
      const student = getStudentByAnyId(communicationStudentId)
      return student ? [student] : []
    }

    const classItem = classes.find(item => item.id === communicationClassId)
    if (!classItem) return []

    return (classItem.studentIds || [])
      .map(studentId => getStudentByAnyId(studentId))
      .filter(Boolean)
  }

  const getCommunicationRecipientPayload = () => {
    const recipientStudents = getCommunicationRecipients()
    const classItem = communicationAudience === 'class'
      ? classes.find(item => item.id === communicationClassId)
      : null

    return {
      recipientStudents,
      recipientIds: uniqueCleanValues(
        recipientStudents.map(student => getStudentPrimaryAssignmentId(student))
      ),
      recipientNames: recipientStudents.map(
        student => student.name || student.email || 'Student'
      ),
      classId: classItem?.id || '',
      className: classItem?.name || ''
    }
  }

  const resetCommunicationForm = () => {
    setCommunicationTitle('')
    setCommunicationBody('')
    setMaterialFile(null)
    setCommunicationStatus('')
  }

  const sendTeacherMessage = async () => {
    const { recipientIds, recipientNames, classId, className } =
      getCommunicationRecipientPayload()

    if (recipientIds.length === 0) {
      alert('Please select a student or class.')
      return
    }

    if (!communicationTitle.trim() || !communicationBody.trim()) {
      alert('Please add a title and message.')
      return
    }

    setCommunicationSaving(true)
    setCommunicationStatus('Sending...')

    try {
      await addDoc(collection(db, 'messages'), {
        senderId: user.uid,
        senderName:
          profile?.name || profile?.fullName || user.email || 'Teacher',
        teacherId: user.uid,
        teacherIds: [user.uid],
        schoolId: profile?.schoolId || DEFAULT_SCHOOL_ID,
        recipientIds,
        recipientNames,
        classId,
        className,
        title: communicationTitle.trim(),
        body: communicationBody.trim(),
        readBy: [],
        archived: false,
        createdAt: new Date().toISOString()
      })

      resetCommunicationForm()
      setCommunicationStatus('Message sent ✓')
    } catch (error) {
      console.error('Could not send message:', error)
      setCommunicationStatus('Could not send message')
    } finally {
      setCommunicationSaving(false)
    }
  }

  const sendTeacherMaterial = async () => {
    const { recipientIds, recipientNames, classId, className } =
      getCommunicationRecipientPayload()

    if (recipientIds.length === 0) {
      alert('Please select a student or class.')
      return
    }

    if (!communicationTitle.trim()) {
      alert('Please add a material title.')
      return
    }

    if (!materialFile) {
      alert('Please select a file.')
      return
    }

    if (materialFile.size > 25 * 1024 * 1024) {
      alert('The file must be 25 MB or smaller.')
      return
    }

    setCommunicationSaving(true)
    setCommunicationStatus('Uploading...')

    const materialDocRef = doc(collection(db, 'materials'))
    const safeFileName = materialFile.name.replace(/[^a-zA-Z0-9._-]+/g, '_')
    const filePath = `materials/${user.uid}/${materialDocRef.id}/${Date.now()}_${safeFileName}`
    const fileRef = storageRef(storage, filePath)
    let uploaded = false

    try {
      await uploadBytes(fileRef, materialFile, {
        contentType: materialFile.type || 'application/octet-stream'
      })
      uploaded = true

      const sharedAt = new Date().toISOString()
      const initialShareTarget = {
        type: communicationAudience,
        classId: classId || '',
        className: className || '',
        studentId:
          communicationAudience === 'student'
            ? recipientIds[0] || ''
            : '',
        studentName:
          communicationAudience === 'student'
            ? recipientNames[0] || ''
            : '',
        label:
          communicationAudience === 'class'
            ? className || 'Class'
            : recipientNames[0] || 'Student',
        recipientIds,
        recipientNames,
        sharedAt
      }

      await setDoc(materialDocRef, {
        ownerId: user.uid,
        teacherId: user.uid,
        teacherIds: [user.uid],
        senderName:
          profile?.name || profile?.fullName || user.email || 'Teacher',
        schoolId: profile?.schoolId || DEFAULT_SCHOOL_ID,
        recipientIds,
        recipientNames,
        readBy: [],
        classId,
        className,
        shareTargets: [initialShareTarget],
        title: communicationTitle.trim(),
        description: communicationBody.trim(),
        fileName: materialFile.name,
        fileType: materialFile.type || 'application/octet-stream',
        fileSize: materialFile.size,
        storagePath: filePath,
        archived: false,
        createdAt: sharedAt,
        updatedAt: sharedAt
      })

      resetCommunicationForm()
      setCommunicationStatus('Material sent ✓')
    } catch (error) {
      console.error('Could not send material:', error)

      if (uploaded) {
        try {
          await deleteObject(fileRef)
        } catch (cleanupError) {
          console.warn('Could not remove orphaned material file:', cleanupError)
        }
      }

      setCommunicationStatus('Could not send material')
    } finally {
      setCommunicationSaving(false)
    }
  }

  const openTeacherMaterial = async material => {
    try {
      const url = await getDownloadURL(storageRef(storage, material.storagePath))
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      console.error('Could not open material:', error)
      alert('Could not open this material.')
    }
  }

  const getLegacyMaterialShareTarget = material => {
    const recipientIds = Array.isArray(material?.recipientIds)
      ? material.recipientIds
      : []
    const recipientNames = Array.isArray(material?.recipientNames)
      ? material.recipientNames
      : []

    if (material?.classId || material?.className) {
      return {
        type: 'class',
        classId: material.classId || '',
        className: material.className || '',
        studentId: '',
        studentName: '',
        label: material.className || 'Class',
        recipientIds,
        recipientNames,
        sharedAt: material.createdAt || ''
      }
    }

    if (recipientIds.length === 1) {
      return {
        type: 'student',
        classId: '',
        className: '',
        studentId: recipientIds[0],
        studentName: recipientNames[0] || '',
        label: recipientNames[0] || 'Student',
        recipientIds,
        recipientNames,
        sharedAt: material.createdAt || ''
      }
    }

    if (recipientIds.length > 1) {
      return {
        type: 'students',
        classId: '',
        className: '',
        studentId: '',
        studentName: '',
        label: `${recipientIds.length} students`,
        recipientIds,
        recipientNames,
        sharedAt: material.createdAt || ''
      }
    }

    return null
  }

  const getMaterialShareTargets = material => {
    if (Array.isArray(material?.shareTargets) && material.shareTargets.length > 0) {
      return material.shareTargets
    }

    const legacy = getLegacyMaterialShareTarget(material)
    return legacy ? [legacy] : []
  }

  const getMaterialShareLabels = material => {
    const labels = getMaterialShareTargets(material)
      .map(target =>
        target?.label ||
        target?.className ||
        target?.studentName ||
        ''
      )
      .filter(Boolean)

    return uniqueCleanValues(labels)
  }

  const getMaterialReadCount = material => {
    const recipientIds = new Set(
      uniqueCleanValues(Array.isArray(material?.recipientIds) ? material.recipientIds : [])
        .map(normalizeAssignmentId)
        .filter(Boolean)
    )

    return uniqueCleanValues(Array.isArray(material?.readBy) ? material.readBy : [])
      .map(normalizeAssignmentId)
      .filter(value => value && recipientIds.has(value))
      .length
  }

  const openMaterialShareAgain = material => {
    setMaterialShareTarget(material)
    setMaterialShareAudience('class')
    setMaterialShareStudentId('')
    setMaterialShareClassId('')
    setMaterialShareStatus('')
  }

  const closeMaterialShareAgain = () => {
    if (materialShareSaving) return

    setMaterialShareTarget(null)
    setMaterialShareStudentId('')
    setMaterialShareClassId('')
    setMaterialShareStatus('')
  }

  const getMaterialShareRecipientPayload = () => {
    if (materialShareAudience === 'student') {
      const student = getStudentByAnyId(materialShareStudentId)

      if (!student) {
        return {
          recipientIds: [],
          recipientNames: [],
          classId: '',
          className: '',
          studentId: '',
          studentName: ''
        }
      }

      const studentId = getStudentPrimaryAssignmentId(student)
      const studentName = student.name || student.email || 'Student'

      return {
        recipientIds: studentId ? [studentId] : [],
        recipientNames: [studentName],
        classId: '',
        className: '',
        studentId,
        studentName
      }
    }

    const classItem = classes.find(item => item.id === materialShareClassId)

    if (!classItem) {
      return {
        recipientIds: [],
        recipientNames: [],
        classId: '',
        className: '',
        studentId: '',
        studentName: ''
      }
    }

    const recipientStudents = (classItem.studentIds || [])
      .map(studentId => getStudentByAnyId(studentId))
      .filter(Boolean)

    return {
      recipientIds: uniqueCleanValues(
        recipientStudents.map(student => getStudentPrimaryAssignmentId(student))
      ),
      recipientNames: recipientStudents.map(
        student => student.name || student.email || 'Student'
      ),
      classId: classItem.id,
      className: classItem.name || 'Class',
      studentId: '',
      studentName: ''
    }
  }

  const shareExistingMaterial = async () => {
    if (!materialShareTarget) return

    const payload = getMaterialShareRecipientPayload()

    if (payload.recipientIds.length === 0) {
      alert('Please select a student or class with at least one student.')
      return
    }

    setMaterialShareSaving(true)
    setMaterialShareStatus('Sharing...')

    try {
      const currentTargets = getMaterialShareTargets(materialShareTarget)
      const sharedAt = new Date().toISOString()
      const nextTarget = {
        type: materialShareAudience,
        classId: payload.classId || '',
        className: payload.className || '',
        studentId: payload.studentId || '',
        studentName: payload.studentName || '',
        label:
          materialShareAudience === 'class'
            ? payload.className || 'Class'
            : payload.studentName || 'Student',
        recipientIds: payload.recipientIds,
        recipientNames: payload.recipientNames,
        sharedAt
      }

      const targetKey = target => {
        if (target?.type === 'class') {
          return `class:${target.classId || target.className || target.label || ''}`
        }

        if (target?.type === 'student') {
          return `student:${target.studentId || target.studentName || target.label || ''}`
        }

        return `${target?.type || 'legacy'}:${target?.label || ''}`
      }

      const nextKey = targetKey(nextTarget)
      const mergedTargets = []
      let refreshedExistingTarget = false

      currentTargets.forEach(target => {
        if (targetKey(target) === nextKey) {
          mergedTargets.push(nextTarget)
          refreshedExistingTarget = true
        } else {
          mergedTargets.push(target)
        }
      })

      if (!refreshedExistingTarget) {
        mergedTargets.push(nextTarget)
      }

      const allRecipientIds = uniqueCleanValues(
        mergedTargets.flatMap(target =>
          Array.isArray(target?.recipientIds) ? target.recipientIds : []
        )
      )

      const allRecipientNames = uniqueCleanValues(
        mergedTargets.flatMap(target =>
          Array.isArray(target?.recipientNames) ? target.recipientNames : []
        )
      )

      await updateDoc(doc(db, 'materials', materialShareTarget.id), {
        recipientIds: allRecipientIds,
        recipientNames: allRecipientNames,
        shareTargets: mergedTargets,
        updatedAt: sharedAt
      })

      setMaterialShareStatus(
        refreshedExistingTarget
          ? 'Material access refreshed ✓'
          : 'Material shared again ✓'
      )

      setTimeout(() => {
        setMaterialShareTarget(null)
        setMaterialShareStudentId('')
        setMaterialShareClassId('')
        setMaterialShareStatus('')
      }, 700)
    } catch (error) {
      console.error('Could not share existing material:', error)
      setMaterialShareStatus('Could not share material')
    } finally {
      setMaterialShareSaving(false)
    }
  }

  const deleteTeacherMessage = async message => {
    const ok = window.confirm(`Delete message "${message.title}"?`)
    if (!ok) return

    await deleteDoc(doc(db, 'messages', message.id))
  }

  const deleteTeacherMaterial = async material => {
    const ok = window.confirm(`Delete material "${material.title}"?`)
    if (!ok) return

    try {
      await deleteDoc(doc(db, 'materials', material.id))
    } catch (error) {
      console.error('Could not delete material record:', error)
      alert('Could not delete this material. Please try again.')
      return
    }

    if (material.storagePath) {
      try {
        await deleteObject(storageRef(storage, material.storagePath))
      } catch (error) {
        if (error?.code !== 'storage/object-not-found') {
          console.warn('Material record deleted, but file cleanup failed:', error)
        }
      }
    }
  }

  const getCompletedCount = readingId => {
    return currentReadingSubmissions.filter(sub => sub.readingId === readingId).length
  }

  const getWritingSubmittedCount = writingId => {
    return currentWritingSubmissions.filter(sub => sub.writingId === writingId).length
  }

  const getWritingReviewedCount = writingId => {
    return currentWritingSubmissions.filter(
      sub => sub.writingId === writingId && sub.reviewed
    ).length
  }

  const getListeningCompletedCount = listeningId => {
    return currentListeningSubmissions.filter(sub => sub.listeningId === listeningId).length
  }

  const getVocabularyCompletedCount = vocabularyTestId => {
    return currentVocabularySubmissions.filter(sub =>
      isVocabularySubmissionForTest(sub, vocabularyTestId)
    ).length
  }

  const pendingReviewWritings = activeWritings.filter(writing => {
    const submitted = getWritingSubmittedCount(writing.id)
    const reviewed = getWritingReviewedCount(writing.id)

    return submitted > reviewed
  })

  const pendingWritingReviews = currentWritingSubmissions
    .filter(submission => !submission.reviewed)
    .map(submission => {
      const student = getStudentByAnyId(submission.uid)
      const writing = writings.find(item => item.id === submission.writingId)

      if (!student || !writing) return null

      return {
        submission,
        student,
        writing
      }
    })
    .filter(Boolean)
    .sort((a, b) =>
      new Date(b.submission.submittedAt || 0) -
      new Date(a.submission.submittedAt || 0)
    )

  const reviewedWritingReviews = currentWritingSubmissions
    .filter(submission => submission.reviewed)
    .map(submission => {
      const student = getStudentByAnyId(submission.uid)
      const writing = writings.find(item => item.id === submission.writingId)

      if (!student || !writing) return null

      return {
        submission,
        student,
        writing
      }
    })
    .filter(Boolean)
    .sort((a, b) =>
      new Date(b.submission.reviewedAt || b.submission.submittedAt || 0) -
      new Date(a.submission.reviewedAt || a.submission.submittedAt || 0)
    )

  const getMockWritingStatus = submission => {
    if (
      submission?.result?.enabledSections?.writing === false ||
      submission?.enabledSections?.writing === false ||
      submission?.result?.writing?.enabled === false
    ) {
      return 'not_included'
    }

    return (
      submission.result?.writing?.status ||
      submission.writingReview?.status ||
      submission.review?.writingStatus ||
      'pending_review'
    )
  }

  const getMockTask1Answer = submission => {
    return (
      submission.writingAnswers?.task1 ||
      submission.writing?.task1 ||
      submission.task1Answer ||
      ''
    )
  }

  const getMockTask2Answer = submission => {
    return (
      submission.writingAnswers?.task2 ||
      submission.writing?.task2 ||
      submission.task2Answer ||
      ''
    )
  }

  const getMockTask1WordCount = submission => {
    return (
      submission.result?.writing?.task1WordCount ||
      submission.writing?.task1WordCount ||
      submission.task1WordCount ||
      getWordCount(getMockTask1Answer(submission))
    )
  }

  const getMockTask2WordCount = submission => {
    return (
      submission.result?.writing?.task2WordCount ||
      submission.writing?.task2WordCount ||
      submission.task2WordCount ||
      getWordCount(getMockTask2Answer(submission))
    )
  }

  const getMockWritingReview = submission => {
    return submission.result?.writing?.review || submission.writingReview || null
  }

  const pendingMockWritingReviews = currentMockSubmissions
    .filter(submission => {
      if (submission.archived) return false
      if (!getMockTask1Answer(submission) && !getMockTask2Answer(submission)) return false

      return getMockWritingStatus(submission) !== 'reviewed'
    })
    .map(submission => {
      const student = getStudentByAnyId(submission.uid)
      const mock = mockTests.find(item => item.id === submission.mockTestId)

      if (!student) return null

      return {
        submission,
        student,
        mock
      }
    })
    .filter(Boolean)
    .sort((a, b) =>
      new Date(b.submission.submittedAt || 0) -
      new Date(a.submission.submittedAt || 0)
    )

  const reviewedMockWritingReviews = currentMockSubmissions
    .filter(submission => {
      if (submission.archived) return false
      if (!getMockTask1Answer(submission) && !getMockTask2Answer(submission)) return false

      return getMockWritingStatus(submission) === 'reviewed'
    })
    .map(submission => {
      const student = getStudentByAnyId(submission.uid)
      const mock = mockTests.find(item => item.id === submission.mockTestId)

      if (!student) return null

      return {
        submission,
        student,
        mock
      }
    })
    .filter(Boolean)
    .sort((a, b) =>
      new Date(b.submission.reviewedAt || b.submission.submittedAt || 0) -
      new Date(a.submission.reviewedAt || a.submission.submittedAt || 0)
    )

  const reviewedMockWritingCount = currentMockSubmissions.filter(
    submission => getMockWritingStatus(submission) === 'reviewed'
  ).length

  const submittedMockWritingCount = currentMockSubmissions.filter(
    submission => getMockTask1Answer(submission) || getMockTask2Answer(submission)
  ).length

  const totalPendingWritingReviews =
    pendingWritingReviews.length + pendingMockWritingReviews.length

  const reviewedWritingCount =
    currentWritingSubmissions.filter(submission => submission.reviewed).length +
    reviewedMockWritingCount

  const submittedWritingCount =
    currentWritingSubmissions.length + submittedMockWritingCount

  const formatDateShort = value => {
    if (!value) return 'No date'

    try {
      return new Date(value).toLocaleDateString()
    } catch (error) {
      return value
    }
  }


  const getLibraryVisibility = item =>
    item?.visibility || item?.libraryVisibility || 'private'

  const isSchoolLibraryItem = item => getLibraryVisibility(item) === 'school'

  const isOwnedByCurrentTeacher = item =>
    profile?.role === 'admin' || isAssignedToTeacher(item, user?.uid)

  const getLibraryContentType = (item, fallback = 'full') =>
    item?.contentType ||
    item?.mockType ||
    item?.practiceType ||
    fallback

  const getLibraryVisibilityLabel = item =>
    isSchoolLibraryItem(item) ? 'School Library' : 'My Library'

  const getContentTypeLabel = value => {
    const labels = {
      full_reading: 'Full Reading',
      short_reading: 'Short Reading',
      mini_reading: 'Mini Reading',
      passage_practice: 'Passage Practice',
      reading_skill: 'Skill Practice',
      full_listening: 'Full Listening',
      listening_part: 'Part Practice',
      part_1: 'Part 1',
      part_2: 'Part 2',
      part_3: 'Part 3',
      part_4: 'Part 4',
      mini_listening: 'Mini Listening',
      short_listening: 'Short Practice',
      listening_skill: 'Skill Practice',
      full_writing: 'Full Writing',
      task1_only: 'Task 1 Only',
      task2_only: 'Task 2 Only',
      vocabulary_quiz: 'Vocabulary Quiz',
      word_set: 'Word Set',
      mixed_practice: 'Mixed Practice',
      topic_vocabulary: 'Topic Vocabulary',
      academic_vocabulary: 'Academic Vocabulary',
      full_mock: 'Full Mock',
      mini_mock: 'Mini Mock',
      reading_mock: 'Reading Mock',
      listening_mock: 'Listening Mock',
      writing_mock: 'Writing Mock'
    }

    return labels[value] || 'Practice'
  }

  const filterByVisibility = (items, visibilityFilter) => {
    if (visibilityFilter === 'school') return items.filter(isSchoolLibraryItem)
    if (visibilityFilter === 'private') return items.filter(item => !isSchoolLibraryItem(item))
    return items
  }

  const filterByContentType = (items, contentTypeFilter, fallback) => {
    if (contentTypeFilter === 'all') return items

    return items.filter(item =>
      getLibraryContentType(item, fallback) === contentTypeFilter
    )
  }

  const applyLibraryFilters = (items, visibilityFilter, contentTypeFilter, fallback) =>
    filterByContentType(
      filterByVisibility(items, visibilityFilter),
      contentTypeFilter,
      fallback
    )

  const librarySelectClass = 'border border-gray-200 rounded-xl px-3 py-2 text-xs bg-white text-gray-600 outline-none focus:border-purple-400'

  const filteredReadings = applyLibraryFilters(
    readingLibraryFilter === 'all'
      ? readings
      : readingLibraryFilter === 'archived'
        ? archivedReadings
        : activeReadings,
    readingVisibilityFilter,
    readingContentTypeFilter,
    'full_reading'
  )

  const filteredWritings = applyLibraryFilters(
    writingLibraryFilter === 'all'
      ? writings
      : writingLibraryFilter === 'archived'
        ? archivedWritings
        : writingLibraryFilter === 'pending'
          ? pendingReviewWritings
          : activeWritings,
    writingVisibilityFilter,
    writingContentTypeFilter,
    'full_writing'
  )

  const filteredListenings = applyLibraryFilters(
    listeningLibraryFilter === 'all'
      ? listenings
      : listeningLibraryFilter === 'archived'
        ? archivedListenings
        : activeListenings,
    listeningVisibilityFilter,
    listeningContentTypeFilter,
    'full_listening'
  )

  const filteredVocabularyTests = applyLibraryFilters(
    vocabularyLibraryFilter === 'all'
      ? vocabularyTests
      : vocabularyLibraryFilter === 'archived'
        ? archivedVocabularyTests
        : activeVocabularyTests,
    vocabularyVisibilityFilter,
    vocabularyContentTypeFilter,
    'vocabulary_quiz'
  )

  const filteredActiveMockTests = filterByContentType(
    filterByVisibility(activeMockTests, mockVisibilityFilter),
    mockContentTypeFilter,
    'full_mock'
  )
  const filteredArchivedMockTests = filterByContentType(
    filterByVisibility(archivedMockTests, mockVisibilityFilter),
    mockContentTypeFilter,
    'full_mock'
  )

  const openAssignmentManager = async (homework, type) => {
    if (!isOwnedByCurrentTeacher(homework)) {
      alert(
        'This is a School Library item. Duplicate it into My Library before assigning it to students.'
      )
      return
    }

    try {
      const assignmentResult = await getContentStudentAccessCall({
        contentType: type,
        contentId: homework.id
      })

      const canonicalStudentIds = Array.isArray(assignmentResult.data?.studentIds)
        ? assignmentResult.data.studentIds.filter(Boolean)
        : []

      const draftStudentIds = canonicalStudentIds
        .map(studentUid => getStudentByAnyId(studentUid)?.id)
        .filter(Boolean)

      setSelectedHomework(homework)
      setSelectedHomeworkType(type)
      setAssignmentDraft(Array.from(new Set(draftStudentIds)))
    } catch (error) {
      console.error('Could not load canonical homework assignments:', error)
      alert('Could not load student assignments. Please try again.')
    }
  }

  const toggleAssignment = studentId => {
    setAssignmentDraft(prev =>
      prev.includes(studentId)
        ? prev.filter(id => id !== studentId)
        : [...prev, studentId]
    )
  }

  const assignClassToHomework = classItem => {
    const classStudentIds = classItem.studentIds || []

    if (classStudentIds.length === 0) {
      alert('This class has no students yet.')
      return
    }

    setAssignmentDraft(prev =>
      Array.from(new Set([...prev, ...classStudentIds]))
    )
  }

  const removeClassFromHomework = classItem => {
    const classStudentIds = classItem.studentIds || []

    setAssignmentDraft(prev =>
      prev.filter(studentId => !classStudentIds.includes(studentId))
    )
  }

  const isClassFullyAssignedToDraft = classItem => {
    const classStudentIds = classItem.studentIds || []
    if (classStudentIds.length === 0) return false
    return classStudentIds.every(studentId => assignmentDraft.includes(studentId))
  }

  const isClassPartlyAssignedToDraft = classItem => {
    const classStudentIds = classItem.studentIds || []
    if (classStudentIds.length === 0) return false
    return classStudentIds.some(studentId => assignmentDraft.includes(studentId))
  }

  const getStudentName = studentId => {
    const student = getStudentByAnyId(studentId)
    return student?.name || student?.email || 'Unknown student'
  }

  const saveAssignments = async () => {
    if (!selectedHomework || !selectedHomeworkType) return

    const allowedStudentIds = new Set(students.map(student => student.id))
    const allowedDraftIds = profile?.role === 'admin'
      ? assignmentDraft
      : assignmentDraft.filter(studentId => allowedStudentIds.has(studentId))

    const selectedStudents = allowedDraftIds
      .map(studentId => students.find(student => student.id === studentId))
      .filter(Boolean)

    const finalAssignment = uniqueCleanValues(
      selectedStudents.map(student => getStudentPrimaryAssignmentId(student))
    )

    try {
      await setContentStudentAccessCall({
        contentType: selectedHomeworkType,
        contentId: selectedHomework.id,
        studentIds: finalAssignment
      })
      await refreshCanonicalAssignmentSnapshot()

      setSelectedHomework(null)
      setSelectedHomeworkType(null)
      setAssignmentDraft([])
    } catch (error) {
      console.error('Could not save canonical homework assignments:', error)
      alert('Could not save student assignments. Please check permissions and try again.')
    }
  }

  const getCallableErrorMessage = (error, fallback) => {
    const raw = error?.message || ''
    const clean = raw
      .replace(/^FirebaseError:\s*/i, '')
      .replace(/^functions\/[a-z-]+:\s*/i, '')
      .trim()

    return clean || fallback
  }

  const getAttemptContentLabel = contentType => {
    if (contentType === 'reading') return 'Reading'
    if (contentType === 'listening') return 'Listening'
    if (contentType === 'vocabulary') return 'Vocabulary'
    if (contentType === 'writing') return 'Writing'
    if (contentType === 'mock') return 'Mock Test'
    return 'Homework'
  }

  const getAttemptReopenDescription = contentType => {
    if (contentType === 'writing') {
      return "Start the new attempt with the student's previous Task 1 / Task 2 answers."
    }

    if (contentType === 'reading') {
      return "Start the new attempt with the student's previous answers, flags, scratch note and highlights restored."
    }

    if (contentType === 'listening') {
      return "Start the new attempt with the student's previous answers, flags and scratch note restored."
    }

    if (contentType === 'vocabulary') {
      return "Start the new attempt with the student's previous vocabulary answers restored."
    }

    if (contentType === 'mock') {
      return "Start the new mock attempt with the student's previous Listening, Reading and Writing answers restored. Timers and test flow restart."
    }

    return "Start the new attempt with the student's previous answers restored."
  }

  const loadManagedAttemptState = async ({ contentType, contentId, student }) => {
    const studentId = getStudentPrimaryAssignmentId(student)

    if (!contentType || !contentId || !studentId) {
      throw new Error('The selected student or homework is missing an ID.')
    }

    const result = await getManagedSubmissionAttemptStateCall({
      contentType,
      contentId,
      studentId
    })

    return result.data || null
  }


  const loadManagedAttemptHistory = async ({ contentType, contentId, student }) => {
    const studentId = getStudentPrimaryAssignmentId(student)

    if (!contentType || !contentId || !studentId) {
      throw new Error('The selected student or homework is missing an ID.')
    }

    const result = await getManagedSubmissionAttemptHistoryCall({
      contentType,
      contentId,
      studentId
    })

    return Array.isArray(result.data?.attempts) ? result.data.attempts : []
  }

  const getAttemptHistoryResultLabel = (contentType, attempt) => {
    const result = attempt?.result || {}

    if (contentType === 'writing') {
      return attempt?.reviewed
        ? `Reviewed · Band ${attempt.reviewOverall ?? '-'}`
        : 'Submitted · Waiting for review'
    }

    if (contentType === 'vocabulary') {
      const correct = result.correct ?? '-'
      const total = result.total ?? '-'
      const percentage = result.percentage ?? null
      return `${correct}/${total} correct${percentage === null ? '' : ` · ${percentage}%`}`
    }

    if (contentType === 'mock') {
      const overall = result.reviewedOverall ?? result.finalOverall ?? result.overall ?? result.overallEstimate
      return `Overall ${overall ?? '-'} · L ${result.listening?.band ?? '-'} · R ${result.reading?.band ?? '-'}`
    }

    const band = result.band ?? result.estimatedBand ?? '-'
    const correct = result.correct ?? '-'
    const total = result.total ?? '-'
    return `Band ${band} · ${correct}/${total} correct`
  }

  const formatAttemptHistoryDate = value => {
    if (!value) return 'No submission date'
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? 'No submission date' : date.toLocaleString()
  }

  const openSubmissionAttemptManager = async ({
    contentType,
    contentId,
    title,
    student
  }) => {
    if (!contentType || !contentId || !student) return

    const base = {
      contentType,
      contentId,
      title: title || 'Homework',
      student,
      state: null
    }

    setAttemptManager(base)
    setAttemptManagerError('')
    setAttemptManagerNotice('')
    setAttemptManagerWarning('')
    setStatsDialogMode(null)
    setStatsDialogError('')
    deletePreviewRequestRef.current += 1
    setDeleteDialogOpen(false)
    setDeleteDialogLoading(false)
    setDeleteDialogPreview(null)
    setDeleteDialogError('')
    setAttemptHistory([])
    setAttemptHistoryError('')
    setAttemptManagerLoading(true)
    setAttemptHistoryLoading(true)

    try {
      const [state, history] = await Promise.all([
        loadManagedAttemptState(base),
        loadManagedAttemptHistory(base).catch(error => {
          console.error('Could not load submission attempt history:', error)
          setAttemptHistoryError(
            getCallableErrorMessage(error, 'Could not load attempt history.')
          )
          return []
        })
      ])

      setAttemptManager(current =>
        current &&
        current.contentType === contentType &&
        current.contentId === contentId &&
        current.student?.id === student.id
          ? { ...current, state }
          : current
      )
      setAttemptHistory(history)
    } catch (error) {
      console.error('Could not load submission attempt state:', error)
      setAttemptManagerError(
        getCallableErrorMessage(error, 'Could not load attempt status. Please try again.')
      )
    } finally {
      setAttemptManagerLoading(false)
      setAttemptHistoryLoading(false)
    }
  }

  const closeSubmissionAttemptManager = () => {
    if (attemptManagerSaving || deleteDialogOpen) return

    setAttemptManager(null)
    setAttemptManagerError('')
    setAttemptManagerNotice('')
    setAttemptManagerWarning('')
    setStatsDialogMode(null)
    setStatsDialogError('')
    setAttemptManagerLoading(false)
    setAttemptHistory([])
    setAttemptHistoryError('')
    setAttemptHistoryLoading(false)
  }

  // A focused V2 dialog replaces browser prompts; cancel never writes to Firebase.
  const openStatsDialog = excluded => {
    if (!attemptManager?.state?.hasSubmission || attemptManagerSaving) return
    setStatsDialogMode(excluded ? 'exclude' : 'restore')
    setStatsDialogError('')
    setAttemptManagerError('')
    setAttemptManagerNotice('')
    setAttemptManagerWarning('')
  }

  const closeStatsDialog = () => {
    if (attemptManagerSaving) return
    setStatsDialogMode(null)
    setStatsDialogError('')
  }

  const setManagedStatsExclusion = async (excluded, reasonInput = '') => {
    if (!attemptManager?.student || !attemptManager.contentId || !attemptManager.contentType) return
    if (!attemptManager.state?.hasSubmission || attemptManagerSaving) return

    const reason = excluded ? reasonInput.trim() : 'Restored to statistics'
    if (excluded && (reason.length < 5 || reason.length > 400)) {
      setStatsDialogError('Please provide a reason between 5 and 400 characters.')
      return
    }

    const target = {
      contentType: attemptManager.contentType,
      contentId: attemptManager.contentId,
      studentId: getStudentPrimaryAssignmentId(attemptManager.student),
      excluded,
      reason
    }
    const sameTarget = current =>
      current?.contentType === target.contentType &&
      current?.contentId === target.contentId &&
      getStudentPrimaryAssignmentId(current?.student) === target.studentId

    setAttemptManagerSaving(true)
    setAttemptManagerError('')
    setAttemptManagerNotice('')
    setAttemptManagerWarning('')
    setStatsDialogError('')
    try {
      // A successful callable is the write result. Refresh errors must not be
      // presented as failed writes, since repeating a successful write is unsafe.
      await setManagedSubmissionStatsExclusionCall(target)

      setStatsDialogMode(null)
      setAttemptManager(current => sameTarget(current)
        ? { ...current, state: { ...current.state, excludedFromStats: excluded } }
        : current
      )
      setAttemptHistory(current => current.map(attempt =>
        attempt.isCurrent ? { ...attempt, excludedFromStats: excluded } : attempt
      ))
      setAttemptManagerNotice(excluded
        ? 'Result saved and excluded from performance statistics.'
        : 'Result restored to performance statistics.'
      )

      const [stateResult, historyResult] = await Promise.allSettled([
        loadManagedAttemptState(attemptManager),
        loadManagedAttemptHistory(attemptManager)
      ])
      if (stateResult.status === 'fulfilled') {
        setAttemptManager(current => sameTarget(current)
          ? { ...current, state: stateResult.value }
          : current
        )
      }
      if (historyResult.status === 'fulfilled') {
        setAttemptHistory(historyResult.value)
        setAttemptHistoryError('')
      }
      if (stateResult.status === 'rejected' || historyResult.status === 'rejected') {
        console.warn('Q1A result was saved but attempt details could not be refreshed:', {
          state: stateResult.status,
          history: historyResult.status
        })
        setAttemptManagerWarning(
          'Your change was saved, but the latest details could not be refreshed. Close and reopen this panel to reload them.'
        )
      }
    } catch (error) {
      console.error('Could not update result statistics status:', error)
      setStatsDialogError(getCallableErrorMessage(error, 'Could not update result statistics status.'))
    } finally {
      setAttemptManagerSaving(false)
    }
  }

  const closeDeleteDialog = () => {
    if (attemptManagerSaving) return
    deletePreviewRequestRef.current += 1
    setDeleteDialogOpen(false)
    setDeleteDialogLoading(false)
    setDeleteDialogPreview(null)
    setDeleteDialogError('')
  }

  const openDeleteDialog = async () => {
    if (!attemptManager?.student || !attemptManager?.contentId || attemptManagerSaving) return
    const requestId = ++deletePreviewRequestRef.current
    const target = {
      contentType: attemptManager.contentType,
      contentId: attemptManager.contentId,
      studentId: getStudentPrimaryAssignmentId(attemptManager.student)
    }
    setStatsDialogMode(null)
    setDeleteDialogOpen(true)
    setDeleteDialogLoading(true)
    setDeleteDialogPreview(null)
    setDeleteDialogError('')
    try {
      const response = await previewManagedSubmissionPermanentDeleteCall(target)
      if (deletePreviewRequestRef.current === requestId) {
        setDeleteDialogPreview(response.data)
      }
    } catch (error) {
      if (deletePreviewRequestRef.current === requestId) {
        setDeleteDialogError(getCallableErrorMessage(error, 'Could not check linked results.'))
      }
    } finally {
      if (deletePreviewRequestRef.current === requestId) setDeleteDialogLoading(false)
    }
  }

  const confirmDeleteResult = async () => {
    if (!deleteDialogPreview?.previewToken || !attemptManager?.student || attemptManagerSaving) return
    const target = {
      contentType: attemptManager.contentType,
      contentId: attemptManager.contentId,
      studentId: getStudentPrimaryAssignmentId(attemptManager.student)
    }
    const sameTarget = current => current?.contentType === target.contentType &&
      current?.contentId === target.contentId &&
      getStudentPrimaryAssignmentId(current?.student) === target.studentId

    setAttemptManagerSaving(true)
    setDeleteDialogError('')
    setAttemptManagerWarning('')
    try {
      const response = await permanentlyDeleteManagedSubmissionResultCall({
        ...target,
        previewToken: deleteDialogPreview.previewToken,
        confirmPermanentDelete: true,
        confirmationPhrase: 'DELETE RESULTS'
      })
      // The callable finished the permanent write. A subsequent refresh failure
      // is only a refresh warning, never a deletion failure.
      closeDeleteDialogAfterSuccess()
      setAttemptManager(current => sameTarget(current)
        ? { ...current, state: { ...current.state, hasSubmission: false, excludedFromStats: false, open: false } }
        : current
      )
      setAttemptHistory([])
      setAttemptHistoryError('')
      setAttemptManagerError('')
      setAttemptManagerNotice(`Permanently deleted ${response.data?.deletedDocuments || 0} linked result record(s). The student and homework assignment remain.`)
      const results = await Promise.allSettled([
        loadManagedAttemptState(attemptManager),
        loadManagedAttemptHistory(attemptManager)
      ])
      if (results[0].status === 'fulfilled') {
        setAttemptManager(current => sameTarget(current)
          ? { ...current, state: results[0].value }
          : current
        )
      }
      if (results[1].status === 'fulfilled') setAttemptHistory(results[1].value)
      if (results.some(result => result.status === 'rejected')) {
        setAttemptManagerWarning('Deletion succeeded, but the latest view could not be refreshed. Reopen this panel to reload it.')
      }
    } catch (error) {
      console.error('Could not permanently delete selected result:', error)
      setDeleteDialogError(getCallableErrorMessage(error, 'Could not confirm deletion. If the connection was interrupted, close this dialog and refresh the result before retrying.'))
    } finally {
      setAttemptManagerSaving(false)
    }
  }

  const closeDeleteDialogAfterSuccess = () => {
    deletePreviewRequestRef.current += 1
    setDeleteDialogOpen(false)
    setDeleteDialogLoading(false)
    setDeleteDialogPreview(null)
    setDeleteDialogError('')
  }

  const setManagedAttemptMode = async mode => {
    if (!attemptManager?.student || !attemptManager.contentId || !attemptManager.contentType) {
      return
    }

    if (!attemptManager.state?.hasSubmission) {
      setAttemptManagerError('This student has no submitted attempt to reopen.')
      return
    }

    const studentName =
      attemptManager.student.name || attemptManager.student.email || 'this student'
    const nextAttempt =
      Number(attemptManager.state?.nextAttemptNumber) ||
      (Number(attemptManager.state?.currentAttemptNumber) || 1) + 1
    const modeLabel = mode === 'reopen_answers' ? 'Reopen Answers' : 'Start Fresh'
    const detail = mode === 'reopen_answers'
      ? "The new attempt will begin with the student's previous answers restored."
      : 'The new attempt will begin blank. The previous submitted attempt will remain saved in history.'

    const confirmed = window.confirm(
      `${modeLabel} for ${studentName}?\n\nThis will open Attempt ${nextAttempt}. ${detail}\n\nThe previous submitted attempt, score/review and original submission data will not be deleted.`
    )

    if (!confirmed) return

    setAttemptManagerSaving(true)
    setAttemptManagerError('')
    setAttemptManagerNotice('')

    try {
      const studentId = getStudentPrimaryAssignmentId(attemptManager.student)

      await setSubmissionAttemptControlCall({
        contentType: attemptManager.contentType,
        contentId: attemptManager.contentId,
        studentId,
        mode
      })

      const [state, history] = await Promise.all([
        loadManagedAttemptState(attemptManager),
        loadManagedAttemptHistory(attemptManager).catch(error => {
          console.error('Could not refresh submission attempt history:', error)
          setAttemptHistoryError(
            getCallableErrorMessage(error, 'Could not refresh attempt history.')
          )
          return attemptHistory
        })
      ])

      setAttemptManager(current =>
        current
          ? { ...current, state }
          : current
      )
      setAttemptHistory(history)
      setAttemptManagerNotice(
        mode === 'reopen_answers'
          ? `Attempt ${state?.nextAttemptNumber || nextAttempt} is open with previous answers restored.`
          : `Attempt ${state?.nextAttemptNumber || nextAttempt} is open as a fresh attempt.`
      )
    } catch (error) {
      console.error('Could not reopen submission attempt:', error)
      setAttemptManagerError(
        getCallableErrorMessage(error, 'Could not reopen this attempt. Please try again.')
      )
    } finally {
      setAttemptManagerSaving(false)
    }
  }

  const removeHomeworkFromStudent = async (homework, type, student) => {
    if (!homework || !student || !type) return

    const typeLabel =
      type === 'reading'
        ? 'reading homework'
        : type === 'listening'
          ? 'listening homework'
          : type === 'vocabulary'
            ? 'vocabulary test'
            : type === 'mock'
              ? 'mock test'
              : 'writing homework'

    const confirmed = window.confirm(
      `Remove "${homework.title || 'this homework'}" from ${student.name || student.email}?\n\nThis will only remove the ${typeLabel} from this student. Existing submissions, answers and results will stay saved.`
    )

    if (!confirmed) return

    const assignmentKey = assignmentAccessKey(type, homework.id)
    const targetUid = normalizeAssignmentId(getStudentPrimaryAssignmentId(student))

    if (!targetUid) {
      alert('Could not identify this student. Please refresh and try again.')
      return
    }

    // Optimistic UI: remove the assignment locally immediately. The server
    // mutation stays authoritative and the final canonical snapshot reconciles
    // the UI after all queued removals for this homework have finished.
    setAssignmentStudentIdsByContent(previous => {
      const currentStudentIds = Array.isArray(previous[assignmentKey])
        ? previous[assignmentKey]
        : []

      return {
        ...previous,
        [assignmentKey]: currentStudentIds.filter(
          uid => normalizeAssignmentId(uid) !== targetUid
        )
      }
    })

    try {
      await queueAssignmentRemoval(assignmentKey, async () => {
        const assignmentResult = await getContentStudentAccessCall({
          contentType: type,
          contentId: homework.id
        })

        const currentStudentIds = Array.isArray(assignmentResult.data?.studentIds)
          ? assignmentResult.data.studentIds.filter(Boolean)
          : []

        const remainingStudentIds = currentStudentIds.filter(
          uid => normalizeAssignmentId(uid) !== targetUid
        )

        if (remainingStudentIds.length === currentStudentIds.length) return

        await setContentStudentAccessCall({
          contentType: type,
          contentId: homework.id,
          studentIds: remainingStudentIds
        })
      })
    } catch (error) {
      console.error('Could not remove homework from student:', error)
      alert(
        'Could not remove homework from this student. The assignment list will refresh to the saved server state.'
      )
    }
  }

  const archiveReadingHomework = async reading => {
    const ok = window.confirm(
      `"${reading.title}" will be archived and removed from students' homework list. Existing results will stay saved.`
    )

    if (!ok) return

    try {
      await setContentArchivedStateCall({
        contentType: 'reading',
        contentId: reading.id,
        archived: true
      })
    } catch (error) {
      console.error('Could not archive reading homework:', error)
      alert('Could not archive this reading homework. Please check permissions and try again.')
    }
  }

  const restoreReadingHomework = async reading => {
    try {
      await setContentArchivedStateCall({
        contentType: 'reading',
        contentId: reading.id,
        archived: false
      })
    } catch (error) {
      console.error('Could not restore reading homework:', error)
      alert('Could not restore this reading homework. Please check permissions and try again.')
    }
  }


  // Q1B-B: preview first, then server-authorized atomic content/results deletion.
  const openLegacyContentPurge = async (contentType, item) => {
    const target = { contentType, contentId: item.id }
    const key = `${contentType}:${item.id}`
    setLegacyCascadeDialog({ key, mode: 'content', target,
      label: item.title || item.id,
      description: 'This deletes the archived test itself, all learner answers, old attempts, scores, drafts and assignments linked to this test. The learner accounts and unrelated tests are preserved. It must not be linked to another Mock Test.',
      loading: true, saving: false, preview: null, error: '' })
    try {
      const res = await previewLegacyContentPurgeCall(target)
      setLegacyCascadeDialog(current => current?.key === key
        ? { ...current, loading: false, preview: res.data || null } : current)
    } catch (error) {
      console.error('Legacy content deletion preview failed:', error)
      setLegacyCascadeDialog(current => current?.key === key
        ? { ...current, loading: false, error: error?.message || 'Could not preview this deletion.' } : current)
    }
  }

  const confirmLegacyContentPurge = async phrase => {
    const current = legacyCascadeDialog
    if (!current || current.saving || current.loading ||
        current.preview?.ready !== true || !current.preview?.previewToken ||
        phrase !== 'DELETE CONTENT') return
    setLegacyCascadeDialog(previous => previous ? { ...previous, saving: true, error: '' } : previous)
    try {
      const result = await purgeLegacyContentCall({ ...current.target,
        confirmPermanentDelete: true, confirmationPhrase: phrase,
        previewToken: current.preview.previewToken })
      setLegacyCascadeDialog(null)
      alert(`Content and ${Number(result.data?.deletedDocuments) || 0} linked Firestore documents permanently deleted.`)
    } catch (error) {
      console.error('Legacy content deletion failed:', error)
      setLegacyCascadeDialog(previous => previous
        ? { ...previous, saving: false, error: error?.message || 'Deletion failed. Nothing was confirmed as removed. Preview again before retrying.' }
        : previous)
    }
  }

  const deleteReadingHomework = reading => openLegacyContentPurge('reading', reading)

  const duplicateReadingHomework = async reading => {
    const ok = window.confirm(
      `Duplicate "${reading.title}"? The copy will not be assigned to any student.`
    )

    if (!ok) return

    const {
      id,
      createdAt,
      updatedAt,
      createdBy,
      archived,
      ...copyData
    } = reading

    await addDoc(collection(db, 'readings'), {
      ...copyData,
      title: `${reading.title} Copy`,
      visibility: 'private',
      archived: false,
      createdBy: user.uid,
      teacherId: profile?.role === 'teacher' ? user.uid : reading.teacherId || '',
      teacherIds: profile?.role === 'teacher' ? [user.uid] : reading.teacherIds || (reading.teacherId ? [reading.teacherId] : []),
      schoolId: profile?.schoolId || getSchoolId(reading),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
  }

  const archiveWritingHomework = async writing => {
    const ok = window.confirm(
      `"${writing.title}" will be archived and removed from students' writing homework list. Existing submissions will stay saved.`
    )

    if (!ok) return

    try {
      await setContentArchivedStateCall({
        contentType: 'writing',
        contentId: writing.id,
        archived: true
      })
    } catch (error) {
      console.error('Could not archive writing homework:', error)
      alert('Could not archive this writing homework. Please check permissions and try again.')
    }
  }

  const restoreWritingHomework = async writing => {
    try {
      await setContentArchivedStateCall({
        contentType: 'writing',
        contentId: writing.id,
        archived: false
      })
    } catch (error) {
      console.error('Could not restore writing homework:', error)
      alert('Could not restore this writing homework. Please check permissions and try again.')
    }
  }

  const deleteWritingHomework = writing => openLegacyContentPurge('writing', writing)

  const duplicateWritingHomework = async writing => {
    const ok = window.confirm(
      `Duplicate "${writing.title}"? The copy will not be assigned to any student.`
    )

    if (!ok) return

    const {
      id,
      createdAt,
      updatedAt,
      createdBy,
      archived,
      ...copyData
    } = writing

    await addDoc(collection(db, 'writingHomeworks'), {
      ...copyData,
      title: `${writing.title} Copy`,
      visibility: 'private',
      archived: false,
      createdBy: user.uid,
      teacherId: profile?.role === 'teacher' ? user.uid : writing.teacherId || '',
      teacherIds: profile?.role === 'teacher' ? [user.uid] : writing.teacherIds || (writing.teacherId ? [writing.teacherId] : []),
      schoolId: profile?.schoolId || getSchoolId(writing),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
  }

  const archiveListeningHomework = async listening => {
    const ok = window.confirm(
      `"${listening.title}" will be archived and removed from students' listening homework list. Existing results will stay saved.`
    )

    if (!ok) return

    try {
      await setContentArchivedStateCall({
        contentType: 'listening',
        contentId: listening.id,
        archived: true
      })
    } catch (error) {
      console.error('Could not archive listening homework:', error)
      alert('Could not archive this listening homework. Please check permissions and try again.')
    }
  }

  const restoreListeningHomework = async listening => {
    try {
      await setContentArchivedStateCall({
        contentType: 'listening',
        contentId: listening.id,
        archived: false
      })
    } catch (error) {
      console.error('Could not restore listening homework:', error)
      alert('Could not restore this listening homework. Please check permissions and try again.')
    }
  }

  const deleteListeningHomework = listening => openLegacyContentPurge('listening', listening)

  const duplicateListeningHomework = async listening => {
    const ok = window.confirm(
      `Duplicate "${listening.title}"? The copy will not be assigned to any student.`
    )

    if (!ok) return

    const {
      id,
      createdAt,
      updatedAt,
      createdBy,
      archived,
      ...copyData
    } = listening

    await addDoc(collection(db, 'listenings'), {
      ...copyData,
      title: `${listening.title} Copy`,
      visibility: 'private',
      archived: false,
      createdBy: user.uid,
      teacherId: profile?.role === 'teacher' ? user.uid : listening.teacherId || '',
      teacherIds: profile?.role === 'teacher' ? [user.uid] : listening.teacherIds || (listening.teacherId ? [listening.teacherId] : []),
      schoolId: profile?.schoolId || getSchoolId(listening),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
  }

  const archiveVocabularyTest = async vocabularyTest => {
    const ok = window.confirm(
      `"${vocabularyTest.title}" will be archived and removed from students' vocabulary homework list. Existing results will stay saved.`
    )

    if (!ok) return

    try {
      await setContentArchivedStateCall({
        contentType: 'vocabulary',
        contentId: vocabularyTest.id,
        archived: true
      })
    } catch (error) {
      console.error('Could not archive vocabulary test:', error)
      alert('Could not archive this vocabulary test. Please check permissions and try again.')
    }
  }

  const restoreVocabularyTest = async vocabularyTest => {
    try {
      await setContentArchivedStateCall({
        contentType: 'vocabulary',
        contentId: vocabularyTest.id,
        archived: false
      })
    } catch (error) {
      console.error('Could not restore vocabulary test:', error)
      alert('Could not restore this vocabulary test. Please check permissions and try again.')
    }
  }

  const deleteVocabularyTest = vocabularyTest => openLegacyContentPurge('vocabulary', vocabularyTest)

  const duplicateVocabularyTest = async vocabularyTest => {
    const ok = window.confirm(
      `Duplicate "${vocabularyTest.title}"? The copy will not be assigned to any student.`
    )

    if (!ok) return

    const {
      id,
      createdAt,
      updatedAt,
      createdBy,
      archived,
      ...copyData
    } = vocabularyTest

    await addDoc(collection(db, 'vocabularyTests'), {
      ...copyData,
      title: `${vocabularyTest.title} Copy`,
      visibility: 'private',
      archived: false,
      createdBy: user.uid,
      teacherId: profile?.role === 'teacher' ? user.uid : vocabularyTest.teacherId || '',
      teacherIds: profile?.role === 'teacher' ? [user.uid] : vocabularyTest.teacherIds || (vocabularyTest.teacherId ? [vocabularyTest.teacherId] : []),
      schoolId: profile?.schoolId || getSchoolId(vocabularyTest),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
  }

  const archiveMockTest = async mockTest => {
    const ok = window.confirm(
      `"${mockTest.title}" will be archived and removed from students' mock test list. Existing submissions will stay saved.`
    )

    if (!ok) return

    try {
      await setContentArchivedStateCall({
        contentType: 'mock',
        contentId: mockTest.id,
        archived: true
      })
    } catch (error) {
      console.error('Could not archive mock test:', error)
      alert('Could not archive this mock test. Please check permissions and try again.')
    }
  }

  const restoreMockTest = async mockTest => {
    try {
      await setContentArchivedStateCall({
        contentType: 'mock',
        contentId: mockTest.id,
        archived: false
      })
    } catch (error) {
      console.error('Could not restore mock test:', error)
      alert('Could not restore this mock test. Please check permissions and try again.')
    }
  }

  const deleteMockTest = mockTest => openLegacyContentPurge('mock', mockTest)

  const numberWords = {
    zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11',
    twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16',
    seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20'
  }

  const normalize = value => {
    if (value === undefined || value === null) return ''

    const clean = value
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[.,!?;:()]/g, '')
      .replace(/\s+/g, ' ')

    return numberWords[clean] || clean
  }

  const getWordCount = value => {
    const clean = normalize(value)
    if (!clean) return 0
    return clean.split(' ').filter(Boolean).length
  }

  const parseAcceptedAnswers = cell => {
    const main = cell.answer ? [cell.answer] : []
    const alternatives = cell.acceptedAnswers
      ? cell.acceptedAnswers.split(',').map(item => item.trim()).filter(Boolean)
      : []

    return [...main, ...alternatives]
  }

  const isWithinWordLimit = (value, maxWords) => {
    if (!maxWords) return true
    return getWordCount(value) <= Number(maxWords)
  }

  const sortAnswers = value => {
    if (!Array.isArray(value)) return []
    return [...value].map(v => v?.toString().trim()).sort()
  }

  const tableAnswerKey = (questionId, rowId, cellIndex) => {
    return `${questionId}_${rowId}_${cellIndex}`
  }

  const noteAnswerKey = (questionId, paragraphId, partId) => {
    return `${questionId}_${paragraphId}_${partId}`
  }

  const listeningCompletionAnswerKey = (questionId, sectionId, itemId) => {
    return `${questionId}_${sectionId}_${itemId}`
  }

  const matchingAnswerKey = (questionId, itemId) => {
    return `${questionId}_${itemId}`
  }

  const mapAnswerKey = (questionId, itemId) => {
    return `${questionId}_${itemId}`
  }

  const getHeadingText = (reading, number) => {
    if (!number) return 'No answer'
    const index = Number(number) - 1
    return reading.headings?.[index] || `Heading ${number}`
  }

  const getOptionText = (question, letter) => {
    if (!letter) return ''
    const index = letters.indexOf(letter)
    return question.options?.[index] || ''
  }

  const getAnswerText = (question, value) => {
    if (question.type === 'mcq') {
      if (Array.isArray(value)) {
        if (value.length === 0) return 'No answer'
        return value
          .map(letter => `${letter}. ${getOptionText(question, letter)}`)
          .join(', ')
      }

      if (!value) return 'No answer'
      return `${value}. ${getOptionText(question, value)}`
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return 'No answer'
      return value.join(', ')
    }

    return formatReviewAnswerValue(value)
  }

  const isNormalCorrect = (submission, question) => {
    if (question.type === 'mcq' && question.mode === 'multi') {
      const userAnswer = sortAnswers(submission.answers?.[question.id]).join('|')
      const correctAnswer = sortAnswers(question.answers || []).join('|')

      return userAnswer === correctAnswer
    }

    const userAnswer = normalize(submission.answers?.[question.id])
    const correctAnswer = normalize(question.answer)

    return userAnswer === correctAnswer
  }

  const isMatchingCorrect = (submission, question, paragraph) => {
    const userAnswer = submission.answers?.[question.id]?.[paragraph.letter]
      ?.toString()
      .trim()

    const correctAnswer = paragraph.answer?.toString().trim()

    return userAnswer === correctAnswer
  }

  const isSentenceEndingCorrect = (submission, question, item) => {
    const userAnswer = submission.answers?.[question.id]?.[item.id]
      ?.toString()
      .trim()

    const correctAnswer = item.answer?.toString().trim()

    return userAnswer === correctAnswer
  }

  const isMatchingInformationCorrect = (submission, question, item) => {
    const userAnswer = submission.answers?.[question.id]?.[item.id]
      ?.toString()
      .trim()

    const correctAnswer = item.answer?.toString().trim()

    return userAnswer === correctAnswer
  }

  const isSummaryOptionCorrect = (submission, question, item) => {
    const userAnswer = submission.answers?.[question.id]?.[item.id]
      ?.toString()
      .trim()

    const correctAnswer = item.answer?.toString().trim()

    return userAnswer === correctAnswer
  }

  const getSentenceEndingText = (question, letter) => {
    if (!letter) return 'No answer'

    const index = letters.indexOf(letter)

    return question.endings?.[index] || `Ending ${letter}`
  }


  const getSummaryOptionText = (question, letter) => {
    if (!letter) return 'No answer'

    const index = letters.indexOf(letter)

    return question.options?.[index] || `Option ${letter}`
  }

  const formatReviewAnswerValue = value => {
    if (value === undefined || value === null || value === '') return 'No answer'

    if (Array.isArray(value)) {
      return value.length ? value.filter(Boolean).join(', ') : 'No answer'
    }

    if (typeof value === 'object') {
      const values = Object.values(value)
        .filter(item => item !== undefined && item !== null && item !== '')
        .map(item => {
          if (Array.isArray(item)) return item.filter(Boolean).join(', ')
          if (typeof item === 'object') return JSON.stringify(item)
          return item.toString()
        })
        .filter(Boolean)

      return values.length ? values.join(', ') : 'No answer'
    }

    return value.toString()
  }

  const isTableCellCorrect = (submission, question, row, cellIndex) => {
    const key = tableAnswerKey(question.id, row.id, cellIndex)
    const cell = row.cells[cellIndex]
    const userAnswer = normalize(submission.answers?.[key])
    const acceptedAnswers = parseAcceptedAnswers(cell).map(normalize)

    if (!isWithinWordLimit(submission.answers?.[key], cell.maxWords)) return false

    return acceptedAnswers.includes(userAnswer)
  }

  const isNoteCompletionPartCorrect = (submission, question, paragraph, part) => {
    const key = noteAnswerKey(question.id, paragraph.id, part.id)
    const userAnswer = submission.answers?.[key]

    if (question.mode === 'choose') {
      return userAnswer?.toString().trim() === part.answer?.toString().trim()
    }

    const acceptedAnswers = [
      part.answer,
      ...(part.acceptedAnswers
        ? part.acceptedAnswers.split(',').map(item => item.trim()).filter(Boolean)
        : [])
    ].map(normalize)

    if (!isWithinWordLimit(userAnswer, part.maxWords)) return false

    return acceptedAnswers.includes(normalize(userAnswer))
  }

  const isListeningCompletionPartCorrect = (submission, question, section, item) => {
    const key = listeningCompletionAnswerKey(question.id, section.id, item.id)
    const userAnswer = submission.answers?.[key]

    if (question.completionMode === 'choose') {
      return userAnswer?.toString().trim() === item.answer?.toString().trim()
    }

    const acceptedAnswers = [
      item.answer,
      ...(item.acceptedAnswers
        ? item.acceptedAnswers.split(',').map(answer => answer.trim()).filter(Boolean)
        : [])
    ].map(normalize)

    if (!isWithinWordLimit(userAnswer, item.maxWords)) return false

    return acceptedAnswers.includes(normalize(userAnswer))
  }

  const isListeningMatchingItemCorrect = (submission, question, item) => {
    const key = matchingAnswerKey(question.id, item.id)
    const userAnswer = normalize(submission.answers?.[key])
    const correctAnswer = normalize(item.answer)

    if (!userAnswer || !correctAnswer) return false

    return userAnswer === correctAnswer
  }

  const getStudentAnalytics = studentId => {
    const student = getStudentByAnyId(studentId)
    const studentSubs = analyticsReadingSubmissions.filter(sub => submissionBelongsToStudent(sub, student))

    const stats = {
      matching: { correct: 0, total: 0 },
      matchingInformation: { correct: 0, total: 0 },
      sentenceEndings: { correct: 0, total: 0 },
      summaryOptions: { correct: 0, total: 0 },
      tfng: { correct: 0, total: 0 },
      fitb: { correct: 0, total: 0 },
      table: { correct: 0, total: 0 },
      summary: { correct: 0, total: 0 },
      note: { correct: 0, total: 0 },
      noteCompletion: { correct: 0, total: 0 },
      shortAnswer: { correct: 0, total: 0 },
      mcq: { correct: 0, total: 0 }
    }

    studentSubs.forEach(sub => {
      if (mergeStoredGradingBreakdown(stats, sub, { mcq_multi: 'mcq' })) return

      const reading = readings.find(r => r.id === sub.readingId)
      if (!reading) return

      reading.questions?.forEach(question => {
        if (question.type === 'matching') {
          question.paragraphs?.forEach(paragraph => {
            stats.matching.total++

            if (isMatchingCorrect(sub, question, paragraph)) {
              stats.matching.correct++
            }
          })

          return
        }

        if (question.type === 'matchingInformation') {
          question.items?.forEach(item => {
            stats.matchingInformation.total++

            if (isMatchingInformationCorrect(sub, question, item)) {
              stats.matchingInformation.correct++
            }
          })

          return
        }

        if (question.type === 'sentenceEndings') {
          question.items?.forEach(item => {
            stats.sentenceEndings.total++

            if (isSentenceEndingCorrect(sub, question, item)) {
              stats.sentenceEndings.correct++
            }
          })

          return
        }

        if (question.type === 'summaryOptions') {
          question.items?.forEach(item => {
            stats.summaryOptions.total++

            if (isSummaryOptionCorrect(sub, question, item)) {
              stats.summaryOptions.correct++
            }
          })

          return
        }

        if (question.type === 'noteCompletion') {
          question.paragraphs?.forEach(paragraph => {
            paragraph.parts?.forEach(part => {
              if (part.type !== 'blank') return

              stats.noteCompletion.total++

              if (isNoteCompletionPartCorrect(sub, question, paragraph, part)) {
                stats.noteCompletion.correct++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          const key = question.type === 'summary'
            ? 'summary'
            : question.type === 'note'
              ? 'note'
              : 'table'

          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats[key].total++

                if (isTableCellCorrect(sub, question, row, cellIndex)) {
                  stats[key].correct++
                }
              }
            })
          })

          return
        }

        if (!stats[question.type]) return

        stats[question.type].total++

        if (isNormalCorrect(sub, question)) {
          stats[question.type].correct++
        }
      })
    })

    const percentage = item =>
      item.total ? Math.round((item.correct / item.total) * 100) : null

    const data = {
      matching: percentage(stats.matching),
      matchingInformation: percentage(stats.matchingInformation),
      sentenceEndings: percentage(stats.sentenceEndings),
      summaryOptions: percentage(stats.summaryOptions),
      tfng: percentage(stats.tfng),
      fitb: percentage(stats.fitb),
      table: percentage(stats.table),
      summary: percentage(stats.summary),
      note: percentage(stats.note),
      noteCompletion: percentage(stats.noteCompletion),
      shortAnswer: percentage(stats.shortAnswer),
      mcq: percentage(stats.mcq)
    }

    const weaknessList = Object.entries(data)
      .filter(([, value]) => value !== null)
      .sort((a, b) => a[1] - b[1])

    return {
      ...data,
      weakest: weaknessList[0]?.[0] || null
    }
  }

  const getWeakestLabel = type => {
    if (type === 'matching') return 'Matching Headings'
    if (type === 'matchingInformation') return 'Matching Information'
    if (type === 'sentenceEndings') return 'Sentence Endings'
    if (type === 'summaryOptions') return 'Summary Completion with Options'
    if (type === 'tfng') return 'True / False / Not Given'
    if (type === 'fitb') return 'Fill in the Blank'
    if (type === 'table') return 'Table Completion'
    if (type === 'summary') return 'Summary Completion'
    if (type === 'note') return 'Legacy Note Completion'
    if (type === 'noteCompletion') return 'Reading Note/Summary Completion'
    if (type === 'shortAnswer') return 'Short Answer'
    if (type === 'mcq') return 'Multiple Choice'
    return 'No data yet'
  }

  const getAnalyticsColor = value => {
    if (value === null || value === undefined) return 'text-gray-400'
    if (value >= 75) return 'text-green-600'
    if (value >= 60) return 'text-amber-600'
    return 'text-red-500'
  }


  const mergeStoredGradingBreakdown = (stats, submission, aliases = {}) => {
    const breakdown = submission?.result?.gradingBreakdown

    if (!breakdown || typeof breakdown !== 'object') return false

    let merged = false

    Object.entries(breakdown).forEach(([rawKey, value]) => {
      const key = aliases[rawKey] || rawKey
      const correct = Number(value?.correct)
      const total = Number(value?.total)

      if (!Number.isFinite(correct) || !Number.isFinite(total) || total <= 0) {
        return
      }

      if (!stats[key]) {
        stats[key] = { correct: 0, total: 0 }
      }

      stats[key].correct += correct
      stats[key].total += total
      merged = true
    })

    return merged
  }

  const getPartialMultiAnswerScore = (selectedAnswers, correctAnswers) => {
    const selected = Array.isArray(selectedAnswers)
      ? Array.from(new Set(selectedAnswers.map(value => value?.toString()).filter(Boolean)))
      : []
    const expected = Array.isArray(correctAnswers)
      ? correctAnswers.map(value => value?.toString()).filter(Boolean)
      : []
    const total = expected.length || 2
    const correct = selected.filter(value => expected.includes(value)).length

    return { correct, total }
  }

  const normalizeVocabularyValue = value =>
    value === undefined || value === null
      ? ''
      : value.toString().trim().toLowerCase()

  const normalizeVocabularyTypedAnswer = value =>
    normalizeVocabularyValue(value)
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\s+/g, ' ')

  const getVocabularyAcceptedAnswers = question => {
    const values = []
    const mainAnswer = question?.answerText || question?.answer

    if (mainAnswer) values.push(mainAnswer)

    ;(question?.acceptedAnswers || '')
      .toString()
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
      .forEach(value => values.push(value))

    return values.map(normalizeVocabularyTypedAnswer)
  }

  const getVocabularyMatchingOrder = vocabularyTest => {
    const matchingQuestions = (vocabularyTest?.questions || []).filter(
      question => (question?.type || 'mcq') === 'match_definition'
    )

    if (vocabularyTest?.matchingShuffle !== true || matchingQuestions.length <= 1) {
      return matchingQuestions
    }

    const hash = Array.from(vocabularyTest?.id || vocabularyTest?.title || 'vocabulary').reduce(
      (value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0,
      7
    )
    const shift = (hash % (matchingQuestions.length - 1)) + 1

    return [
      ...matchingQuestions.slice(shift),
      ...matchingQuestions.slice(0, shift)
    ]
  }

  const isVocabularyQuestionCorrectForAnalytics = (vocabularyTest, submission, question) => {
    const type = question?.type || 'mcq'
    const selected = submission?.answers?.[question.id]

    if (type === 'match_definition') {
      const matchingOrder = getVocabularyMatchingOrder(vocabularyTest)
      const selectedIndex = letters.findIndex(letter => letter === selected)

      if (selectedIndex < 0 || selectedIndex >= matchingOrder.length) return false
      return matchingOrder[selectedIndex]?.id === question.id
    }

    if (type === 'word_bank' || type === 'grammar_form') {
      const cleanUser = normalizeVocabularyTypedAnswer(selected)
      if (!cleanUser) return false

      return getVocabularyAcceptedAnswers(question).includes(cleanUser)
    }

    return Boolean(normalizeVocabularyValue(selected)) &&
      Boolean(normalizeVocabularyValue(question?.answer)) &&
      selected === question.answer
  }




  const estimateReadingBand = (correct, total) => {
    if (!total) return null

    const percentage = (correct / total) * 100

    if (percentage >= 90) return 9
    if (percentage >= 85) return 8.5
    if (percentage >= 80) return 8
    if (percentage >= 75) return 7.5
    if (percentage >= 70) return 7
    if (percentage >= 65) return 6.5
    if (percentage >= 60) return 6
    if (percentage >= 50) return 5.5
    if (percentage >= 40) return 5
    if (percentage >= 30) return 4.5
    if (percentage >= 20) return 4
    return 3.5
  }

  const getReadingSubmissionResult = submission => {
    const reading = readings.find(item => item.id === submission.readingId)
    if (!reading) return null

    let correct = 0
    let total = 0

    reading.questions?.forEach(question => {
      if (question.type === 'matching') {
        question.paragraphs?.forEach(paragraph => {
          total++

          if (isMatchingCorrect(submission, question, paragraph)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'matchingInformation') {
        question.items?.forEach(item => {
          total++

          if (isMatchingInformationCorrect(submission, question, item)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'sentenceEndings') {
        question.items?.forEach(item => {
          total++

          if (isSentenceEndingCorrect(submission, question, item)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'summaryOptions') {
        question.items?.forEach(item => {
          total++

          if (isSummaryOptionCorrect(submission, question, item)) {
            correct++
          }
        })

        return
      }

      if (question.type === 'noteCompletion') {
        question.paragraphs?.forEach(paragraph => {
          paragraph.parts?.forEach(part => {
            if (part.type !== 'blank') return

            total++

            if (isNoteCompletionPartCorrect(submission, question, paragraph, part)) {
              correct++
            }
          })
        })

        return
      }

      if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
        question.rows?.forEach(row => {
          row.cells?.forEach((cell, cellIndex) => {
            if (cell.type === 'blank') {
              total++

              if (isTableCellCorrect(submission, question, row, cellIndex)) {
                correct++
              }
            }
          })
        })

        return
      }

      total++

      if (isNormalCorrect(submission, question)) {
        correct++
      }
    })

    return {
      correct,
      total,
      accuracy: total ? Math.round((correct / total) * 100) : null,
      estimatedBand: estimateReadingBand(correct, total)
    }
  }

  const getAverageReadingEstimatedBand = () => {
    const bands = analyticsReadingSubmissions
      .map(submission => {
        if (submission.result?.band) return Number(submission.result.band)
        if (submission.result?.estimatedBand) return Number(submission.result.estimatedBand)

        const result = getReadingSubmissionResult(submission)
        return result?.estimatedBand
      })
      .filter(value => !Number.isNaN(value) && value > 0)

    if (bands.length === 0) return null

    const avg = bands.reduce((sum, value) => sum + value, 0) / bands.length
    return (Math.round(avg * 10) / 10).toFixed(1)
  }

  const getReadingCompletionStats = () => {
    const assigned = activeReadings.reduce(
      (sum, reading) => sum + getCanonicalAssignmentCount('reading', reading.id),
      0
    )

    const activeReadingIds = activeReadings.map(reading => reading.id)

    const completed = submissions.filter(submission =>
      activeReadingIds.includes(submission.readingId)
    ).length

    const rate = assigned ? Math.round((completed / assigned) * 100) : 0

    return {
      assigned,
      completed,
      rate
    }
  }

  const getMostMissedReadingQuestions = () => {
    const stats = {}

    analyticsReadingSubmissions.forEach(submission => {
      const reading = readings.find(item => item.id === submission.readingId)
      if (!reading) return

      reading.questions?.forEach((question, questionIndex) => {
        const key = `${reading.title} — Q${questionIndex + 1}`

        if (!stats[key]) {
          stats[key] = {
            label: key,
            wrong: 0,
            total: 0
          }
        }

        if (question.type === 'matching') {
          question.paragraphs?.forEach(paragraph => {
            stats[key].total++

            if (!isMatchingCorrect(submission, question, paragraph)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'matchingInformation') {
          question.items?.forEach(item => {
            stats[key].total++

            if (!isMatchingInformationCorrect(submission, question, item)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'sentenceEndings') {
          question.items?.forEach(item => {
            stats[key].total++

            if (!isSentenceEndingCorrect(submission, question, item)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'summaryOptions') {
          question.items?.forEach(item => {
            stats[key].total++

            if (!isSummaryOptionCorrect(submission, question, item)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'noteCompletion') {
          question.paragraphs?.forEach(paragraph => {
            paragraph.parts?.forEach(part => {
              if (part.type !== 'blank') return

              stats[key].total++

              if (!isNoteCompletionPartCorrect(submission, question, paragraph, part)) {
                stats[key].wrong++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats[key].total++

                if (!isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats[key].wrong++
                }
              }
            })
          })

          return
        }

        if (question.type === 'mcq' && question.mode === 'multi') {
          const score = getPartialMultiAnswerScore(
            submission.answers?.[question.id],
            question.answers
          )

          stats[key].total += score.total
          stats[key].wrong += score.total - score.correct
          return
        }

        stats[key].total++

        if (!isNormalCorrect(submission, question)) {
          stats[key].wrong++
        }
      })
    })

    return Object.values(stats)
      .filter(item => item.total > 0 && item.wrong > 0)
      .map(item => ({
        ...item,
        wrongRate: Math.round((item.wrong / item.total) * 100)
      }))
      .sort((a, b) => b.wrongRate - a.wrongRate)
      .slice(0, 5)
  }

  const getAtRiskReadingStudents = () => {
    return students
      .map(student => {
        const studentSubs = analyticsReadingSubmissions
          .filter(sub => submissionBelongsToStudent(sub, student))
          .sort(
            (a, b) =>
              new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0)
          )

        const latest = studentSubs[0]

        if (!latest) return null

        const result = latest.result?.band
          ? {
              estimatedBand: Number(latest.result.band),
              accuracy: latest.result.accuracy || null
            }
          : getReadingSubmissionResult(latest)

        if (!result?.estimatedBand) return null

        return {
          student,
          latestBand: Number(result.estimatedBand),
          latestAccuracy: result.accuracy,
          submissions: studentSubs.length
        }
      })
      .filter(item => item && item.latestBand < 6)
      .sort((a, b) => a.latestBand - b.latestBand)
      .slice(0, 5)
  }

  const getReadingTypeAnalytics = () => {
    const stats = {
      matching: { correct: 0, total: 0 },
      matchingInformation: { correct: 0, total: 0 },
      sentenceEndings: { correct: 0, total: 0 },
      summaryOptions: { correct: 0, total: 0 },
      mcq: { correct: 0, total: 0 },
      fitb: { correct: 0, total: 0 },
      tfng: { correct: 0, total: 0 },
      table: { correct: 0, total: 0 },
      summary: { correct: 0, total: 0 },
      note: { correct: 0, total: 0 },
      noteCompletion: { correct: 0, total: 0 },
      shortAnswer: { correct: 0, total: 0 }
    }

    analyticsReadingSubmissions.forEach(submission => {
      if (mergeStoredGradingBreakdown(stats, submission, { mcq_multi: 'mcq' })) return

      const reading = readings.find(item => item.id === submission.readingId)
      if (!reading) return

      reading.questions?.forEach(question => {
        if (question.type === 'matching') {
          question.paragraphs?.forEach(paragraph => {
            stats.matching.total++

            if (isMatchingCorrect(submission, question, paragraph)) {
              stats.matching.correct++
            }
          })

          return
        }

        if (question.type === 'matchingInformation') {
          question.items?.forEach(item => {
            stats.matchingInformation.total++

            if (isMatchingInformationCorrect(submission, question, item)) {
              stats.matchingInformation.correct++
            }
          })

          return
        }

        if (question.type === 'sentenceEndings') {
          question.items?.forEach(item => {
            stats.sentenceEndings.total++

            if (isSentenceEndingCorrect(submission, question, item)) {
              stats.sentenceEndings.correct++
            }
          })

          return
        }

        if (question.type === 'summaryOptions') {
          question.items?.forEach(item => {
            stats.summaryOptions.total++

            if (isSummaryOptionCorrect(submission, question, item)) {
              stats.summaryOptions.correct++
            }
          })

          return
        }

        if (question.type === 'noteCompletion') {
          question.paragraphs?.forEach(paragraph => {
            paragraph.parts?.forEach(part => {
              if (part.type !== 'blank') return

              stats.noteCompletion.total++

              if (isNoteCompletionPartCorrect(submission, question, paragraph, part)) {
                stats.noteCompletion.correct++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          const key = question.type === 'summary'
            ? 'summary'
            : question.type === 'note'
              ? 'note'
              : 'table'

          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats[key].total++

                if (isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats[key].correct++
                }
              }
            })
          })

          return
        }

        if (!stats[question.type]) return

        stats[question.type].total++

        if (isNormalCorrect(submission, question)) {
          stats[question.type].correct++
        }
      })
    })

    return Object.entries(stats)
      .map(([key, value]) => ({
        key,
        correct: value.correct,
        total: value.total,
        percentage: value.total
          ? Math.round((value.correct / value.total) * 100)
          : null
      }))
      .filter(item => item.total > 0)
  }


  const getStudentReadingSubmissions = studentId => {
    const student = getStudentByAnyId(studentId)

    return currentReadingSubmissions
      .filter(submission => submissionBelongsToStudent(submission, student) && submission.excludedFromStats !== true)
      .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))
  }

  const getAverageReadingEstimatedBandFromSubmissions = targetSubmissions => {
    const bands = targetSubmissions
      .map(submission => {
        if (submission.result?.band) return Number(submission.result.band)
        if (submission.result?.estimatedBand) return Number(submission.result.estimatedBand)

        const result = getReadingSubmissionResult(submission)
        return result?.estimatedBand
      })
      .filter(value => !Number.isNaN(value) && value > 0)

    if (bands.length === 0) return null

    const avg = bands.reduce((sum, value) => sum + value, 0) / bands.length
    return (Math.round(avg * 10) / 10).toFixed(1)
  }

  const getReadingCompletionStatsForStudent = studentId => {
    const assignedReadings = getStudentReadings(studentId)
    const completed = assignedReadings.filter(reading =>
      getSubmission(studentId, reading.id)
    ).length

    return {
      assigned: assignedReadings.length,
      completed,
      rate: assignedReadings.length
        ? Math.round((completed / assignedReadings.length) * 100)
        : 0
    }
  }

  const getReadingTypeAnalyticsForSubmissions = targetSubmissions => {
    const stats = {
      matching: { correct: 0, total: 0 },
      matchingInformation: { correct: 0, total: 0 },
      sentenceEndings: { correct: 0, total: 0 },
      summaryOptions: { correct: 0, total: 0 },
      mcq: { correct: 0, total: 0 },
      fitb: { correct: 0, total: 0 },
      tfng: { correct: 0, total: 0 },
      table: { correct: 0, total: 0 },
      summary: { correct: 0, total: 0 },
      note: { correct: 0, total: 0 },
      noteCompletion: { correct: 0, total: 0 },
      shortAnswer: { correct: 0, total: 0 }
    }

    targetSubmissions.forEach(submission => {
      if (mergeStoredGradingBreakdown(stats, submission, { mcq_multi: 'mcq' })) return

      const reading = readings.find(item => item.id === submission.readingId)
      if (!reading) return

      reading.questions?.forEach(question => {
        if (question.type === 'matching') {
          question.paragraphs?.forEach(paragraph => {
            stats.matching.total++

            if (isMatchingCorrect(submission, question, paragraph)) {
              stats.matching.correct++
            }
          })

          return
        }

        if (question.type === 'matchingInformation') {
          question.items?.forEach(item => {
            stats.matchingInformation.total++

            if (isMatchingInformationCorrect(submission, question, item)) {
              stats.matchingInformation.correct++
            }
          })

          return
        }

        if (question.type === 'sentenceEndings') {
          question.items?.forEach(item => {
            stats.sentenceEndings.total++

            if (isSentenceEndingCorrect(submission, question, item)) {
              stats.sentenceEndings.correct++
            }
          })

          return
        }

        if (question.type === 'summaryOptions') {
          question.items?.forEach(item => {
            stats.summaryOptions.total++

            if (isSummaryOptionCorrect(submission, question, item)) {
              stats.summaryOptions.correct++
            }
          })

          return
        }

        if (question.type === 'noteCompletion') {
          question.paragraphs?.forEach(paragraph => {
            paragraph.parts?.forEach(part => {
              if (part.type !== 'blank') return

              stats.noteCompletion.total++

              if (isNoteCompletionPartCorrect(submission, question, paragraph, part)) {
                stats.noteCompletion.correct++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          const key = question.type === 'summary'
            ? 'summary'
            : question.type === 'note'
              ? 'note'
              : 'table'

          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats[key].total++

                if (isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats[key].correct++
                }
              }
            })
          })

          return
        }

        if (!stats[question.type]) return

        stats[question.type].total++

        if (isNormalCorrect(submission, question)) {
          stats[question.type].correct++
        }
      })
    })

    return Object.entries(stats)
      .map(([key, value]) => ({
        key,
        correct: value.correct,
        total: value.total,
        percentage: value.total
          ? Math.round((value.correct / value.total) * 100)
          : null
      }))
      .filter(item => item.total > 0)
  }

  const getMostMissedReadingQuestionsForSubmissions = targetSubmissions => {
    const stats = {}

    targetSubmissions.forEach(submission => {
      const reading = readings.find(item => item.id === submission.readingId)
      if (!reading) return

      reading.questions?.forEach((question, questionIndex) => {
        const key = `${reading.title} — Q${questionIndex + 1}`

        if (!stats[key]) {
          stats[key] = {
            label: key,
            wrong: 0,
            total: 0
          }
        }

        if (question.type === 'matching') {
          question.paragraphs?.forEach(paragraph => {
            stats[key].total++

            if (!isMatchingCorrect(submission, question, paragraph)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'matchingInformation') {
          question.items?.forEach(item => {
            stats[key].total++

            if (!isMatchingInformationCorrect(submission, question, item)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'sentenceEndings') {
          question.items?.forEach(item => {
            stats[key].total++

            if (!isSentenceEndingCorrect(submission, question, item)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'summaryOptions') {
          question.items?.forEach(item => {
            stats[key].total++

            if (!isSummaryOptionCorrect(submission, question, item)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'noteCompletion') {
          question.paragraphs?.forEach(paragraph => {
            paragraph.parts?.forEach(part => {
              if (part.type !== 'blank') return

              stats[key].total++

              if (!isNoteCompletionPartCorrect(submission, question, paragraph, part)) {
                stats[key].wrong++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats[key].total++

                if (!isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats[key].wrong++
                }
              }
            })
          })

          return
        }

        if (question.type === 'mcq' && question.mode === 'multi') {
          const score = getPartialMultiAnswerScore(
            submission.answers?.[question.id],
            question.answers
          )

          stats[key].total += score.total
          stats[key].wrong += score.total - score.correct
          return
        }

        stats[key].total++

        if (!isNormalCorrect(submission, question)) {
          stats[key].wrong++
        }
      })
    })

    return Object.values(stats)
      .filter(item => item.total > 0 && item.wrong > 0)
      .map(item => ({
        ...item,
        wrongRate: Math.round((item.wrong / item.total) * 100)
      }))
      .sort((a, b) => b.wrongRate - a.wrongRate)
      .slice(0, 5)
  }


  const getStudentListeningSubmissions = studentId => {
    const student = getStudentByAnyId(studentId)

    return currentListeningSubmissions
      .filter(submission => submissionBelongsToStudent(submission, student) && submission.excludedFromStats !== true)
      .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))
  }

  const getListeningCompletionStatsForStudent = studentId => {
    const assignedListenings = getStudentListenings(studentId)
    const completed = assignedListenings.filter(listening =>
      getListeningSubmission(studentId, listening.id)
    ).length

    return {
      assigned: assignedListenings.length,
      completed,
      rate: assignedListenings.length
        ? Math.round((completed / assignedListenings.length) * 100)
        : 0
    }
  }

  const getAverageListeningBandFromSubmissions = targetSubmissions => {
    const bands = targetSubmissions
      .map(submission => Number(submission.result?.band))
      .filter(value => !Number.isNaN(value) && value > 0)

    if (bands.length === 0) return null

    const avg = bands.reduce((sum, value) => sum + value, 0) / bands.length
    return (Math.round(avg * 10) / 10).toFixed(1)
  }

  const getListeningTypeAnalyticsForSubmissions = targetSubmissions => {
    const stats = {
      mcq: { correct: 0, total: 0 },
      fitb: { correct: 0, total: 0 },
      tfng: { correct: 0, total: 0 },
      table: { correct: 0, total: 0 },
      note: { correct: 0, total: 0 },
      listeningCompletion: { correct: 0, total: 0 },
      listeningMatching: { correct: 0, total: 0 },
      map: { correct: 0, total: 0 },
      shortAnswer: { correct: 0, total: 0 }
    }

    targetSubmissions.forEach(submission => {
      if (mergeStoredGradingBreakdown(stats, submission, {
        matching: 'listeningMatching',
        mcq_multi: 'mcq'
      })) return

      const listening = listenings.find(item => item.id === submission.listeningId)
      if (!listening) return

      listening.questions?.forEach(question => {
        if (question.type === 'matching' && Array.isArray(question.matchingItems)) {
          question.matchingItems.forEach(item => {
            stats.listeningMatching.total++

            if (isListeningMatchingItemCorrect(submission, question, item)) {
              stats.listeningMatching.correct++
            }
          })

          return
        }

        if (question.type === 'map' && Array.isArray(question.mapItems)) {
          question.mapItems.forEach(item => {
            stats.map.total++

            const userAnswer = normalize(submission.answers?.[mapAnswerKey(question.id, item.id)])
            const correctAnswer = normalize(item.answer)

            if (userAnswer && correctAnswer && userAnswer === correctAnswer) {
              stats.map.correct++
            }
          })

          return
        }

        if (question.type === 'listeningCompletion') {
          question.sections?.forEach(section => {
            section.parts?.forEach(item => {
              if (item.type !== 'blank') return

              stats.listeningCompletion.total++

              if (isListeningCompletionPartCorrect(submission, question, section, item)) {
                stats.listeningCompletion.correct++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          const key = question.type === 'note' ? 'note' : 'table'

          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats[key].total++

                if (isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats[key].correct++
                }
              }
            })
          })

          return
        }

        if (!stats[question.type]) return

        stats[question.type].total++

        if (isNormalCorrect(submission, question)) {
          stats[question.type].correct++
        }
      })
    })

    return Object.entries(stats)
      .map(([key, value]) => ({
        key,
        correct: value.correct,
        total: value.total,
        percentage: value.total
          ? Math.round((value.correct / value.total) * 100)
          : null
      }))
      .filter(item => item.total > 0)
  }

  const getMostMissedListeningQuestionsForSubmissions = targetSubmissions => {
    const stats = {}

    targetSubmissions.forEach(submission => {
      const listening = listenings.find(item => item.id === submission.listeningId)
      if (!listening) return

      listening.questions?.forEach((question, questionIndex) => {
        const key = `${listening.title} — Q${questionIndex + 1}`

        if (!stats[key]) {
          stats[key] = {
            label: key,
            wrong: 0,
            total: 0
          }
        }

        if (question.type === 'matching' && Array.isArray(question.matchingItems)) {
          question.matchingItems.forEach(item => {
            stats[key].total++

            if (!isListeningMatchingItemCorrect(submission, question, item)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'map' && Array.isArray(question.mapItems)) {
          question.mapItems.forEach(item => {
            stats[key].total++

            const userAnswer = normalize(submission.answers?.[mapAnswerKey(question.id, item.id)])
            const correctAnswer = normalize(item.answer)

            if (!userAnswer || !correctAnswer || userAnswer !== correctAnswer) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'listeningCompletion') {
          question.sections?.forEach(section => {
            section.parts?.forEach(item => {
              if (item.type !== 'blank') return

              stats[key].total++

              if (!isListeningCompletionPartCorrect(submission, question, section, item)) {
                stats[key].wrong++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats[key].total++

                if (!isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats[key].wrong++
                }
              }
            })
          })

          return
        }

        if (question.type === 'mcq' && question.mode === 'multi') {
          const score = getPartialMultiAnswerScore(
            submission.answers?.[question.id],
            question.answers
          )

          stats[key].total += score.total
          stats[key].wrong += score.total - score.correct
          return
        }

        stats[key].total++

        if (!isNormalCorrect(submission, question)) {
          stats[key].wrong++
        }
      })
    })

    return Object.values(stats)
      .filter(item => item.total > 0 && item.wrong > 0)
      .map(item => ({
        ...item,
        wrongRate: Math.round((item.wrong / item.total) * 100)
      }))
      .sort((a, b) => b.wrongRate - a.wrongRate)
      .slice(0, 5)
  }

  const getStudentVocabularySubmissions = studentId => {
    const student = getStudentByAnyId(studentId)

    return currentVocabularySubmissions
      .filter(submission => submissionBelongsToStudent(submission, student) && submission.excludedFromStats !== true)
      .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))
  }

  const getVocabularyCompletionStatsForStudent = studentId => {
    const assignedVocabularyTests = getStudentVocabularyTests(studentId)
    const completed = assignedVocabularyTests.filter(vocabularyTest =>
      getVocabularySubmission(studentId, vocabularyTest.id)
    ).length

    return {
      assigned: assignedVocabularyTests.length,
      completed,
      rate: assignedVocabularyTests.length
        ? Math.round((completed / assignedVocabularyTests.length) * 100)
        : 0
    }
  }

  const getAverageVocabularyAccuracyFromSubmissions = targetSubmissions => {
    const percentages = targetSubmissions
      .map(submission => Number(submission.result?.percentage))
      .filter(value => !Number.isNaN(value) && value >= 0)

    if (percentages.length === 0) return null

    const avg = percentages.reduce((sum, value) => sum + value, 0) / percentages.length
    return Math.round(avg)
  }

  const getVocabularyTestPerformanceForSubmissions = targetSubmissions => {
    return targetSubmissions
      .map(submission => {
        const vocabularyTest = vocabularyTests.find(test =>
          isVocabularySubmissionForTest(submission, test.id)
        )

        return {
          id: submission.id,
          title: vocabularyTest?.title || submission.vocabularyTitle || 'Vocabulary Test',
          correct: submission.result?.correct || 0,
          total: submission.result?.total || vocabularyTest?.questions?.length || 0,
          percentage: submission.result?.percentage ?? null,
          submittedAt: submission.submittedAt
        }
      })
      .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))
      .slice(0, 5)
  }

  const getMostMissedVocabularyQuestionsForSubmissions = targetSubmissions => {
    const stats = {}

    targetSubmissions.forEach(submission => {
      const vocabularyTest = vocabularyTests.find(test =>
        isVocabularySubmissionForTest(submission, test.id)
      )

      if (!vocabularyTest) return

      vocabularyTest.questions?.forEach((question, questionIndex) => {
        const isCorrect = isVocabularyQuestionCorrectForAnalytics(
          vocabularyTest,
          submission,
          question
        )
        const key = `${vocabularyTest.title} — Q${questionIndex + 1}`

        if (!stats[key]) {
          stats[key] = {
            label: key,
            question: question.question || '',
            wrong: 0,
            total: 0
          }
        }

        stats[key].total++

        if (!isCorrect) {
          stats[key].wrong++
        }
      })
    })

    return Object.values(stats)
      .filter(item => item.total > 0 && item.wrong > 0)
      .map(item => ({
        ...item,
        wrongRate: Math.round((item.wrong / item.total) * 100)
      }))
      .sort((a, b) => b.wrongRate - a.wrongRate)
      .slice(0, 5)
  }

  const getReadingTypeLabel = type => {
    if (type === 'matching') return 'Matching Headings'
    if (type === 'matchingInformation') return 'Matching Information'
    if (type === 'sentenceEndings') return 'Sentence Endings'
    if (type === 'summaryOptions') return 'Summary Completion with Options'
    if (type === 'mcq') return 'MCQ'
    if (type === 'fitb') return 'Fill Blank'
    if (type === 'tfng') return 'T/F/NG'
    if (type === 'table') return 'Table Completion'
    if (type === 'summary') return 'Summary Completion'
    if (type === 'note') return 'Legacy Note Completion'
    if (type === 'noteCompletion') return 'Reading Note/Summary Completion'
    if (type === 'shortAnswer') return 'Short Answer'
    return type
  }


  const getAverageListeningBand = () => {
    const bands = analyticsListeningSubmissions
      .map(sub => Number(sub.result?.band))
      .filter(value => !Number.isNaN(value) && value > 0)

    if (bands.length === 0) return null

    const avg = bands.reduce((sum, value) => sum + value, 0) / bands.length
    return (Math.round(avg * 10) / 10).toFixed(1)
  }

  const getListeningCompletionStats = () => {
    const assigned = activeListenings.reduce(
      (sum, listening) => sum + getCanonicalAssignmentCount('listening', listening.id),
      0
    )

    const activeListeningIds = activeListenings.map(listening => listening.id)

    const completed = currentListeningSubmissions.filter(submission =>
      activeListeningIds.includes(submission.listeningId)
    ).length

    const rate = assigned ? Math.round((completed / assigned) * 100) : 0

    return {
      assigned,
      completed,
      rate
    }
  }

  const getMostMissedListeningQuestions = () => {
    const stats = {}

    analyticsListeningSubmissions.forEach(submission => {
      const listening = listenings.find(item => item.id === submission.listeningId)
      if (!listening) return

      listening.questions?.forEach((question, questionIndex) => {
        const key = `${listening.title} — Q${questionIndex + 1}`

        if (!stats[key]) {
          stats[key] = {
            label: key,
            wrong: 0,
            total: 0
          }
        }

        if (question.type === 'matching' && Array.isArray(question.matchingItems)) {
          question.matchingItems.forEach(item => {
            stats[key].total++

            if (!isListeningMatchingItemCorrect(submission, question, item)) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'map' && Array.isArray(question.mapItems)) {
          question.mapItems.forEach(item => {
            stats[key].total++

            const userAnswer = normalize(submission.answers?.[mapAnswerKey(question.id, item.id)])
            const correctAnswer = normalize(item.answer)

            if (!userAnswer || !correctAnswer || userAnswer !== correctAnswer) {
              stats[key].wrong++
            }
          })

          return
        }

        if (question.type === 'listeningCompletion') {
          question.sections?.forEach(section => {
            section.parts?.forEach(item => {
              if (item.type !== 'blank') return

              stats[key].total++

              if (!isListeningCompletionPartCorrect(submission, question, section, item)) {
                stats[key].wrong++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats[key].total++

                if (!isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats[key].wrong++
                }
              }
            })
          })

          return
        }

        if (question.type === 'mcq' && question.mode === 'multi') {
          const score = getPartialMultiAnswerScore(
            submission.answers?.[question.id],
            question.answers
          )

          stats[key].total += score.total
          stats[key].wrong += score.total - score.correct
          return
        }

        stats[key].total++

        if (!isNormalCorrect(submission, question)) {
          stats[key].wrong++
        }
      })
    })

    return Object.values(stats)
      .filter(item => item.total > 0 && item.wrong > 0)
      .map(item => ({
        ...item,
        wrongRate: Math.round((item.wrong / item.total) * 100)
      }))
      .sort((a, b) => b.wrongRate - a.wrongRate)
      .slice(0, 5)
  }

  const getAtRiskListeningStudents = () => {
    return students
      .map(student => {
        const studentSubs = analyticsListeningSubmissions
          .filter(sub => submissionBelongsToStudent(sub, student) && sub.result?.band)
          .sort(
            (a, b) =>
              new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0)
          )

        const latest = studentSubs[0]

        if (!latest) return null

        return {
          student,
          latestBand: Number(latest.result.band),
          submissions: studentSubs.length
        }
      })
      .filter(item => item && item.latestBand < 6)
      .sort((a, b) => a.latestBand - b.latestBand)
      .slice(0, 5)
  }

  const getListeningTypeAnalytics = () => {
    const stats = {
      mcq: { correct: 0, total: 0 },
      fitb: { correct: 0, total: 0 },
      tfng: { correct: 0, total: 0 },
      table: { correct: 0, total: 0 },
      note: { correct: 0, total: 0 },
      listeningCompletion: { correct: 0, total: 0 },
      listeningMatching: { correct: 0, total: 0 },
      map: { correct: 0, total: 0 },
      shortAnswer: { correct: 0, total: 0 }
    }

    analyticsListeningSubmissions.forEach(submission => {
      if (mergeStoredGradingBreakdown(stats, submission, {
        matching: 'listeningMatching',
        mcq_multi: 'mcq'
      })) return

      const listening = listenings.find(item => item.id === submission.listeningId)
      if (!listening) return

      listening.questions?.forEach(question => {
        if (question.type === 'matching' && Array.isArray(question.matchingItems)) {
          question.matchingItems.forEach(item => {
            stats.listeningMatching.total++

            if (isListeningMatchingItemCorrect(submission, question, item)) {
              stats.listeningMatching.correct++
            }
          })

          return
        }

        if (question.type === 'map' && Array.isArray(question.mapItems)) {
          question.mapItems.forEach(item => {
            stats.map.total++

            const userAnswer = normalize(submission.answers?.[mapAnswerKey(question.id, item.id)])
            const correctAnswer = normalize(item.answer)

            if (userAnswer && correctAnswer && userAnswer === correctAnswer) {
              stats.map.correct++
            }
          })

          return
        }

        if (question.type === 'listeningCompletion') {
          question.sections?.forEach(section => {
            section.parts?.forEach(item => {
              if (item.type !== 'blank') return

              stats.listeningCompletion.total++

              if (isListeningCompletionPartCorrect(submission, question, section, item)) {
                stats.listeningCompletion.correct++
              }
            })
          })

          return
        }

        if (question.type === 'table' || question.type === 'summary' || question.type === 'note') {
          const key = question.type === 'note' ? 'note' : 'table'

          question.rows?.forEach(row => {
            row.cells?.forEach((cell, cellIndex) => {
              if (cell.type === 'blank') {
                stats[key].total++

                if (isTableCellCorrect(submission, question, row, cellIndex)) {
                  stats[key].correct++
                }
              }
            })
          })

          return
        }

        if (!stats[question.type]) return

        stats[question.type].total++

        if (isNormalCorrect(submission, question)) {
          stats[question.type].correct++
        }
      })
    })

    return Object.entries(stats)
      .map(([key, value]) => ({
        key,
        correct: value.correct,
        total: value.total,
        percentage: value.total
          ? Math.round((value.correct / value.total) * 100)
          : null
      }))
      .filter(item => item.total > 0)
  }

  const getListeningTypeLabel = type => {
    if (type === 'listeningMatching') return 'Listening Matching'
    if (type === 'mcq') return 'MCQ'
    if (type === 'fitb') return 'Fill Blank'
    if (type === 'tfng') return 'T/F/NG'
    if (type === 'table') return 'Form/Table'
    if (type === 'note') return 'Legacy Note Completion'
    if (type === 'listeningCompletion') return 'Listening Note/Summary Completion'
    if (type === 'map') return 'Map Labelling'
    if (type === 'shortAnswer') return 'Short Answer'
    return type
  }

  const formatBand = value => {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? number.toFixed(1) : '-'
  }

  const getMockOverall = submission => {
    const result = submission?.result || {}

    return (
      result.reviewedOverall ||
      result.finalOverall ||
      result.overall ||
      result.overallEstimate ||
      null
    )
  }


  const getMockTypeForSubmission = submission => {
    const mock = mockTests.find(item => item.id === submission?.mockTestId)

    return (
      submission?.mockType ||
      submission?.contentType ||
      mock?.mockType ||
      mock?.contentType ||
      'full_mock'
    )
  }

  const getMockTypeLabelForSubmission = submission =>
    getMockTypeForSubmission(submission) === 'mini_mock'
      ? 'Mini Mock'
      : 'Full Mock'

  const getMockWritingBand = submission => {
    const result = submission?.result || {}

    return (
      result.writing?.band ||
      result.writingBand ||
      submission?.writingReview?.overall ||
      submission?.review?.writingOverall ||
      null
    )
  }

  const getMockWritingStatusLabel = submission => {
    if (getMockWritingStatus(submission) === 'not_included') return 'Not included'

    const band = getMockWritingBand(submission)

    if (band) return `Reviewed · Band ${formatBand(band)}`

    return 'Pending teacher review'
  }

  const getMockTitle = submission => {
    const mock = mockTests.find(item => item.id === submission.mockTestId)

    return mock?.title || submission.mockTitle || submission.title || 'Mock Test'
  }

  const getStudentMockSubmissions = studentId => {
    const student = getStudentByAnyId(studentId)

    return currentMockSubmissions
      .filter(submission => submissionBelongsToStudent(submission, student) && submission.archived !== true)
      .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))
  }

  const latestMockSubmission = studentId => getStudentMockSubmissions(studentId)[0]

  const handlePrint = student => {
    const studentMocks = getStudentMockSubmissions(student.id)
    const printWindow = window.open('', '_blank')

    if (!printWindow) {
      window.alert('Print window could not be opened. Please allow pop-ups and try again.')
      return
    }

    const reportDocument = printWindow.document
    const studentName = student?.name || 'Student'
    const studentEmail = student?.email || ''

    reportDocument.title = `${studentName} - Mock History`
    reportDocument.body.replaceChildren()

    const style = reportDocument.createElement('style')
    style.textContent = `
      body { font-family: sans-serif; padding: 40px; color: #111; }
      h1 { font-size: 24px; margin-bottom: 4px; }
      p { color: #666; font-size: 14px; margin-bottom: 30px; }
      table { width: 100%; border-collapse: collapse; }
      th { background: #7c3aed; color: white; padding: 10px 14px; text-align: left; font-size: 13px; }
      td { padding: 10px 14px; font-size: 13px; border-bottom: 1px solid #eee; }
      .overall { font-weight: bold; color: #7c3aed; }
      img { height: 50px; margin-bottom: 20px; }
    `
    reportDocument.head.appendChild(style)

    const logo = reportDocument.createElement('img')
    logo.src = `${window.location.origin}/1.png`
    logo.alt = 'Maxima'
    reportDocument.body.appendChild(logo)

    const heading = reportDocument.createElement('h1')
    heading.textContent = studentName
    reportDocument.body.appendChild(heading)

    const subtitle = reportDocument.createElement('p')
    subtitle.textContent = `${studentEmail} — Mock History Report`
    reportDocument.body.appendChild(subtitle)

    const table = reportDocument.createElement('table')
    const thead = reportDocument.createElement('thead')
    const headerRow = reportDocument.createElement('tr')
    ;['Date', 'Mock', 'Type', 'Listening', 'Reading', 'Writing', 'Overall'].forEach(label => {
      const header = reportDocument.createElement('th')
      header.textContent = label
      headerRow.appendChild(header)
    })
    thead.appendChild(headerRow)
    table.appendChild(thead)

    const tbody = reportDocument.createElement('tbody')
    const appendCell = (row, value, className = '') => {
      const cell = reportDocument.createElement('td')
      cell.textContent = value === undefined || value === null ? '' : String(value)
      if (className) cell.className = className
      row.appendChild(cell)
    }

    studentMocks.forEach(submission => {
      const result = submission.result || {}
      const row = reportDocument.createElement('tr')

      appendCell(row, formatDateShort(submission.submittedAt))
      appendCell(row, getMockTitle(submission))
      appendCell(row, getMockTypeLabelForSubmission(submission))
      appendCell(row, formatBand(result.listening?.band))
      appendCell(row, formatBand(result.reading?.band))
      appendCell(row, getMockWritingBand(submission) ? formatBand(getMockWritingBand(submission)) : 'Pending')
      appendCell(row, formatBand(getMockOverall(submission)), 'overall')

      tbody.appendChild(row)
    })

    table.appendChild(tbody)
    reportDocument.body.appendChild(table)

    printWindow.focus()
    printWindow.print()
  }

  const handleChangePassword = async () => {
    if (newPassword.length < 6) {
      setPasswordMsg('Password must be at least 6 characters')
      return
    }

    try {
      await updatePassword(auth.currentUser, newPassword)
      setPasswordMsg('Password changed successfully!')
      setNewPassword('')
    } catch (err) {
      setPasswordMsg(
        'Error: Please log out and log back in first, then try again.'
      )
    }
  }


  const getWritingMode = (writing, submission = {}) =>
    submission?.writingMode ||
    submission?.contentType ||
    writing?.writingMode ||
    writing?.contentType ||
    'full_writing'

  const isWritingTask1Enabled = (writing, submission = {}) => {
    if (submission?.task1Enabled === true) return true
    if (submission?.task1Enabled === false) return false

    return getWritingMode(writing, submission) !== 'task2_only'
  }

  const isWritingTask2Enabled = (writing, submission = {}) => {
    if (submission?.task2Enabled === true) return true
    if (submission?.task2Enabled === false) return false

    return getWritingMode(writing, submission) !== 'task1_only'
  }

  const getWritingTaskLabel = (writing, submission = {}) => {
    const task1Enabled = isWritingTask1Enabled(writing, submission)
    const task2Enabled = isWritingTask2Enabled(writing, submission)

    if (task1Enabled && task2Enabled) return 'Task 1 + Task 2'
    if (task1Enabled) return 'Task 1 Only'
    if (task2Enabled) return 'Task 2 Only'

    return 'Writing'
  }

  const getWritingSubmissionWordSummary = (writing, submission = {}) => {
    const parts = []

    if (isWritingTask1Enabled(writing, submission)) {
      parts.push(`Task 1: ${submission.task1WordCount || 0} words`)
    }

    if (isWritingTask2Enabled(writing, submission)) {
      parts.push(`Task 2: ${submission.task2WordCount || 0} words`)
    }

    return parts.join(' · ') || 'No answer'
  }

  const openWritingReview = ({ student, writing, submission }) => {
    setSelectedMockWritingReview(null)
    setSelectedWritingReview({ student, writing, submission })

    setWritingReviewForm({
      task1Band: submission.review?.task1Band || '',
      task2Band: submission.review?.task2Band || '',
      task1TA: submission.review?.rubric?.task1?.taskAchievement || '',
      task1CC: submission.review?.rubric?.task1?.coherenceCohesion || '',
      task1LR: submission.review?.rubric?.task1?.lexicalResource || '',
      task1GRA: submission.review?.rubric?.task1?.grammarRangeAccuracy || '',
      task2TR: submission.review?.rubric?.task2?.taskResponse || '',
      task2CC: submission.review?.rubric?.task2?.coherenceCohesion || '',
      task2LR: submission.review?.rubric?.task2?.lexicalResource || '',
      task2GRA: submission.review?.rubric?.task2?.grammarRangeAccuracy || '',
      task1Feedback: submission.review?.task1Feedback || '',
      task2Feedback: submission.review?.task2Feedback || '',
      overall: submission.review?.overall || '',
      generalFeedback: submission.review?.generalFeedback || ''
    })
  }

  const openMockWritingReview = ({ student, mock, submission }) => {
    const review = getMockWritingReview(submission) || {}

    setSelectedWritingReview(null)
    setSelectedMockWritingReview({ student, mock, submission })

    setWritingReviewForm({
      task1Band: review.task1Band || submission.result?.writing?.task1Band || '',
      task2Band: review.task2Band || submission.result?.writing?.task2Band || '',
      task1TA: review.rubric?.task1?.taskAchievement || '',
      task1CC: review.rubric?.task1?.coherenceCohesion || '',
      task1LR: review.rubric?.task1?.lexicalResource || '',
      task1GRA: review.rubric?.task1?.grammarRangeAccuracy || '',
      task2TR: review.rubric?.task2?.taskResponse || '',
      task2CC: review.rubric?.task2?.coherenceCohesion || '',
      task2LR: review.rubric?.task2?.lexicalResource || '',
      task2GRA: review.rubric?.task2?.grammarRangeAccuracy || '',
      task1Feedback: review.task1Feedback || '',
      task2Feedback: review.task2Feedback || '',
      overall: review.overall || submission.result?.writing?.band || '',
      generalFeedback: review.generalFeedback || ''
    })
  }

  const roundToHalf = value => {
    if (!value && value !== 0) return ''

    return (Math.round(Number(value) * 2) / 2).toFixed(1)
  }

  const averageBand = values => {
    const numbers = values
      .map(value => Number(value))
      .filter(value => !Number.isNaN(value) && value > 0)

    if (numbers.length === 0) return ''

    const avg = numbers.reduce((sum, value) => sum + value, 0) / numbers.length

    return roundToHalf(avg)
  }

  const getWeightedWritingOverall = ({
    task1Enabled,
    task2Enabled,
    task1Band,
    task2Band
  }) => {
    const t1 = Number(task1Band)
    const t2 = Number(task2Band)
    const hasTask1Band =
      task1Enabled && Number.isFinite(t1) && t1 > 0
    const hasTask2Band =
      task2Enabled && Number.isFinite(t2) && t2 > 0

    if (hasTask1Band && hasTask2Band) {
      // IELTS Writing Task 2 contributes twice as much as Task 1.
      return roundToHalf((t1 + t2 * 2) / 3)
    }

    if (hasTask1Band) return roundToHalf(t1)
    if (hasTask2Band) return roundToHalf(t2)

    return ''
  }

  const currentNormalWritingReviewTask1Enabled = selectedWritingReview
    ? isWritingTask1Enabled(selectedWritingReview.writing, selectedWritingReview.submission)
    : true

  const currentNormalWritingReviewTask2Enabled = selectedWritingReview
    ? isWritingTask2Enabled(selectedWritingReview.writing, selectedWritingReview.submission)
    : true

  const currentWritingReviewTask1Enabled = selectedMockWritingReview
    ? isWritingTask1Enabled(
        selectedMockWritingReview.mock,
        selectedMockWritingReview.submission
      )
    : currentNormalWritingReviewTask1Enabled

  const currentWritingReviewTask2Enabled = selectedMockWritingReview
    ? isWritingTask2Enabled(
        selectedMockWritingReview.mock,
        selectedMockWritingReview.submission
      )
    : currentNormalWritingReviewTask2Enabled

  const suggestedTask1Band = currentWritingReviewTask1Enabled
    ? averageBand([
        writingReviewForm.task1TA,
        writingReviewForm.task1CC,
        writingReviewForm.task1LR,
        writingReviewForm.task1GRA
      ])
    : ''

  const suggestedTask2Band = currentWritingReviewTask2Enabled
    ? averageBand([
        writingReviewForm.task2TR,
        writingReviewForm.task2CC,
        writingReviewForm.task2LR,
        writingReviewForm.task2GRA
      ])
    : ''

  const suggestedOverallBand = getWeightedWritingOverall({
    task1Enabled: currentWritingReviewTask1Enabled,
    task2Enabled: currentWritingReviewTask2Enabled,
    task1Band: currentWritingReviewTask1Enabled
      ? writingReviewForm.task1Band || suggestedTask1Band
      : '',
    task2Band: currentWritingReviewTask2Enabled
      ? writingReviewForm.task2Band || suggestedTask2Band
      : ''
  })

  const useSuggestedBands = () => {
    setWritingReviewForm(prev => ({
      ...prev,
      task1Band: currentWritingReviewTask1Enabled
        ? prev.task1Band || suggestedTask1Band
        : prev.task1Band,
      task2Band: currentWritingReviewTask2Enabled
        ? prev.task2Band || suggestedTask2Band
        : prev.task2Band,
      overall: suggestedOverallBand || prev.overall
    }))
  }

  const resetWritingReviewForm = () => {
    setWritingReviewForm({
      task1Band: '',
      task2Band: '',
      task1TA: '',
      task1CC: '',
      task1LR: '',
      task1GRA: '',
      task2TR: '',
      task2CC: '',
      task2LR: '',
      task2GRA: '',
      task1Feedback: '',
      task2Feedback: '',
      overall: '',
      generalFeedback: ''
    })
  }

  const buildWritingReviewPayload = () => ({
    task1Enabled: currentWritingReviewTask1Enabled,
    task2Enabled: currentWritingReviewTask2Enabled,
    task1Band: currentWritingReviewTask1Enabled ? writingReviewForm.task1Band : '',
    task2Band: currentWritingReviewTask2Enabled ? writingReviewForm.task2Band : '',
    rubric: {
      task1: currentWritingReviewTask1Enabled
        ? {
            taskAchievement: writingReviewForm.task1TA,
            coherenceCohesion: writingReviewForm.task1CC,
            lexicalResource: writingReviewForm.task1LR,
            grammarRangeAccuracy: writingReviewForm.task1GRA
          }
        : {},
      task2: currentWritingReviewTask2Enabled
        ? {
            taskResponse: writingReviewForm.task2TR,
            coherenceCohesion: writingReviewForm.task2CC,
            lexicalResource: writingReviewForm.task2LR,
            grammarRangeAccuracy: writingReviewForm.task2GRA
          }
        : {}
    },
    task1Feedback: currentWritingReviewTask1Enabled ? writingReviewForm.task1Feedback : '',
    task2Feedback: currentWritingReviewTask2Enabled ? writingReviewForm.task2Feedback : '',
    overall: writingReviewForm.overall,
    generalFeedback: writingReviewForm.generalFeedback
  })

  const saveWritingReview = async () => {
    if (!selectedWritingReview) return

    if (!writingReviewForm.overall) {
      alert('Please enter overall writing band.')
      return
    }

    await updateDoc(
      doc(db, 'writingSubmissions', selectedWritingReview.submission.id),
      {
        reviewed: true,
        reviewedAt: new Date().toISOString(),
        reviewedBy: user.uid,
        review: buildWritingReviewPayload()
      }
    )

    setSelectedWritingReview(null)
    resetWritingReviewForm()
  }

  const saveMockWritingReview = async () => {
    if (!selectedMockWritingReview) return

    if (!writingReviewForm.overall) {
      alert('Please enter overall writing band.')
      return
    }

    const submission = selectedMockWritingReview.submission
    const result = submission.result || {}
    const review = buildWritingReviewPayload()
    const now = new Date().toISOString()

    const listeningBand = Number(result.listening?.band)
    const readingBand = Number(result.reading?.band)
    const writingBand = Number(writingReviewForm.overall)

    const overallInputs = [listeningBand, readingBand, writingBand].filter(
      value => !Number.isNaN(value) && value > 0
    )

    const finalOverall =
      overallInputs.length > 0
        ? roundToHalf(
            overallInputs.reduce((sum, value) => sum + value, 0) /
              overallInputs.length
          )
        : writingReviewForm.overall

    await updateDoc(
      doc(db, 'mockSubmissions', submission.id),
      {
        reviewedAt: now,
        reviewedBy: user.uid,
        writingReview: {
          status: 'reviewed',
          ...review
        },
        result: {
          ...result,
          writing: {
            ...(result.writing || {}),
            status: 'reviewed',
            band: writingReviewForm.overall,
            task1Band: review.task1Band,
            task2Band: review.task2Band,
            review
          },
          finalOverall,
          overallEstimate: finalOverall,
          overall: finalOverall
        }
      }
    )

    const scoreTeacherIds = profile?.role === 'teacher'
      ? [user.uid]
      : Array.isArray(submission.teacherIds)
        ? submission.teacherIds
        : submission.teacherId
          ? [submission.teacherId]
          : []

    const mockScorePayload = {
      uid: submission.uid,
      studentId: submission.studentId || submission.uid,
      studentEmail: submission.studentEmail || '',
      date: (submission.submittedAt || now).slice(0, 10),
      source: 'mock_test',
      mockTestId: submission.mockTestId || '',
      listening: !Number.isNaN(listeningBand) && listeningBand > 0
        ? roundToHalf(listeningBand)
        : result.listening?.band || '',
      reading: !Number.isNaN(readingBand) && readingBand > 0
        ? roundToHalf(readingBand)
        : result.reading?.band || '',
      writing: writingReviewForm.overall,
      speaking: '',
      overall: finalOverall,
      updatedAt: now,
      updatedBy: user.uid,
      teacherId: scoreTeacherIds[0] || '',
      teacherIds: scoreTeacherIds,
      schoolId: submission.schoolId || profile?.schoolId || DEFAULT_SCHOOL_ID,
      ...(submission.excludedFromStats === true ? { excludedFromStats: true } : {})
    }

    const candidateScoreItems = [
      ...(scores[submission.uid] || []),
      ...(scores[submission.studentId] || [])
    ]

    const uniqueCandidateScores = Array.from(
      new Map(
        candidateScoreItems
          .filter(score => score?.id)
          .map(score => [score.id, score])
      ).values()
    )

    const matchingScoreItems = uniqueCandidateScores.filter(score => {
      return (
        score.mockTestId === submission.mockTestId ||
        score.mockId === submission.mockTestId
      )
    })

    if (matchingScoreItems.length > 0) {
      for (const scoreItem of matchingScoreItems) {
        await updateDoc(doc(db, 'scores', scoreItem.id), mockScorePayload)
      }
    } else {
      await addDoc(collection(db, 'scores'), {
        ...mockScorePayload,
        createdAt: now
      })
    }

    setSelectedMockWritingReview(null)
    resetWritingReviewForm()
  }


  const getMockSubmittedCount = mockTest => {
    return currentMockSubmissions.filter(submission => submission.mockTestId === mockTest.id).length
  }

  const getMockAssignedCount = mockTest => {
    return getCanonicalAssignmentCount('mock', mockTest.id)
  }

  const getMockType = mockTest =>
    mockTest?.mockType ||
    mockTest?.contentType ||
    'full_mock'

  const getMockEnabledSections = mockTest => {
    if (getMockType(mockTest) !== 'mini_mock') {
      return { listening: true, reading: true, writing: true }
    }

    if (
      mockTest?.enabledSections &&
      typeof mockTest.enabledSections === 'object'
    ) {
      const stored = {
        listening: mockTest.enabledSections.listening === true,
        reading: mockTest.enabledSections.reading === true,
        writing: mockTest.enabledSections.writing === true
      }

      if (Object.values(stored).some(Boolean)) return stored
    }

    const inferred = {
      listening: Boolean(
        mockTest?.listeningId ||
        mockTest?.listeningIds?.filter(Boolean).length
      ),
      reading: Boolean(
        mockTest?.readingId ||
        mockTest?.readingIds?.filter(Boolean).length
      ),
      writing: Boolean(mockTest?.writingId)
    }

    return Object.values(inferred).some(Boolean)
      ? inferred
      : { listening: true, reading: true, writing: true }
  }

  const getMockSectionTimes = mockTest => {
    const isMini = getMockType(mockTest) === 'mini_mock'
    const enabled = getMockEnabledSections(mockTest)
    const defaults = isMini
      ? { listening: 15, reading: 30, writing: 30 }
      : { listening: 35, reading: 60, writing: 60 }
    const stored = mockTest?.sectionTimeLimits || {}

    return {
      listening: enabled.listening
        ? Number(stored.listening) || defaults.listening
        : 0,
      reading: enabled.reading
        ? Number(stored.reading) || defaults.reading
        : 0,
      writing: enabled.writing
        ? Number(stored.writing) || defaults.writing
        : 0
    }
  }

  const getMockWritingLabel = mockTest => {
    if (!getMockEnabledSections(mockTest).writing) return 'No Writing'

    const mode = mockTest?.writingMode || 'full_writing'

    if (mode === 'task1_only') return 'Writing Task 1'
    if (mode === 'task2_only') return 'Writing Task 2'

    return 'Full Writing'
  }

  const getMockFlowSummary = mockTest => {
    const isMini = getMockType(mockTest) === 'mini_mock'
    const enabled = getMockEnabledSections(mockTest)
    const listeningCount = Array.isArray(mockTest?.listeningIds)
      ? mockTest.listeningIds.filter(Boolean).length
      : mockTest?.listeningId
        ? 1
        : 0
    const readingCount = Array.isArray(mockTest?.readingIds)
      ? mockTest.readingIds.filter(Boolean).length
      : mockTest?.readingId
        ? 1
        : 0

    const parts = [
      enabled.listening
        ? isMini
          ? 'Listening'
          : `${listeningCount || 1} Listening resource(s)`
        : null,
      enabled.reading
        ? isMini
          ? 'Reading'
          : `${readingCount || 3} Reading passages`
        : null,
      enabled.writing ? getMockWritingLabel(mockTest) : null
    ].filter(Boolean)

    return parts.join(' · ')
  }

  const getMockTotalTime = mockTest => {
    const times = getMockSectionTimes(mockTest)

    return times.listening + times.reading + times.writing
  }

  const libraryCard = ({ item, index, archived, type, description, detail,
    canEdit, editPath, duplicate, manage, archive, restore, remove }) => {
    const own = isOwnedByCurrentTeacher(item)
    const hasMore = Boolean((duplicate && !archived) || (own && (archive || restore || remove)))
    return (
      <div key={item.id} className={`rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 shadow-sm ${archived ? 'opacity-80' : ''}`}>
        <div className="min-w-0 flex-1">
          <p className="text-sm sm:text-base font-semibold text-slate-900 break-words">{index !== null ? `${index + 1}. ` : ''}{item.title || 'Untitled activity'}</p>
          <div className="flex items-center flex-wrap gap-2 mt-2">
            <span className="text-[11px] rounded-md bg-indigo-50 text-indigo-700 px-2.5 py-1 font-medium">{getContentTypeLabel(getLibraryContentType(item, type === 'mock' ? 'full_mock' : type === 'vocabulary' ? 'vocabulary_quiz' : `full_${type}`))}</span>
            <span className="text-[11px] rounded-md bg-slate-100 text-slate-600 px-2.5 py-1">{getLibraryVisibilityLabel(item)}</span>
            {archived && <span className="text-[11px] rounded-md bg-amber-50 text-amber-700 px-2.5 py-1">Archived</span>}
          </div>
          <p className="text-xs text-slate-500 mt-3">{description}</p>
          {detail && <p className="text-xs text-slate-500 mt-1">{detail}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end lg:shrink-0">
          <button type="button" onClick={() => openTeacherPreview(type, item.id)}
            className="rounded-xl border border-slate-200 bg-white hover:bg-slate-50 px-3.5 py-2 text-xs font-semibold text-slate-700">Preview</button>
          {!archived && manage && own && (
            <button type="button" onClick={manage} className="rounded-xl bg-indigo-600 hover:bg-indigo-700 px-3.5 py-2 text-xs font-semibold text-white">Assign</button>
          )}
          {!archived && manage && !own && duplicate && (
            <button type="button" onClick={duplicate} className="rounded-xl bg-indigo-50 hover:bg-indigo-100 px-3.5 py-2 text-xs font-semibold text-indigo-700">Duplicate to assign</button>
          )}
          {own && canEdit && !archived && editPath && (
            <button type="button" onClick={() => navigate(editPath)} className="rounded-xl bg-indigo-50 hover:bg-indigo-100 px-3.5 py-2 text-xs font-semibold text-indigo-700">Edit</button>
          )}
          {hasMore && (
            <details className="relative group">
              <summary className="list-none cursor-pointer select-none rounded-xl border border-slate-200 bg-white hover:bg-slate-50 px-3.5 py-2 text-xs font-semibold text-slate-700 flex items-center gap-2">
                More <TeacherIcon name="down" className="h-3.5 w-3.5" />
              </summary>
              <div className="absolute right-0 top-full mt-2 z-20 min-w-[180px] rounded-xl border border-slate-200 bg-white shadow-xl p-1.5">
                {!archived && duplicate && <button type="button" onClick={duplicate} className="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-50 text-xs text-slate-700">Duplicate</button>}
                {own && archived && restore && <button type="button" onClick={restore} className="w-full text-left px-3 py-2 rounded-lg hover:bg-emerald-50 text-xs text-emerald-700">Restore</button>}
                {own && !archived && archive && <button type="button" onClick={archive} className="w-full text-left px-3 py-2 rounded-lg hover:bg-amber-50 text-xs text-amber-700">Archive</button>}
                {own && remove && <button type="button" onClick={remove} className="w-full text-left px-3 py-2 rounded-lg hover:bg-red-50 text-xs text-red-700">Delete permanently</button>}
              </div>
            </details>
          )}
        </div>
      </div>
    )
  }

  const renderMockTestCard = (item, archived = false, index = null) => libraryCard({
    item, index, archived, type: 'mock', canEdit: true,
    description: `Assigned to ${getMockAssignedCount(item)} students · Submitted by ${getMockSubmittedCount(item)} students`,
    detail: `${getMockFlowSummary(item)} · ${getMockTotalTime(item)} min`,
    manage: () => openAssignmentManager(item, 'mock'),
    editPath: `/edit-mock/${item.id}`,
    archive: () => archiveMockTest(item),
    restore: () => restoreMockTest(item),
    remove: () => deleteMockTest(item),
  })

  const renderReadingHomeworkCard = (item, archived = false, index = null) => libraryCard({
    item, index, archived, type: 'reading', canEdit: true,
    description: `Assigned to ${getCanonicalAssignmentCount('reading', item.id)} students · Completed by ${getCompletedCount(item.id)} students · ${item.timeLimit || 60} min`,
    manage: () => openAssignmentManager(item, 'reading'),
    editPath: `/edit-reading/${item.id}`,
    duplicate: () => duplicateReadingHomework(item),
    archive: () => archiveReadingHomework(item),
    restore: () => restoreReadingHomework(item),
    remove: () => deleteReadingHomework(item),
  })

  const renderWritingHomeworkCard = (item, archived = false, index = null) => {
    const submitted = getWritingSubmittedCount(item.id)
    const reviewed = getWritingReviewedCount(item.id)
    return libraryCard({
      item, index, archived, type: 'writing', canEdit: true,
      description: `Assigned to ${getCanonicalAssignmentCount('writing', item.id)} students · Submitted by ${submitted} students · Reviewed ${reviewed}/${submitted} · ${item.timeLimit || 60} min`,
      detail: submitted > reviewed ? `${submitted - reviewed} writing review(s) pending` : '',
      manage: () => openAssignmentManager(item, 'writing'),
      editPath: `/edit-writing/${item.id}`,
      duplicate: () => duplicateWritingHomework(item),
      archive: () => archiveWritingHomework(item),
      restore: () => restoreWritingHomework(item),
      remove: () => deleteWritingHomework(item),
    })
  }

  const renderListeningHomeworkCard = (item, archived = false, index = null) => libraryCard({
    item, index, archived, type: 'listening', canEdit: true,
    description: `Assigned to ${getCanonicalAssignmentCount('listening', item.id)} students · Completed by ${getListeningCompletedCount(item.id)} students · ${item.timeLimit || 30} min`,
    manage: () => openAssignmentManager(item, 'listening'),
    editPath: `/edit-listening/${item.id}`,
    duplicate: () => duplicateListeningHomework(item),
    archive: () => archiveListeningHomework(item),
    restore: () => restoreListeningHomework(item),
    remove: () => deleteListeningHomework(item),
  })

  const renderVocabularyHomeworkCard = (item, archived = false, index = null) => libraryCard({
    item, index, archived, type: 'vocabulary', canEdit: true,
    description: `Assigned to ${getCanonicalAssignmentCount('vocabulary', item.id)} students · Completed by ${getVocabularyCompletedCount(item.id)} students · ${item.timeLimit || 20} min · ${item.questions?.length || 0} questions`,
    manage: () => openAssignmentManager(item, 'vocabulary'),
    editPath: `/edit-vocabulary/${item.id}`,
    duplicate: () => duplicateVocabularyTest(item),
    archive: () => archiveVocabularyTest(item),
    restore: () => restoreVocabularyTest(item),
    remove: () => deleteVocabularyTest(item),
  })

  const homeworkProgressByStudent = useMemo(() => students.map(student => ({
    student,
    progress: getStudentHomeworkProgress(student.id)
  })), [
    students, readings, writings, listenings, vocabularyTests, mockTests,
    submissions, writingSubmissions, listeningSubmissions,
    vocabularySubmissions, mockSubmissions, assignmentStudentIdsByContent
  ])
  const homeworkProgressById = useMemo(() => new Map(
    homeworkProgressByStudent.map(({ student, progress }) => [student.id, progress])
  ), [homeworkProgressByStudent])

  const overallHomeworkProgress = homeworkProgressByStudent.reduce(
    (summary, item) => {
      summary.assigned += item.progress.assigned
      summary.completed += item.progress.completed
      summary.notCompleted += item.progress.notCompleted
      summary.overdue += item.progress.overdue

      Object.entries(item.progress.types).forEach(([key, value]) => {
        if (!summary.types[key]) {
          summary.types[key] = {
            label: value.label,
            assigned: 0,
            completed: 0,
            overdue: 0,
            rate: 0
          }
        }

        summary.types[key].assigned += value.assigned
        summary.types[key].completed += value.completed
        summary.types[key].overdue += value.overdue
      })

      return summary
    },
    {
      assigned: 0,
      completed: 0,
      notCompleted: 0,
      overdue: 0,
      rate: 0,
      types: {}
    }
  )

  overallHomeworkProgress.rate = overallHomeworkProgress.assigned
    ? Math.round(
        (overallHomeworkProgress.completed / overallHomeworkProgress.assigned) * 100
      )
    : 0

  Object.values(overallHomeworkProgress.types).forEach(item => {
    item.rate = item.assigned
      ? Math.round((item.completed / item.assigned) * 100)
      : 0
  })

  // Do not compute heavy per-student analytics outside the Analytics page.
  const selectedAnalyticsStudent = activeTab !== 'analytics' || analyticsStudentId === 'all'
    ? null
    : getStudentByAnyId(analyticsStudentId)

  const selectedAnalyticsReadingSubmissions = selectedAnalyticsStudent
    ? getStudentReadingSubmissions(selectedAnalyticsStudent.id)
    : []
  const selectedAnalyticsReadingStats = selectedAnalyticsStudent
    ? getReadingCompletionStatsForStudent(selectedAnalyticsStudent.id)
    : null
  const selectedAnalyticsAverageReadingBand = selectedAnalyticsStudent
    ? getAverageReadingEstimatedBandFromSubmissions(selectedAnalyticsReadingSubmissions)
    : null
  const selectedAnalyticsReadingTypeAnalytics = selectedAnalyticsStudent
    ? getReadingTypeAnalyticsForSubmissions(selectedAnalyticsReadingSubmissions)
    : []
  const selectedAnalyticsMostMissedReadingQuestions = selectedAnalyticsStudent
    ? getMostMissedReadingQuestionsForSubmissions(selectedAnalyticsReadingSubmissions)
    : []
  const selectedAnalyticsWeakestReadingArea = selectedAnalyticsReadingTypeAnalytics
    .filter(item => item.percentage !== null && item.percentage !== undefined)
    .sort((a, b) => a.percentage - b.percentage)[0]

  const selectedAnalyticsListeningSubmissions = selectedAnalyticsStudent
    ? getStudentListeningSubmissions(selectedAnalyticsStudent.id)
    : []
  const selectedAnalyticsListeningStats = selectedAnalyticsStudent
    ? getListeningCompletionStatsForStudent(selectedAnalyticsStudent.id)
    : null
  const selectedAnalyticsAverageListeningBand = selectedAnalyticsStudent
    ? getAverageListeningBandFromSubmissions(selectedAnalyticsListeningSubmissions)
    : null
  const selectedAnalyticsListeningTypeAnalytics = selectedAnalyticsStudent
    ? getListeningTypeAnalyticsForSubmissions(selectedAnalyticsListeningSubmissions)
    : []
  const selectedAnalyticsMostMissedListeningQuestions = selectedAnalyticsStudent
    ? getMostMissedListeningQuestionsForSubmissions(selectedAnalyticsListeningSubmissions)
    : []
  const selectedAnalyticsWeakestListeningArea = selectedAnalyticsListeningTypeAnalytics
    .filter(item => item.percentage !== null && item.percentage !== undefined)
    .sort((a, b) => a.percentage - b.percentage)[0]

  const selectedAnalyticsVocabularySubmissions = selectedAnalyticsStudent
    ? getStudentVocabularySubmissions(selectedAnalyticsStudent.id)
    : []
  const selectedAnalyticsVocabularyStats = selectedAnalyticsStudent
    ? getVocabularyCompletionStatsForStudent(selectedAnalyticsStudent.id)
    : null
  const selectedAnalyticsAverageVocabularyAccuracy = selectedAnalyticsStudent
    ? getAverageVocabularyAccuracyFromSubmissions(selectedAnalyticsVocabularySubmissions)
    : null
  const selectedAnalyticsVocabularyPerformance = selectedAnalyticsStudent
    ? getVocabularyTestPerformanceForSubmissions(selectedAnalyticsVocabularySubmissions)
    : []
  const selectedAnalyticsMostMissedVocabularyQuestions = selectedAnalyticsStudent
    ? getMostMissedVocabularyQuestionsForSubmissions(selectedAnalyticsVocabularySubmissions)
    : []

  const teacherSectionId = TEACHER_CONTENT_TABS.some(item => item.id === activeTab)
    ? 'library'
    : activeTab
  const teacherPage = TEACHER_NAV_ITEMS.find(item => item.id === teacherSectionId) || TEACHER_NAV_ITEMS[0]
  const activeContentCount = activeReadings.length + activeListenings.length +
    activeWritings.length + activeVocabularyTests.length + activeMockTests.length
  const isStudentInClass = (student, classItem) => {
    if (!classItem) return false
    const keys = getStudentAssignmentValues(student).map(normalizeAssignmentId)
    return (Array.isArray(classItem.studentIds) ? classItem.studentIds : [])
      .some(id => keys.includes(normalizeAssignmentId(id)))
  }
  const filteredTeacherStudents = students.filter(student => {
    const term = studentSearchTerm.trim().toLowerCase()
    if (term && ![student.name, student.email, student.username]
      .some(value => String(value || '').toLowerCase().includes(term))) return false
    if (studentClassId !== 'all' && !isStudentInClass(student, classes.find(item => item.id === studentClassId))) return false
    return true
  })
  const contentSearchMatch = item => {
    const term = librarySearchTerm.trim().toLowerCase()
    return !term || String(item?.title || '').toLowerCase().includes(term)
  }
  const allReviewCount = reviewedWritingReviews.length + reviewedMockWritingReviews.length

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="min-h-screen lg:flex">
        <aside className="hidden lg:flex lg:w-64 xl:w-72 shrink-0 flex-col border-r border-slate-200 bg-white sticky top-0 h-screen">
          <div className="px-6 py-7 border-b border-slate-100">
            <div className="flex items-center gap-3">
              <img src="/1.png" alt="Maxima" className="h-9 w-auto max-w-[116px] object-contain" />
              <div className="border-l border-slate-200 pl-3">
                <p className="text-xs font-bold tracking-wider text-slate-800">MAXIMA</p>
                <p className="text-[11px] text-slate-500">Teacher Workspace</p>
              </div>
            </div>
          </div>
          <div className="px-4 py-6 flex-1 overflow-y-auto">
            <p className="px-3 text-[11px] font-semibold uppercase tracking-[.16em] text-slate-400 mb-3">Workspace</p>
            <nav className="space-y-1" aria-label="Teacher navigation">
              {TEACHER_NAV_ITEMS.map(item => (
                <button key={item.id} type="button" onClick={() => openTeacherSection(item.id)}
                  aria-current={teacherSectionId === item.id ? 'page' : undefined}
                  className={`w-full flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium text-left transition-colors ${teacherSectionId === item.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}>
                  <TeacherIcon name={item.icon} />
                  <span className="min-w-0 flex-1">{item.label}</span>
                  {item.id === 'reviews' && totalPendingWritingReviews > 0 && (
                    <span className="shrink-0 text-[11px] rounded-md bg-amber-100 px-2 py-0.5 text-amber-800">{totalPendingWritingReviews}</span>
                  )}
                </button>
              ))}
            </nav>
            <div className="mt-7 border-t border-slate-100 pt-5">
              <p className="px-3 text-[11px] font-semibold uppercase tracking-[.16em] text-slate-400 mb-3">Teaching tools</p>
              <button type="button" onClick={() => navigate('/teacher/classes')}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-sm text-slate-600 hover:bg-slate-50 hover:text-slate-900 text-left">
                <TeacherIcon name="classes" /> Manage classes <TeacherIcon name="arrow" className="w-4 h-4 ml-auto" />
              </button>
            </div>
          </div>
          <div className="px-6 py-5 border-t border-slate-100">
            <div className="flex items-center gap-2 text-xs text-slate-500"><TeacherIcon name="check" className="w-4 h-4" /> Institution teaching workspace</div>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
            <div className="px-4 sm:px-7 lg:px-9 py-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <img src="/1.png" alt="Maxima" className="h-8 w-auto max-w-[100px] object-contain lg:hidden" />
                <span className="hidden sm:block text-sm font-semibold text-slate-800 truncate">Teacher Workspace</span>
                <span className="rounded-md bg-indigo-50 px-2 py-1 text-[11px] font-semibold text-indigo-700">TEACHER</span>
              </div>
              <div className="flex items-center gap-2 sm:gap-4 shrink-0">
                <span className="hidden xl:block text-xs text-slate-500 max-w-[200px] truncate" title={user?.email}>{user?.email}</span>
                <button type="button" onClick={() => setShowPasswordModal(true)} className="inline-flex items-center gap-2 text-xs sm:text-sm text-slate-600 hover:text-slate-900 rounded-lg px-2 py-1 focus-visible:ring-2 focus-visible:ring-indigo-500">
                  <TeacherIcon name="lock" className="h-4 w-4" /> <span className="hidden sm:inline">Password</span>
                </button>
                <button type="button" onClick={() => { signOut(auth); navigate('/') }} className="inline-flex items-center gap-2 text-xs sm:text-sm text-slate-600 hover:text-slate-900 rounded-lg px-2 py-1 focus-visible:ring-2 focus-visible:ring-indigo-500">
                  <TeacherIcon name="exit" className="h-4 w-4" /> Sign out
                </button>
              </div>
            </div>
            <nav className="lg:hidden flex gap-1 px-3 pb-3 overflow-x-auto" aria-label="Mobile teacher navigation">
              {TEACHER_NAV_ITEMS.map(item => (
                <button key={item.id} type="button" onClick={() => openTeacherSection(item.id)}
                  aria-current={teacherSectionId === item.id ? 'page' : undefined}
                  className={`shrink-0 flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium ${teacherSectionId === item.id ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}`}>
                  <TeacherIcon name={item.icon} className="h-4 w-4" />{item.label}
                  {item.id === 'reviews' && totalPendingWritingReviews > 0 && <span className="text-[10px] bg-amber-100 text-amber-800 rounded px-1.5">{totalPendingWritingReviews}</span>}
                </button>
              ))}
            </nav>
          </header>

          <main className="max-w-[1480px] mx-auto px-4 sm:px-7 lg:px-9 py-7 sm:py-9 pb-20">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-7">
              <div>
                <p className="text-xs font-medium text-indigo-700 mb-2 uppercase tracking-[.12em]">Maxima / Teaching</p>
                <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-slate-900">{teacherPage.label}</h1>
                <p className="text-sm text-slate-500 mt-2 max-w-2xl">{teacherPage.description}</p>
              </div>
              <div className="flex gap-2 items-center shrink-0">
                {teacherSectionId === 'students' && (
                  <button type="button" onClick={() => navigate('/teacher/classes')}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-slate-200 text-slate-700 text-sm font-medium hover:bg-slate-50">
                    <TeacherIcon name="classes" className="h-4 w-4" /> Manage classes
                  </button>
                )}
                <div className="relative">
                  <button type="button" onClick={() => setCreateMenuOpen(value => !value)}
                    aria-expanded={createMenuOpen} aria-haspopup="menu"
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500">
                    <TeacherIcon name="plus" className="h-4 w-4" /> Create new <TeacherIcon name="down" className="h-4 w-4" />
                  </button>
                  {createMenuOpen && (
                    <div role="menu" aria-label="Create new teaching content" className="absolute top-full right-0 mt-2 w-60 z-50 rounded-xl border border-slate-200 bg-white shadow-xl p-1.5">
                      {TEACHER_CREATION_ROUTES.map(item => (
                        <button key={item.path} type="button" role="menuitem"
                          onClick={() => { setCreateMenuOpen(false); navigate(item.path) }}
                          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm text-slate-700 hover:bg-indigo-50 hover:text-indigo-700">
                          <TeacherIcon name={item.icon} className="w-4 h-4" /> {item.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {dashboardDataError && (
              <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3" role="alert">
                <p className="text-sm text-amber-800">{dashboardDataError}</p>
                <button type="button" onClick={() => window.location.reload()}
                  className="shrink-0 rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700">Retry</button>
              </div>
            )}

            {teacherSectionId === 'library' && (
              <div className="mb-6 space-y-4">
                <nav aria-label="Content types" className="flex gap-2 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
                  {TEACHER_CONTENT_TABS.map(item => (
                    <button key={item.id} type="button" onClick={() => openTeacherContentTab(item.id)}
                      aria-current={activeTab === item.id ? 'page' : undefined}
                      className={`whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-medium transition-colors ${activeTab === item.id ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                      {item.label}
                      <span className={`ml-2 text-[11px] ${activeTab === item.id ? 'text-indigo-100' : 'text-slate-400'}`}>
                        {item.id === 'reading' ? activeReadings.length : item.id === 'listening' ? activeListenings.length : item.id === 'writing' ? activeWritings.length : item.id === 'vocabulary' ? activeVocabularyTests.length : activeMockTests.length}
                      </span>
                    </button>
                  ))}
                </nav>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <p className="text-xs text-slate-500">Preview, Edit and Assign remain available. School Library content may require duplication before assigning.</p>
                  <div className="relative w-full sm:w-72 shrink-0">
                    <TeacherIcon name="search" className="absolute h-4 w-4 left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input aria-label="Search content by title" value={librarySearchTerm} onChange={event => setLibrarySearchTerm(event.target.value)}
                      placeholder="Search content by title..." className="w-full pl-9 pr-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm outline-none focus:ring-2 focus:ring-indigo-200" />
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'overview' && (
              <div className="space-y-6">
                <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4" aria-label="Teacher overview metrics">
                  {[
                    { label: 'Students', value: students.length, icon: 'students', note: 'Assigned learners', target: 'students' },
                    { label: 'Active content', value: activeContentCount, icon: 'library', note: 'Across five IELTS modules', target: 'library' },
                    { label: 'Pending reviews', value: totalPendingWritingReviews, icon: 'reviews', note: 'Writing and Mock Writing', target: 'reviews' },
                    { label: 'Homework completion', value: `${overallHomeworkProgress.rate}%`, icon: 'analytics', note: `${overallHomeworkProgress.completed} of ${overallHomeworkProgress.assigned} assigned`, target: 'analytics' },
                  ].map(metric => (
                    <button key={metric.label} type="button" onClick={() => openTeacherSection(metric.target)}
                      className="text-left rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm hover:border-indigo-300 hover:shadow-md transition-all focus-visible:ring-2 focus-visible:ring-indigo-400 min-w-0">
                      <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500">
                        <span>{metric.label}</span><TeacherIcon name={metric.icon} className="h-4 w-4 shrink-0" />
                      </div>
                      <p className="mt-4 text-2xl sm:text-3xl font-semibold tracking-tight text-slate-900">{metric.value}</p>
                      <p className="mt-1 text-[11px] sm:text-xs text-slate-500">{metric.note}</p>
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-5 gap-5">
                  <section className="xl:col-span-3 bg-white border border-slate-200 shadow-sm rounded-2xl p-5 sm:p-6">
                    <div className="flex items-start justify-between gap-3 mb-5">
                      <div>
                        <h2 className="text-base font-semibold text-slate-900">Needs your attention</h2>
                        <p className="text-sm text-slate-500 mt-1">Important work, without searching through the library</p>
                      </div>
                      {totalPendingWritingReviews > 0 && <span className="shrink-0 text-[11px] rounded-md bg-amber-50 text-amber-700 px-2 py-1">{totalPendingWritingReviews} pending</span>}
                    </div>
                    {totalPendingWritingReviews > 0 ? (
                      <div className="space-y-3">
                        {pendingWritingReviews.slice(0, 3).map(item => (
                          <div key={`writing-${item.submission.id}`} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-4 py-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-slate-800 truncate">{item.student.name}</p>
                              <p className="text-xs text-slate-500 truncate">Writing · {item.writing.title}</p>
                            </div>
                            <button type="button" onClick={() => openWritingReview(item)}
                              className="shrink-0 rounded-lg bg-indigo-50 px-3 py-2 text-xs font-medium text-indigo-700 hover:bg-indigo-100">Grade now</button>
                          </div>
                        ))}
                        {pendingMockWritingReviews.slice(0, 3).map(item => (
                          <div key={`mock-${item.submission.id}`} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-4 py-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-slate-800 truncate">{item.student.name}</p>
                              <p className="text-xs text-slate-500 truncate">Mock Writing · {item.mock?.title || 'Mock Test'}</p>
                            </div>
                            <button type="button" onClick={() => openMockWritingReview(item)}
                              className="shrink-0 rounded-lg bg-indigo-50 px-3 py-2 text-xs font-medium text-indigo-700 hover:bg-indigo-100">Grade now</button>
                          </div>
                        ))}
                        <button type="button" onClick={() => { setReviewView('pending'); openTeacherSection('reviews') }}
                          className="inline-flex items-center gap-2 text-sm font-medium text-indigo-700 hover:text-indigo-900 mt-1">View all reviews <TeacherIcon name="arrow" className="h-4 w-4" /></button>
                      </div>
                    ) : (
                      <div className="flex items-start gap-3 rounded-xl border border-emerald-100 bg-emerald-50/60 px-4 py-4">
                        <TeacherIcon name="check" className="h-5 w-5 text-emerald-700 mt-0.5" />
                        <div><p className="text-sm font-semibold text-emerald-800">All writing reviews are up to date</p><p className="text-xs text-emerald-700 mt-1">New submissions will appear here automatically.</p></div>
                      </div>
                    )}
                  </section>
                  <section className="xl:col-span-2 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 shadow-sm">
                    <h2 className="text-base font-semibold text-slate-900">Assignment progress</h2>
                    <p className="text-sm text-slate-500 mt-1">Current active student assignments</p>
                    <div className="flex justify-between items-end gap-3 mt-6 mb-3">
                      <div><span className="text-4xl font-semibold tracking-tight text-slate-900">{overallHomeworkProgress.rate}%</span><p className="text-xs text-slate-500 mt-1">Completion rate</p></div>
                      <span className="text-sm font-medium text-slate-500">{overallHomeworkProgress.completed} / {overallHomeworkProgress.assigned}</span>
                    </div>
                    <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden"><div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${Math.max(0, Math.min(100, overallHomeworkProgress.rate))}%` }} /></div>
                    <div className="grid grid-cols-2 gap-3 mt-5">
                      <div className="rounded-xl border border-slate-100 bg-slate-50 p-3"><p className="text-xs text-slate-500">Not completed</p><p className="text-2xl font-semibold text-slate-800 mt-1">{overallHomeworkProgress.notCompleted}</p></div>
                      <div className="rounded-xl border border-amber-100 bg-amber-50/60 p-3"><p className="text-xs text-amber-700">Overdue</p><p className="text-2xl font-semibold text-amber-800 mt-1">{overallHomeworkProgress.overdue}</p></div>
                    </div>
                    <button type="button" onClick={() => openTeacherSection('analytics')}
                      className="inline-flex items-center gap-2 mt-5 text-sm text-indigo-700 font-medium hover:text-indigo-900">View detailed analytics <TeacherIcon name="arrow" className="h-4 w-4"/></button>
                  </section>
                </div>

                <section className="bg-white border border-slate-200 shadow-sm rounded-2xl p-5 sm:p-6">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-5">
                    <div><h2 className="text-base font-semibold text-slate-900">Quick actions</h2><p className="text-sm text-slate-500 mt-1">The actions teachers use most often</p></div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                    {[
                      { title: 'Create Reading', caption: 'Design a passage and questions', action: () => navigate('/create-reading'), icon: 'book' },
                      { title: 'Create Listening', caption: 'Upload audio and questions', action: () => navigate('/create-listening'), icon: 'book' },
                      { title: 'Content Library', caption: 'Find, preview and assign', action: () => openTeacherSection('library'), icon: 'library' },
                      { title: 'Manage Classes', caption: 'Organise teaching groups', action: () => navigate('/teacher/classes'), icon: 'classes' },
                    ].map(item => (
                      <button key={item.title} type="button" onClick={item.action}
                        className="flex gap-3 text-left rounded-xl border border-slate-200 p-4 hover:bg-indigo-50/50 hover:border-indigo-300 transition-colors">
                        <span className="shrink-0 rounded-lg bg-indigo-50 text-indigo-700 p-2"><TeacherIcon name={item.icon} className="w-5 h-5" /></span>
                        <span><span className="block text-sm font-semibold text-slate-900">{item.title}</span><span className="block text-xs text-slate-500 mt-1">{item.caption}</span></span>
                      </button>
                    ))}
                  </div>
                </section>
              </div>
            )}

        {activeTab === 'analytics' && (
          <>
            <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
              <div className="flex items-start justify-between gap-4 mb-5">
                <div>
                  <h2 className="font-semibold text-gray-800">
                    📚 Homework Completion Analytics
                  </h2>
                  <p className="text-xs text-gray-400 mt-1">
                    Completion is calculated from active student × homework assignments.
                  </p>
                </div>
                <span className="text-3xl font-bold text-purple-600">
                  {overallHomeworkProgress.rate}%
                </span>
              </div>

              <div className="w-full bg-gray-100 rounded-full h-3 overflow-hidden mb-5">
                <div
                  className="bg-purple-600 h-3 rounded-full"
                  style={{ width: `${overallHomeworkProgress.rate}%` }}
                />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
                <div className="bg-gray-50 rounded-xl p-4">
                  <p className="text-xs text-gray-400">Assigned</p>
                  <p className="text-2xl font-bold text-gray-800">{overallHomeworkProgress.assigned}</p>
                </div>
                <div className="bg-green-50 rounded-xl p-4">
                  <p className="text-xs text-gray-500">Completed</p>
                  <p className="text-2xl font-bold text-green-600">{overallHomeworkProgress.completed}</p>
                </div>
                <div className="bg-amber-50 rounded-xl p-4">
                  <p className="text-xs text-gray-500">Not completed</p>
                  <p className="text-2xl font-bold text-amber-600">{overallHomeworkProgress.notCompleted}</p>
                </div>
                <div className="bg-red-50 rounded-xl p-4">
                  <p className="text-xs text-gray-500">Overdue</p>
                  <p className="text-2xl font-bold text-red-600">{overallHomeworkProgress.overdue}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                {Object.entries(overallHomeworkProgress.types).map(([key, item]) => (
                  <div key={key} className="border border-gray-100 rounded-xl p-4">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <p className="text-xs font-semibold text-gray-600">{item.label}</p>
                      <p className="text-xs font-bold text-purple-600">{item.rate}%</p>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                      <div
                        className="bg-purple-600 h-2 rounded-full"
                        style={{ width: `${item.rate}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-gray-400 mt-2">
                      {item.completed}/{item.assigned} completed
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
              <div className="flex items-start justify-between gap-4 mb-5">
                <div>
                  <h2 className="font-semibold text-gray-800">
                    👤 Student Analytics
                  </h2>

                  <p className="text-xs text-gray-400 mt-1">
                    Select one student to see Reading, Listening and Vocabulary analytics separately.
                  </p>
                </div>

                <select
                  value={analyticsStudentId}
                  onChange={e => setAnalyticsStudentId(e.target.value)}
                  className="border border-gray-200 rounded-xl px-3 py-2 text-xs bg-white text-gray-600 outline-none focus:border-purple-400 min-w-[260px]"
                >
                  <option value="all">Select student</option>
                  {students.map(student => (
                    <option key={student.id} value={student.id}>
                      {student.name || student.email}
                    </option>
                  ))}
                </select>
              </div>

              {!selectedAnalyticsStudent ? (
                <div className="bg-gray-50 border border-gray-100 rounded-xl p-5 text-sm text-gray-400">
                  Choose a student from the list to view individual Reading, Listening and Vocabulary analytics.
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                    <div className="bg-gray-900 text-white rounded-2xl p-5">
                      <p className="text-xs text-gray-400 mb-1">
                        Student
                      </p>

                      <p className="text-lg font-bold truncate">
                        {selectedAnalyticsStudent.name || selectedAnalyticsStudent.email}
                      </p>

                      <p className="text-xs text-gray-400 mt-2 truncate">
                        {selectedAnalyticsStudent.email}
                      </p>
                    </div>

                    <div className="bg-blue-50 rounded-2xl p-5">
                      <p className="text-xs text-gray-500 mb-1">
                        Reading
                      </p>

                      <p className="text-3xl font-bold text-blue-600">
                        {selectedAnalyticsReadingStats?.rate || 0}%
                      </p>

                      <p className="text-xs text-gray-500 mt-2">
                        {selectedAnalyticsReadingStats?.completed || 0}/{selectedAnalyticsReadingStats?.assigned || 0} completed · Avg Band {selectedAnalyticsAverageReadingBand || '--'}
                      </p>
                    </div>

                    <div className="bg-purple-50 rounded-2xl p-5">
                      <p className="text-xs text-gray-500 mb-1">
                        Listening
                      </p>

                      <p className="text-3xl font-bold text-purple-600">
                        {selectedAnalyticsListeningStats?.rate || 0}%
                      </p>

                      <p className="text-xs text-gray-500 mt-2">
                        {selectedAnalyticsListeningStats?.completed || 0}/{selectedAnalyticsListeningStats?.assigned || 0} completed · Avg Band {selectedAnalyticsAverageListeningBand || '--'}
                      </p>
                    </div>

                    <div className="bg-green-50 rounded-2xl p-5">
                      <p className="text-xs text-gray-500 mb-1">
                        Vocabulary
                      </p>

                      <p className="text-3xl font-bold text-green-600">
                        {selectedAnalyticsVocabularyStats?.rate || 0}%
                      </p>

                      <p className="text-xs text-gray-500 mt-2">
                        {selectedAnalyticsVocabularyStats?.completed || 0}/{selectedAnalyticsVocabularyStats?.assigned || 0} completed · Avg Accuracy {selectedAnalyticsAverageVocabularyAccuracy ?? '--'}%
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                    <div className="bg-gray-50 rounded-2xl p-5">
                      <div className="flex items-start justify-between gap-3 mb-4">
                        <div>
                          <h3 className="text-sm font-semibold text-gray-700">
                            📖 Reading Analytics
                          </h3>
                          <p className="text-xs text-gray-400 mt-1">
                            Weakest area: {selectedAnalyticsWeakestReadingArea ? getReadingTypeLabel(selectedAnalyticsWeakestReadingArea.key) : '--'}
                          </p>
                        </div>
                        <span className="text-xs bg-blue-50 text-blue-600 px-3 py-1 rounded-full">
                          {selectedAnalyticsReadingSubmissions.length} submissions
                        </span>
                      </div>

                      {selectedAnalyticsReadingTypeAnalytics.length === 0 ? (
                        <p className="text-sm text-gray-400 bg-white rounded-xl p-4">
                          No completed reading homework yet.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-3 mb-5">
                          {selectedAnalyticsReadingTypeAnalytics.map(item => (
                            <div key={item.key}>
                              <div className="flex justify-between mb-1">
                                <p className="text-xs text-gray-500">
                                  {getReadingTypeLabel(item.key)}
                                </p>
                                <p className={`text-xs font-semibold ${getAnalyticsColor(item.percentage)}`}>
                                  {item.percentage === null ? '--' : `${item.percentage}%`}
                                </p>
                              </div>
                              <div className="w-full bg-white rounded-full h-2 overflow-hidden">
                                <div
                                  className="bg-blue-600 h-2 rounded-full"
                                  style={{ width: `${item.percentage || 0}%` }}
                                />
                              </div>
                              <p className="text-[10px] text-gray-400 mt-1">
                                {item.correct}/{item.total} correct
                              </p>
                            </div>
                          ))}
                        </div>
                      )}

                      <h4 className="text-xs font-semibold text-gray-500 mb-2">
                        Most Missed Reading Questions
                      </h4>
                      {selectedAnalyticsMostMissedReadingQuestions.length === 0 ? (
                        <p className="text-xs text-gray-400 bg-white rounded-xl p-3">
                          No missed-question data yet.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-2">
                          {selectedAnalyticsMostMissedReadingQuestions.map(item => (
                            <div key={item.label} className="bg-white rounded-xl p-3 flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-xs font-medium text-gray-700 truncate">
                                  {item.label}
                                </p>
                                <p className="text-[10px] text-gray-400">
                                  {item.wrong}/{item.total} wrong
                                </p>
                              </div>
                              <span className="text-xs bg-red-50 text-red-600 px-2 py-1 rounded-full font-semibold">
                                {item.wrongRate}%
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="bg-gray-50 rounded-2xl p-5">
                      <div className="flex items-start justify-between gap-3 mb-4">
                        <div>
                          <h3 className="text-sm font-semibold text-gray-700">
                            🎧 Listening Analytics
                          </h3>
                          <p className="text-xs text-gray-400 mt-1">
                            Weakest area: {selectedAnalyticsWeakestListeningArea ? getListeningTypeLabel(selectedAnalyticsWeakestListeningArea.key) : '--'}
                          </p>
                        </div>
                        <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
                          {selectedAnalyticsListeningSubmissions.length} submissions
                        </span>
                      </div>

                      {selectedAnalyticsListeningTypeAnalytics.length === 0 ? (
                        <p className="text-sm text-gray-400 bg-white rounded-xl p-4">
                          No completed listening homework yet.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-3 mb-5">
                          {selectedAnalyticsListeningTypeAnalytics.map(item => (
                            <div key={item.key}>
                              <div className="flex justify-between mb-1">
                                <p className="text-xs text-gray-500">
                                  {getListeningTypeLabel(item.key)}
                                </p>
                                <p className={`text-xs font-semibold ${getAnalyticsColor(item.percentage)}`}>
                                  {item.percentage === null ? '--' : `${item.percentage}%`}
                                </p>
                              </div>
                              <div className="w-full bg-white rounded-full h-2 overflow-hidden">
                                <div
                                  className="bg-purple-600 h-2 rounded-full"
                                  style={{ width: `${item.percentage || 0}%` }}
                                />
                              </div>
                              <p className="text-[10px] text-gray-400 mt-1">
                                {item.correct}/{item.total} correct
                              </p>
                            </div>
                          ))}
                        </div>
                      )}

                      <h4 className="text-xs font-semibold text-gray-500 mb-2">
                        Most Missed Listening Questions
                      </h4>
                      {selectedAnalyticsMostMissedListeningQuestions.length === 0 ? (
                        <p className="text-xs text-gray-400 bg-white rounded-xl p-3">
                          No missed-question data yet.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-2">
                          {selectedAnalyticsMostMissedListeningQuestions.map(item => (
                            <div key={item.label} className="bg-white rounded-xl p-3 flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-xs font-medium text-gray-700 truncate">
                                  {item.label}
                                </p>
                                <p className="text-[10px] text-gray-400">
                                  {item.wrong}/{item.total} wrong
                                </p>
                              </div>
                              <span className="text-xs bg-red-50 text-red-600 px-2 py-1 rounded-full font-semibold">
                                {item.wrongRate}%
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="bg-gray-50 rounded-2xl p-5">
                      <div className="flex items-start justify-between gap-3 mb-4">
                        <div>
                          <h3 className="text-sm font-semibold text-gray-700">
                            🧩 Vocabulary Analytics
                          </h3>
                          <p className="text-xs text-gray-400 mt-1">
                            Average accuracy: {selectedAnalyticsAverageVocabularyAccuracy ?? '--'}%
                          </p>
                        </div>
                        <span className="text-xs bg-green-50 text-green-600 px-3 py-1 rounded-full">
                          {selectedAnalyticsVocabularySubmissions.length} submissions
                        </span>
                      </div>

                      {selectedAnalyticsVocabularyPerformance.length === 0 ? (
                        <p className="text-sm text-gray-400 bg-white rounded-xl p-4">
                          No completed vocabulary test yet.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-2 mb-5">
                          {selectedAnalyticsVocabularyPerformance.map(item => (
                            <div key={item.id} className="bg-white rounded-xl p-3 flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-xs font-medium text-gray-700 truncate">
                                  {item.title}
                                </p>
                                <p className="text-[10px] text-gray-400">
                                  {item.correct}/{item.total} correct · {formatDateShort(item.submittedAt)}
                                </p>
                              </div>
                              <span className={`text-xs px-2 py-1 rounded-full font-semibold ${item.percentage >= 70 ? 'bg-green-100 text-green-700' : item.percentage >= 50 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                                {item.percentage ?? '--'}%
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      <h4 className="text-xs font-semibold text-gray-500 mb-2">
                        Most Missed Vocabulary Questions
                      </h4>
                      {selectedAnalyticsMostMissedVocabularyQuestions.length === 0 ? (
                        <p className="text-xs text-gray-400 bg-white rounded-xl p-3">
                          No missed vocabulary questions yet.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-2">
                          {selectedAnalyticsMostMissedVocabularyQuestions.map(item => (
                            <div key={item.label} className="bg-white rounded-xl p-3 flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="text-xs font-medium text-gray-700 truncate">
                                  {item.label}
                                </p>
                                <p className="text-[10px] text-gray-400 truncate">
                                  {item.question || `${item.wrong}/${item.total} wrong`}
                                </p>
                              </div>
                              <span className="text-xs bg-red-50 text-red-600 px-2 py-1 rounded-full font-semibold">
                                {item.wrongRate}%
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {activeTab === 'communication' && (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-[0.95fr_1.05fr] gap-6 mb-8">
              <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
                <div className="flex items-start justify-between gap-4 mb-5">
                  <div>
                    <h2 className="font-semibold text-gray-800">
                      💬 Send to Students
                    </h2>
                    <p className="text-xs text-gray-400 mt-1">
                      Send a message or share a lesson file with one student or a whole class.
                    </p>
                  </div>

                  <div className="flex bg-gray-100 rounded-xl p-1">
                    <button
                      type="button"
                      onClick={() => setCommunicationMode('message')}
                      className={`px-3 py-2 rounded-lg text-xs font-medium ${communicationMode === 'message' ? 'bg-white text-purple-600 shadow-sm' : 'text-gray-500'}`}
                    >
                      Message
                    </button>
                    <button
                      type="button"
                      onClick={() => setCommunicationMode('material')}
                      className={`px-3 py-2 rounded-lg text-xs font-medium ${communicationMode === 'material' ? 'bg-white text-purple-600 shadow-sm' : 'text-gray-500'}`}
                    >
                      Material
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Send to</label>
                    <select
                      value={communicationAudience}
                      onChange={e => {
                        setCommunicationAudience(e.target.value)
                        setCommunicationStudentId('')
                        setCommunicationClassId('')
                      }}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm bg-white outline-none focus:border-purple-400"
                    >
                      <option value="student">Individual student</option>
                      <option value="class">Class</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">
                      {communicationAudience === 'student' ? 'Student' : 'Class'}
                    </label>
                    {communicationAudience === 'student' ? (
                      <select
                        value={communicationStudentId}
                        onChange={e => setCommunicationStudentId(e.target.value)}
                        className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm bg-white outline-none focus:border-purple-400"
                      >
                        <option value="">Select student</option>
                        {students.map(student => (
                          <option key={student.id} value={student.id}>
                            {student.name || student.email}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <select
                        value={communicationClassId}
                        onChange={e => setCommunicationClassId(e.target.value)}
                        className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm bg-white outline-none focus:border-purple-400"
                      >
                        <option value="">Select class</option>
                        {classes.map(classItem => (
                          <option key={classItem.id} value={classItem.id}>
                            {classItem.name} ({classItem.studentIds?.length || 0})
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>

                <div className="mb-4">
                  <label className="text-xs text-gray-400 mb-1 block">Title</label>
                  <input
                    value={communicationTitle}
                    onChange={e => setCommunicationTitle(e.target.value)}
                    placeholder={communicationMode === 'message' ? 'Homework reminder' : 'Unit 3 lesson notes'}
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400"
                  />
                </div>

                <div className="mb-4">
                  <label className="text-xs text-gray-400 mb-1 block">
                    {communicationMode === 'message' ? 'Message' : 'Description / note'}
                  </label>
                  <textarea
                    rows={5}
                    value={communicationBody}
                    onChange={e => setCommunicationBody(e.target.value)}
                    placeholder={communicationMode === 'message' ? 'Write your message...' : 'Optional note about this material...'}
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm outline-none focus:border-purple-400 resize-y"
                  />
                </div>

                {communicationMode === 'material' && (
                  <div className="mb-4">
                    <label className="text-xs text-gray-400 mb-1 block">File</label>
                    <input
                      key={materialFile?.name || 'material-file-empty'}
                      type="file"
                      accept=".pdf,.doc,.docx,.ppt,.pptx,.png,.jpg,.jpeg,.webp,.txt"
                      onChange={e => setMaterialFile(e.target.files?.[0] || null)}
                      className="w-full border border-dashed border-purple-200 bg-purple-50 rounded-xl px-4 py-4 text-sm text-gray-600"
                    />
                    <p className="text-[11px] text-gray-400 mt-2">
                      PDF, Word, PowerPoint, image or text file · maximum 25 MB
                    </p>
                  </div>
                )}

                {communicationStatus && (
                  <div className={`text-sm rounded-xl px-4 py-3 mb-4 ${communicationStatus.includes('✓') ? 'bg-green-50 text-green-600' : communicationStatus.includes('Could not') ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
                    {communicationStatus}
                  </div>
                )}

                <button
                  type="button"
                  onClick={communicationMode === 'message' ? sendTeacherMessage : sendTeacherMaterial}
                  disabled={communicationSaving}
                  className="w-full bg-purple-600 text-white rounded-xl py-3.5 text-sm font-medium hover:bg-purple-700 disabled:opacity-60"
                >
                  {communicationSaving
                    ? communicationMode === 'message' ? 'Sending...' : 'Uploading...'
                    : communicationMode === 'message' ? 'Send Message' : 'Upload & Send Material'}
                </button>
              </div>

              <div className="space-y-6">
                <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="font-semibold text-gray-800">Recent Messages</h2>
                    <span className="text-xs bg-gray-100 text-gray-500 px-3 py-1 rounded-full">
                      {teacherMessages.length}
                    </span>
                  </div>

                  {teacherMessages.length === 0 ? (
                    <p className="text-sm text-gray-400">No messages sent yet.</p>
                  ) : (
                    <div className="space-y-3 max-h-[360px] overflow-y-auto pr-1">
                      {teacherMessages.slice(0, 20).map(message => (
                        <div key={message.id} className="border border-gray-100 rounded-xl p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-gray-800">{message.title}</p>
                              <p className="text-xs text-purple-600 mt-1 truncate">
                                To: {message.className || message.recipientNames?.join(', ') || 'Student'}
                              </p>
                              <p className="text-sm text-gray-600 mt-2 whitespace-pre-wrap">{message.body}</p>
                              <p className="text-[11px] text-gray-400 mt-2">
                                {message.createdAt ? new Date(message.createdAt).toLocaleString() : ''} · Read by {message.readBy?.length || 0}/{message.recipientIds?.length || 0}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => deleteTeacherMessage(message)}
                              className="text-xs text-red-500 hover:text-red-700"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="font-semibold text-gray-800">Shared Materials</h2>
                    <span className="text-xs bg-gray-100 text-gray-500 px-3 py-1 rounded-full">
                      {teacherMaterials.length}
                    </span>
                  </div>

                  {teacherMaterials.length === 0 ? (
                    <p className="text-sm text-gray-400">No materials shared yet.</p>
                  ) : (
                    <div className="space-y-3 max-h-[360px] overflow-y-auto pr-1">
                      {teacherMaterials.slice(0, 20).map(material => (
                        <div key={material.id} className="border border-gray-100 rounded-xl p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-gray-800">📎 {material.title}</p>
                              <div className="mt-1">
                                <p className="text-xs text-gray-400 mb-1">Shared with:</p>
                                <div className="flex flex-wrap gap-1.5">
                                  {getMaterialShareLabels(material).length > 0 ? (
                                    getMaterialShareLabels(material).map(label => (
                                      <span
                                        key={label}
                                        className="text-[11px] bg-purple-50 text-purple-600 px-2 py-1 rounded-full"
                                      >
                                        {label}
                                      </span>
                                    ))
                                  ) : (
                                    <span className="text-[11px] text-gray-400">Student</span>
                                  )}
                                </div>
                              </div>
                              <p className="text-xs text-gray-400 mt-2 truncate">{material.fileName}</p>
                              <p className="text-[11px] text-gray-500 mt-1">
                                Opened by {getMaterialReadCount(material)}/{uniqueCleanValues(Array.isArray(material.recipientIds) ? material.recipientIds : []).length}
                              </p>
                              {material.description && (
                                <p className="text-sm text-gray-600 mt-2 whitespace-pre-wrap">{material.description}</p>
                              )}
                            </div>
                            <div className="flex gap-2 flex-shrink-0">
                              <button
                                type="button"
                                onClick={() => openTeacherMaterial(material)}
                                className="text-xs bg-purple-50 text-purple-600 px-3 py-2 rounded-lg hover:bg-purple-100"
                              >
                                Open
                              </button>
                              <button
                                type="button"
                                onClick={() => openMaterialShareAgain(material)}
                                className="text-xs bg-blue-50 text-blue-600 px-3 py-2 rounded-lg hover:bg-blue-100"
                              >
                                Share Again
                              </button>
                              <button
                                type="button"
                                onClick={() => deleteTeacherMaterial(material)}
                                className="text-xs bg-red-50 text-red-500 px-3 py-2 rounded-lg hover:bg-red-100"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {materialShareTarget && (
              <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4">
                <div className="bg-white rounded-2xl w-full max-w-lg p-6 shadow-xl">
                  <div className="flex items-start justify-between gap-4 mb-5">
                    <div>
                      <p className="text-xs font-semibold text-purple-600 uppercase tracking-wider mb-1">
                        Reuse Material
                      </p>
                      <h2 className="text-lg font-bold text-gray-900">
                        {materialShareTarget.title}
                      </h2>
                      <p className="text-xs text-gray-400 mt-1 truncate">
                        {materialShareTarget.fileName}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={closeMaterialShareAgain}
                      disabled={materialShareSaving}
                      className="text-sm text-gray-400 hover:text-gray-600 disabled:opacity-50"
                    >
                      Close
                    </button>
                  </div>

                  <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 mb-5">
                    <p className="text-sm text-blue-700 font-medium">
                      The existing file will be reused. It will not be uploaded again.
                    </p>
                    <p className="text-xs text-blue-600 mt-1">
                      Students in the new class will get access to the same PDF or lesson file.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
                    <div>
                      <label className="text-xs text-gray-400 mb-1 block">Share with</label>
                      <select
                        value={materialShareAudience}
                        onChange={e => {
                          setMaterialShareAudience(e.target.value)
                          setMaterialShareStudentId('')
                          setMaterialShareClassId('')
                          setMaterialShareStatus('')
                        }}
                        className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm bg-white outline-none focus:border-purple-400"
                      >
                        <option value="class">Class</option>
                        <option value="student">Individual student</option>
                      </select>
                    </div>

                    <div>
                      <label className="text-xs text-gray-400 mb-1 block">
                        {materialShareAudience === 'class' ? 'Class' : 'Student'}
                      </label>

                      {materialShareAudience === 'class' ? (
                        <select
                          value={materialShareClassId}
                          onChange={e => {
                            setMaterialShareClassId(e.target.value)
                            setMaterialShareStatus('')
                          }}
                          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm bg-white outline-none focus:border-purple-400"
                        >
                          <option value="">Select class</option>
                          {classes.map(classItem => (
                            <option key={classItem.id} value={classItem.id}>
                              {classItem.name} ({classItem.studentIds?.length || 0})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <select
                          value={materialShareStudentId}
                          onChange={e => {
                            setMaterialShareStudentId(e.target.value)
                            setMaterialShareStatus('')
                          }}
                          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm bg-white outline-none focus:border-purple-400"
                        >
                          <option value="">Select student</option>
                          {students.map(student => (
                            <option key={student.id} value={student.id}>
                              {student.name || student.email}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>

                  {materialShareStatus && (
                    <div className={`text-sm rounded-xl px-4 py-3 mb-4 ${materialShareStatus.includes('✓') ? 'bg-green-50 text-green-600' : materialShareStatus.includes('Could not') ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
                      {materialShareStatus}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={shareExistingMaterial}
                    disabled={materialShareSaving}
                    className="w-full bg-purple-600 text-white rounded-xl py-3.5 text-sm font-medium hover:bg-purple-700 disabled:opacity-60"
                  >
                    {materialShareSaving ? 'Sharing...' : 'Share Existing Material'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === 'reviews' && (
          <>
            <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <nav aria-label="Review status" className="inline-flex rounded-xl border border-slate-200 bg-white p-1.5 gap-1 self-start">
                <button type="button" onClick={() => setReviewView('pending')}
                  className={`rounded-lg px-4 py-2.5 text-sm font-medium ${reviewView === 'pending' ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                  Pending <span className="ml-1 opacity-80">({totalPendingWritingReviews})</span>
                </button>
                <button type="button" onClick={() => setReviewView('reviewed')}
                  className={`rounded-lg px-4 py-2.5 text-sm font-medium ${reviewView === 'reviewed' ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                  Reviewed <span className="ml-1 opacity-80">({allReviewCount})</span>
                </button>
              </nav>
              <p className="text-xs text-slate-500">Task 1 / Task 2 rubrics and Mock Writing grading are unchanged.</p>
            </div>
            {reviewView === 'pending' && (<>)
<div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Pending Writing Reviews
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Essays submitted by students but not graded yet. Click Grade Now to open the review screen directly.
              </p>
            </div>

            <span className={`text-xs px-3 py-1.5 rounded-full ${
              pendingWritingReviews.length > 0
                ? 'bg-amber-50 text-amber-600'
                : 'bg-green-50 text-green-600'
            }`}>
              {pendingWritingReviews.length > 0
                ? `${pendingWritingReviews.length} pending`
                : 'All caught up'}
            </span>
          </div>

          {pendingWritingReviews.length === 0 ? (
            <div className="bg-green-50 text-green-700 rounded-xl p-4 text-sm">
              ✅ No pending writing reviews right now.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {pendingWritingReviews.slice(0, 6).map(item => (
                <div
                  key={item.submission.id}
                  className="border border-amber-100 bg-amber-50/40 rounded-xl p-4 flex items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {item.student.name}
                    </p>

                    <p className="text-xs text-gray-500 mt-0.5">
                      {item.writing.title} · Submitted {formatDateShort(item.submission.submittedAt)}
                    </p>

                    <p className="text-xs text-gray-400 mt-1">
                      {getWritingSubmissionWordSummary(item.writing, item.submission)}
                    </p>
                  </div>

                  <button
                    onClick={() => openWritingReview(item)}
                    className="text-xs bg-purple-600 text-white px-4 py-2 rounded-xl hover:bg-purple-700"
                  >
                    Grade Now
                  </button>
                </div>
              ))}

              {pendingWritingReviews.length > 6 && (
                <p className="text-xs text-gray-400 text-center pt-2">
                  Showing latest 6 pending reviews. Use the Pending Review filter in Writing Homework Library for the full list.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Pending Mock Writing Reviews
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Writing sections submitted inside full mock tests.
              </p>
            </div>

            <span className={`text-xs px-3 py-1.5 rounded-full ${
              pendingMockWritingReviews.length > 0
                ? 'bg-amber-50 text-amber-600'
                : 'bg-green-50 text-green-600'
            }`}>
              {pendingMockWritingReviews.length > 0
                ? `${pendingMockWritingReviews.length} pending`
                : 'All caught up'}
            </span>
          </div>

          {pendingMockWritingReviews.length === 0 ? (
            <div className="bg-green-50 text-green-700 rounded-xl p-4 text-sm">
              ✅ No pending mock writing reviews right now.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {pendingMockWritingReviews.slice(0, 8).map(item => (
                <div
                  key={item.submission.id}
                  className="border border-purple-100 bg-purple-50/40 rounded-xl p-4 flex items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {item.student.name}
                    </p>

                    <p className="text-xs text-gray-500 mt-0.5">
                      {item.mock?.title || item.submission.mockTitle || 'Mock Test'} · Submitted {formatDateShort(item.submission.submittedAt)}
                    </p>

                    <p className="text-xs text-gray-400 mt-1">
                      Task 1: {getMockTask1WordCount(item.submission) || 0} words · Task 2: {getMockTask2WordCount(item.submission) || 0} words
                    </p>
                  </div>

                  <button
                    onClick={() => openMockWritingReview(item)}
                    className="text-xs bg-purple-600 text-white px-4 py-2 rounded-xl hover:bg-purple-700"
                  >
                    Grade Mock
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

            </>)}
            {reviewView === 'reviewed' && (<>)
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Reviewed Writing Reviews
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Previously graded writing homework. Click Edit Review to update scores, rubric or feedback.
              </p>
            </div>

            <span className="text-xs bg-green-50 text-green-600 px-3 py-1.5 rounded-full">
              {reviewedWritingReviews.length} reviewed
            </span>
          </div>

          {reviewedWritingReviews.length === 0 ? (
            <div className="bg-gray-50 text-gray-500 rounded-xl p-4 text-sm">
              No reviewed writing homework yet.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {reviewedWritingReviews.slice(0, 10).map(item => (
                <div
                  key={item.submission.id}
                  className="border border-green-100 bg-green-50/40 rounded-xl p-4 flex items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {item.student.name}
                    </p>

                    <p className="text-xs text-gray-500 mt-0.5">
                      {item.writing.title} · Reviewed {formatDateShort(item.submission.reviewedAt || item.submission.submittedAt)}
                    </p>

                    <p className="text-xs text-gray-400 mt-1">
                      {getWritingTaskLabel(item.writing, item.submission)} · Overall Band {item.submission.review?.overall || '-'}
                    </p>
                  </div>

                  <button
                    onClick={() => openWritingReview(item)}
                    className="text-xs bg-green-600 text-white px-4 py-2 rounded-xl hover:bg-green-700"
                  >
                    Edit Review
                  </button>
                </div>
              ))}

              {reviewedWritingReviews.length > 10 && (
                <p className="text-xs text-gray-400 text-center pt-2">
                  Showing latest 10 reviewed writing homework submissions.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Reviewed Mock Writing Reviews
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Previously graded mock writing sections. Click Edit Mock Review to update the writing band and final mock overall.
              </p>
            </div>

            <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1.5 rounded-full">
              {reviewedMockWritingReviews.length} reviewed
            </span>
          </div>

          {reviewedMockWritingReviews.length === 0 ? (
            <div className="bg-gray-50 text-gray-500 rounded-xl p-4 text-sm">
              No reviewed mock writing yet.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {reviewedMockWritingReviews.slice(0, 10).map(item => (
                <div
                  key={item.submission.id}
                  className="border border-purple-100 bg-purple-50/40 rounded-xl p-4 flex items-center justify-between gap-4"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-800">
                      {item.student.name}
                    </p>

                    <p className="text-xs text-gray-500 mt-0.5">
                      {item.mock?.title || item.submission.mockTitle || 'Mock Test'} · Reviewed {formatDateShort(item.submission.reviewedAt || item.submission.submittedAt)}
                    </p>

                    <p className="text-xs text-gray-400 mt-1">
                      Writing Band {item.submission.result?.writing?.band || item.submission.writingReview?.overall || '-'} · Overall {item.submission.result?.overall || item.submission.result?.overallEstimate || '-'}
                    </p>
                  </div>

                  <button
                    onClick={() => openMockWritingReview(item)}
                    className="text-xs bg-purple-600 text-white px-4 py-2 rounded-xl hover:bg-purple-700"
                  >
                    Edit Mock Review
                  </button>
                </div>
              ))}

              {reviewedMockWritingReviews.length > 10 && (
                <p className="text-xs text-gray-400 text-center pt-2">
                  Showing latest 10 reviewed mock writing submissions.
                </p>
              )}
            </div>
          )}
        </div>


            </>)}
          </>
        )}

        {activeTab === 'reading' && (
          <>
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Reading Homework Library
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Reuse, duplicate, assign, unassign, archive or delete reading homework.
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap justify-end">
              {[
                ['active', `Active (${activeReadings.length})`],
                ['archived', `Archived (${archivedReadings.length})`],
                ['all', `All (${readings.length})`]
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setReadingLibraryFilter(key)}
                  className={`text-xs px-3 py-1.5 rounded-full ${
                    readingLibraryFilter === key
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-3 mb-4">
            <select
              value={readingVisibilityFilter}
              onChange={e => setReadingVisibilityFilter(e.target.value)}
              className={librarySelectClass}
            >
              <option value="all">All Libraries</option>
              <option value="private">My Library</option>
              <option value="school">School Library</option>
            </select>

            <select
              value={readingContentTypeFilter}
              onChange={e => setReadingContentTypeFilter(e.target.value)}
              className={librarySelectClass}
            >
              <option value="all">All Reading Types</option>
              <option value="full_reading">Full Reading</option>
              <option value="short_reading">Short Reading</option>
              <option value="mini_reading">Mini Reading</option>
              <option value="passage_practice">Passage Practice</option>
              <option value="reading_skill">Skill Practice</option>
            </select>
          </div>

          {filteredReadings.filter(contentSearchMatch).length === 0 ? (
            <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
              No reading homework found for this filter.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredReadings.filter(contentSearchMatch).map((reading, index) =>
                renderReadingHomeworkCard(reading, reading.archived, index)
              )}
            </div>
          )}
        </div>


          </>
        )}

        {activeTab === 'listening' && (
          <>
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Listening Homework Library
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Reuse, duplicate, assign, unassign, archive or delete listening homework.
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap justify-end">
              {[
                ['active', `Active (${activeListenings.length})`],
                ['archived', `Archived (${archivedListenings.length})`],
                ['all', `All (${listenings.length})`]
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setListeningLibraryFilter(key)}
                  className={`text-xs px-3 py-1.5 rounded-full ${
                    listeningLibraryFilter === key
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-3 mb-4">
            <select
              value={listeningVisibilityFilter}
              onChange={e => setListeningVisibilityFilter(e.target.value)}
              className={librarySelectClass}
            >
              <option value="all">All Libraries</option>
              <option value="private">My Library</option>
              <option value="school">School Library</option>
            </select>

            <select
              value={listeningContentTypeFilter}
              onChange={e => setListeningContentTypeFilter(e.target.value)}
              className={librarySelectClass}
            >
              <option value="all">All Listening Types</option>
              <option value="full_listening">Full Listening</option>
              <option value="part_1">Part 1</option>
              <option value="part_2">Part 2</option>
              <option value="part_3">Part 3</option>
              <option value="part_4">Part 4</option>
              <option value="mini_listening">Mini Listening</option>
              <option value="short_listening">Short Practice</option>
              <option value="listening_skill">Skill Practice</option>
            </select>
          </div>

          {filteredListenings.filter(contentSearchMatch).length === 0 ? (
            <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
              No listening homework found for this filter.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredListenings.filter(contentSearchMatch).map((listening, index) =>
                renderListeningHomeworkCard(listening, listening.archived, index)
              )}
            </div>
          )}
        </div>

          </>
        )}

        {activeTab === 'vocabulary' && (
          <>
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Vocabulary Test Library
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Create, reuse, assign, archive or delete multiple choice vocabulary tests.
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap justify-end">
              {[
                ['active', `Active (${activeVocabularyTests.length})`],
                ['archived', `Archived (${archivedVocabularyTests.length})`],
                ['all', `All (${vocabularyTests.length})`]
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setVocabularyLibraryFilter(key)}
                  className={`text-xs px-3 py-1.5 rounded-full ${
                    vocabularyLibraryFilter === key
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-3 mb-4">
            <select
              value={vocabularyVisibilityFilter}
              onChange={e => setVocabularyVisibilityFilter(e.target.value)}
              className={librarySelectClass}
            >
              <option value="all">All Libraries</option>
              <option value="private">My Library</option>
              <option value="school">School Library</option>
            </select>

            <select
              value={vocabularyContentTypeFilter}
              onChange={e => setVocabularyContentTypeFilter(e.target.value)}
              className={librarySelectClass}
            >
              <option value="all">All Vocabulary Types</option>
              <option value="vocabulary_quiz">Vocabulary Quiz</option>
              <option value="word_set">Word Set</option>
              <option value="mixed_practice">Mixed Practice</option>
              <option value="topic_vocabulary">Topic Vocabulary</option>
              <option value="academic_vocabulary">Academic Vocabulary</option>
            </select>
          </div>

          {filteredVocabularyTests.filter(contentSearchMatch).length === 0 ? (
            <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
              No vocabulary tests found for this filter.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredVocabularyTests.filter(contentSearchMatch).map((vocabularyTest, index) =>
                renderVocabularyHomeworkCard(vocabularyTest, vocabularyTest.archived, index)
              )}
            </div>
          )}
        </div>

          </>
        )}

        {activeTab === 'writing' && (
          <>
        <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold text-gray-800">
                Writing Homework Library
              </h2>

              <p className="text-xs text-gray-400 mt-1">
                Review Task 1 and Task 2 submissions, manage assignments and archive writing homework.
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap justify-end">
              {[
                ['active', `Active (${activeWritings.length})`],
                ['pending', `Pending Review (${pendingReviewWritings.length})`],
                ['archived', `Archived (${archivedWritings.length})`],
                ['all', `All (${writings.length})`]
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setWritingLibraryFilter(key)}
                  className={`text-xs px-3 py-1.5 rounded-full ${
                    writingLibraryFilter === key
                      ? 'bg-purple-600 text-white'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap gap-3 mb-4">
            <select
              value={writingVisibilityFilter}
              onChange={e => setWritingVisibilityFilter(e.target.value)}
              className={librarySelectClass}
            >
              <option value="all">All Libraries</option>
              <option value="private">My Library</option>
              <option value="school">School Library</option>
            </select>

            <select
              value={writingContentTypeFilter}
              onChange={e => setWritingContentTypeFilter(e.target.value)}
              className={librarySelectClass}
            >
              <option value="all">All Writing Types</option>
              <option value="full_writing">Full Writing</option>
              <option value="task1_only">Task 1 Only</option>
              <option value="task2_only">Task 2 Only</option>
            </select>
          </div>

          {filteredWritings.filter(contentSearchMatch).length === 0 ? (
            <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
              No writing homework found for this filter.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {filteredWritings.filter(contentSearchMatch).map((writing, index) =>
                renderWritingHomeworkCard(writing, writing.archived, index)
              )}
            </div>
          )}
        </div>


          </>
        )}

        {activeTab === 'mock' && (
          <>
            <div className="bg-white border border-gray-100 rounded-2xl p-6 mb-8">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="font-semibold text-gray-800">
                    Mock Test Library
                  </h2>

                  <p className="text-xs text-gray-400 mt-1">
                    Manage Full Mock and Mini Mock tests and monitor student submissions.
                  </p>
                </div>

                <select
                  value={mockVisibilityFilter}
                  onChange={e => setMockVisibilityFilter(e.target.value)}
                  className={librarySelectClass}
                >
                  <option value="all">All Libraries</option>
                  <option value="private">My Library</option>
                  <option value="school">School Library</option>
                </select>

                <select
                  value={mockContentTypeFilter}
                  onChange={e => setMockContentTypeFilter(e.target.value)}
                  className={librarySelectClass}
                >
                  <option value="all">All Mock Types</option>
                  <option value="full_mock">Full Mock</option>
                  <option value="mini_mock">Mini Mock</option>
                  <option value="reading_mock">Reading Mock</option>
                  <option value="listening_mock">Listening Mock</option>
                  <option value="writing_mock">Writing Mock</option>
                </select>

                <button
                  onClick={() => navigate('/create-mock')}
                  className="text-xs bg-green-600 text-white px-4 py-2 rounded-xl hover:bg-green-700"
                >
                  + Create Mock Test
                </button>
              </div>

              {filteredActiveMockTests.filter(contentSearchMatch).length === 0 ? (
                <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
                  No active mock tests found yet.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {filteredActiveMockTests.filter(contentSearchMatch).map((mockTest, index) => renderMockTestCard(mockTest, false, index))}
                </div>
              )}

              {filteredArchivedMockTests.length > 0 && (
                <div className="mt-8">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">
                    Archived Mock Tests
                  </h3>

                  <div className="flex flex-col gap-3">
                    {filteredArchivedMockTests.filter(contentSearchMatch).map((mockTest, index) => renderMockTestCard(mockTest, true, index))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {activeTab === 'students' && (
          <>
            <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm">
              <div className="flex flex-col md:flex-row md:items-end gap-3">
                <div className="flex-1 min-w-0">
                  <label htmlFor="teacher-v2-student-search" className="block text-xs font-semibold text-slate-600 mb-2">Find a student</label>
                  <div className="relative">
                    <TeacherIcon name="search" className="absolute h-4 w-4 left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input id="teacher-v2-student-search" value={studentSearchTerm} onChange={event => setStudentSearchTerm(event.target.value)}
                      placeholder="Name, email or username" className="w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-200" />
                  </div>
                </div>
                <div className="w-full md:w-60">
                  <label htmlFor="teacher-v2-class-filter" className="block text-xs font-semibold text-slate-600 mb-2">Class</label>
                  <select id="teacher-v2-class-filter" value={studentClassId} onChange={event => setStudentClassId(event.target.value)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-200">
                    <option value="all">All students</option>
                    {classes.map(item => <option key={item.id} value={item.id}>{item.name || 'Unnamed class'}</option>)}
                  </select>
                </div>
                <p className="text-xs text-slate-500 pb-2 whitespace-nowrap">{filteredTeacherStudents.length} of {students.length} students</p>
              </div>
            </div>
        <div className="grid grid-cols-1 gap-4">
          {filteredTeacherStudents.length === 0 && (
            <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center text-gray-400 text-sm">
              {students.length === 0 ? 'No students are assigned yet.' : 'No students match the selected filters.'}
            </div>
          )}

          {filteredTeacherStudents.map(student => {
            // The collapsed rows must not recalculate full homework/analytics.
            const detailsOpen = selected?.id === student.id && selectedStudentSection === 'homework'
            const studentReadings = detailsOpen ? getStudentReadings(student.id) : []
            const studentWritings = detailsOpen ? getStudentWritings(student.id) : []
            const studentListenings = detailsOpen ? getStudentListenings(student.id) : []
            const studentVocabularyTests = detailsOpen ? getStudentVocabularyTests(student.id) : []
            const analytics = detailsOpen ? getStudentAnalytics(student.id) : null
            const homeworkProgress = homeworkProgressById.get(student.id) || {
              assigned: 0, completed: 0, notCompleted: 0, overdue: 0, rate: 0, types: {}
            }
            const latestMock = latestMockSubmission(student.id)

            return (
              <div
                key={student.id}
                className="bg-white border border-gray-100 rounded-2xl overflow-hidden"
              >
                <div
                  className="flex items-center justify-between p-5 cursor-pointer hover:bg-gray-50"
                  onClick={() => {
                    const isOpen = selected?.id === student.id
                    setSelected(isOpen ? null : student)
                    setSelectedStudentSection('mock')
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 font-semibold text-sm">
                      {student.name?.charAt(0).toUpperCase()}
                    </div>

                    <div>
                      <p className="text-sm font-medium text-gray-800">
                        {student.name}
                      </p>

                      <p className="text-xs text-gray-400">
                        {student.email}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {latestMock && (
                      <div className="text-right">
                        <p className="text-xs text-gray-400">
                          Latest {getMockTypeLabelForSubmission(latestMock)}
                        </p>
                        <p className="text-lg font-bold text-purple-600">
                          {formatBand(getMockOverall(latestMock))}
                        </p>
                      </div>
                    )}

                    <div className="min-w-[170px]">
                      <div className="flex items-center justify-between gap-3 mb-1">
                        <p className="text-xs text-gray-400">Homework completion</p>
                        <p className="text-sm font-bold text-purple-600">
                          {homeworkProgress.rate}%
                        </p>
                      </div>
                      <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                        <div
                          className="bg-purple-600 h-2 rounded-full"
                          style={{ width: `${homeworkProgress.rate}%` }}
                        />
                      </div>
                      <p className="text-[11px] text-gray-400 mt-1">
                        {homeworkProgress.completed}/{homeworkProgress.assigned} completed
                      </p>
                    </div>

                    <div className="text-right min-w-[70px]">
                      <p className="text-xs text-gray-400">Overdue</p>
                      <p className={`text-sm font-semibold ${homeworkProgress.overdue > 0 ? 'text-red-600' : 'text-green-600'}`}>
                        {homeworkProgress.overdue}
                      </p>
                    </div>

                    <div className="text-gray-300 text-lg">
                      {selected?.id === student.id ? '▲' : '▼'}
                    </div>
                  </div>
                </div>

                {selected?.id === student.id && (
                  <div className="border-t border-gray-100 p-5">
                    <div className="flex flex-wrap gap-2 mb-6">
                      {[
                        ['mock', '🧠 Mock History'],
                        ['homework', '📚 Homework'],
                        ['reviews', '✍ Writing Reviews']
                      ].map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setSelectedStudentSection(key)}
                          className={`text-xs px-4 py-2 rounded-xl font-medium ${
                            selectedStudentSection === key
                              ? 'bg-purple-600 text-white'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {selectedStudentSection === 'mock' && (
                      <>
                        <div className="mb-8">
                          <div className="flex items-center justify-between mb-3 gap-3">
                            <div>
                              <h3 className="text-sm font-semibold text-gray-700">
                                Mock History for {student.name}
                              </h3>
                              <p className="text-xs text-gray-400 mt-1">
                                Full Mock and Mini Mock results are listed here with their types kept separate.
                              </p>
                            </div>

                            <button
                              type="button"
                              onClick={() => handlePrint(student)}
                              disabled={getStudentMockSubmissions(student.id).length === 0}
                              className="text-xs bg-gray-100 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed text-gray-600 px-3 py-1.5 rounded-lg"
                            >
                              🖨️ Print report
                            </button>
                          </div>

                          {getStudentMockSubmissions(student.id).length === 0 ? (
                            <div className="bg-gray-50 border border-gray-100 rounded-xl p-5 text-sm text-gray-400">
                              No completed mock test yet.
                            </div>
                          ) : (
                            <div className="flex flex-col gap-3">
                              {getStudentMockSubmissions(student.id).map(submission => {
                                const result = submission.result || {}
                                const overall = getMockOverall(submission)
                                const mock = mockTests.find(
                                  item => item.id === submission.mockTestId
                                )
                                const canRetakeMock = Boolean(
                                  mock &&
                                  !mock.archived &&
                                  isHomeworkAssignedToStudent(mock, student, 'mock')
                                )

                                return (
                                  <div
                                    key={submission.id}
                                    className="border border-gray-100 bg-gray-50 rounded-xl p-4"
                                  >
                                    <div className="flex items-start justify-between gap-4 mb-3">
                                      <div>
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <p className="text-sm font-semibold text-gray-800">
                                            {getMockTitle(submission)}
                                          </p>
                                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                                            getMockTypeForSubmission(submission) === 'mini_mock'
                                              ? 'bg-blue-50 text-blue-600'
                                              : 'bg-purple-50 text-purple-600'
                                          }`}>
                                            {getMockTypeLabelForSubmission(submission)}
                                          </span>
                                        </div>

                                        <p className="text-xs text-gray-400 mt-0.5">
                                          Submitted {formatDateShort(submission.submittedAt)}
                                        </p>
                                      </div>

                                      <div className="flex items-center gap-2 flex-wrap justify-end">
                                        <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1.5 rounded-full font-semibold">
                                          Overall {formatBand(overall)}
                                        </span>

                                        {canRetakeMock && (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              openSubmissionAttemptManager({
                                                contentType: 'mock',
                                                contentId: submission.mockTestId,
                                                title: getMockTitle(submission),
                                                student
                                              })
                                            }
                                            className="text-xs bg-blue-50 text-blue-700 px-3 py-2 rounded-xl hover:bg-blue-100"
                                          >
                                            Retake Options
                                          </button>
                                        )}
                                      </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                                      <div className="bg-white rounded-xl p-3">
                                        <p className="text-[11px] text-gray-400 mb-1">Listening</p>
                                        <p className="text-lg font-bold text-purple-600">
                                          {formatBand(result.listening?.band)}
                                        </p>
                                        <p className="text-[10px] text-gray-400 mt-1">
                                          {result.listening?.correct ?? '-'}/{result.listening?.total ?? '-'} correct
                                        </p>
                                      </div>

                                      <div className="bg-white rounded-xl p-3">
                                        <p className="text-[11px] text-gray-400 mb-1">Reading</p>
                                        <p className="text-lg font-bold text-blue-600">
                                          {formatBand(result.reading?.band)}
                                        </p>
                                        <p className="text-[10px] text-gray-400 mt-1">
                                          {result.reading?.correct ?? '-'}/{result.reading?.total ?? '-'} correct
                                        </p>
                                      </div>

                                      <div className="bg-white rounded-xl p-3">
                                        <p className="text-[11px] text-gray-400 mb-1">Writing</p>
                                        <p className="text-sm font-bold text-amber-700">
                                          {getMockWritingStatusLabel(submission)}
                                        </p>
                                      </div>

                                      <div className="bg-white rounded-xl p-3">
                                        <p className="text-[11px] text-gray-400 mb-1">Status</p>
                                        <p className="text-sm font-semibold text-gray-700">
                                          {getMockWritingStatus(submission) === 'not_included'
                                            ? 'No Writing'
                                            : getMockWritingStatus(submission) === 'reviewed'
                                              ? 'Reviewed'
                                              : 'Waiting for writing review'}
                                        </p>
                                      </div>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      </>
                    )}

                    {selectedStudentSection === 'homework' && (
                      <>
                    {analytics.weakest && (
                      <div className="mb-8">
                        <h3 className="text-sm font-semibold text-gray-700 mb-3">
                          Reading Weakness Analytics
                        </h3>

                        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
                          {[
                            ['Matching', analytics.matching],
                            ['Matching Information', analytics.matchingInformation],
                            ['Sentence Endings', analytics.sentenceEndings],
                            ['TFNG', analytics.tfng],
                            ['Fill Blank', analytics.fitb],
                            ['Table Completion', analytics.table],
                            ['Legacy Note Completion', analytics.note],
                            ['Reading Note/Summary Completion', analytics.noteCompletion],
                            ['Short Answer', analytics.shortAnswer],
                            ['MCQ', analytics.mcq]
                          ]
                            .filter(([, value]) => value !== null && value !== undefined)
                            .map(([label, value]) => (
                            <div
                              key={label}
                              className="bg-gray-50 rounded-xl p-4 text-center"
                            >
                              <p className="text-xs text-gray-400 mb-1">
                                {label}
                              </p>

                              <p
                                className={`text-xl font-bold ${getAnalyticsColor(
                                  value
                                )}`}
                              >
                                {value ?? '--'}%
                              </p>
                            </div>
                          ))}
                        </div>

                        <div className="bg-purple-50 rounded-xl p-4">
                          <p className="text-xs text-gray-500 mb-1">
                            Weakest Area
                          </p>

                          <p className="font-semibold text-purple-700">
                            {getWeakestLabel(analytics.weakest)}
                          </p>
                        </div>
                      </div>
                    )}

                    <div className="mb-8">
                      <h3 className="text-sm font-semibold text-gray-700 mb-3">
                        Reading homework results
                      </h3>

                      {studentReadings.length === 0 ? (
                        <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
                          No active or submitted reading homework found for this student.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-3">
                          {studentReadings.map(reading => {
                            const submission = getSubmission(
                              student.id,
                              reading.id
                            )

                            return (
                              <div
                                key={reading.id}
                                className="border border-gray-100 rounded-xl p-4 bg-gray-50"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-medium text-gray-800">
                                      {reading.title}
                                    </p>

                                    <p className="text-xs text-gray-400">
                                      {reading.questions?.length || 0} question
                                      sets · {reading.timeLimit} min
                                    </p>
                                  </div>

                                  {submission ? (
                                    <div className="flex items-center gap-3">
                                      <div className="text-right">
                                        <p className="text-xs text-gray-400">
                                          Band
                                        </p>

                                        <p className="text-lg font-bold text-purple-600">
                                          {submission.result?.band}
                                        </p>
                                      </div>

                                      <div className="text-right">
                                        <p className="text-xs text-gray-400">
                                          Score
                                        </p>

                                        <p className="text-sm font-semibold text-gray-700">
                                          {submission.result?.correct}/
                                          {submission.result?.total}
                                        </p>
                                      </div>

                                      <button
                                        onClick={() =>
                                          setSelectedReview({
                                            student,
                                            reading,
                                            submission
                                          })
                                        }
                                        className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
                                      >
                                        Review
                                      </button>

                                      <button
                                        type="button"
                                        onClick={() =>
                                          openSubmissionAttemptManager({
                                            contentType: 'reading',
                                            contentId: reading.id,
                                            title: reading.title,
                                            student
                                          })
                                        }
                                        className="text-xs bg-blue-50 text-blue-700 px-3 py-2 rounded-xl hover:bg-blue-100"
                                      >
                                        Retake Options
                                      </button>

                                      {isHomeworkAssignedToStudent(reading, student, 'reading') && (
                                        <button
                                          onClick={() => removeHomeworkFromStudent(reading, 'reading', student)}
                                          className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
                                        >
                                          Remove
                                        </button>
                                      )}
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs bg-amber-50 text-amber-600 px-3 py-1.5 rounded-full">
                                        Not done
                                      </span>

                                      <button
                                        onClick={() => removeHomeworkFromStudent(reading, 'reading', student)}
                                        className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>

                    <div className="mb-8">
                      <h3 className="text-sm font-semibold text-gray-700 mb-3">
                        Listening homework results
                      </h3>

                      {studentListenings.length === 0 ? (
                        <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
                          No active or submitted listening homework found for this student.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-3">
                          {studentListenings.map(listening => {
                            const submission = getListeningSubmission(
                              student.id,
                              listening.id
                            )

                            return (
                              <div
                                key={listening.id}
                                className="border border-gray-100 rounded-xl p-4 bg-gray-50"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-medium text-gray-800">
                                      {listening.title}
                                    </p>

                                    <p className="text-xs text-gray-400">
                                      {listening.questions?.length || 0} question sets · {listening.timeLimit || 30} min
                                    </p>

                                    {submission && (
                                      <p className="text-xs text-green-600 mt-1 font-medium">
                                        Submitted {formatDateShort(submission.submittedAt)}
                                      </p>
                                    )}
                                  </div>

                                  {submission ? (
                                    <div className="flex items-center gap-3">
                                      <div className="text-right">
                                        <p className="text-xs text-gray-400">
                                          Band
                                        </p>

                                        <p className="text-lg font-bold text-purple-600">
                                          {submission.result?.band || '-'}
                                        </p>
                                      </div>

                                      <div className="text-right">
                                        <p className="text-xs text-gray-400">
                                          Score
                                        </p>

                                        <p className="text-sm font-semibold text-gray-700">
                                          {submission.result?.correct ?? 0}/
                                          {submission.result?.total ?? 0}
                                        </p>
                                      </div>

                                      <span className="text-xs bg-green-50 text-green-600 px-3 py-1.5 rounded-full">
                                        Completed
                                      </span>

                                      <button
                                        type="button"
                                        onClick={() =>
                                          openSubmissionAttemptManager({
                                            contentType: 'listening',
                                            contentId: listening.id,
                                            title: listening.title,
                                            student
                                          })
                                        }
                                        className="text-xs bg-blue-50 text-blue-700 px-3 py-2 rounded-xl hover:bg-blue-100"
                                      >
                                        Retake Options
                                      </button>

                                      {isHomeworkAssignedToStudent(listening, student, 'listening') && (
                                        <button
                                          onClick={() => removeHomeworkFromStudent(listening, 'listening', student)}
                                          className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
                                        >
                                          Remove
                                        </button>
                                      )}
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs bg-amber-50 text-amber-600 px-3 py-1.5 rounded-full">
                                        Not done
                                      </span>

                                      <button
                                        onClick={() => removeHomeworkFromStudent(listening, 'listening', student)}
                                        className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>

                    <div className="mb-8">
                      <h3 className="text-sm font-semibold text-gray-700 mb-3">
                        Vocabulary test results
                      </h3>

                      {studentVocabularyTests.length === 0 ? (
                        <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
                          No active or submitted vocabulary test found for this student.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-3">
                          {studentVocabularyTests.map(vocabularyTest => {
                            const submission = getVocabularySubmission(
                              student.id,
                              vocabularyTest.id
                            )

                            return (
                              <div
                                key={vocabularyTest.id}
                                className="border border-gray-100 rounded-xl p-4 bg-gray-50"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-medium text-gray-800">
                                      {vocabularyTest.title}
                                    </p>

                                    <p className="text-xs text-gray-400">
                                      {vocabularyTest.questions?.length || 0} questions · {vocabularyTest.timeLimit || 20} min
                                    </p>

                                    {submission && (
                                      <p className="text-xs text-green-600 mt-1 font-medium">
                                        Submitted {formatDateShort(submission.submittedAt)}
                                      </p>
                                    )}
                                  </div>

                                  {submission ? (
                                    <div className="flex items-center gap-3">
                                      <div className="text-right">
                                        <p className="text-xs text-gray-400">
                                          Score
                                        </p>

                                        <p className="text-sm font-semibold text-gray-700">
                                          {submission.result?.correct || 0}/
                                          {submission.result?.total || 0}
                                        </p>
                                      </div>

                                      <div className="text-right">
                                        <p className="text-xs text-gray-400">
                                          Accuracy
                                        </p>

                                        <p className="text-lg font-bold text-purple-600">
                                          {submission.result?.percentage ?? 0}%
                                        </p>
                                      </div>

                                      <button
                                        onClick={() =>
                                          setSelectedVocabularyReview({
                                            student,
                                            vocabularyTest,
                                            submission
                                          })
                                        }
                                        className="text-xs bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700"
                                      >
                                        Review
                                      </button>

                                      <button
                                        type="button"
                                        onClick={() =>
                                          openSubmissionAttemptManager({
                                            contentType: 'vocabulary',
                                            contentId: vocabularyTest.id,
                                            title: vocabularyTest.title,
                                            student
                                          })
                                        }
                                        className="text-xs bg-blue-50 text-blue-700 px-3 py-2 rounded-xl hover:bg-blue-100"
                                      >
                                        Retake Options
                                      </button>

                                      <span className="text-xs bg-green-50 text-green-600 px-3 py-1.5 rounded-full">
                                        Completed
                                      </span>

                                      {isHomeworkAssignedToStudent(vocabularyTest, student, 'vocabulary') && (
                                        <button
                                          onClick={() => removeHomeworkFromStudent(vocabularyTest, 'vocabulary', student)}
                                          className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
                                        >
                                          Remove
                                        </button>
                                      )}
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs bg-amber-50 text-amber-600 px-3 py-1.5 rounded-full">
                                        Not done
                                      </span>

                                      <button
                                        onClick={() => removeHomeworkFromStudent(vocabularyTest, 'vocabulary', student)}
                                        className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>

                      </>
                    )}

                    {selectedStudentSection === 'reviews' && (
                      <>
                    <div>
                      <h3 className="text-sm font-semibold text-gray-700 mb-3">
                        Writing homework results
                      </h3>

                      {studentWritings.length === 0 ? (
                        <p className="text-sm text-gray-400 bg-gray-50 rounded-xl p-4">
                          No active or submitted writing homework found for this student.
                        </p>
                      ) : (
                        <div className="flex flex-col gap-3">
                          {studentWritings.map(writing => {
                            const submission = getWritingSubmission(
                              student.id,
                              writing.id
                            )

                            return (
                              <div
                                key={writing.id}
                                className="border border-gray-100 rounded-xl p-4 bg-gray-50"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-medium text-gray-800">
                                      {writing.title}
                                    </p>

                                    <p className="text-xs text-gray-400">
                                      {getWritingTaskLabel(writing, submission || {})} · {writing.timeLimit || 60} min
                                    </p>

                                    {submission && (
                                      <p
                                        className={`text-xs mt-1 font-medium ${
                                          submission.reviewed
                                            ? 'text-green-600'
                                            : 'text-amber-600'
                                        }`}
                                      >
                                        {submission.reviewed
                                          ? `Reviewed — Band ${submission.review?.overall}`
                                          : 'Submitted — Waiting for review'}
                                      </p>
                                    )}
                                  </div>

                                  {submission ? (
                                    <div className="flex items-center gap-3">
                                      {isWritingTask1Enabled(writing, submission) && (
                                        <div className="text-right">
                                          <p className="text-xs text-gray-400">
                                            Task 1
                                          </p>

                                          <p className="text-sm font-semibold text-gray-700">
                                            {submission.task1WordCount || 0} words
                                          </p>
                                        </div>
                                      )}

                                      {isWritingTask2Enabled(writing, submission) && (
                                        <div className="text-right">
                                          <p className="text-xs text-gray-400">
                                            Task 2
                                          </p>

                                          <p className="text-sm font-semibold text-gray-700">
                                            {submission.task2WordCount || 0} words
                                          </p>
                                        </div>
                                      )}

                                      <button
                                        onClick={() =>
                                          openWritingReview({
                                            student,
                                            writing,
                                            submission
                                          })
                                        }
                                        className={`text-xs px-3 py-2 rounded-xl text-white ${
                                          submission.reviewed
                                            ? 'bg-green-600 hover:bg-green-700'
                                            : 'bg-purple-600 hover:bg-purple-700'
                                        }`}
                                      >
                                        {submission.reviewed ? 'Edit Review' : 'Grade'}
                                      </button>

                                      <button
                                        type="button"
                                        onClick={() =>
                                          openSubmissionAttemptManager({
                                            contentType: 'writing',
                                            contentId: writing.id,
                                            title: writing.title,
                                            student
                                          })
                                        }
                                        className="text-xs bg-blue-50 text-blue-700 px-3 py-2 rounded-xl hover:bg-blue-100"
                                      >
                                        Retake Options
                                      </button>

                                      {isHomeworkAssignedToStudent(writing, student, 'writing') && (
                                        <button
                                          onClick={() => removeHomeworkFromStudent(writing, 'writing', student)}
                                          className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
                                        >
                                          Remove
                                        </button>
                                      )}
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs bg-amber-50 text-amber-600 px-3 py-1.5 rounded-full">
                                        Not done
                                      </span>

                                      <button
                                        onClick={() => removeHomeworkFromStudent(writing, 'writing', student)}
                                        className="text-xs bg-red-50 text-red-600 px-3 py-2 rounded-xl hover:bg-red-100"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>

          </>
        )}

          </main>
        </div>
      </div>

      {attemptManager && (
        <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4 mb-5">
              <div>
                <p className="text-xs font-semibold text-blue-600 uppercase tracking-wide">
                  {getAttemptContentLabel(attemptManager.contentType)} Retake
                </p>
                <h2 className="text-xl font-bold text-gray-900 mt-1">
                  {attemptManager.title}
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  {attemptManager.student?.name || attemptManager.student?.email || 'Student'}
                </p>
              </div>

              <button
                type="button"
                onClick={closeSubmissionAttemptManager}
                disabled={attemptManagerSaving}
                className="text-gray-400 hover:text-gray-700 disabled:opacity-50 text-xl leading-none"
                aria-label="Close retake options"
              >
                ×
              </button>
            </div>

            {attemptManagerLoading ? (
              <div className="bg-gray-50 rounded-xl p-5 text-sm text-gray-500">
                Loading attempt status...
              </div>
            ) : attemptManagerError && !attemptManager.state ? (
              <div className="bg-red-50 border border-red-100 rounded-xl p-4 text-sm text-red-700">
                {attemptManagerError}
              </div>
            ) : (
              <>
                <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 mb-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs text-gray-400">Current submitted attempt</p>
                      <p className="text-lg font-bold text-gray-800 mt-0.5">
                        {attemptManager.state?.hasSubmission
                          ? `Attempt ${attemptManager.state?.currentAttemptNumber || 1}`
                          : 'No submitted attempt'}
                      </p>
                    </div>

                    {attemptManager.state?.open ? (
                      <span className="text-xs bg-blue-100 text-blue-700 px-3 py-1.5 rounded-full font-semibold">
                        Attempt {attemptManager.state?.nextAttemptNumber || 2} open
                      </span>
                    ) : attemptManager.state?.hasSubmission ? (
                      <span className="text-xs bg-green-50 text-green-700 px-3 py-1.5 rounded-full font-semibold">
                        Submitted
                      </span>
                    ) : (
                      <span className="text-xs bg-slate-100 text-slate-600 px-3 py-1.5 rounded-full font-semibold">
                        No result
                      </span>
                    )}
                  </div>

                  {attemptManager.state?.excludedFromStats && (
                    <p className="text-xs text-amber-700 mt-3 font-semibold">
                      Excluded from statistics. The reason is retained in the protected moderation audit.
                    </p>
                  )}
                  {attemptManager.state?.open && (
                    <p className="text-xs text-blue-700 mt-3">
                      {attemptManager.state.mode === 'reopen_answers'
                        ? 'The next attempt is open with the previous answers restored.'
                        : 'The next attempt is open as a fresh blank attempt.'}
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setManagedAttemptMode('reopen_answers')}
                    disabled={attemptManagerSaving || !attemptManager.state?.hasSubmission}
                    className="text-left border border-purple-200 bg-purple-50 hover:bg-purple-100 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl p-4"
                  >
                    <span className="block text-sm font-semibold text-purple-700">
                      Reopen Answers
                    </span>
                    <span className="block text-xs text-purple-600/80 mt-1 leading-relaxed">
                      {getAttemptReopenDescription(attemptManager.contentType)}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setManagedAttemptMode('start_fresh')}
                    disabled={attemptManagerSaving || !attemptManager.state?.hasSubmission}
                    className="text-left border border-blue-200 bg-blue-50 hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl p-4"
                  >
                    <span className="block text-sm font-semibold text-blue-700">
                      Start Fresh
                    </span>
                    <span className="block text-xs text-blue-600/80 mt-1 leading-relaxed">
                      Start the new attempt blank while keeping the previous submission in history.
                    </span>
                  </button>
                </div>

                <p className="text-xs text-gray-400 mt-4 leading-relaxed">
                  Reopening never deletes the current submitted attempt. The previous answers, submission time and review are preserved for attempt history when the student resubmits.
                </p>
                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm font-semibold text-slate-800">Result statistics control</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Keep the submitted answer and review, but exclude its grade from performance statistics; you can restore it later.
                  </p>
                  <button
                    type="button"
                    onClick={() => openStatsDialog(!attemptManager.state?.excludedFromStats)}
                    disabled={attemptManagerSaving || !attemptManager.state?.hasSubmission}
                    className={`mt-3 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50 ${attemptManager.state?.excludedFromStats
                      ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                      : 'border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'}`}
                  >
                    {attemptManager.state?.excludedFromStats ? 'Restore to statistics' : 'Exclude from statistics'}
                  </button>
                </div>

                <div className="mt-4 rounded-xl border border-red-200 bg-red-50/60 p-4">
                  <p className="text-sm font-semibold text-red-800">Permanent result removal</p>
                  <p className="mt-1 text-xs text-red-700 leading-relaxed">
                    Hard Delete removes this student's current submission and all saved attempts for this test,
                    plus matching scores and attempt controls. The assignment and original test are preserved.
                    Unlike statistics exclusion, this cannot be restored.
                  </p>
                  <button type="button" onClick={openDeleteDialog}
                    disabled={attemptManagerSaving || attemptManagerLoading || (!attemptManager.state?.hasSubmission && attemptHistory.length === 0)}
                    className="mt-3 rounded-xl border border-red-300 bg-white px-4 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50">
                    Permanently Delete Results
                  </button>
                </div>

                <div className="border border-gray-100 rounded-xl p-4 mt-4">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">Attempt History</p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        Latest valid attempt plus immutable prior attempts.
                      </p>
                    </div>
                    <span className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">
                      {attemptHistory.length} saved
                    </span>
                  </div>

                  {attemptHistoryLoading ? (
                    <p className="text-xs text-gray-400">Loading history...</p>
                  ) : attemptHistoryError ? (
                    <div className="bg-amber-50 border border-amber-100 rounded-lg p-3 text-xs text-amber-700">
                      {attemptHistoryError}
                    </div>
                  ) : attemptHistory.length === 0 ? (
                    <p className="text-xs text-gray-400">No submitted attempt history yet.</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {attemptHistory.map(attempt => (
                        <div
                          key={`${attempt.attemptNumber}-${attempt.submissionId || 'attempt'}`}
                          className="bg-gray-50 border border-gray-100 rounded-lg p-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-semibold text-gray-800">
                                  Attempt {attempt.attemptNumber}
                                </p>
                                <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                                  attempt.isCurrent
                                    ? 'bg-green-50 text-green-700'
                                    : 'bg-purple-50 text-purple-700'
                                }`}>
                                  {attempt.isCurrent ? 'Current' : 'Saved history'}
                                </span>
                              </div>
                              <p className="text-xs text-gray-500 mt-1">
                                {getAttemptHistoryResultLabel(attemptManager.contentType, attempt)}
                              </p>
                              {attempt.excludedFromStats === true && (
                                <span className="mt-1 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Excluded from statistics</span>
                              )}
                              <p className="text-[11px] text-gray-400 mt-1">
                                {formatAttemptHistoryDate(attempt.submittedAt)}
                              </p>
                            </div>

                            {attempt.autoSubmitted && (
                              <span className="text-[10px] bg-amber-50 text-amber-700 px-2 py-1 rounded-full">
                                Auto-submitted
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {attemptManagerNotice && (
                  <div className="bg-green-50 border border-green-100 rounded-xl p-3 text-sm text-green-700 mt-4">
                    {attemptManagerNotice}
                  </div>
                )}

                {attemptManagerWarning && (
                  <div role="status" className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800 mt-4">
                    {attemptManagerWarning}
                  </div>
                )}

                {attemptManagerError && (
                  <div className="bg-red-50 border border-red-100 rounded-xl p-3 text-sm text-red-700 mt-4">
                    {attemptManagerError}
                  </div>
                )}

                {attemptManagerSaving && (
                  <p className="text-xs text-gray-400 mt-4">
                    Saving changes...
                  </p>
                )}
              </>
            )}
          </div>
          {statsDialogMode && (
            <StatsModerationDialog
              mode={statsDialogMode}
              saving={attemptManagerSaving}
              error={statsDialogError}
              onCancel={closeStatsDialog}
              onConfirm={setManagedStatsExclusion}
              onClearError={() => setStatsDialogError('')}
            />
          )}
          {deleteDialogOpen && (
            <ResultPermanentDeleteDialog
              loading={deleteDialogLoading}
              preview={deleteDialogPreview}
              saving={attemptManagerSaving}
              error={deleteDialogError}
              studentName={attemptManager.student?.name || attemptManager.student?.email || 'Selected student'}
              contentTitle={attemptManager.title}
              onCancel={closeDeleteDialog}
              onConfirm={confirmDeleteResult}
            />
          )}
        </div>
      )}

      {selectedHomework && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-start justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-gray-900">
                  Manage Assignment
                </h2>

                <p className="text-sm text-gray-400">
                  {selectedHomework.title}
                </p>
              </div>

              <button
                onClick={() => {
                  setSelectedHomework(null)
                  setSelectedHomeworkType(null)
                  setAssignmentDraft([])
                }}
                className="text-sm text-gray-400 hover:text-gray-600"
              >
                Close
              </button>
            </div>

            {classes.length > 0 && (
              <div className="bg-purple-50 border border-purple-100 rounded-2xl p-4 mb-6">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <p className="text-sm font-semibold text-purple-800">
                      Assign by Class
                    </p>

                    <p className="text-xs text-purple-500 mt-1">
                      Add or remove all students from a class for this homework.
                    </p>
                  </div>

                  <span className="text-xs bg-white text-purple-600 px-3 py-1 rounded-full">
                    {assignmentDraft.length} selected
                  </span>
                </div>

                <div className="flex flex-col gap-2">
                  {classes.map(classItem => {
                    const classStudentIds = classItem.studentIds || []
                    const fullyAssigned = isClassFullyAssignedToDraft(classItem)
                    const partlyAssigned = isClassPartlyAssignedToDraft(classItem)

                    return (
                      <div
                        key={classItem.id}
                        className={`bg-white border rounded-xl p-3 ${
                          fullyAssigned
                            ? 'border-purple-300'
                            : partlyAssigned
                              ? 'border-amber-200'
                              : 'border-gray-100'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">
                              {classItem.name}
                            </p>

                            <p className="text-xs text-gray-400 mt-0.5">
                              {classStudentIds.length} student{classStudentIds.length === 1 ? '' : 's'}
                              {partlyAssigned && !fullyAssigned ? ' · partly selected' : ''}
                              {fullyAssigned ? ' · selected' : ''}
                            </p>

                            {classStudentIds.length > 0 && (
                              <p className="text-[11px] text-gray-400 mt-1 truncate">
                                {classStudentIds.slice(0, 3).map(getStudentName).join(', ')}
                                {classStudentIds.length > 3
                                  ? ` +${classStudentIds.length - 3} more`
                                  : ''}
                              </p>
                            )}
                          </div>

                          {fullyAssigned ? (
                            <button
                              type="button"
                              onClick={() => removeClassFromHomework(classItem)}
                              className="text-xs bg-red-50 text-red-500 px-3 py-1.5 rounded-lg hover:bg-red-100 flex-shrink-0"
                            >
                              Remove
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => assignClassToHomework(classItem)}
                              className="text-xs bg-purple-600 text-white px-3 py-1.5 rounded-lg hover:bg-purple-700 flex-shrink-0"
                            >
                              Add
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 mb-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Individual Students
              </p>

              {assignmentDraft.length > 0 && (
                <button
                  type="button"
                  onClick={() => setAssignmentDraft([])}
                  className="text-xs bg-gray-100 text-gray-500 px-3 py-1.5 rounded-lg hover:bg-gray-200"
                >
                  Clear all
                </button>
              )}
            </div>

            <div className="flex flex-col gap-3 mb-6">
              {students.map(student => {
                const completed =
                  selectedHomeworkType === 'reading'
                    ? getSubmission(student.id, selectedHomework.id)
                    : selectedHomeworkType === 'listening'
                      ? getListeningSubmission(student.id, selectedHomework.id)
                      : selectedHomeworkType === 'mock'
                        ? getMockSubmission(student.id, selectedHomework.id)
                        : selectedHomeworkType === 'vocabulary'
                          ? getVocabularySubmission(student.id, selectedHomework.id)
                          : getWritingSubmission(student.id, selectedHomework.id)

                return (
                  <label
                    key={student.id}
                    className="flex items-center justify-between gap-4 border border-gray-100 rounded-xl p-4 cursor-pointer hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={assignmentDraft.includes(student.id)}
                        onChange={() => toggleAssignment(student.id)}
                        className="accent-purple-600"
                      />

                      <div>
                        <p className="text-sm font-medium text-gray-800">
                          {student.name}
                        </p>

                        <p className="text-xs text-gray-400">
                          {student.email}
                        </p>
                      </div>
                    </div>

                    {completed ? (
                      <span className="text-xs bg-green-50 text-green-600 px-3 py-1.5 rounded-full">
                        Completed
                      </span>
                    ) : assignmentDraft.includes(student.id) ? (
                      <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1.5 rounded-full">
                        Assigned
                      </span>
                    ) : (
                      <span className="text-xs bg-gray-100 text-gray-500 px-3 py-1.5 rounded-full">
                        Not assigned
                      </span>
                    )}
                  </label>
                )
              })}
            </div>

            <button
              onClick={saveAssignments}
              className="w-full bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700"
            >
              Save assignments
            </button>
          </div>
        </div>
      )}

      {selectedReview && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-start justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-gray-900">
                  Reading Review
                </h2>

                <p className="text-sm text-gray-400">
                  {selectedReview.student.name} — {selectedReview.reading.title}
                </p>

                <p className="text-sm text-purple-600 font-semibold mt-1">
                  Band {selectedReview.submission.result?.band} ·{' '}
                  {selectedReview.submission.result?.correct}/
                  {selectedReview.submission.result?.total} correct
                </p>
              </div>

              <button
                onClick={() => setSelectedReview(null)}
                className="text-sm text-gray-400 hover:text-gray-600"
              >
                Close
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="border border-gray-100 rounded-2xl p-5">
                <h3 className="font-semibold text-gray-800 mb-4">
                  Reading Passage
                </h3>

                {selectedReview.reading.passageMode === 'sections' ? (
                  <div className="space-y-6">
                    {selectedReview.reading.paragraphs.map(paragraph => (
                      <div key={paragraph.id}>
                        <h4 className="font-semibold text-gray-900 mb-2">
                          Paragraph {paragraph.letter}
                        </h4>

                        <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap">
                          {paragraph.text}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap">
                    {selectedReview.reading.passage}
                  </p>
                )}
              </div>

              <div className="border border-gray-100 rounded-2xl p-5">
                <h3 className="font-semibold text-gray-800 mb-4">
                  Student Answers
                </h3>

                <div className="flex flex-col gap-4">
                  {selectedReview.reading.questions.map((question, index) => (
                    <div
                      key={question.id}
                      className="border border-gray-100 rounded-xl p-4"
                    >
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-xs text-gray-400">
                          Q{index + 1}
                        </span>

                        <span className="text-xs bg-purple-50 text-purple-600 px-2 py-1 rounded-full">
                          {question.type === 'matching'
                            ? 'Matching Headings'
                            : question.type === 'matchingInformation'
                              ? 'Matching Information'
                              : question.type === 'sentenceEndings'
                                ? 'Sentence Endings'
                                : question.type === 'summaryOptions'
                                  ? 'Summary Completion with Options'
                              : question.type === 'tfng'
                              ? 'T/F/NG'
                              : question.type === 'fitb'
                                ? 'Fill blank'
                                : (question.type === 'table' || question.type === 'summary' || question.type === 'note')
                                  ? question.type === 'note' ? 'Note Completion' : 'Table Completion'
                                  : question.mode === 'multi'
                                    ? 'MCQ — Choose TWO'
                                    : 'MCQ'}
                        </span>
                      </div>

                      {question.type === 'matchingInformation' ? (
                        <div>
                          {question.instruction && (
                            <p className="text-sm text-gray-700 mb-4">
                              {question.instruction}
                            </p>
                          )}

                          <div className="flex flex-col gap-3">
                            {question.items?.map(item => {
                              const correct = isMatchingInformationCorrect(
                                selectedReview.submission,
                                question,
                                item
                              )

                              const userAnswer =
                                selectedReview.submission.answers?.[
                                  question.id
                                ]?.[item.id]

                              const correctAnswer = item.answer

                              return (
                                <div
                                  key={item.id}
                                  className={`rounded-xl p-3 border ${
                                    correct
                                      ? 'bg-green-50 border-green-100'
                                      : 'bg-red-50 border-red-100'
                                  }`}
                                >
                                  <div className="flex justify-between mb-2">
                                    <p className="text-sm font-semibold text-gray-800">
                                      {item.statement || item.question || 'Matching information item'}
                                    </p>

                                    <p
                                      className={`text-xs font-semibold ${
                                        correct
                                          ? 'text-green-600'
                                          : 'text-red-600'
                                      }`}
                                    >
                                      {correct ? 'Correct' : 'Wrong'}
                                    </p>
                                  </div>

                                  <p className="text-xs text-gray-500">
                                    Student:
                                  </p>

                                  <p className="text-sm text-gray-800 mb-2">
                                    {userAnswer || 'No answer'}
                                  </p>

                                  {!correct && (
                                    <>
                                      <p className="text-xs text-gray-500">
                                        Correct:
                                      </p>

                                      <p className="text-sm font-medium text-green-700">
                                        {correctAnswer || 'No answer key'}
                                      </p>
                                    </>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      ) : question.type === 'matching' ? (
                        <div className="flex flex-col gap-3">
                          {question.paragraphs.map(paragraph => {
                            const correct = isMatchingCorrect(
                              selectedReview.submission,
                              question,
                              paragraph
                            )

                            const userAnswer =
                              selectedReview.submission.answers?.[
                                question.id
                              ]?.[paragraph.letter]

                            const correctAnswer = paragraph.answer

                            return (
                              <div
                                key={paragraph.letter}
                                className={`rounded-xl p-3 border ${
                                  correct
                                    ? 'bg-green-50 border-green-100'
                                    : 'bg-red-50 border-red-100'
                                }`}
                              >
                                <div className="flex justify-between mb-2">
                                  <p className="text-sm font-semibold text-gray-800">
                                    Paragraph {paragraph.letter}
                                  </p>

                                  <p
                                    className={`text-xs font-semibold ${
                                      correct
                                        ? 'text-green-600'
                                        : 'text-red-600'
                                    }`}
                                  >
                                    {correct ? 'Correct' : 'Wrong'}
                                  </p>
                                </div>

                                <p className="text-xs text-gray-500">
                                  Student:
                                </p>

                                <p className="text-sm text-gray-800 mb-2">
                                  {userAnswer
                                    ? `${userAnswer}. ${getHeadingText(
                                        selectedReview.reading,
                                        userAnswer
                                      )}`
                                    : 'No answer'}
                                </p>

                                {!correct && (
                                  <>
                                    <p className="text-xs text-gray-500">
                                      Correct:
                                    </p>

                                    <p className="text-sm font-medium text-green-700">
                                      {correctAnswer}.{' '}
                                      {getHeadingText(
                                        selectedReview.reading,
                                        correctAnswer
                                      )}
                                    </p>
                                  </>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      ) : question.type === 'sentenceEndings' ? (
                        <div>
                          {question.instruction && (
                            <p className="text-sm text-gray-700 mb-4">
                              {question.instruction}
                            </p>
                          )}

                          <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 mb-4">
                            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                              Endings
                            </p>

                            <div className="space-y-1">
                              {question.endings?.filter(Boolean).map((ending, endingIndex) => (
                                <p key={endingIndex} className="text-sm text-gray-700">
                                  <span className="font-semibold">
                                    {letters[endingIndex]}.
                                  </span>{' '}
                                  {ending}
                                </p>
                              ))}
                            </div>
                          </div>

                          <div className="flex flex-col gap-3">
                            {question.items?.map(item => {
                              const correct = isSentenceEndingCorrect(
                                selectedReview.submission,
                                question,
                                item
                              )

                              const userAnswer =
                                selectedReview.submission.answers?.[
                                  question.id
                                ]?.[item.id]

                              const correctAnswer = item.answer

                              return (
                                <div
                                  key={item.id}
                                  className={`rounded-xl p-3 border ${
                                    correct
                                      ? 'bg-green-50 border-green-100'
                                      : 'bg-red-50 border-red-100'
                                  }`}
                                >
                                  <div className="flex justify-between mb-2">
                                    <p className="text-sm font-semibold text-gray-800">
                                      {item.sentence}
                                    </p>

                                    <p
                                      className={`text-xs font-semibold ${
                                        correct
                                          ? 'text-green-600'
                                          : 'text-red-600'
                                      }`}
                                    >
                                      {correct ? 'Correct' : 'Wrong'}
                                    </p>
                                  </div>

                                  <p className="text-xs text-gray-500">
                                    Student:
                                  </p>

                                  <p className="text-sm text-gray-800 mb-2">
                                    {userAnswer
                                      ? `${userAnswer}. ${getSentenceEndingText(
                                          question,
                                          userAnswer
                                        )}`
                                      : 'No answer'}
                                  </p>

                                  {!correct && (
                                    <>
                                      <p className="text-xs text-gray-500">
                                        Correct:
                                      </p>

                                      <p className="text-sm font-medium text-green-700">
                                        {correctAnswer}.{' '}
                                        {getSentenceEndingText(
                                          question,
                                          correctAnswer
                                        )}
                                      </p>
                                    </>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      ) : question.type === 'summaryOptions' ? (
                        <div>
                          {question.instruction && (
                            <p className="text-sm text-gray-700 mb-4">
                              {question.instruction}
                            </p>
                          )}

                          {question.title && (
                            <p className="text-sm font-semibold text-gray-800 mb-4">
                              {question.title}
                            </p>
                          )}

                          <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 mb-4">
                            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                              Options
                            </p>

                            <div className="space-y-1">
                              {question.options?.filter(Boolean).map((option, optionIndex) => (
                                <p key={optionIndex} className="text-sm text-gray-700">
                                  <span className="font-semibold">
                                    {letters[optionIndex]}.
                                  </span>{' '}
                                  {option}
                                </p>
                              ))}
                            </div>
                          </div>

                          <div className="flex flex-col gap-3">
                            {question.items?.map(item => {
                              const correct = isSummaryOptionCorrect(
                                selectedReview.submission,
                                question,
                                item
                              )

                              const userAnswer =
                                selectedReview.submission.answers?.[
                                  question.id
                                ]?.[item.id]

                              const correctAnswer = item.answer

                              return (
                                <div
                                  key={item.id}
                                  className={`rounded-xl p-3 border ${
                                    correct
                                      ? 'bg-green-50 border-green-100'
                                      : 'bg-red-50 border-red-100'
                                  }`}
                                >
                                  <div className="flex justify-between mb-2">
                                    <p className="text-sm font-semibold text-gray-800">
                                      Question {item.number || ''}
                                    </p>

                                    <p
                                      className={`text-xs font-semibold ${
                                        correct
                                          ? 'text-green-600'
                                          : 'text-red-600'
                                      }`}
                                    >
                                      {correct ? 'Correct' : 'Wrong'}
                                    </p>
                                  </div>

                                  <p className="text-xs text-gray-500">
                                    Student:
                                  </p>

                                  <p className="text-sm text-gray-800 mb-2">
                                    {userAnswer
                                      ? `${userAnswer}. ${getSummaryOptionText(
                                          question,
                                          userAnswer
                                        )}`
                                      : 'No answer'}
                                  </p>

                                  {(item.beforeText || item.afterText) && (
                                    <p className="text-xs text-gray-500 mb-2 leading-5">
                                      {item.beforeText || ''}{' '}
                                      <span className="font-semibold">
                                        [{formatReviewAnswerValue(userAnswer)}]
                                      </span>{' '}
                                      {item.afterText || ''}
                                    </p>
                                  )}

                                  {!correct && (
                                    <>
                                      <p className="text-xs text-gray-500">
                                        Correct:
                                      </p>

                                      <p className="text-sm font-medium text-green-700">
                                        {correctAnswer}.{' '}
                                        {getSummaryOptionText(
                                          question,
                                          correctAnswer
                                        )}
                                      </p>
                                    </>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      ) : question.type === 'noteCompletion' ? (
                        <div>
                          {question.instruction && (
                            <p className="text-sm text-gray-700 mb-4">
                              {question.instruction}
                            </p>
                          )}

                          <div className="space-y-4">
                            {question.paragraphs?.map(paragraph => (
                              <div key={paragraph.id} className="bg-gray-50 border border-gray-100 rounded-xl p-4">
                                <div className="text-sm text-gray-800 leading-8">
                                  {paragraph.parts?.map(part => {
                                    if (part.type === 'text') {
                                      return (
                                        <span key={part.id} className="whitespace-pre-wrap">
                                          {part.content}
                                        </span>
                                      )
                                    }

                                    const key = noteAnswerKey(question.id, paragraph.id, part.id)
                                    const correct = isNoteCompletionPartCorrect(
                                      selectedReview.submission,
                                      question,
                                      paragraph,
                                      part
                                    )

                                    return (
                                      <span
                                        key={part.id}
                                        className={`inline-flex items-center gap-2 mx-1 px-2 py-1 rounded-xl border ${
                                          correct
                                            ? 'bg-green-50 border-green-100'
                                            : 'bg-red-50 border-red-100'
                                        }`}
                                      >
                                        <span className="font-medium text-gray-800">
                                          {selectedReview.submission.answers?.[key] || 'No answer'}
                                        </span>

                                        {!correct && (
                                          <span className="text-xs font-semibold text-green-700">
                                            Correct: {[part.answer, part.acceptedAnswers].filter(Boolean).join(', ')}
                                          </span>
                                        )}
                                      </span>
                                    )
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : question.type === 'table' || question.type === 'summary' ? (
                        <div>
                          <p className="text-sm text-gray-700 mb-4">
                            {question.instruction}
                          </p>

                          <div className="overflow-x-auto">
                            <table className="w-full text-sm border border-gray-100 rounded-xl overflow-hidden">
                              <thead>
                                <tr className="bg-gray-100">
                                  {question.columns.map((column, columnIndex) => (
                                    <th
                                      key={columnIndex}
                                      className="p-3 text-left font-semibold text-gray-700 border border-white"
                                    >
                                      {column}
                                    </th>
                                  ))}
                                </tr>
                              </thead>

                              <tbody>
                                {question.rows.map(row => (
                                  <tr key={row.id}>
                                    {row.cells.map((cell, cellIndex) => {
                                      if (cell.type !== 'blank') {
                                        return (
                                          <td
                                            key={cellIndex}
                                            className="p-3 bg-gray-50 border border-white text-gray-700 whitespace-pre-wrap"
                                          >
                                            {cell.text}
                                          </td>
                                        )
                                      }

                                      const key = tableAnswerKey(
                                        question.id,
                                        row.id,
                                        cellIndex
                                      )

                                      const correct = isTableCellCorrect(
                                        selectedReview.submission,
                                        question,
                                        row,
                                        cellIndex
                                      )

                                      return (
                                        <td
                                          key={cellIndex}
                                          className={`p-3 border border-white ${
                                            correct
                                              ? 'bg-green-50'
                                              : 'bg-red-50'
                                          }`}
                                        >
                                          <p className="text-xs text-gray-500 mb-1">
                                            Student:
                                          </p>

                                          <p className="text-sm text-gray-800 mb-2">
                                            {selectedReview.submission.answers?.[
                                              key
                                            ] || 'No answer'}
                                          </p>

                                          {!correct && (
                                            <>
                                              <p className="text-xs text-gray-500 mb-1">
                                                Correct:
                                              </p>

                                              <p className="text-sm font-medium text-green-700">
                                                {[cell.answer, cell.acceptedAnswers].filter(Boolean).join(', ')}
                                              </p>
                                            </>
                                          )}
                                        </td>
                                      )
                                    })}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ) : (
                        <div>
                          <p className="text-sm text-gray-800 mb-3">
                            {question.question}
                          </p>

                          <div
                            className={`rounded-xl p-3 border ${
                              isNormalCorrect(
                                selectedReview.submission,
                                question
                              )
                                ? 'bg-green-50 border-green-100'
                                : 'bg-red-50 border-red-100'
                            }`}
                          >
                            <div className="flex justify-between mb-2">
                              <p className="text-xs text-gray-500">
                                Student answer:
                              </p>

                              <p
                                className={`text-xs font-semibold ${
                                  isNormalCorrect(
                                    selectedReview.submission,
                                    question
                                  )
                                    ? 'text-green-600'
                                    : 'text-red-600'
                                }`}
                              >
                                {isNormalCorrect(
                                  selectedReview.submission,
                                  question
                                )
                                  ? 'Correct'
                                  : 'Wrong'}
                              </p>
                            </div>

                            <p className="text-sm text-gray-800 mb-2">
                              {getAnswerText(
                                question,
                                selectedReview.submission.answers?.[
                                  question.id
                                ]
                              )}
                            </p>

                            {!isNormalCorrect(
                              selectedReview.submission,
                              question
                            ) && (
                              <>
                                <p className="text-xs text-gray-500">
                                  Correct answer:
                                </p>

                                <p className="text-sm font-medium text-green-700">
                                  {question.type === 'mcq' &&
                                  question.mode === 'multi'
                                    ? (question.answers || [])
                                        .map(
                                          letter =>
                                            `${letter}. ${getOptionText(
                                              question,
                                              letter
                                            )}`
                                        )
                                        .join(', ')
                                    : question.type === 'mcq'
                                      ? `${question.answer}. ${getOptionText(
                                          question,
                                          question.answer
                                        )}`
                                      : question.answer}
                                </p>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedVocabularyReview && (() => {
        const vocabularyTest = selectedVocabularyReview.vocabularyTest
        const submission = selectedVocabularyReview.submission
        const result = submission.result || {}

        return (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4">
            <div className="bg-white rounded-2xl w-full max-w-5xl max-h-[90vh] overflow-y-auto p-6">
              <div className="flex items-start justify-between mb-6">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">
                    Vocabulary Review
                  </h2>

                  <p className="text-sm text-gray-400">
                    {selectedVocabularyReview.student.name} — {vocabularyTest.title}
                  </p>

                  <p className="text-sm text-purple-600 font-semibold mt-1">
                    {result.correct || 0}/{result.total || 0} correct · {result.percentage ?? 0}%
                  </p>
                </div>

                <button
                  onClick={() => setSelectedVocabularyReview(null)}
                  className="text-sm text-gray-400 hover:text-gray-600"
                >
                  Close
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                <div className="bg-purple-50 rounded-xl p-4 text-center">
                  <p className="text-xs text-gray-500 mb-1">Score</p>
                  <p className="text-2xl font-bold text-purple-600">
                    {result.correct || 0}/{result.total || 0}
                  </p>
                </div>

                <div className="bg-green-50 rounded-xl p-4 text-center">
                  <p className="text-xs text-gray-500 mb-1">Accuracy</p>
                  <p className="text-2xl font-bold text-green-600">
                    {result.percentage ?? 0}%
                  </p>
                </div>

                <div className="bg-amber-50 rounded-xl p-4 text-center">
                  <p className="text-xs text-gray-500 mb-1">Submitted</p>
                  <p className="text-sm font-bold text-amber-700">
                    {formatDateShort(submission.submittedAt)}
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-4">
                {vocabularyTest.questions?.map((question, index) => {
                  const selectedAnswer = submission.answers?.[question.id]
                  const correctAnswer = question.answer
                  const isCorrect = selectedAnswer === correctAnswer

                  return (
                    <div
                      key={question.id}
                      className={`border rounded-xl p-5 ${
                        isCorrect
                          ? 'bg-green-50 border-green-100'
                          : 'bg-red-50 border-red-100'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3 mb-3">
                        <p className="text-xs font-semibold text-gray-400">
                          Question {index + 1}
                        </p>

                        <span className={`text-xs font-semibold ${isCorrect ? 'text-green-600' : 'text-red-600'}`}>
                          {isCorrect ? 'Correct' : 'Wrong'}
                        </span>
                      </div>

                      <p className="text-sm font-medium text-gray-800 mb-4">
                        {question.question}
                      </p>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
                        <div className="bg-white/70 rounded-xl p-4">
                          <p className="text-xs text-gray-500 mb-1">
                            Student answer
                          </p>

                          <p className="text-sm text-gray-800">
                            {selectedAnswer
                              ? `${selectedAnswer}. ${getOptionText(question, selectedAnswer)}`
                              : 'No answer'}
                          </p>
                        </div>

                        <div className="bg-white/70 rounded-xl p-4">
                          <p className="text-xs text-gray-500 mb-1">
                            Correct answer
                          </p>

                          <p className="text-sm font-medium text-green-700">
                            {correctAnswer
                              ? `${correctAnswer}. ${getOptionText(question, correctAnswer)}`
                              : 'No answer key'}
                          </p>
                        </div>
                      </div>

                      {Array.isArray(question.options) && question.options.length > 0 && (
                        <div className="bg-white/60 rounded-xl p-4">
                          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                            Options
                          </p>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            {question.options.map((option, optionIndex) => {
                              const letter = letters[optionIndex]

                              return (
                                <p
                                  key={optionIndex}
                                  className={`text-xs rounded-lg px-3 py-2 ${
                                    letter === correctAnswer
                                      ? 'bg-green-100 text-green-700 font-semibold'
                                      : letter === selectedAnswer && !isCorrect
                                        ? 'bg-red-100 text-red-700 font-semibold'
                                        : 'bg-gray-50 text-gray-600'
                                  }`}
                                >
                                  <span className="font-semibold">{letter}.</span> {option}
                                </p>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )
      })()}

      {(selectedWritingReview || selectedMockWritingReview) && (() => {
        const reviewTarget = selectedWritingReview || selectedMockWritingReview
        const isMockReview = Boolean(selectedMockWritingReview)
        const reviewTitle = isMockReview
          ? reviewTarget.mock?.title || reviewTarget.submission.mockTitle || 'Mock Test'
          : reviewTarget.writing.title

        const task1Prompt = isMockReview
          ? reviewTarget.mock?.writing?.task1?.prompt || reviewTarget.mock?.task1?.prompt || 'Mock Writing Task 1'
          : reviewTarget.writing.task1?.prompt

        const task1Image = isMockReview
          ? reviewTarget.mock?.writing?.task1?.image || reviewTarget.mock?.task1?.image
          : reviewTarget.writing.task1?.image

        const task2Prompt = isMockReview
          ? reviewTarget.mock?.writing?.task2?.prompt || reviewTarget.mock?.task2?.prompt || 'Mock Writing Task 2'
          : reviewTarget.writing.task2?.prompt

        const task1Answer = isMockReview
          ? getMockTask1Answer(reviewTarget.submission)
          : reviewTarget.submission.task1Answer

        const task2Answer = isMockReview
          ? getMockTask2Answer(reviewTarget.submission)
          : reviewTarget.submission.task2Answer

        const task1WordCount = isMockReview
          ? getMockTask1WordCount(reviewTarget.submission)
          : reviewTarget.submission.task1WordCount

        const task2WordCount = isMockReview
          ? getMockTask2WordCount(reviewTarget.submission)
          : reviewTarget.submission.task2WordCount

        const writingSource = isMockReview
          ? reviewTarget.mock
          : reviewTarget.writing

        const task1Enabled = isWritingTask1Enabled(
          writingSource,
          reviewTarget.submission
        )

        const task2Enabled = isWritingTask2Enabled(
          writingSource,
          reviewTarget.submission
        )

        const reviewTaskLabel = getWritingTaskLabel(
          writingSource,
          reviewTarget.submission
        )

        return (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl w-full max-w-6xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-start justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-gray-900">
                  {isMockReview ? 'Mock Writing Review' : 'Writing Review'}
                </h2>

                <p className="text-sm text-gray-400">
                  {reviewTarget.student.name} — {reviewTitle}
                </p>
              </div>

              <button
                onClick={() => {
                  setSelectedWritingReview(null)
                  setSelectedMockWritingReview(null)
                }}
                className="text-sm text-gray-400 hover:text-gray-600"
              >
                Close
              </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-6">
                <div className="bg-purple-50 border border-purple-100 rounded-2xl p-4">
                  <p className="text-xs text-purple-500 mb-1">Writing type</p>
                  <p className="text-sm font-semibold text-purple-800">
                    {reviewTaskLabel}
                  </p>
                </div>

                {task1Enabled && (
                  <div className="border border-gray-100 rounded-2xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-semibold text-gray-800">
                        Task 1 Answer
                      </h3>

                      <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
                        {task1WordCount || 0} words
                      </span>
                    </div>

                    <p className="text-xs text-gray-400 mb-3">
                      Prompt:
                    </p>

                    <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap mb-4 bg-gray-50 rounded-xl p-4">
                      {task1Prompt || 'No Task 1 prompt'}
                    </p>

                    {task1Image && (
                      <img
                        src={task1Image}
                        alt="Task 1"
                        className="w-full max-h-[320px] object-contain bg-gray-50 rounded-xl border border-gray-100 mb-4"
                      />
                    )}

                    <p className="text-sm text-gray-800 leading-7 whitespace-pre-wrap">
                      {task1Answer || 'No Task 1 answer'}
                    </p>
                  </div>
                )}

                {task2Enabled && (
                  <div className="border border-gray-100 rounded-2xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-semibold text-gray-800">
                        Task 2 Answer
                      </h3>

                      <span className="text-xs bg-indigo-50 text-indigo-600 px-3 py-1 rounded-full">
                        {task2WordCount || 0} words
                      </span>
                    </div>

                    <p className="text-xs text-gray-400 mb-3">
                      Prompt:
                    </p>

                    <p className="text-sm text-gray-700 leading-7 whitespace-pre-wrap mb-4 bg-gray-50 rounded-xl p-4">
                      {task2Prompt || 'No Task 2 prompt'}
                    </p>

                    <p className="text-sm text-gray-800 leading-7 whitespace-pre-wrap">
                      {task2Answer || 'No Task 2 answer'}
                    </p>
                  </div>
                )}
              </div>

              <div className="border border-gray-100 rounded-2xl p-5 h-fit sticky top-5">
                <h3 className="font-semibold text-gray-800 mb-2">
                  Teacher Evaluation
                </h3>

                <p className="text-xs text-gray-400 mb-5">
                  Use IELTS Writing criteria. For full Writing, Task 2 counts twice as much as Task 1 in the suggested overall band. Single-task work uses that task's band. You can still edit the final band manually.
                </p>

                <div className="bg-purple-50 rounded-2xl p-4 mb-5">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div>
                      <p className="text-xs text-gray-500">
                        Suggested Overall
                      </p>

                      <p className="text-2xl font-bold text-purple-700">
                        {suggestedOverallBand || '--'}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={useSuggestedBands}
                      className="text-xs bg-purple-600 text-white px-4 py-2 rounded-xl hover:bg-purple-700"
                    >
                      Use Suggested Bands
                    </button>
                  </div>

                  <div className={`grid gap-3 ${task1Enabled && task2Enabled ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    {task1Enabled && (
                      <div className="bg-white rounded-xl p-3">
                        <p className="text-xs text-gray-400 mb-1">
                          Suggested Task 1
                        </p>

                        <p className="text-lg font-bold text-purple-600">
                          {suggestedTask1Band || '--'}
                        </p>
                      </div>
                    )}

                    {task2Enabled && (
                      <div className="bg-white rounded-xl p-3">
                        <p className="text-xs text-gray-400 mb-1">
                          Suggested Task 2
                        </p>

                        <p className="text-lg font-bold text-indigo-600">
                          {suggestedTask2Band || '--'}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {task1Enabled && (
                  <div className="border border-gray-100 rounded-2xl p-4 mb-5">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="font-semibold text-gray-800">
                        Task 1 Rubric
                      </h4>

                      <span className="text-xs bg-purple-50 text-purple-600 px-3 py-1 rounded-full">
                        Academic Task 1
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      {[
                        ['task1TA', 'Task Achievement'],
                        ['task1CC', 'Coherence & Cohesion'],
                        ['task1LR', 'Lexical Resource'],
                        ['task1GRA', 'Grammar Range & Accuracy']
                      ].map(([key, label]) => (
                        <div key={key}>
                          <label className="text-xs text-gray-400 block mb-1">
                            {label}
                          </label>

                          <input
                            type="number"
                            min="0"
                            max="9"
                            step="0.5"
                            value={writingReviewForm[key]}
                            onChange={e =>
                              setWritingReviewForm(prev => ({
                                ...prev,
                                [key]: e.target.value
                              }))
                            }
                            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {task2Enabled && (
                  <div className="border border-gray-100 rounded-2xl p-4 mb-5">
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="font-semibold text-gray-800">
                        Task 2 Rubric
                      </h4>

                      <span className="text-xs bg-indigo-50 text-indigo-600 px-3 py-1 rounded-full">
                        Essay
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      {[
                        ['task2TR', 'Task Response'],
                        ['task2CC', 'Coherence & Cohesion'],
                        ['task2LR', 'Lexical Resource'],
                        ['task2GRA', 'Grammar Range & Accuracy']
                      ].map(([key, label]) => (
                        <div key={key}>
                          <label className="text-xs text-gray-400 block mb-1">
                            {label}
                          </label>

                          <input
                            type="number"
                            min="0"
                            max="9"
                            step="0.5"
                            value={writingReviewForm[key]}
                            onChange={e =>
                              setWritingReviewForm(prev => ({
                                ...prev,
                                [key]: e.target.value
                              }))
                            }
                            className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className={`grid gap-3 mb-5 ${task1Enabled && task2Enabled ? 'grid-cols-3' : 'grid-cols-2'}`}>
                  {task1Enabled && (
                    <div>
                      <label className="text-xs text-gray-400 block mb-1">
                        Task 1 Band
                      </label>

                      <input
                        type="number"
                        min="0"
                        max="9"
                        step="0.5"
                        value={writingReviewForm.task1Band}
                        onChange={e =>
                          setWritingReviewForm(prev => ({
                            ...prev,
                            task1Band: e.target.value
                          }))
                        }
                        placeholder={suggestedTask1Band || ''}
                        className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                      />
                    </div>
                  )}

                  {task2Enabled && (
                    <div>
                      <label className="text-xs text-gray-400 block mb-1">
                        Task 2 Band
                      </label>

                      <input
                        type="number"
                        min="0"
                        max="9"
                        step="0.5"
                        value={writingReviewForm.task2Band}
                        onChange={e =>
                          setWritingReviewForm(prev => ({
                            ...prev,
                            task2Band: e.target.value
                          }))
                        }
                        placeholder={suggestedTask2Band || ''}
                        className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                      />
                    </div>
                  )}

                  <div>
                    <label className="text-xs text-gray-400 block mb-1">
                      Overall
                    </label>

                    <input
                      type="number"
                      min="0"
                      max="9"
                      step="0.5"
                      value={writingReviewForm.overall}
                      onChange={e =>
                        setWritingReviewForm(prev => ({
                          ...prev,
                          overall: e.target.value
                        }))
                      }
                      placeholder={suggestedOverallBand || ''}
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400"
                    />
                  </div>
                </div>

                {task1Enabled && (
                  <div className="mb-4">
                    <label className="text-xs text-gray-400 block mb-1">
                      Task 1 Feedback
                    </label>

                    <textarea
                      rows={4}
                      value={writingReviewForm.task1Feedback}
                      onChange={e =>
                        setWritingReviewForm(prev => ({
                          ...prev,
                          task1Feedback: e.target.value
                        }))
                      }
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 resize-none"
                      placeholder="Comment on Task 1..."
                    />
                  </div>
                )}

                {task2Enabled && (
                  <div className="mb-4">
                    <label className="text-xs text-gray-400 block mb-1">
                      Task 2 Feedback
                    </label>

                    <textarea
                      rows={4}
                      value={writingReviewForm.task2Feedback}
                      onChange={e =>
                        setWritingReviewForm(prev => ({
                          ...prev,
                          task2Feedback: e.target.value
                        }))
                      }
                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 resize-none"
                      placeholder="Comment on Task 2..."
                    />
                  </div>
                )}

                <div className="mb-5">
                  <label className="text-xs text-gray-400 block mb-1">
                    General Feedback
                  </label>

                  <textarea
                    rows={4}
                    value={writingReviewForm.generalFeedback}
                    onChange={e =>
                      setWritingReviewForm(prev => ({
                        ...prev,
                        generalFeedback: e.target.value
                      }))
                    }
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400 resize-none"
                    placeholder="Overall writing feedback..."
                  />
                </div>

                <button
                  onClick={isMockReview ? saveMockWritingReview : saveWritingReview}
                  className="w-full bg-purple-600 text-white rounded-xl py-3 text-sm font-medium hover:bg-purple-700"
                >
                  {isMockReview ? 'Save Mock Writing Review' : 'Save Writing Review'}
                </button>
              </div>
            </div>
          </div>
        </div>
        )
      })()}

      {legacyCascadeDialog && (
        <LegacyCascadeDialog key={legacyCascadeDialog.key} state={legacyCascadeDialog}
          onCancel={() => setLegacyCascadeDialog(null)} onConfirm={confirmLegacyContentPurge} />
      )}

      {showPasswordModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm">
            <h2 className="font-semibold text-gray-800 mb-4">
              Change Password
            </h2>

            {passwordMsg && (
              <div
                className={`text-sm rounded-xl p-3 mb-4 ${
                  passwordMsg.includes('Error')
                    ? 'bg-red-50 text-red-600'
                    : 'bg-green-50 text-green-600'
                }`}
              >
                {passwordMsg}
              </div>
            )}

            <div className="mb-4">
              <label className="text-xs text-gray-400 mb-1 block">
                New password
              </label>

              <input
                type="password"
                className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-purple-400"
                placeholder="At least 6 characters"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => {
                  setShowPasswordModal(false)
                  setPasswordMsg('')
                  setNewPassword('')
                }}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-500"
              >
                Cancel
              </button>

              <button
                onClick={handleChangePassword}
                className="flex-1 py-2.5 rounded-xl bg-purple-600 text-white text-sm font-medium"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
