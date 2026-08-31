// tests/batchRoute.test.ts
//
// Regression tests for /api/batch — the Vercel cron entry point.
//
// Bugs pinned here: the route was POST-only, read brand from the JSON body
// only, and only accepted an `x-cron-secret` header. Vercel cron sends an
// HTTP GET, no body, brand via `?brand=` in the path (see vercel.json), and
// — when CRON_SECRET is set — an automatic `Authorization: Bearer` header.
// Net effect before the fix: every scheduled run failed (405/401/400) and
// no batch was ever assembled by cron.
//
// The orchestrator is mocked; everything under test is auth + brand parsing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const assembleReviewBatch = vi.fn();
const verifyUserJwt = vi.fn();

vi.mock('../src/lib/orchestrator', () => ({
  assembleReviewBatch: (...args: unknown[]) => assembleReviewBatch(...args),
}));

vi.mock('../src/lib/supabaseClient', () => ({
  getSupabaseAdmin: vi.fn(),
  verifyUserJwt: (...args: unknown[]) => verifyUserJwt(...args),
  _resetSupabaseAdminForTesting: vi.fn(),
}));

import { NextRequest } from 'next/server';

function makeReq(
  url: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(url, { method: 'GET', headers });
}

const BATCH_URL = 'https://media-engine.example.com/api/batch';

describe('/api/batch — Vercel cron contract', () => {
  const OLD_SECRET = process.env.CRON_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'test-cron-secret';
    verifyUserJwt.mockResolvedValue(null); // bearer tokens fail closed by default
    assembleReviewBatch.mockResolvedValue({
      batchId: 'batch-1',
      queued: 0,
      laneOutcomes: {},
    });
  });

  afterEach(() => {
    if (OLD_SECRET === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = OLD_SECRET;
  });

  it('accepts the Vercel cron shape: GET + Authorization Bearer CRON_SECRET + ?brand=', async () => {
    const { GET } = await import('../src/app/api/batch/route');

    const res = await GET(
      makeReq(`${BATCH_URL}?brand=misfit`, {
        authorization: 'Bearer test-cron-secret',
      })
    );

    expect(res.status).toBe(200);
    expect(assembleReviewBatch).toHaveBeenCalledWith(
      'misfit',
      expect.objectContaining({ assetStore: expect.anything() })
    );
  });

  it('accepts x-cron-secret header for non-Vercel schedulers', async () => {
    const { GET } = await import('../src/app/api/batch/route');

    const res = await GET(
      makeReq(`${BATCH_URL}?brand=forge`, { 'x-cron-secret': 'test-cron-secret' })
    );

    expect(res.status).toBe(200);
    expect(assembleReviewBatch).toHaveBeenCalledWith('forge', expect.anything());
  });

  it('rejects cron-shaped requests with the wrong secret', async () => {
    const { GET } = await import('../src/app/api/batch/route');

    const res = await GET(
      makeReq(`${BATCH_URL}?brand=misfit`, { authorization: 'Bearer wrong' })
    );

    expect(res.status).toBe(401);
    expect(assembleReviewBatch).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated requests', async () => {
    const { GET } = await import('../src/app/api/batch/route');

    const res = await GET(makeReq(`${BATCH_URL}?brand=misfit`));

    expect(res.status).toBe(401);
    expect(assembleReviewBatch).not.toHaveBeenCalled();
  });

  it('returns 400 when brand is missing entirely (no query, no body)', async () => {
    const { GET } = await import('../src/app/api/batch/route');

    const res = await GET(
      makeReq(BATCH_URL, { authorization: 'Bearer test-cron-secret' })
    );

    expect(res.status).toBe(400);
    expect(assembleReviewBatch).not.toHaveBeenCalled();
  });

  it('POST still works for manual triggers with a JSON body', async () => {
    const { POST } = await import('../src/app/api/batch/route');

    const req = new NextRequest(`${BATCH_URL}?brand=misfit`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-cron-secret' },
      body: JSON.stringify({ brand: 'forge' }),
    });

    // Query param wins over body — both are valid sources.
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(assembleReviewBatch).toHaveBeenCalledWith('misfit', expect.anything());
  });
});
