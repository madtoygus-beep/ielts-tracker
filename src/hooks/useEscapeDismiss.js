import { useEffect, useRef } from 'react'
import { createEscapeDismissRegistry } from '../services/escapeDismissPolicy'

const registries = new WeakMap()

// Return true when a visible layer closes OR must stay open while saving.
// Return false only when this handler has no visible layer to dismiss.
export function useEscapeDismiss(onEscape, priority = 0) {
  const handlerRef = useRef(onEscape)
  handlerRef.current = onEscape
  useEffect(() => {
    let registry = registries.get(window)
    if (!registry) {
      registry = createEscapeDismissRegistry(window)
      registries.set(window, registry)
    }
    return registry.register(() => handlerRef.current?.() === true, priority)
  }, [priority])
}
