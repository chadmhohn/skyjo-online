import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

const CONTACT_EMAIL = 'chad.hohn@groundworkrevops.com';

function LegalPageShell({ children }: { children: ReactNode }) {
  return (
    <main className="skyjo-surface px-4 py-8">
      <article className="skyjo-shell skyjo-legal-page mx-auto max-w-3xl">
        <nav aria-label="Legal and support navigation" className="mb-5 flex flex-wrap gap-4 text-sm font-bold">
          <Link className="skyjo-legal-nav-link text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/">Home</Link>
          <Link className="skyjo-legal-nav-link text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/privacy">Privacy</Link>
          <Link className="skyjo-legal-nav-link text-[#f5e6c8]/65 hover:text-[#f5e6c8]" to="/support">Support</Link>
        </nav>
        <div className="skyjo-panel p-5 sm:p-7">{children}</div>
      </article>
    </main>
  );
}

export function PrivacyPolicyPage() {
  return (
    <LegalPageShell>
      <p className="skyjo-kicker">Flipvale</p>
      <h1 className="skyjo-serif mt-2 text-4xl font-black text-[#f5e6c8]">Privacy Policy</h1>
      <p className="mt-2 text-sm text-[#f5e6c8]/58">Effective August 24, 2026</p>

      <section>
        <h2>Overview</h2>
        <p>
          Flipvale is a casual card game for solo play and private multiplayer rooms. We use the
          information described below only to provide, secure, and operate the game. We do not sell
          personal information, show advertising, track you across other companies&apos; apps or websites,
          or use third-party analytics.
        </p>
      </section>

      <section>
        <h2>Information we use</h2>
        <ul>
          <li><strong>Account information:</strong> email address, display name, account identifier, password hash, and successful sign-in timestamps.</li>
          <li><strong>Game information:</strong> solo saves submitted to account stats, multiplayer room state, results, history, and messages sent in room chat.</li>
          <li><strong>Notification information:</strong> browser push subscription endpoint, public encryption keys, and browser user agent for Web Push; or a random installation identifier, encrypted Apple Push Notification token, notification environment, app version, and locale for the native app, when you enable turn notifications.</li>
          <li><strong>Deletion records:</strong> account identifier and deletion timestamp retained to prevent a deleted account from being restored from an older backup.</li>
        </ul>
        <p>
          Passwords are transmitted for authentication and stored by the service only as password
          hashes. Guest solo games stay on the device and are not uploaded to account stats.
        </p>
      </section>

      <section>
        <h2>Information we do not collect</h2>
        <p>
          Flipvale does not collect location, contacts, photos, recordings, health or financial data,
          purchases, browsing history, or search history. It has no advertising, third-party analytics,
          crash-reporting SDK, or cross-app tracking.
        </p>
      </section>

      <section>
        <h2>How information is used and shared</h2>
        <p>
          Information is used for account access, saved games and stats, multiplayer synchronization,
          room chat, notifications, security, and support. It is processed through the first-party
          Flipvale service and its hosting and network providers. Apple or your browser&apos;s push
          service processes notification registration and delivery when you enable notifications.
          We may disclose information when required by law or necessary to protect the service and
          its users.
        </p>
      </section>

      <section>
        <h2>Retention and deletion</h2>
        <p>
          Active rooms expire after six hours without activity. Browser Web Push registrations are
          removed when you turn notifications off, the push service permanently rejects them, or you
          delete your account; signing out alone does not disable a browser&apos;s enabled subscription.
          Native Apple notification registrations are removed when you turn notifications off, the
          app signs that installation out, Apple permanently rejects the token, or you delete your
          account. Native registrations that are not refreshed expire after 180 days.
        </p>
        <p>
          You can permanently delete your account from the Account screen in the app or on the web.
          Deletion removes the account profile, email, password verifier, sessions, notification
          registrations, account-owned solo history, and messages you authored in active rooms.
          Completed multiplayer scores remain only in anonymized form with the account identifier
          removed and the player name replaced by “Deleted player.” These anonymized shared results
          currently have no automatic expiration.
        </p>
        <p>
          Restricted backups containing account source data are retained for no more than 12 months.
          To prevent restoration of deleted accounts, a restricted security ledger retains only the
          account identifier and deletion timestamp for the life of the service.
        </p>
      </section>

      <section>
        <h2>Your choices</h2>
        <p>
          You may play solo as a guest, create an account, enable or disable notifications, and delete
          your account without contacting support. Removing the app deletes local guest saves from that
          device.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          For privacy questions, email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
      </section>
    </LegalPageShell>
  );
}

export function SupportPage() {
  return (
    <LegalPageShell>
      <p className="skyjo-kicker">Flipvale</p>
      <h1 className="skyjo-serif mt-2 text-4xl font-black text-[#f5e6c8]">Support</h1>
      <p className="mt-4">
        Need help with Flipvale? Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>

      <section>
        <h2>What to include</h2>
        <p>
          Tell us whether you are using iPhone, iPad, or the web, along with the app version and build
          number. If a private room is affected, include its five-character room code. Never send your
          password, sign-in cookie, invitation link, notification token, or hidden card state.
        </p>
      </section>

      <section>
        <h2>Account deletion</h2>
        <p>
          You can delete your account without contacting support. Open Account, choose Delete Account,
          enter your current password, and type DELETE to confirm.
        </p>
      </section>

      <section>
        <h2>Privacy</h2>
        <p>Read the <Link to="/privacy">Flipvale Privacy Policy</Link>.</p>
      </section>
    </LegalPageShell>
  );
}
