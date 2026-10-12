import { useCallback, useEffect, useMemo, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'

const api = Object.fromEntries([
  'listSelfStudyPackages', 'saveSelfStudyPackage', 'setSelfStudyPackageStatus',
  'getSelfStudyFreeSamples', 'setSelfStudyFreeSamples', 'listSelfStudyLearners',
  'listSelfStudyEntitlements', 'grantSelfStudyPackage', 'revokeSelfStudyPackage',
  'listSelfStudyMasterContent'
].map(name => [name, httpsCallable(functions, name)]))

const TYPE_LABELS = { reading: 'Reading', listening: 'Listening', writing: 'Writing', vocabulary: 'Vocabulary', mock: 'Mock' }
const card = 'rounded-2xl border border-gray-200 bg-white p-5 shadow-sm'
const input = 'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-200'
const btn = 'rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50'
const freshForm = () => ({ id: '', title: '', description: '', accessType: 'paid', price: '', currency: 'TRY', contentIds: [], featured: false, order: '0' })
const money = p => new Intl.NumberFormat('tr-TR', { style: 'currency', currency: p.currency || 'TRY' }).format((p.priceMinor || 0) / 100)
function messageFor(error) { return String(error?.message || 'Operation failed. Try again.').replace(/^FirebaseError:\s*/, '') }

export default function SelfStudyPackages() {
  const [tab, setTab] = useState('packages')
  const [packages, setPackages] = useState([])
  const [masters, setMasters] = useState([])
  const [masterCursor, setMasterCursor] = useState(null)
  const [samples, setSamples] = useState([])
  const [draftSamples, setDraftSamples] = useState([])
  const [learners, setLearners] = useState([])
  const [selectedLearner, setSelectedLearner] = useState('')
  const [entitlements, setEntitlements] = useState([])
  const [grantPackage, setGrantPackage] = useState('')
  const [grantExpiry, setGrantExpiry] = useState('')
  const [searchEmail, setSearchEmail] = useState('')
  const [form, setForm] = useState(freshForm)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const call = async (name, args = {}) => (await api[name](args)).data || {}
  const reloadPackages = useCallback(async () => {
    const result = await api.listSelfStudyPackages({})
    setPackages(result.data?.packages || [])
  }, [])
  const reloadSamples = useCallback(async () => {
    const result = await api.getSelfStudyFreeSamples({})
    const ids = result.data?.contentIds || []
    setSamples(ids)
    setDraftSamples(ids)
  }, [])
  const reloadLearners = useCallback(async email => {
    const result = await api.listSelfStudyLearners({ email: email || '' })
    setLearners(result.data?.learners || [])
    return result.data || {}
  }, [])
  const reloadMasters = useCallback(async (cursor = null) => {
    const result = await api.listSelfStudyMasterContent({ cursor, limit: 80 })
    const list = result.data?.items || []
    setMasters(old => cursor ? [...old.filter(x => !list.some(y => x.id === y.id)), ...list] : list)
    setMasterCursor(result.data?.nextCursor || null)
  }, [])
  const reloadEntitlements = useCallback(async uid => {
    if (!uid) { setEntitlements([]); return }
    const result = await api.listSelfStudyEntitlements({ userId: uid })
    setEntitlements(result.data?.entitlements || [])
  }, [])
  useEffect(() => {
    let active = true
    Promise.all([reloadPackages(), reloadSamples(), reloadMasters(), reloadLearners()])
      .catch(err => { if (active) setError(messageFor(err)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [reloadPackages, reloadSamples, reloadMasters, reloadLearners])

  const rootMasters = useMemo(() => masters.filter(m => !m.linkedFromMasterMockId && m.status !== 'archived'), [masters])
  const activePackages = packages.filter(p => p.status === 'active')
  const packageById = id => packages.find(p => p.id === id)
  const masterById = id => masters.find(m => m.id === id)

  const perform = async (work, success) => {
    if (busy) return
    setBusy(true); setError(''); setMessage('')
    try { await work(); setMessage(success) }
    catch (err) { setError(messageFor(err)) }
    finally { setBusy(false) }
  }
  const startEdit = p => {
    setForm({ id: p.id, title: p.title, description: p.description || '', accessType: p.accessType,
      price: p.priceMinor ? String(p.priceMinor / 100) : '', currency: p.currency,
      contentIds: p.contentIds || [], featured: !!p.featured, order: String(p.order || 0) })
    setTab('packages'); setError(''); setMessage('')
  }
  const save = event => {
    event.preventDefault()
    const priceStr = (form.price || '').replace(',', '.').trim()
    if (form.accessType === 'paid' && priceStr && !/^\d+(\.\d{1,2})?$/.test(priceStr)) {
      setError('Enter a valid price with at most two decimal places.'); return
    }
    const minor = form.accessType === 'free' ? 0 : priceStr ? Math.round(Number(priceStr) * 100) : 0
    if (!Number.isSafeInteger(minor) || minor < 0) { setError('Invalid price.'); return }
    const changes = { title: form.title.trim(), description: form.description.trim(), accessType: form.accessType,
      priceMinor: minor, currency: form.currency, contentIds: form.contentIds,
      featured: form.featured, order: Number(form.order) || 0 }
    const published = packages.find(p => p.id === form.id && p.status === 'active')
    if (published && !window.confirm('This package is ACTIVE. Saving changes may immediately affect existing subscribers. Continue?')) return
    perform(async () => {
      await call('saveSelfStudyPackage', { ...(form.id ? { packageId: form.id } : {}), changes })
      await reloadPackages()
      setForm(freshForm())
    }, form.id ? 'Package saved. Published changes affect existing subscribers.' : 'Draft package created. Activate it when ready.')
  }
  const changeStatus = (p, status) => {
    const question = status === 'active'
      ? `Activate "${p.title}"? All free users or granted learners will see its contents. No checkout is enabled.`
      : `${status === 'archived' ? 'Archive' : 'Return to draft'} "${p.title}"? Existing learners will lose access while it is not active.`
    if (!window.confirm(question)) return
    perform(async () => {
      await call('setSelfStudyPackageStatus', { packageId: p.id, status })
      await reloadPackages()
    }, `Package is now ${status}.`)
  }
  const toggleId = (id, selected, update) => update(old => selected ? old.filter(x => x !== id) : [...old, id])
  const togglePackageContent = id => setForm(old => ({ ...old,
    contentIds: old.contentIds.includes(id) ? old.contentIds.filter(x => x !== id) : [...old.contentIds, id] }))
  const saveSamples = () => perform(async () => {
    await call('setSelfStudyFreeSamples', { contentIds: draftSamples })
    await reloadSamples()
  }, 'Free sample selections saved for future learner release. Individual practice is currently paused.')
  const searchLearners = e => {
    e.preventDefault()
    perform(async () => {
      const result = await reloadLearners(searchEmail.trim().toLowerCase())
      setSelectedLearner(''); setEntitlements([])
      if (result.limited) setMessage('Showing the first 100 individual accounts. Search by full email if needed.')
    }, 'Individual learner list loaded.')
  }
  const selectLearner = uid => {
    setSelectedLearner(uid)
    perform(() => reloadEntitlements(uid), 'Learner package access loaded.')
  }
  const grant = () => {
    if (!selectedLearner || !grantPackage) { setError('Choose an individual learner and an active package.'); return }
    const learner = learners.find(l => l.uid === selectedLearner)
    if (!window.confirm(`Grant "${packageById(grantPackage)?.title || grantPackage}" to ${learner?.email || selectedLearner}? This does not charge their card.`)) return
    const expiresAt = grantExpiry ? new Date(`${grantExpiry}T23:59:59`).toISOString() : null
    perform(async () => {
      await call('grantSelfStudyPackage', { userId: selectedLearner, packageId: grantPackage, expiresAt })
      await reloadEntitlements(selectedLearner)
    }, 'Manual access recorded for future learner release. No payment was taken.')
  }
  const revoke = e => {
    if (!window.confirm(`Revoke ${packageById(e.packageId)?.title || e.packageId} for this learner?`)) return
    perform(async () => {
      await call('revokeSelfStudyPackage', { userId: selectedLearner, packageId: e.packageId })
      await reloadEntitlements(selectedLearner)
    }, 'Package access revoked.')
  }

  return (
    <section className="mt-10" aria-label="Self-Study packages and entitlements">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div><p className="text-xs uppercase tracking-wide text-purple-700 font-semibold">P4D · Access management</p>
          <h2 className="text-xl font-bold text-gray-900 mt-1">Packages, Free Samples & Entitlements</h2>
          <p className="text-sm text-gray-500 mt-1">Prepare packages and internal access records. Individual practice is paused; checkout is not enabled.</p>
        </div>
        <span className="rounded-full px-3 py-1.5 bg-purple-50 border border-purple-100 text-purple-700 text-xs font-medium">Internal setup only</span>
      </div>
      <div className="flex gap-2 flex-wrap mb-5" role="tablist">
        {[['packages', 'Packages'], ['samples', 'Free Samples'], ['access', 'Learner Access']].map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => { setTab(key); setError(''); setMessage('') }}
            className={`${btn} ${tab === key ? 'bg-purple-700 text-white' : 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50'}`}>{label}</button>
        ))}
      </div>
      {error && <p role="alert" className="text-sm text-red-700 p-3 rounded-xl border border-red-200 bg-red-50 mb-5">{error}</p>}
      {message && <p role="status" className="text-sm text-green-700 p-3 rounded-xl border border-green-200 bg-green-50 mb-5">{message}</p>}
      {loading && <p className="text-sm text-gray-500">Loading manager data...</p>}

      {tab === 'packages' && !loading && <div className="grid xl:grid-cols-2 gap-5">
        <div className={card}>
          <div className="flex justify-between gap-2 mb-4"><h3 className="font-semibold text-gray-900">{form.id ? 'Edit package' : 'New package'}</h3>
            <button type="button" onClick={() => setForm(freshForm())} className="text-sm text-purple-700 hover:underline">Clear form</button></div>
          <form onSubmit={save} className="space-y-4">
            <label className="block text-sm font-medium text-gray-700">Package title
              <input className={`${input} mt-1`} maxLength={140} value={form.title} onChange={e => setForm(x => ({ ...x, title: e.target.value }))} required /></label>
            <label className="block text-sm font-medium text-gray-700">Description
              <textarea className={`${input} mt-1`} rows={3} maxLength={600} value={form.description} onChange={e => setForm(x => ({ ...x, description: e.target.value }))} /></label>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block text-sm font-medium text-gray-700">Access type
                <select className={`${input} mt-1`} value={form.accessType} onChange={e => setForm(x => ({ ...x, accessType: e.target.value, price: e.target.value === 'free' ? '' : x.price }))}>
                  <option value="paid">Paid (manual grant now)</option><option value="free">Free for all individuals</option>
                </select></label>
              <label className="block text-sm font-medium text-gray-700">Price (major units)
                <input className={`${input} mt-1`} inputMode="decimal" placeholder="e.g. 490.00" value={form.accessType === 'free' ? '0' : form.price}
                  disabled={form.accessType === 'free'} onChange={e => setForm(x => ({ ...x, price: e.target.value }))} /></label>
              <label className="block text-sm font-medium text-gray-700">Currency
                <select className={`${input} mt-1`} value={form.currency} onChange={e => setForm(x => ({ ...x, currency: e.target.value }))}>
                  {['TRY', 'EUR', 'USD', 'GBP'].map(v => <option key={v}>{v}</option>)}
                </select></label>
              <label className="block text-sm font-medium text-gray-700">Display order
                <input className={`${input} mt-1`} type="number" min="0" max="100000" value={form.order} onChange={e => setForm(x => ({ ...x, order: e.target.value }))} /></label>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" checked={form.featured} onChange={e => setForm(x => ({ ...x, featured: e.target.checked }))} /> Featured package</label>
            <fieldset className="border border-gray-200 rounded-xl p-3">
              <legend className="px-1 font-medium text-sm text-gray-800">Select Master Content ({form.contentIds.length})</legend>
              <p className="text-xs text-gray-500 mb-2">Choose independent copies. Linked Mock parts come with their root automatically.</p>
              <div className="max-h-64 overflow-y-auto space-y-1">
                {rootMasters.map(m => <label key={m.id} className="flex items-start gap-2 text-xs rounded-lg p-2 hover:bg-gray-50 cursor-pointer">
                  <input type="checkbox" checked={form.contentIds.includes(m.id)} onChange={() => togglePackageContent(m.id)} />
                  <span><strong>{m.title}</strong> <span className="text-gray-400">· {TYPE_LABELS[m.contentType] || m.contentType}</span></span>
                </label>)}
                {!rootMasters.length && <p className="text-xs text-gray-500 p-2">Import items into Master Library first.</p>}
              </div>
              {masterCursor && <button type="button" disabled={busy} onClick={() => perform(() => reloadMasters(masterCursor), 'More master content loaded.')} className="text-xs text-purple-700 mt-2">Load more content</button>}
            </fieldset>
            <button type="submit" disabled={busy} className={`${btn} bg-purple-700 text-white hover:bg-purple-800`}>{busy ? 'Saving...' : form.id ? 'Save changes' : 'Create draft package'}</button>
          </form>
        </div>
        <div className="space-y-3">
          <h3 className="font-semibold text-gray-900">Existing packages ({packages.length})</h3>
          {!packages.length && <p className={`${card} text-sm text-gray-500`}>No packages yet. Create a draft on the left.</p>}
          {packages.map(p => <article key={p.id} className={card}>
            <div className="flex justify-between items-start gap-3 mb-2">
              <div><h4 className="font-semibold text-gray-900">{p.title}</h4><p className="text-xs text-gray-500 mt-1">{p.accessType === 'free' ? 'Free' : money(p)} · {p.contentIds.length} activities</p></div>
              <span className={`text-xs rounded-full px-2.5 py-1 ${p.status === 'active' ? 'bg-green-50 text-green-700' : p.status === 'archived' ? 'bg-gray-100 text-gray-600' : 'bg-amber-50 text-amber-700'}`}>{p.status}</span>
            </div>
            {p.description && <p className="text-sm text-gray-600 leading-6 mb-2">{p.description}</p>}
            <p className="text-xs text-gray-400 mb-3">{p.contentIds.map(id => masterById(id)?.title || id).join(' · ') || 'No activities yet'}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => startEdit(p)} className={`${btn} border border-gray-200`}>Edit</button>
              {p.status !== 'active' && <button type="button" disabled={busy} onClick={() => changeStatus(p, 'active')} className={`${btn} bg-purple-700 text-white`}>Activate</button>}
              {p.status === 'active' && <button type="button" disabled={busy} onClick={() => changeStatus(p, 'draft')} className={`${btn} border border-gray-200`}>Return to draft</button>}
              {p.status !== 'archived' && <button type="button" disabled={busy} onClick={() => changeStatus(p, 'archived')} className={`${btn} border border-gray-200`}>Archive</button>}
            </div>
          </article>)}
        </div>
      </div>}

      {tab === 'samples' && !loading && <div className={card}>
        <h3 className="font-semibold text-gray-900 mb-1">Free Sample Library</h3>
        <p className="text-sm text-gray-500 mb-4">Every approved individual learner can open these independent activities, without a package grant. Keep samples limited and deliberate.</p>
        <div className="grid md:grid-cols-2 gap-2 max-h-96 overflow-y-auto">
          {rootMasters.map(m => <label key={m.id} className="rounded-xl border border-gray-100 p-3 flex gap-3 cursor-pointer hover:bg-gray-50">
            <input type="checkbox" checked={draftSamples.includes(m.id)} onChange={() => toggleId(m.id, draftSamples.includes(m.id), setDraftSamples)} />
            <span className="text-sm"><strong>{m.title}</strong><span className="block text-xs text-gray-500 mt-1">{TYPE_LABELS[m.contentType] || m.contentType}</span></span>
          </label>)}
        </div>
        {masterCursor && <button type="button" disabled={busy} onClick={() => perform(() => reloadMasters(masterCursor), 'More master content loaded.')} className="text-xs text-purple-700 mt-3">Load more content</button>}
        <div className="flex flex-wrap items-center gap-3 mt-5">
          <button type="button" disabled={busy || draftSamples.length > 25} onClick={saveSamples} className={`${btn} bg-purple-700 text-white`}>Publish Free Samples ({draftSamples.length})</button>
          <span className="text-xs text-gray-500">Currently published: {samples.length} · Maximum 25</span>
        </div>
      </div>}

      {tab === 'access' && !loading && <div className="grid lg:grid-cols-2 gap-5">
        <div className={card}>
          <h3 className="font-semibold text-gray-900 mb-2">Individual learner accounts</h3>
          <form onSubmit={searchLearners} className="flex flex-wrap gap-2 mb-4">
            <input className={`${input} flex-1 min-w-48`} placeholder="Full email (optional)" value={searchEmail} onChange={e => setSearchEmail(e.target.value)} />
            <button type="submit" disabled={busy} className={`${btn} border border-gray-200`}>Search / Refresh</button>
          </form>
          <p className="text-xs text-gray-500 mb-3">Only independent accounts appear. Institution teachers and students are excluded.</p>
          <div className="max-h-96 overflow-y-auto space-y-2">
            {learners.map(l => <button type="button" key={l.uid} onClick={() => selectLearner(l.uid)} disabled={busy}
              className={`block text-left w-full rounded-xl border px-3 py-3 ${selectedLearner === l.uid ? 'border-purple-400 bg-purple-50' : 'border-gray-100 hover:bg-gray-50'}`}>
              <p className="font-medium text-sm break-all">{l.name || l.email || 'Individual learner'}</p>
              <p className="text-xs text-gray-500 break-all">{l.email} · {l.deleted ? 'archived' : l.status}</p>
            </button>)}
            {!learners.length && <p className="text-sm text-gray-500">No individual accounts found.</p>}
          </div>
        </div>
        <div className={card}>
          <h3 className="font-semibold text-gray-900 mb-3">Manual package assignment</h3>
          {!selectedLearner ? <p className="text-sm text-gray-500">Select an individual learner on the left.</p> : <>
            <p className="text-xs text-gray-500 mb-3 break-all">Account: {learners.find(l => l.uid === selectedLearner)?.email}</p>
            <label className="block text-sm font-medium text-gray-700 mb-3">Active paid package
              <select className={`${input} mt-1`} value={grantPackage} onChange={e => setGrantPackage(e.target.value)}>
                <option value="">Choose a package</option>
                {activePackages.filter(p => p.accessType === 'paid').map(p => <option key={p.id} value={p.id}>{p.title} · {money(p)}</option>)}
              </select></label>
            <label className="block text-sm font-medium text-gray-700 mb-3">Expiry (optional)
              <input className={`${input} mt-1`} type="date" value={grantExpiry} onChange={e => setGrantExpiry(e.target.value)} />
            </label>
            <button type="button" onClick={grant} disabled={busy || !grantPackage} className={`${btn} bg-purple-700 text-white`}>Grant access without payment</button>
            <p className="text-xs text-amber-700 bg-amber-50 rounded-xl p-3 mt-3">This is a manual entitlement, not proof of payment. Online checkout is introduced in P8A.</p>
            <h4 className="font-semibold text-gray-900 mt-6 mb-3">Existing grants ({entitlements.length})</h4>
            <div className="space-y-2">
              {entitlements.map(e => <div key={e.id} className="rounded-xl border border-gray-100 p-3 flex gap-2 justify-between items-start">
                <div><p className="text-sm font-semibold">{packageById(e.packageId)?.title || e.packageId}</p>
                  <p className="text-xs text-gray-500 mt-1">{e.status} · {e.expiresAt ? `expires ${new Date(e.expiresAt).toLocaleDateString('tr-TR')}` : 'no expiry'}</p></div>
                {e.status === 'active' && <button type="button" disabled={busy} onClick={() => revoke(e)} className="text-xs text-red-700 underline">Revoke</button>}
              </div>)}
              {!entitlements.length && <p className="text-sm text-gray-500">No package grants for this learner.</p>}
            </div>
          </>}
        </div>
      </div>}
    </section>
  )
}
