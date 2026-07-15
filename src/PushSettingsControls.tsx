import { useEffect, useState } from 'react';
import {
  disablePushNotifications,
  enablePushNotifications,
  loadPushNotificationStatus,
  type PushUiStatus
} from './push';

export default function PushSettingsControls() {
  const [status, setStatus] = useState<PushUiStatus>('checking');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    loadPushNotificationStatus()
      .then(setStatus)
      .catch(() => setStatus('error'));
  }, []);

  const enabled = status === 'subscribed';
  const statusText =
    status === 'subscribed'
      ? 'Enabled'
      : status === 'denied'
        ? 'Blocked'
        : status === 'unsupported'
          ? 'Unavailable'
          : status === 'unconfigured'
            ? 'Not configured'
            : status === 'error'
              ? 'Could not check'
              : 'Off';

  async function handleToggle() {
    setBusy(true);
    setMessage('');
    try {
      if (enabled) {
        await disablePushNotifications();
        setStatus('prompt');
        setMessage('Notifications disabled.');
      } else {
        await enablePushNotifications();
        setStatus('subscribed');
        setMessage('Notifications enabled.');
      }
    } catch (requestError) {
      setStatus(status === 'checking' ? 'error' : status);
      setMessage(requestError instanceof Error ? requestError.message : 'Notification request failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="skyjo-account-card">
      <div>
        <div className="skyjo-kicker">Notifications</div>
        <div className="text-xl font-black text-[#f5e6c8]">Turn alerts</div>
        <div className="text-sm font-bold text-[#f5e6c8]/58">{statusText}</div>
      </div>
      <div className="flex flex-col items-start gap-2 sm:items-end">
        <button
          className={`skyjo-button px-3 py-2 ${enabled ? '' : 'skyjo-button-primary'}`}
          disabled={busy || status === 'checking' || status === 'unsupported' || status === 'unconfigured' || status === 'denied'}
          onClick={handleToggle}
          type="button"
        >
          {enabled ? 'Disable' : 'Enable'}
        </button>
        {message ? <div className="text-xs font-bold text-[#f5e6c8]/58">{message}</div> : null}
      </div>
    </div>
  );
}
