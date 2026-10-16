'use client';
// src/components/SignInPanel.tsx
//
// Phone-first email-OTP sign-in, factored out of the review page so the setup
// wizard can use the same flow instead of becoming a fourth copy of it.
// One-handed targets (48px min), inline feedback, no dependencies.
//
// The session events here also drive the parent's user id display — which is
// the value the operator has to paste into GALLERY_WRITER_IDS, and the single
// most annoying thing to hunt down in the Supabase dashboard.

import { useCallback, useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { browserSupabase } from '../lib/browserSupabase';

export interface SignInPanelProps {
  onSession?: (session: Session | null) => void;
  /** Called with a human-readable status line for the parent to surface. */
  onNotice?: (message: string, type: 'info' | 'error') => void;
}

export function useSupabaseSession(onSession?: (s: Session | null) => void): Session | null {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let client;
    try {
      client = browserSupabase();
    } catch {
      // NEXT_PUBLIC_* not set at build/runtime — the setup page renders an
      // explicit "browser key missing" state; nothing to subscribe to here.
      return;
    }
    void client.auth.getSession().then(({ data }) => {
      setSession(data.session);
      onSession?.(data.session);
    });
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      onSession?.(s);
    });
    return () => subscription.unsubscribe();
    // onSession is intentionally not a dependency: it is a callback the parent
    // recreates freely, and resubscribing on every render would thrash auth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return session;
}

export function SignInPanel({ onSession, onNotice }: SignInPanelProps): React.ReactElement {
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const session = useSupabaseSession(onSession);

  const notify = useCallback(
    (message: string, type: 'info' | 'error') => {
      setError(type === 'error' ? message : null);
      onNotice?.(message, type);
    },
    [onNotice],
  );

  async function sendOtp() {
    setBusy(true);
    try {
      const { error: err } = await browserSupabase().auth.signInWithOtp({ email });
      if (err) notify(`OTP send failed: ${err.message}`, 'error');
      else {
        setOtpSent(true);
        notify('Code sent — check your email.', 'info');
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp() {
    setBusy(true);
    try {
      const { error: err } = await browserSupabase().auth.verifyOtp({
        email,
        token: otp,
        type: 'email',
      });
      if (err) notify(`Code rejected: ${err.message}`, 'error');
      else notify('Signed in.', 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (session) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-widest text-emerald-400">Signed in</p>
            <p className="truncate text-sm text-neutral-200">
              {session.user.email ?? session.user.id}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void browserSupabase().auth.signOut()}
            className="shrink-0 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-xs text-neutral-300 hover:bg-neutral-800"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {!otpSent ? (
        <>
          <label htmlFor="setup-email" className="text-sm text-neutral-300">
            Email for the one-time code
          </label>
          <input
            id="setup-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-3 text-base text-neutral-100 placeholder-neutral-600"
            placeholder="you@example.com"
          />
          <button
            type="button"
            disabled={busy || email.trim() === ''}
            onClick={() => void sendOtp()}
            className="min-h-[48px] rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </>
      ) : (
        <>
          <label htmlFor="setup-otp" className="text-sm text-neutral-300">
            The 6-digit code
          </label>
          <input
            id="setup-otp"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-3 text-center text-2xl tracking-[0.4em] text-neutral-100"
            placeholder="000000"
          />
          <button
            type="button"
            disabled={busy || otp.trim() === ''}
            onClick={() => void verifyOtp()}
            className="min-h-[48px] rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {busy ? 'Checking…' : 'Sign in'}
          </button>
        </>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}
