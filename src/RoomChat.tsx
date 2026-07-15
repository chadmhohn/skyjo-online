import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from './accessibility';
import { knownCardCount } from './gamePresentation';
import type { GameState, RoomChatMessage } from './types';

const preservedDrafts = new Map<string, string>();

export interface RoomChatProps {
  messages: RoomChatMessage[];
  playerId: string;
  isOpen: boolean;
  variant?: 'panel' | 'dock';
  state?: GameState | null;
  unreadCount: number;
  interactionDisabledReason?: string;
  onToggle: () => void;
  onSend: (text: string) => void;
}

function ChatIcon() {
  return (
    <svg aria-hidden="true" className="skyjo-icon" focusable="false" viewBox="0 0 24 24">
      <path d="M5 5.75h14v10.5H9l-4 3v-13.5Z" />
      <path d="M8.5 10.25h7M8.5 13h4.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" className="skyjo-icon" focusable="false" viewBox="0 0 24 24">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function formatChatTime(createdAt: number) {
  try {
    return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(new Date(createdAt));
  } catch {
    return '';
  }
}

export default function RoomChat({
  messages,
  playerId,
  isOpen,
  variant = 'panel',
  state,
  unreadCount,
  interactionDisabledReason,
  onToggle,
  onSend
}: RoomChatProps) {
  const [draft, setDraft] = useState(() => preservedDrafts.get(playerId) ?? '');
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const latestMessage = messages[messages.length - 1];
  const dockMode = variant === 'dock';
  const unreadLabel = unreadCount === 1 ? '1 unread message' : `${unreadCount} unread messages`;

  useModalFocus({
    open: dockMode && isOpen,
    dialogRef,
    initialFocusRef: closeButtonRef,
    triggerRef,
    onDismiss: onToggle
  });

  useEffect(() => {
    if (!isOpen) return;
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [isOpen, messages.length]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (interactionDisabledReason) return;
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    preservedDrafts.delete(playerId);
    setDraft('');
  }

  function flippedSummaryForPlayer(messagePlayerId: string) {
    const player = state?.players.find((item) => item.id === messagePlayerId);
    return player ? `${knownCardCount(player)}/12` : '';
  }

  const chatBody = (
    <div className="skyjo-chat-body grid min-h-0 gap-3">
      <div
        aria-atomic="false"
        aria-label="Table chat messages"
        aria-live="polite"
        aria-relevant="additions"
        className="skyjo-chat-messages max-h-64 space-y-2 overflow-y-auto rounded-xl border border-[#f5e6c8]/10 bg-black/10 p-2"
        ref={messagesRef}
        role="log"
      >
        {messages.length > 0 ? (
          messages.map((message) => {
            const mine = message.playerId === playerId;
            const flippedSummary = flippedSummaryForPlayer(message.playerId);
            return (
              <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`} key={message.id}>
                <div
                  className={`max-w-[88%] rounded-xl border px-3 py-2 text-sm ${
                    mine
                      ? 'border-amber-200/24 bg-amber-300/12 text-amber-50'
                      : 'border-[#f5e6c8]/10 bg-white/[0.035] text-[#f5e6c8]/82'
                  }`}
                >
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="font-black text-[#f5e6c8]">{mine ? 'You' : message.playerName}</span>
                    {flippedSummary ? (
                      <span
                        aria-label={`${flippedSummary} cards flipped`}
                        className="skyjo-chat-flipped-pill"
                        title={`${flippedSummary} cards flipped`}
                      >
                        {flippedSummary}
                      </span>
                    ) : null}
                    <time
                      className="text-xs font-bold text-[#f5e6c8]/42"
                      dateTime={new Date(message.createdAt).toISOString()}
                    >
                      {formatChatTime(message.createdAt)}
                    </time>
                  </div>
                  <p className="mt-1 break-words leading-5">{message.text}</p>
                </div>
              </div>
            );
          })
        ) : (
          <div className="rounded-lg border border-dashed border-[#f5e6c8]/14 px-3 py-5 text-center text-sm font-bold text-[#f5e6c8]/45">
            Say hello when people join the table.
          </div>
        )}
      </div>

      <form className="skyjo-chat-form flex gap-2" onSubmit={handleSubmit}>
        <input
          aria-label="Message"
          className="skyjo-input min-w-0 flex-1 px-3 py-2 text-sm"
          disabled={Boolean(interactionDisabledReason)}
          maxLength={280}
          onChange={(event) => {
            preservedDrafts.set(playerId, event.target.value);
            setDraft(event.target.value);
          }}
          placeholder="Message players"
          title={interactionDisabledReason || 'Message players'}
          value={draft}
        />
        <button
          className="skyjo-button skyjo-button-primary px-4 py-2 text-sm"
          disabled={Boolean(interactionDisabledReason) || !draft.trim()}
          title={interactionDisabledReason || 'Send message'}
          type="submit"
        >
          Send
        </button>
      </form>
    </div>
  );

  if (dockMode) {
    return (
      <>
        <button
          aria-controls="skyjo-table-chat-dialog"
          aria-expanded={isOpen}
          aria-haspopup="dialog"
          aria-label={`Open table chat${unreadCount > 0 ? `, ${unreadLabel}` : ''}`}
          className="skyjo-button skyjo-icon-button skyjo-chat-dock-button"
          onClick={onToggle}
          ref={triggerRef}
          title="Table chat"
          type="button"
        >
          <ChatIcon />
          {unreadCount > 0 ? (
            <span aria-hidden="true" className="skyjo-chat-dock-badge">{Math.min(unreadCount, 99)}</span>
          ) : null}
          <span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
            {unreadCount > 0 ? unreadLabel : 'No unread table chat messages'}
          </span>
        </button>
        {isOpen
          ? createPortal(
              <div
                className="skyjo-chat-overlay fixed inset-0 flex items-end justify-center bg-black/70 px-3 py-4 backdrop-blur-sm"
                data-modal-overlay
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget) onToggle();
                }}
              >
                <section
                  aria-labelledby="skyjo-table-chat-title"
                  aria-modal="true"
                  className="skyjo-panel skyjo-chat-dialog"
                  id="skyjo-table-chat-dialog"
                  ref={dialogRef}
                  role="dialog"
                  tabIndex={-1}
                >
                  <header className="skyjo-chat-dialog-header">
                    <div className="min-w-0">
                      <div className="skyjo-kicker">Room conversation</div>
                      <h2 className="skyjo-serif text-2xl font-black text-[#f5e6c8]" id="skyjo-table-chat-title">
                        Table chat
                      </h2>
                    </div>
                    <button
                      aria-label="Close table chat"
                      className="skyjo-button skyjo-icon-button"
                      onClick={onToggle}
                      ref={closeButtonRef}
                      type="button"
                    >
                      <CloseIcon />
                    </button>
                  </header>
                  {chatBody}
                </section>
              </div>,
              document.body
            )
          : null}
      </>
    );
  }

  return (
    <section
      className={`skyjo-panel skyjo-room-chat-panel ${isOpen ? 'skyjo-room-chat-panel-open' : 'skyjo-room-chat-panel-closed'}`}
    >
      <button
        aria-expanded={isOpen}
        aria-label={`Table Chat${unreadCount > 0 ? `, ${unreadLabel}` : ''}`}
        className="skyjo-chat-toggle flex w-full items-center justify-between gap-3 text-left"
        onClick={onToggle}
        ref={triggerRef}
        type="button"
      >
        <span className="min-w-0">
          <span className="skyjo-serif block text-xl font-semibold text-[#f5e6c8]">Table Chat</span>
          <span className="mt-1 block truncate text-sm text-[#f5e6c8]/55">
            {latestMessage ? `${latestMessage.playerName}: ${latestMessage.text}` : 'No messages yet'}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {unreadCount > 0 ? (
            <span
              aria-hidden="true"
              className="rounded-full border border-amber-200/35 bg-amber-400/18 px-2 py-1 text-xs font-black text-amber-100"
            >
              {unreadCount}
            </span>
          ) : null}
          <span className="skyjo-kicker">{isOpen ? 'Hide' : 'Open'}</span>
          <span
            aria-hidden="true"
            className={`skyjo-disclosure-caret ${isOpen ? 'skyjo-disclosure-caret-open' : ''}`}
          />
        </span>
      </button>
      {isOpen ? <div className="mt-3">{chatBody}</div> : null}
    </section>
  );
}
