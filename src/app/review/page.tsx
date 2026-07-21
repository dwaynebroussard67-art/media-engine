// src/app/review/page.tsx
//
// Review UI — client component.
// Requires: @supabase/supabase-js (browser client), NEXT_PUBLIC_SUPABASE_URL,
// NEXT_PUBLIC_SUPABASE_ANON_KEY (add to .env.example — these are the ANON key
// equivalents for the browser, which is safe to expose).
//
// Works one-handed on a phone (S25 Ultra):
//   - Large tap targets (min 48px height on buttons)
//   - Brand toggle at the top, easy thumb reach
//   - ReviewCard handles all item interaction
//
// Unverified — traced by hand. Must be checked against:
//   1. @supabase/supabase-js v2 session API (createBrowserClient or createClient).
//   2. Next.js App Router 'use client' data-fetching pattern.
//   3. Email OTP flow in supabase-js v2.

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import { ReviewCard } from '../../components/ReviewCard';
import type { ReviewItem, ReviewDecision, Brand } from '../../types/media';

// ---------------------------------------------------------------------------
// Supabase browser client — ANON key only. Never use service-role in the browser.
// ---------------------------------------------------------------------------

function getBrowserSupabase(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set'
    );
  }
  return createClient(url, key);
}

// Singleton for the browser client.
let _browserClient: SupabaseClient | null = null;
function browserClient(): SupabaseClient {
  if (!_browserClient) _browserClient = getBrowserSupabase();
  return _browserClient;
}

// ---------------------------------------------------------------------------
// Types mirroring review_queue row shape returned from the API.
// ---------------------------------------------------------------------------

interface QueueItem {
  id: string;
  brand: Brand;
  lane: string;
  image_url: string;
  source_data: Record<string, unknown>;
  oracle_result: ReviewItem['oracleResult'];
  merch_meta: unknown;
  queued_at: number;
  status: string;
}

function queueItemToReviewItem(row: QueueItem): ReviewItem {
  return {
    id: row.id,
    imageUrl: row.image_url,
    brand: row.brand,
    generationLane: row.lane as ReviewItem['generationLane'],
    sourceData: row.source_data,
    createdAt: row.queued_at,
    oracleResult: row.oracle_result,
    ...(row.merch_meta
      ? { sourceDetail: JSON.stringify(row.merch_meta) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Toast — minimal, no dependency.
// ---------------------------------------------------------------------------

interface Toast {
  id: number;
  message: string;
  type: 'info' | 'error';
}

let _toastSeq = 0;

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = ++_toastSeq;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  return { toasts, addToast };
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function ReviewPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  const [brand, setBrand] = useState<Brand>('misfit');
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [deciding, setDeciding] = useState<Record<string, boolean>>({});

  const { toasts, addToast } = useToasts();

  const PAGE_SIZE = 10;

  // Track session.
  useEffect(() => {
    const client = browserClient();
    client.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => subscription.unsubscribe();
  }, []);

  // Fetch items when session, brand, or page changes.
  const fetchItems = useCallback(async () => {
    if (!session) return;
    setFetchLoading(true);
    try {
      const params = new URLSearchParams({
        brand,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      const res = await fetch(`/api/review?${params}`);
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        addToast(`Failed to load items: ${body.error ?? res.statusText}`, 'error');
        return;
      }
      const data = (await res.json()) as {
        items: QueueItem[];
        total: number;
        page: number;
        pageSize: number;
      };
      setItems(data.items.map(queueItemToReviewItem));
      setTotal(data.total);
    } catch (err) {
      addToast(`Network error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setFetchLoading(false);
    }
  }, [session, brand, page, addToast]);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  // Reset to page 1 when brand changes.
  useEffect(() => {
    setPage(1);
  }, [brand]);

  // Auth handlers.
  async function handleSendOtp() {
    setAuthLoading(true);
    try {
      const { error } = await browserClient().auth.signInWithOtp({ email });
      if (error) {
        addToast(`OTP send failed: ${error.message}`, 'error');
      } else {
        setOtpSent(true);
        addToast('Check your email for the code.', 'info');
      }
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleVerifyOtp() {
    setAuthLoading(true);
    try {
      const { error } = await browserClient().auth.verifyOtp({
        email,
        token: otp,
        type: 'email',
      });
      if (error) {
        addToast(`OTP verify failed: ${error.message}`, 'error');
      }
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleSignOut() {
    await browserClient().auth.signOut();
  }

  // Decision handler.
  async function handleDecide(item: ReviewItem, decision: ReviewDecision) {
    if (!session) return;
    setDeciding((prev) => ({ ...prev, [item.id]: true }));

    try {
      const res = await fetch(`/api/review/${item.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ decision }),
      });

      if (res.status === 409) {
        addToast('Already decided — refreshing queue.', 'info');
        await fetchItems();
        return;
      }

      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        addToast(`Decision failed: ${body.error ?? res.statusText}`, 'error');
        return;
      }

      // Optimistic removal on success.
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setTotal((prev) => Math.max(0, prev - 1));
    } catch (err) {
      addToast(`Network error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setDeciding((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 600,
        margin: '0 auto',
        padding: '16px',
        paddingBottom: 80,
      }}
    >
      {/* Toast region */}
      <div
        role="status"
        aria-live="polite"
        style={{ position: 'fixed', top: 16, right: 16, zIndex: 100, maxWidth: 300 }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              background: t.type === 'error' ? '#c0392b' : '#2c3e50',
              color: '#fff',
              padding: '12px 16px',
              borderRadius: 8,
              marginBottom: 8,
              fontSize: 14,
            }}
          >
            {t.message}
          </div>
        ))}
      </div>

      <h1 style={{ fontSize: 22, marginBottom: 16 }}>Media Engine — Review</h1>

      {/* Auth section */}
      {!session ? (
        <section aria-label="Sign in">
          <h2 style={{ fontSize: 18, marginBottom: 12 }}>Sign in</h2>
          {!otpSent ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label htmlFor="email-input" style={{ fontWeight: 600 }}>
                Email
              </label>
              <input
                id="email-input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                style={inputStyle}
                placeholder="[email protected]"
              />
              <button
                onClick={() => void handleSendOtp()}
                disabled={authLoading || !email}
                style={buttonStyle('primary')}
              >
                {authLoading ? 'Sending…' : 'Send code'}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label htmlFor="otp-input" style={{ fontWeight: 600 }}>
                Code from email
              </label>
              <input
                id="otp-input"
                type="text"
                inputMode="numeric"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                style={inputStyle}
                placeholder="123456"
              />
              <button
                onClick={() => void handleVerifyOtp()}
                disabled={authLoading || !otp}
                style={buttonStyle('primary')}
              >
                {authLoading ? 'Verifying…' : 'Verify'}
              </button>
              <button
                onClick={() => { setOtpSent(false); setOtp(''); }}
                style={buttonStyle('secondary')}
              >
                Back
              </button>
            </div>
          )}
        </section>
      ) : (
        <>
          {/* Brand toggle */}
          <section
            aria-label="Brand selection"
            style={{ display: 'flex', gap: 8, marginBottom: 20 }}
          >
            {(['misfit', 'forge'] as Brand[]).map((b) => (
              <button
                key={b}
                onClick={() => setBrand(b)}
                aria-pressed={brand === b}
                style={{
                  ...buttonStyle(brand === b ? 'primary' : 'secondary'),
                  flex: 1,
                }}
              >
                {b.charAt(0).toUpperCase() + b.slice(1)}
              </button>
            ))}
          </section>

          {/* Queue header */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <span style={{ fontSize: 14, color: '#555' }}>
              {fetchLoading ? 'Loading…' : `${total} pending`}
            </span>
            <button
              onClick={() => void fetchItems()}
              disabled={fetchLoading}
              style={{ ...buttonStyle('secondary'), padding: '6px 12px', fontSize: 13 }}
            >
              Refresh
            </button>
          </div>

          {/* Items */}
          {items.length === 0 && !fetchLoading && (
            <p style={{ color: '#777', textAlign: 'center', marginTop: 40 }}>
              Nothing pending for {brand}.
            </p>
          )}

          {items.map((item) => (
            <div key={item.id} style={{ marginBottom: 24 }}>
              <ReviewCard
                item={item}
                onDecide={(decision) => void handleDecide(item, decision)}
                disabled={deciding[item.id] ?? false}
              />
            </div>
          ))}

          {/* Pagination */}
          {totalPages > 1 && (
            <div
              style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}
            >
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1 || fetchLoading}
                style={buttonStyle('secondary')}
              >
                ‹ Prev
              </button>
              <span style={{ alignSelf: 'center', fontSize: 14 }}>
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages || fetchLoading}
                style={buttonStyle('secondary')}
              >
                Next ›
              </button>
            </div>
          )}

          {/* Sign out */}
          <div style={{ marginTop: 32, textAlign: 'center' }}>
            <button
              onClick={() => void handleSignOut()}
              style={{ ...buttonStyle('secondary'), color: '#888' }}
            >
              Sign out
            </button>
          </div>
        </>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Shared inline styles — minimal, no CSS dependency.
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  padding: '12px',
  fontSize: 16,
  borderRadius: 8,
  border: '1px solid #ccc',
  width: '100%',
  boxSizing: 'border-box',
};

function buttonStyle(variant: 'primary' | 'secondary'): React.CSSProperties {
  return {
    padding: '12px 20px',
    fontSize: 16,
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    minHeight: 48, // thumb-friendly
    fontWeight: 600,
    background: variant === 'primary' ? '#1a1a2e' : '#e8e8e8',
    color: variant === 'primary' ? '#fff' : '#333',
  };
}
