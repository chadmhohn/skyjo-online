import type { RoomChatProps } from './RoomChat';

export default function RoomChatLoadFallback({ variant }: RoomChatProps) {
  return variant === 'dock' ? (
    <button
      aria-label="Table chat unavailable"
      className="skyjo-button skyjo-icon-button skyjo-chat-dock-button"
      disabled
      type="button"
    >
      !
    </button>
  ) : (
    <p className="skyjo-panel text-sm font-bold text-amber-100" role="alert">Table chat could not load.</p>
  );
}
