export default function Toast({ toast, onUndo, onDismiss }) {
  if (!toast) return null
  return (
    <div className="toast" role="status">
      <span>{toast.message}</span>
      {toast.undo && <button onClick={onUndo}>Undo</button>}
      <button onClick={onDismiss} aria-label="Dismiss">×</button>
    </div>
  )
}
