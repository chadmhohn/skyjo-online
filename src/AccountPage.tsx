import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAccount } from './account';
import { safeAccountReturnPath } from './navigation';

const loadPushSettingsControls = () => import('./PushSettingsControls').catch(() => ({
  default: () => (
    <div role="alert">
      <a className="skyjo-button px-3 py-2" href="/account">Reload turn alerts</a>
    </div>
  )
}));
const PushSettingsControls = lazy(loadPushSettingsControls);

export default function AccountPage() {
  const account = useAccount();
  const location = useLocation();
  const navigate = useNavigate();
  const next = safeAccountReturnPath(new URLSearchParams(location.search).get('next'));
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [profileDisplayName, setProfileDisplayName] = useState('');
  const [showsDeletion, setShowsDeletion] = useState(false);
  const [deletionPassword, setDeletionPassword] = useState('');
  const [deletionConfirmation, setDeletionConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (account.user) setProfileDisplayName(account.user.displayName);
  }, [account.user]);

  async function handleAuth(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (mode === 'login') await account.login(email, password);
      else await account.signup(email, displayName, password, confirmPassword);
      navigate(next);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Account request failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handlePasswordChange(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await account.changePassword(currentPassword, password, confirmPassword);
      setCurrentPassword('');
      setPassword('');
      setConfirmPassword('');
      setMessage('Password changed. Sign in again with the new password.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Password change failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleProfileUpdate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await account.updateProfile(profileDisplayName);
      setMessage('Display name updated.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Profile update failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    setBusy(true);
    setError('');
    try {
      await account.logout();
      navigate('/');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Logout failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleAccountDeletion(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await account.deleteAccount(deletionPassword, deletionConfirmation);
      setDeletionPassword('');
      setDeletionConfirmation('');
      navigate('/');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Account deletion failed safely. Your account remains active.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="skyjo-surface px-4 py-8">
      <section className="skyjo-shell mx-auto max-w-3xl space-y-5">
        <Link className="skyjo-back-link text-sm font-bold text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/">Back</Link>
        <div className="skyjo-panel p-5">
          <p className="skyjo-kicker">Flipvale account</p>
          <h1 className="skyjo-serif mt-2 text-4xl font-black text-[#f5e6c8]">{account.user ? 'Account' : mode === 'login' ? 'Sign In' : 'Create Account'}</h1>
          {account.user ? (
            <div className="mt-5 space-y-4">
              <div className="skyjo-account-card">
                <div>
                  <div className="skyjo-kicker">Signed in</div>
                  <div className="text-xl font-black text-[#f5e6c8]">{account.user.displayName}</div>
                  <div className="text-sm text-[#f5e6c8]/58">{account.user.email}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link className="skyjo-button px-3 py-2" to="/stats">Stats</Link>
                  {account.user.role === 'admin' ? <Link className="skyjo-button px-3 py-2" to="/admin">Admin</Link> : null}
                  <button className="skyjo-button px-3 py-2" disabled={busy} onClick={handleLogout} type="button">Logout</button>
                </div>
              </div>
              <form className="skyjo-account-form" onSubmit={handleProfileUpdate}>
                <label>
                  Display name
                  <input className="skyjo-input px-3 py-2" maxLength={24} onChange={(event) => setProfileDisplayName(event.target.value)} value={profileDisplayName} />
                </label>
                <button className="skyjo-button skyjo-button-primary px-4 py-2" disabled={busy || profileDisplayName.trim() === account.user.displayName} type="submit">Save Display Name</button>
              </form>
              <Suspense fallback={<p role="status">Loading turn alerts…</p>}><PushSettingsControls /></Suspense>
              <form className="skyjo-account-form" onSubmit={handlePasswordChange}>
                <label>Current password<input className="skyjo-input px-3 py-2" onChange={(event) => setCurrentPassword(event.target.value)} type="password" value={currentPassword} /></label>
                <label>New password<input className="skyjo-input px-3 py-2" onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></label>
                <label>Confirm new password<input className="skyjo-input px-3 py-2" onChange={(event) => setConfirmPassword(event.target.value)} type="password" value={confirmPassword} /></label>
                <button className="skyjo-button skyjo-button-primary px-4 py-2" disabled={busy} type="submit">Change Password</button>
              </form>
              <section className="skyjo-account-form" aria-labelledby="delete-account-heading">
                <div>
                  <h2 className="text-xl font-black text-[#f5e6c8]" id="delete-account-heading">Delete account</h2>
                  <p className="mt-2 text-sm text-[#f5e6c8]/72">
                    This permanently removes your profile, sessions, notification registrations, and solo history. Multiplayer scores remain only as “Deleted player”; your active-room chat is removed.
                  </p>
                </div>
                {!showsDeletion ? (
                  <button className="skyjo-button px-4 py-2" disabled={busy} onClick={() => setShowsDeletion(true)} type="button">Delete Account</button>
                ) : (
                  <form className="space-y-3" onSubmit={handleAccountDeletion}>
                    <label>Current password<input autoComplete="current-password" className="skyjo-input px-3 py-2" onChange={(event) => setDeletionPassword(event.target.value)} type="password" value={deletionPassword} /></label>
                    <label>Type DELETE to confirm<input autoCapitalize="characters" autoComplete="off" className="skyjo-input px-3 py-2" onChange={(event) => setDeletionConfirmation(event.target.value)} value={deletionConfirmation} /></label>
                    <div className="flex flex-wrap gap-2">
                      <button className="skyjo-button px-4 py-2" disabled={busy || !deletionPassword || deletionConfirmation !== 'DELETE'} type="submit">Permanently Delete Account</button>
                      <button className="skyjo-button px-4 py-2" disabled={busy} onClick={() => {
                        setShowsDeletion(false);
                        setDeletionPassword('');
                        setDeletionConfirmation('');
                      }} type="button">Cancel</button>
                    </div>
                  </form>
                )}
              </section>
            </div>
          ) : (
            <form className="skyjo-account-form mt-5" onSubmit={handleAuth}>
              <label>Email<input className="skyjo-input px-3 py-2" onChange={(event) => setEmail(event.target.value)} type="email" value={email} /></label>
              {mode === 'signup' ? <label>Display name<input className="skyjo-input px-3 py-2" onChange={(event) => setDisplayName(event.target.value)} value={displayName} /></label> : null}
              <label>Password<input className="skyjo-input px-3 py-2" onChange={(event) => setPassword(event.target.value)} type="password" value={password} /></label>
              {mode === 'signup' ? <label>Confirm password<input className="skyjo-input px-3 py-2" onChange={(event) => setConfirmPassword(event.target.value)} type="password" value={confirmPassword} /></label> : null}
              <div className="flex flex-wrap gap-2">
                <button className="skyjo-button skyjo-button-primary px-4 py-2" disabled={busy} type="submit">{mode === 'login' ? 'Sign In' : 'Create Account'}</button>
                <button className="skyjo-button px-4 py-2" disabled={busy} onClick={() => setMode(mode === 'login' ? 'signup' : 'login')} type="button">{mode === 'login' ? 'Create Account' : 'Use Sign In'}</button>
              </div>
            </form>
          )}
          {message ? <div className="skyjo-success-note mt-4">{message}</div> : null}
          {error ? <div className="skyjo-error-note mt-4">{error}</div> : null}
        </div>
      </section>
    </main>
  );
}
