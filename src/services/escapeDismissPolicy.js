// Shared keyboard dispatch: only the highest visible handler consumes Escape.
// A busy visible dialog returns true without closing, blocking lower layers.
export function createEscapeDismissRegistry(target) {
  const handlers = new Map()
  let order = 0
  const onKeyDown = event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.repeat) return
    const sorted = [...handlers.values()].sort((a, b) => b.priority - a.priority || b.order - a.order)
    for (const item of sorted) {
      if (item.handler() === true) {
        event.preventDefault()
        return
      }
    }
  }
  return {
    register(handler, priority = 0) {
      const key = ++order
      if (!handlers.size) target.addEventListener('keydown', onKeyDown)
      handlers.set(key, { handler, priority, order: key })
      return () => {
        handlers.delete(key)
        if (!handlers.size) target.removeEventListener('keydown', onKeyDown)
      }
    }
  }
}

// Set synchronously before an async write, including before the next render.
export async function runWithDismissLock(lock, operation) {
  if (lock.current) return
  lock.current = true
  try { return await operation() }
  finally { lock.current = false }
}
