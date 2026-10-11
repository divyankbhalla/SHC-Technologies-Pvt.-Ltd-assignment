import { describe, expect, it, vi } from 'vitest';
import { AuthError, RateLimiter, ShcClient } from '../src/client';
import type { Patient } from '../src/normalize';

const cfg = {
  apiUrl: 'http://x', token: 't', batchSize: 100, maxRps: 5, maxRetries: 3,
  baseDelayMs: 10, maxDelayMs: 100, requestTimeoutMs: 1000,
};
const mk = (n: number, bad: number[] = []): Patient[] =>
  Array.from({ length: n }, (_, i) => ({
    patient_id: bad.includes(i) ? 'BAD' : `P${i}`, first_name: null, last_name: null, email: null,
    phone: null, dob: null, account_balance: null, last_modified: null,
  }));
const deps = (fetchImpl: any) => ({ fetchImpl, sleep: vi.fn(async () => {}), random: () => 0.5, log: () => {} });

describe('ShcClient', () => {
  it('batches at <= 100 records', async () => {
    const sizes: number[] = [];
    const f = vi.fn(async (_u: any, init: any) => { sizes.push(JSON.parse(init.body).length); return new Response(null, { status: 201 }); });
    const r = await new ShcClient(cfg, deps(f)).ingestAll(mk(250));
    expect(sizes).toEqual([100, 100, 50]);
    expect(r.accepted).toBe(250);
  });

  it('retries 429 and 5xx with backoff, then succeeds', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    const d = deps(f);
    const r = await new ShcClient(cfg, d).ingestAll(mk(3));
    expect(r.accepted).toBe(3);
    expect(f).toHaveBeenCalledTimes(3);
    expect(d.sleep).toHaveBeenCalled();
  });

  it('gives up after maxRetries and records the batch as failed', async () => {
    const f = vi.fn(async () => new Response('boom', { status: 500 }));
    const r = await new ShcClient(cfg, deps(f)).ingestAll(mk(2));
    expect(f).toHaveBeenCalledTimes(cfg.maxRetries + 1);
    expect(r.failed.map((x) => x.reason)).toEqual(['retries_exhausted', 'retries_exhausted']);
  });

  it('isolates bad records on 400 without halting', async () => {
    const f = vi.fn(async (_u: any, init: any) =>
      JSON.parse(init.body).some((p: Patient) => p.patient_id === 'BAD')
        ? new Response('invalid', { status: 400 }) : new Response(null, { status: 201 }));
    const r = await new ShcClient(cfg, deps(f)).ingestAll(mk(10, [7]));
    expect(r.accepted).toBe(9);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.reason).toBe('bad_request');
  });

  it('aborts on 401', async () => {
    const f = vi.fn(async () => new Response(null, { status: 401 }));
    await expect(new ShcClient(cfg, deps(f)).ingestAll(mk(1))).rejects.toBeInstanceOf(AuthError);
  });
});

describe('RateLimiter', () => {
  it('never starts more than 5 requests in any second', async () => {
    let clock = 0;
    const starts: number[] = [];
    const rl = new RateLimiter(200, () => clock, async (ms) => { clock += ms; });
    for (let i = 0; i < 20; i++) { await rl.acquire(); starts.push(clock); }
    for (let i = 5; i < starts.length; i++) expect(starts[i]! - starts[i - 5]!).toBeGreaterThanOrEqual(1000);
  });
});
