import { useEffect, useRef, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
import { readableAiWritingError, safeAiWritingEnvelope } from '../services/aiWritingStudentPolicy'
import {
  MOCK_AI_POLL_MS,
  MOCK_AI_WAIT_LIMIT_MS,
  mockAiGateDecision,
  savedMockWritingScoreReady
} from '../services/mockAiResultGatePolicy'

// Read-only status and result callables. This component NEVER invokes
// evaluateMyAiWriting, a provider, credits or any Firestore client write.
const getMyAiWritingReportCall = httpsCallable(functions, 'getMyAiWritingReport')
const getCompletedMockReviewCall = httpsCallable(functions, 'getCompletedMockReview')
const ACCESS_ERRORS = new Set(['permission-denied', 'unauthenticated'])
const TERMINAL_PARTIAL = new Set(['failed', 'too_short', 'feedback_only'])

function errorCode(error) {
  return String(error?.code || '').replace(/^functions\//, '')
}

function WaitingAnimation() {
  return (
    <div className="mt-7" aria-label="AI Writing assessment in progress">
      <style>{`
        @keyframes maximaMockAiShimmer {
          from { transform: translateX(-120%); }
          to { transform: translateX(410%); }
        }
        @keyframes maximaMockAiPulse {
          0%, 100% { opacity: .5; transform: scale(.92); }
          50% { opacity: 1; transform: scale(1.08); }
        }
        .maxima-mock-ai-shimmer { animation: maximaMockAiShimmer 2.5s ease-in-out infinite; }
        .maxima-mock-ai-pulse { animation: maximaMockAiPulse 2s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .maxima-mock-ai-shimmer, .maxima-mock-ai-pulse { animation: none; }
        }
      `}</style>
      <div className="h-2.5 rounded-full bg-indigo-100 overflow-hidden" aria-hidden="true">
        <div className="relative h-full w-full overflow-hidden rounded-full bg-indigo-100">
          <span className="maxima-mock-ai-shimmer absolute inset-y-0 left-0 w-1/3 rounded-full bg-gradient-to-r from-indigo-400 via-violet-600 to-indigo-400" />
        </div>
      </div>
      <p className="mt-3 text-xs text-gray-500">
        The animation shows that assessment is in progress, not an exact completion percentage.
      </p>
    </div>
  )
}

export default function MockAiResultsGate({ mockTestId, attemptNumber, onRelease, onBack }) {
  const [phase, setPhase] = useState('checking')
  const [errorText, setErrorText] = useState('')
  const [checkNumber, setCheckNumber] = useState(0)
  const [openingPartial, setOpeningPartial] = useState(false)
  const releaseRef = useRef(onRelease)
  const mountedRef = useRef(false)

  useEffect(() => { releaseRef.current = onRelease }, [onRelease])
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    let active = true
    let stopped = false
    let busy = false
    let timer = null
    let limitTimer = null

    const release = (result, outcome) => {
      if (!active || stopped || !result) return
      stopped = true
      releaseRef.current({ result, outcome })
    }

    const check = async () => {
      if (!active || stopped || busy) return
      busy = true
      try {
        const response = await getMyAiWritingReportCall({ context: 'mock', contentId: mockTestId })
        if (!active || stopped) return
        const envelope = safeAiWritingEnvelope(response?.data, attemptNumber, 'mock')
        const initialDecision = mockAiGateDecision(envelope)

        if (initialDecision === 'wait') {
          setPhase(envelope.status === 'processing' ? 'processing' : 'checking')
          setErrorText('')
        } else if (initialDecision === 'syncing' || initialDecision === 'not_funded') {
          // The report may finish before syncMockOverallAfterAiWriting writes
          // aiEstimatedBand and the recomputed Overall to mockSubmissions.
          const review = await getCompletedMockReviewCall({ mockTestId })
          if (!active || stopped) return
          const currentResult = review?.data?.result || null
          if (!currentResult) throw new Error('The saved Mock result is not available yet.')
          const decision = mockAiGateDecision(envelope, currentResult)
          if (decision === 'ready') {
            release(currentResult, 'complete')
          } else if (decision === 'not_funded') {
            release(currentResult, 'not_funded')
          } else {
            setPhase('syncing')
            setErrorText('')
          }
        } else if (TERMINAL_PARTIAL.has(initialDecision)) {
          stopped = true
          setPhase(initialDecision)
          setErrorText('')
        } else if (initialDecision === 'blocked') {
          stopped = true
          setPhase('blocked')
          setErrorText('The AI report does not match this submitted attempt. Please contact your school.')
        } else {
          // A malformed or temporarily unavailable response is never treated
          // as a completed assessment or as permission to show a final score.
          setPhase('checking')
        }
      } catch (error) {
        if (!active || stopped) return
        setErrorText(readableAiWritingError(error))
        if (ACCESS_ERRORS.has(errorCode(error))) {
          stopped = true
          setPhase('blocked')
        } else {
          setPhase('checking')
        }
      } finally {
        busy = false
      }
    }

    void check()
    timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void check()
    }, MOCK_AI_POLL_MS)
    limitTimer = window.setTimeout(() => {
      if (!active || stopped) return
      stopped = true
      setPhase('delayed')
    }, MOCK_AI_WAIT_LIMIT_MS)

    return () => {
      active = false
      stopped = true
      window.clearInterval(timer)
      window.clearTimeout(limitTimer)
    }
  }, [mockTestId, attemptNumber, checkNumber])

  const showAvailableResults = async () => {
    if (!TERMINAL_PARTIAL.has(phase) || openingPartial) return
    setOpeningPartial(true)
    setErrorText('')
    try {
      // A fresh, authorized review is mandatory before exposing even partial
      // results. A cached response never bypasses a revoked assignment.
      const response = await getCompletedMockReviewCall({ mockTestId })
      if (!mountedRef.current) return
      const currentResult = response?.data?.result
      if (!currentResult) throw new Error('Saved Mock results are unavailable.')
      releaseRef.current({
        result: currentResult,
        outcome: savedMockWritingScoreReady(currentResult) ? 'complete' : 'partial'
      })
    } catch (error) {
      if (mountedRef.current) setErrorText(readableAiWritingError(error))
    } finally {
      if (mountedRef.current) setOpeningPartial(false)
    }
  }

  const isWaiting = ['checking', 'processing', 'syncing'].includes(phase)
  const title = phase === 'syncing'
    ? 'Preparing your complete IELTS results'
    : isWaiting
      ? 'AI is evaluating your Writing'
      : phase === 'delayed'
        ? 'Your Writing assessment is taking longer than expected'
        : phase === 'too_short'
          ? 'Writing has 20 words or fewer'
          : phase === 'feedback_only'
            ? 'Writing feedback is ready'
            : phase === 'failed'
              ? 'AI Writing assessment was not completed'
              : 'Your assessment status could not be confirmed'

  const description = phase === 'syncing'
    ? 'Your AI report is ready. We are waiting for its Writing band and final Overall to be saved together.'
    : isWaiting
      ? 'Your exam has been submitted successfully. We are checking the saved AI Writing report before revealing your Mock scores.'
      : phase === 'delayed'
        ? 'Your exam is saved. The assessment may still finish on the server. You can return later or check its status again.'
        : phase === 'too_short'
          ? 'No AI band was generated because the submitted Writing is too short. A teacher can still review your work.'
          : phase === 'feedback_only'
            ? 'Your answers received development feedback, but not a numeric IELTS Writing band. A final Overall requires a valid Writing score.'
            : phase === 'failed'
              ? 'Your exam is saved, but the institution-funded AI check did not finish. No personal AI credit is used by this Mock assessment.'
              : 'We could not safely verify the AI report for this attempt. Your exam remains saved.'

  return (
    <main className="min-h-screen bg-[#faf9f6] flex flex-col">
      <header className="bg-white border-b border-gray-100 px-5 sm:px-8 py-4">
        <img src="/1.png" alt="Maxima" className="h-11 sm:h-14 object-contain" />
      </header>
      <div className="flex-1 flex items-center justify-center px-4 py-10">
        <section className="bg-white border border-indigo-100 shadow-sm rounded-3xl px-6 py-8 sm:p-10 max-w-xl w-full text-center" aria-live="polite">
          <div className="mx-auto mb-5 relative w-20 h-20 flex items-center justify-center rounded-full bg-indigo-50" aria-hidden="true">
            <div className={`w-11 h-11 rounded-full border-4 border-indigo-200 border-t-indigo-600 ${isWaiting ? 'animate-spin motion-reduce:animate-none' : ''}`} />
            {isWaiting && <span className="maxima-mock-ai-pulse absolute inset-2 rounded-full border border-indigo-200" />}
          </div>
          <p className="text-xs font-semibold uppercase tracking-widest text-indigo-600 mb-3">Mock submitted successfully</p>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{title}</h1>
          <p className="mt-4 text-sm sm:text-base leading-7 text-gray-600">{description}</p>

          {isWaiting && (
            <>
              <WaitingAnimation />
              <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-left">
                <div className="rounded-xl bg-emerald-50 text-emerald-800 p-3">✓ Exam saved</div>
                <div className="rounded-xl bg-indigo-50 text-indigo-800 p-3">{phase === 'syncing' ? '✓ AI reviewed' : 'AI reviewing Writing'}</div>
                <div className="rounded-xl bg-gray-50 text-gray-600 p-3">Complete scores next</div>
              </div>
            </>
          )}
          {errorText && <p role="alert" className="mt-5 text-sm text-amber-900 bg-amber-50 rounded-xl p-3">{errorText}</p>}
          <div className="mt-8 flex flex-col sm:flex-row justify-center gap-3">
            {TERMINAL_PARTIAL.has(phase) && (
              <button type="button" onClick={showAvailableResults} disabled={openingPartial}
                className="rounded-xl bg-indigo-700 hover:bg-indigo-800 disabled:opacity-60 px-5 py-3 text-sm font-semibold text-white">
                {openingPartial ? 'Checking results...' : 'View available results'}
              </button>
            )}
            {['delayed', 'blocked', 'failed'].includes(phase) && (
              <button type="button" onClick={() => {
                setPhase('checking')
                setErrorText('')
                setCheckNumber(number => number + 1)
              }}
                className="rounded-xl bg-indigo-700 hover:bg-indigo-800 px-5 py-3 text-sm font-semibold text-white">
                Check AI status again
              </button>
            )}
            <button type="button" onClick={onBack}
              className="rounded-xl bg-gray-100 hover:bg-gray-200 px-5 py-3 text-sm font-medium text-gray-700">
              Back to dashboard
            </button>
          </div>
          {TERMINAL_PARTIAL.has(phase) && (
            <p className="mt-4 text-xs text-gray-500">Available section results are not a final IELTS Mock Overall without a Writing band.</p>
          )}
          {isWaiting && (
            <p className="mt-5 text-xs text-gray-400">No additional AI assessment is started by this screen. You may safely return to the dashboard.</p>
          )}
        </section>
      </div>
    </main>
  )
}
