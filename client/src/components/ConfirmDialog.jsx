import { useEffect, useId, useRef } from 'react';

/**
 * A small styled stand-in for window.confirm() so destructive actions
 * (delete/cancel) match the rest of the dashboard's look instead of a bare
 * browser dialog. Reimplements what a native dialog gives for free: Escape
 * to dismiss, focus moved in on open (to the non-destructive Cancel button,
 * so a stray Enter doesn't trigger the destructive action), a two-element
 * focus trap so Tab can't escape to the page behind it, and a backdrop
 * click that dismisses like Cancel.
 *
 * @param {{
 *   open: boolean,
 *   title: string,
 *   message: string,
 *   confirmLabel?: string,
 *   onConfirm: () => void,
 *   onCancel: () => void,
 * }} props
 */
function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', onConfirm, onCancel }) {
  const titleId = useId();
  const messageId = useId();
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        onCancel();
        return;
      }
      if (e.key === 'Tab') {
        // Only two focusable elements ever exist in here -- Tab and
        // Shift+Tab both just toggle between them, trapping focus inside.
        e.preventDefault();
        const next = document.activeElement === cancelRef.current ? confirmRef.current : cancelRef.current;
        next?.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center p-4 z-50" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-3xl shadow-xl max-w-sm w-full p-6 space-y-4"
      >
        <h3 id={titleId} className="text-lg font-extrabold text-slate-900">
          {title}
        </h3>
        <p id={messageId} className="text-sm text-slate-600">
          {message}
        </p>
        <div className="flex gap-3 justify-end pt-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="py-2.5 px-5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-bold hover:bg-slate-50 transition-all"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className="py-2.5 px-5 bg-rose-600 text-white rounded-xl text-sm font-bold hover:bg-rose-700 transition-all active:scale-[0.99]"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
