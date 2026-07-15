import { useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from './accessibility';

export interface ActiveRoomOptionsDialogProps {
  active: boolean;
  children: ReactNode;
  onDismiss: () => void;
  open: boolean;
  roomCode: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" className="skyjo-icon" focusable="false" viewBox="0 0 24 24">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

export default function ActiveRoomOptionsDialog({
  active,
  children,
  onDismiss,
  open,
  roomCode,
  triggerRef
}: ActiveRoomOptionsDialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useModalFocus({
    open: active && open,
    dialogRef,
    initialFocusRef: closeButtonRef,
    triggerRef,
    onDismiss
  });

  if (!active) return <>{children}</>;
  if (!open) return null;

  return createPortal(
    <div
      className="skyjo-room-options-overlay fixed inset-0 flex items-end justify-center bg-black/70 px-3 py-4 backdrop-blur-sm"
      data-modal-overlay
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <section
        aria-labelledby="skyjo-room-options-title"
        aria-modal="true"
        className="skyjo-panel skyjo-room-options-dialog"
        id="skyjo-room-options-dialog"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="skyjo-room-options-header">
          <div className="min-w-0">
            <div className="skyjo-kicker">Room controls</div>
            <h2 className="skyjo-serif text-2xl font-black text-[#f5e6c8]" id="skyjo-room-options-title">
              Room {roomCode}
            </h2>
          </div>
          <button
            aria-label="Close room options"
            className="skyjo-button skyjo-icon-button"
            onClick={onDismiss}
            ref={closeButtonRef}
            type="button"
          >
            <CloseIcon />
          </button>
        </header>
        <div className="skyjo-room-options-body">{children}</div>
      </section>
    </div>,
    document.body
  );
}
