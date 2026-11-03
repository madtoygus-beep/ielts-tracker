import { useEffect, useRef } from 'react'

// One safe dismissal per Escape. Callers must not cancel in-progress writes.
export function useEscapeDismiss(onEscape) {
  const handlerRef = useRef(onEscape)
  handlerRef.current = onEscape
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      if (typeof handlerRef.current === 'function' && handlerRef.current() === true) {
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
