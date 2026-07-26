import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from './accessibility';
import type { GameSettingsDialogProps } from './GameSettingsDialog';

export default function GameSettingsDialogLoadFallback({ onDismiss, triggerRef }: GameSettingsDialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus({ open: true, dialogRef, initialFocusRef: closeRef, triggerRef, onDismiss });
  return createPortal(
    <div className="skyjo-settings-overlay fixed inset-0 flex items-end justify-center bg-black/70 px-3 py-4" data-modal-overlay>
      <section aria-label="Settings" aria-modal="true" className="skyjo-panel w-full max-w-lg p-6" ref={dialogRef} role="dialog">
        <p className="skyjo-disabled-note" role="status">Settings are loading. Close this panel to keep playing.</p>
        <button className="skyjo-button mt-4 px-4 py-3" onClick={onDismiss} ref={closeRef} type="button">Close Settings</button>
      </section>
    </div>,
    document.body
  );
}
