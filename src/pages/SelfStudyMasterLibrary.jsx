import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'

const TYPE_LABELS = {
  reading: 'Reading',
  listening: 'Listening',
  writing: 'Writing',
  vocabulary: 'Vocabulary',
  mock: 'Mock Test'
}

const sourceListCall = httpsCallable(functions, 'listMaximaSourceContent')
const masterListCall = httpsCallable(functions, 'listSelfStudyMasterContent')
const importCall = httpsCallable(functions, 'importMaximaToMasterContent', { timeout: 300000 })
const updateCall = httpsCallable(functions, 'updateSelfStudyMasterContent')
const previewCall = httpsCallable(functions, 'getSelfStudyMasterPreview')

function errorText(error) {
  if (error?.code === 'functions/unauthenticated' || error?.code === 'functions/permission-denied') {
    return 'Your manager permission could not be verified. Sign in again or contact the platform administrator.'
  }
  return String(error?.message || 'The operation failed. Please retry.').replace(/^FirebaseError:\s*/, '')
}

const actionButton = 'rounded-xl px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50'

export default function SelfStudyMasterLibrary() {
  const [sourceType, setSourceType] = useState('reading')
  const [sourceItems, setSourceItems] = useState([])
  const [sourceCursor, setSourceCursor] = useState(null)
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceFilter, setSourceFilter] = useState('')
  const [masterItems, setMasterItems] = useState([])
  const [masterCursor, setMasterCursor] = useState(null)
  const [masterLoading, setMasterLoading] = useState(false)
  const [masterFilter, setMasterFilter] = useState('')
  const [showLinked, setShowLinked] = useState(false)
  const [importingId, setImportingId] = useState('')
  const [editingId, setEditingId] = useState('')
  const [previewId, setPreviewId] = useState('')
  const [previewInfo, setPreviewInfo] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [editingTitle, setEditingTitle] = useState('')
  const [editingDescription, setEditingDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const sourceRequestId = useRef(0)
  const masterRequestId = useRef(0)

  const loadSources = useCallback(async (cursor = null, append = false) => {
    const requestId = ++sourceRequestId.current
    setSourceLoading(true)
    try {
      const result = await sourceListCall({ contentType: sourceType, cursor, limit: 40 })
      if (requestId !== sourceRequestId.current) return
      const data = result.data || {}
      setSourceItems(old => append ? [...old, ...(data.items || [])] : (data.items || []))
      setSourceCursor(data.nextCursor || null)
    } catch (loadError) {
      if (requestId === sourceRequestId.current) setError(errorText(loadError))
    } finally {
      if (requestId === sourceRequestId.current) setSourceLoading(false)
    }
  }, [sourceType])

  const loadMasters = useCallback(async (cursor = null, append = false) => {
    const requestId = ++masterRequestId.current
    setMasterLoading(true)
    try {
      const result = await masterListCall({ cursor, limit: 40 })
      if (requestId !== masterRequestId.current) return
      const data = result.data || {}
      setMasterItems(old => append ? [...old, ...(data.items || [])] : (data.items || []))
      setMasterCursor(data.nextCursor || null)
    } catch (loadError) {
      if (requestId === masterRequestId.current) setError(errorText(loadError))
    } finally {
      if (requestId === masterRequestId.current) setMasterLoading(false)
    }
  }, [])

  useEffect(() => {
    setSourceItems([])
    setSourceCursor(null)
    setSourceFilter('')
    void loadSources()
    return () => { sourceRequestId.current += 1 }
  }, [loadSources])

  useEffect(() => {
    void loadMasters()
    return () => { masterRequestId.current += 1 }
  }, [loadMasters])

  const visibleSources = useMemo(() => sourceItems.filter(item =>
    `${item.title} ${item.contentMode} ${item.id}`.toLowerCase().includes(sourceFilter.toLowerCase().trim())
  ), [sourceItems, sourceFilter])

  const visibleMasters = useMemo(() => masterItems.filter(item =>
    (showLinked || !item.linkedFromMasterMockId) &&
    `${item.title} ${item.contentType} ${item.description} ${item.sourceContentId}`
      .toLowerCase().includes(masterFilter.toLowerCase().trim())
  ), [masterItems, masterFilter, showLinked])

  const performImport = async item => {
    if (importingId || saving) return
    const description = item.contentType === 'mock'
      ? 'This will independently copy the mock and all of its shared Reading, Listening and Writing resources.'
      : 'This will create an independent draft in the Master Library. The Maxima original will not change.'
    if (!window.confirm(`Import "${item.title}"?\n\n${description}`)) return
    setError('')
    setMessage('')
    setImportingId(item.id)
    try {
      const result = await importCall({ contentType: item.contentType, sourceContentId: item.id })
      const data = result.data || {}
      const outcome = data.alreadyImported
        ? 'This exact source version was already imported. No duplicate was made.'
        : `Imported successfully: ${data.createdCount} independent document(s), ${data.assetCount} media file(s).`
      setMessage(`${outcome} Master ID: ${data.masterId}`)
      await loadMasters()
    } catch (importError) {
      setError(errorText(importError))
    } finally {
      setImportingId('')
    }
  }

  const openPreview = async item => {
    if (previewId === item.id) {
      setPreviewId('')
      setPreviewInfo(null)
      return
    }
    setPreviewId(item.id)
    setPreviewInfo(null)
    setPreviewLoading(true)
    setError('')
    try {
      const result = await previewCall({ masterId: item.id })
      setPreviewInfo(result.data?.preview || null)
    } catch (previewError) {
      setError(errorText(previewError))
      setPreviewId('')
    } finally {
      setPreviewLoading(false)
    }
  }

  const startEdit = item => {
    setEditingId(item.id)
    setEditingTitle(item.title)
    setEditingDescription(item.description || '')
    setError('')
    setMessage('')
  }

  const saveEdit = async () => {
    if (!editingId || saving) return
    if (editingTitle.trim().length < 2) {
      setError('Title must contain at least two characters.')
      return
    }
    setError('')
    setSaving(true)
    try {
      await updateCall({
        masterId: editingId,
        changes: { title: editingTitle.trim(), description: editingDescription.trim() }
      })
      setEditingId('')
      setMessage('Master content details saved. Original Maxima content was not changed.')
      await loadMasters()
    } catch (updateError) {
      setError(errorText(updateError))
    } finally {
      setSaving(false)
    }
  }

  const changeStatus = async item => {
    if (saving || importingId) return
    const nextStatus = item.status === 'archived' ? 'draft' : 'archived'
    if (!window.confirm(`${nextStatus === 'archived' ? 'Archive' : 'Restore to draft'} "${item.title}"?\n\nThe copied content and source will not be deleted.`)) return
    setError('')
    setSaving(true)
    try {
      await updateCall({ masterId: item.id, changes: { status: nextStatus } })
      setMessage(`"${item.title}" is now ${nextStatus}.`)
      await loadMasters()
    } catch (updateError) {
      setError(errorText(updateError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="mt-9 space-y-7" aria-labelledby="p4c-heading">
      <div className="flex flex-wrap justify-between gap-3 items-end">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h2 id="p4c-heading" className="text-xl font-bold text-gray-900">Master Content Library</h2>
            <span className="text-[11px] px-2.5 py-1 rounded-full bg-green-50 text-green-800 border border-green-100">P4C</span>
          </div>
          <p className="text-sm text-gray-500 leading-6 max-w-3xl">
            Import shared Maxima IELTS resources as independent, private drafts. Source documents are never edited.
            Mock Tests copy their linked resources; first-party Listening audio and map images are copied into protected storage.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setError(''); setMessage(''); void loadMasters() }}
          disabled={masterLoading}
          className={`${actionButton} border border-gray-200 text-gray-600 bg-white hover:bg-gray-50`}
        >
          {masterLoading ? 'Refreshing...' : 'Refresh library'}
        </button>
      </div>

      {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">{error}</div>}
      {message && <div role="status" className="rounded-xl border border-green-200 bg-green-50 text-green-800 px-4 py-3 text-sm break-words">{message}</div>}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-white border border-gray-200 rounded-2xl p-5 sm:p-6 space-y-5">
          <div>
            <h3 className="font-bold text-gray-900">1. Maxima shared library</h3>
            <p className="text-xs text-gray-500 mt-1 leading-5">
              Only non-archived, school-shared Maxima resources are eligible. Private teacher content and other institutions are excluded.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-xs font-semibold text-gray-600">
              Content type
              <select
                value={sourceType}
                onChange={event => setSourceType(event.target.value)}
                disabled={Boolean(importingId)}
                className="block w-full mt-1 rounded-xl border border-gray-200 px-3 py-2.5 bg-white text-sm"
              >
                {Object.entries(TYPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            <label className="block text-xs font-semibold text-gray-600">
              Filter loaded results
              <input
                value={sourceFilter}
                onChange={event => setSourceFilter(event.target.value)}
                placeholder="Title or source ID"
                className="block w-full mt-1 rounded-xl border border-gray-200 px-3 py-2.5 text-sm"
              />
            </label>
          </div>
          <div className="space-y-3 max-h-[520px] overflow-y-auto pr-1">
            {!sourceLoading && visibleSources.length === 0 && <p className="text-sm text-gray-500 py-5 text-center">No eligible results on the loaded page. Try another type or load more.</p>}
            {visibleSources.map(item => (
              <article key={item.id} className="rounded-xl border border-gray-200 p-4">
                <div className="flex justify-between gap-3 items-start">
                  <div className="min-w-0">
                    <h4 className="font-semibold text-sm text-gray-900 break-words">{item.title}</h4>
                    <p className="text-xs text-gray-500 mt-1">{TYPE_LABELS[item.contentType]} · {item.blocks} question blocks</p>
                    {item.linkedParts > 0 && <p className="text-xs text-indigo-600 mt-1">{item.linkedParts} linked resource(s) copied with mock</p>}
                    <p className="text-[11px] text-gray-400 mt-2 break-all">Source: {item.id}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void performImport(item)}
                    disabled={Boolean(importingId) || saving || item.mediaNeedsUpload}
                    className={`${actionButton} shrink-0 bg-purple-700 text-white hover:bg-purple-800`}
                  >
                    {importingId === item.id ? 'Importing...' : 'Import copy'}
                  </button>
                </div>
                {item.mediaNeedsUpload && <p className="text-xs mt-3 text-amber-700">External audio: upload it to Maxima Firebase Storage before importing.</p>}
              </article>
            ))}
          </div>
          {sourceLoading && <p className="text-xs text-gray-500">Loading shared Maxima resources...</p>}
          <div className="flex justify-between items-center gap-3">
            <p className="text-xs text-gray-400">{sourceItems.length} eligible result(s) loaded</p>
            {sourceCursor && <button type="button" disabled={sourceLoading || Boolean(importingId)} onClick={() => void loadSources(sourceCursor, true)} className={`${actionButton} border border-gray-200 bg-white hover:bg-gray-50`}>Load more</button>}
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-2xl p-5 sm:p-6 space-y-5">
          <div>
            <h3 className="font-bold text-gray-900">2. Independent master copies</h3>
            <p className="text-xs text-gray-500 mt-1 leading-5">
              Drafts can be renamed, described and archived. P4D will add package publishing and learner entitlements.
            </p>
          </div>
          <div className="flex flex-wrap gap-3 items-center">
            <input
              value={masterFilter}
              onChange={event => setMasterFilter(event.target.value)}
              aria-label="Filter master content"
              placeholder="Filter loaded master content"
              className="flex-1 min-w-[170px] rounded-xl border border-gray-200 px-3 py-2.5 text-sm"
            />
            <label className="flex items-center gap-2 text-xs text-gray-600 whitespace-nowrap">
              <input type="checkbox" checked={showLinked} onChange={event => setShowLinked(event.target.checked)} />
              Show mock child copies
            </label>
          </div>
          <div className="space-y-3 max-h-[520px] overflow-y-auto pr-1">
            {!masterLoading && visibleMasters.length === 0 && <p className="text-sm text-gray-500 py-5 text-center">No matching master content on the loaded page yet.</p>}
            {visibleMasters.map(item => (
              <article key={item.id} className="rounded-xl border border-gray-200 p-4 space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="font-semibold text-sm text-gray-900 break-words">{item.title}</h4>
                    <p className="text-xs text-gray-500 mt-1">{TYPE_LABELS[item.contentType] || item.contentType} · {item.blockCount} blocks · {item.assetCount} copied file(s)</p>
                  </div>
                  <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${item.status === 'archived' ? 'bg-gray-100 text-gray-500' : 'bg-indigo-50 text-indigo-700'}`}>
                    {item.status}
                  </span>
                </div>
                {item.description && <p className="text-xs text-gray-600 leading-5 break-words">{item.description}</p>}
                <p className="text-[11px] text-gray-400 break-all">Master ID: {item.id}</p>
                <p className="text-[11px] text-gray-400 break-all">Original: {item.sourceContentId}</p>
                {item.linkedFromMasterMockId && <p className="text-[11px] text-indigo-700">Linked to master mock: {item.linkedFromMasterMockId}</p>}
                {item.linkedMasterContentIds.length > 0 && <p className="text-[11px] text-indigo-700">Independent mock parts: {item.linkedMasterContentIds.length}</p>}
                <div className="flex gap-2 flex-wrap pt-1">
                  <button type="button" onClick={() => void openPreview(item)} disabled={previewLoading} className="text-xs rounded-lg border border-gray-200 px-3 py-2 hover:bg-gray-50">{previewId === item.id ? 'Close preview' : 'Preview'}</button>
                  <button type="button" onClick={() => startEdit(item)} disabled={saving || Boolean(importingId)} className="text-xs rounded-lg border border-gray-200 px-3 py-2 hover:bg-gray-50">Edit details</button>
                  <button type="button" onClick={() => void changeStatus(item)} disabled={saving || Boolean(importingId)} className="text-xs rounded-lg border border-gray-200 px-3 py-2 hover:bg-gray-50">{item.status === 'archived' ? 'Restore to draft' : 'Archive'}</button>
                </div>
                {previewId === item.id && (
                  <div className="mt-3 p-3 rounded-xl border border-indigo-100 bg-indigo-50/40 text-xs text-gray-700 space-y-2">
                    {previewLoading && <p>Loading safe preview...</p>}
                    {previewInfo && <>
                      {previewInfo.passageExcerpt && <p className="leading-5 whitespace-pre-wrap"><strong>Passage excerpt:</strong> {previewInfo.passageExcerpt}</p>}
                      {previewInfo.instructions && <p className="leading-5"><strong>Instructions:</strong> {previewInfo.instructions}</p>}
                      {previewInfo.questions?.length > 0 && <div><strong>Question samples (no answer keys):</strong><ul className="list-disc pl-4 mt-1 space-y-1">{previewInfo.questions.map((question, index) => <li key={index}>{question.type || 'Question'}{question.title ? ` · ${question.title}` : ''}{question.prompt ? `: ${question.prompt}` : ''}</li>)}</ul></div>}
                      {previewInfo.listeningParts?.length > 0 && <p><strong>Listening parts:</strong> {previewInfo.listeningParts.map(part => `${part.title || 'Part'} (${part.questions})`).join(', ')}</p>}
                      {previewInfo.hasAudioCopy && <p><strong>Audio:</strong> protected independent copy available</p>}
                      {previewInfo.writingTask1 && <p className="whitespace-pre-wrap"><strong>Writing Task 1:</strong> {previewInfo.writingTask1}</p>}
                      {previewInfo.task1HasImage && <p><strong>Task 1 image:</strong> embedded in independent copy</p>}
                      {previewInfo.writingTask2 && <p className="whitespace-pre-wrap"><strong>Writing Task 2:</strong> {previewInfo.writingTask2}</p>}
                      {previewInfo.linkedMasterContentIds?.length > 0 && <p><strong>Mock parts:</strong> {previewInfo.linkedMasterContentIds.length} independent resources</p>}
                    </>}
                  </div>
                )}
                {editingId === item.id && (
                  <div className="bg-gray-50 border border-gray-200 p-3 rounded-xl space-y-3 mt-3">
                    <label className="block text-xs font-medium text-gray-600">Master title
                      <input value={editingTitle} onChange={event => setEditingTitle(event.target.value)} maxLength={180} className="block w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg bg-white text-sm" />
                    </label>
                    <label className="block text-xs font-medium text-gray-600">Description
                      <textarea value={editingDescription} onChange={event => setEditingDescription(event.target.value)} maxLength={600} rows={3} className="block w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg bg-white text-sm" />
                    </label>
                    <div className="flex gap-2 flex-wrap">
                      <button type="button" onClick={() => void saveEdit()} disabled={saving} className={`${actionButton} bg-purple-700 text-white hover:bg-purple-800`}>{saving ? 'Saving...' : 'Save'}</button>
                      <button type="button" onClick={() => setEditingId('')} disabled={saving} className={`${actionButton} border border-gray-200`}>Cancel</button>
                    </div>
                  </div>
                )}
              </article>
            ))}
          </div>
          {masterLoading && <p className="text-xs text-gray-500">Loading master content...</p>}
          <div className="flex justify-between items-center gap-3">
            <p className="text-xs text-gray-400">{masterItems.length} master record(s) loaded</p>
            {masterCursor && <button type="button" onClick={() => void loadMasters(masterCursor, true)} disabled={masterLoading} className={`${actionButton} border border-gray-200 bg-white hover:bg-gray-50`}>Load more</button>}
          </div>
        </div>
      </div>
      <p className="text-xs text-gray-500 leading-6 border border-gray-200 bg-white rounded-xl p-4">
        Security: the master content documents contain assessment answers and are inaccessible to browser Firestore queries. Storage copies have no public download tokens. Import is version-specific and does not create institution student assignments. No Self-Study learner access is enabled until P4D.
      </p>
    </section>
  )
}
