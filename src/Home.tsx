import { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccount } from './account';
import AudioSettingsControls from './AudioSettingsControls';
import {
  loadSoloSession,
  soloOwnerKey,
  type SoloOwnerKey,
  type SoloPersistenceWarning,
  type SoloSessionRecord
} from './soloDurability';

function HomeSoloActionsLoadFallback() {
  return (
    <section aria-label="Play" className="skyjo-home-play-panel skyjo-panel">
      <p className="skyjo-kicker">Choose a table</p>
      <p className="skyjo-home-play-loading" role="status">Loading saved solo options…</p>
      <Link className="skyjo-button skyjo-home-play-action" to="/single-player">Open Single Player</Link>
      <Link className="skyjo-button skyjo-home-play-action" to="/lobby">Multiplayer</Link>
    </section>
  );
}

const HomeSoloActions = lazy(() => import('./SoloSetupFlow').then((module) => ({ default: module.HomeSoloActions })).catch(() => ({ default: HomeSoloActionsLoadFallback })));

function AccountLinks() {
  const { loading, user } = useAccount();
  if (loading) return null;
  return (
    <div className="skyjo-home-account-links mt-6 flex flex-wrap items-center gap-2 text-sm font-bold">
      {user ? (
        <>
          <span className="text-[#f5e6c8]/64">Signed in as {user.displayName}</span>
          <Link className="skyjo-button px-3 py-2" to="/stats">Stats</Link>
          <Link className="skyjo-button px-3 py-2" to="/account">Account</Link>
          {user.role === 'admin' ? <Link className="skyjo-button px-3 py-2" to="/admin">Admin</Link> : null}
        </>
      ) : (
        <>
          <span className="text-[#f5e6c8]/64">Sign in to save stats and play multiplayer.</span>
          <Link className="skyjo-button px-3 py-2" to="/account">Account</Link>
        </>
      )}
    </div>
  );
}

function AudioSettingsPanel() {
  return (
    <section aria-labelledby="skyjo-audio-settings-title" className="skyjo-panel skyjo-home-audio-panel mt-7">
      <div>
        <p className="skyjo-kicker">Settings</p>
        <h2 className="skyjo-serif mt-1 text-2xl font-bold text-[#f5e6c8]" id="skyjo-audio-settings-title">Audio</h2>
      </div>
      <div className="mt-4"><AudioSettingsControls /></div>
    </section>
  );
}

export default function Home() {
  const { loading: accountLoading, localSoloOwnerId, user } = useAccount();
  const ownerKey = soloOwnerKey(user?.id ?? localSoloOwnerId);
  const [soloPreview, setSoloPreview] = useState<{
    ownerKey: SoloOwnerKey;
    loading: boolean;
    session: SoloSessionRecord | null;
    warning: SoloPersistenceWarning | null;
  }>(() => ({ ownerKey, loading: true, session: null, warning: null }));

  useEffect(() => {
    if (accountLoading) return undefined;
    let cancelled = false;
    setSoloPreview({ ownerKey, loading: true, session: null, warning: null });
    void loadSoloSession(ownerKey).then((result) => {
      if (cancelled) return;
      setSoloPreview({ ownerKey, loading: false, session: result.session, warning: result.warning });
    });
    return () => {
      cancelled = true;
    };
  }, [accountLoading, ownerKey]);

  const previewReady = !accountLoading && soloPreview.ownerKey === ownerKey && !soloPreview.loading;
  return (
    <main className="skyjo-surface">
      <section className="skyjo-shell skyjo-home-shell flex min-h-screen flex-col justify-center px-4 py-7 sm:px-5 sm:py-10">
        <div className="skyjo-home-hero max-w-3xl">
          <p className="skyjo-kicker mb-3">Private game table</p>
          <h1 className="skyjo-title text-6xl sm:text-8xl">Flipvale</h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-[#f5e6c8]/70 sm:text-lg sm:leading-8">
            Play solo against the house AI or create a private room for friends at the multiplayer table.
          </p>
          <Suspense fallback={<HomeSoloActionsLoadFallback />}>
            <HomeSoloActions
              loading={!previewReady}
              session={previewReady ? soloPreview.session : null}
              warning={previewReady ? soloPreview.warning : null}
            />
          </Suspense>
          <div className="skyjo-home-utilities">
            <AccountLinks />
            <details className="skyjo-panel skyjo-home-audio-disclosure">
              <summary className="skyjo-button skyjo-button-disclosure px-3 py-2">Sound</summary>
              <AudioSettingsPanel />
            </details>
            <nav aria-label="Legal and support" className="flex flex-wrap gap-4 text-sm font-bold">
              <Link className="skyjo-legal-nav-link text-[#f5e6c8]/64 hover:text-[#f5e6c8]" to="/privacy">Privacy</Link>
              <Link className="skyjo-legal-nav-link text-[#f5e6c8]/64 hover:text-[#f5e6c8]" to="/support">Support</Link>
            </nav>
          </div>
        </div>
      </section>
    </main>
  );
}
