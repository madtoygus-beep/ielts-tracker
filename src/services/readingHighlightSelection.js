// selectionchange also covers delayed touch selection, native selection handles
// and keyboard selection. Keep a toolbar tap from discarding its pending range.
export function watchReadingHighlightSelection({ document: doc, capture, toolbar, enabled = true }) {
  if (!enabled) return { beginAction() {}, finishAction() {}, dispose() {} }
  let actionPending = false
  let releaseTimer
  const changed = () => {
    const selection = doc.getSelection()
    if ((!selection || selection.rangeCount === 0 || selection.isCollapsed) &&
        (actionPending || toolbar()?.contains(doc.activeElement))) return
    capture()
  }
  const beginAction = event => {
    actionPending = true
    clearTimeout(releaseTimer)
    // Preserve the native selection when a mouse/pen focuses the toolbar.
    // Touch scrolling and the browser's native selection handles stay intact.
    if (event?.pointerType === 'mouse' || event?.pointerType === 'pen') event.preventDefault()
  }
  const finishAction = () => { actionPending = false; clearTimeout(releaseTimer) }
  const released = () => { releaseTimer = setTimeout(finishAction, 150) }
  doc.addEventListener('selectionchange', changed)
  doc.addEventListener('pointerup', released)
  doc.addEventListener('pointercancel', finishAction)
  return {
    beginAction, finishAction,
    dispose() {
      finishAction()
      doc.removeEventListener('selectionchange', changed)
      doc.removeEventListener('pointerup', released)
      doc.removeEventListener('pointercancel', finishAction)
    }
  }
}
