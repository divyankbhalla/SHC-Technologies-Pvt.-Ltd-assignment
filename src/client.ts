import type { Config } from './config';
import type { FailedRecord, Patient } from './normalize';

export class AuthError extends Error {}

type ClientConfig = Pick<
  Config,
  'apiUrl' | 'token' | 'batchSize' | 'maxRps' | 'maxRetries' | 'baseDelayMs' | 'maxDelayMs' | 'requestTimeoutMs'
>;

export interface Deps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  log?: (msg: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Spaces request *starts* at least 1/maxRps apart, so any 1s window holds <= maxRps requests. */
export class RateLimiter {
  private next = 0;
  constructor(
    private minIntervalMs: number,
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}
  async acquire(): Promise<void> {
    const t = this.now();
    const start = Math.max(t, this.next);
    this.next = start + this.minIntervalMs; // reserve slot synchronously (safe under concurrency)
    if (start > t) await this.sleep(start - t);
  }
}

type PostOutcome =
  | { kind: 'ok' }
  | { kind: 'rejected'; status: number; body: string }
  | { kind: 'exhausted'; status?: number; body: string };

export interface IngestResult {
  accepted: number;
  failed: FailedRecord[];
  requests: number;
}

/** Single place to change if the API wants a wrapped body such as { patients: [...] }. */
const buildPayload = (batch: Patient[]) => JSON.stringify(batch);

export class ShcClient {
  private limiter: RateLimiter;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private random: () => number;
  private log: (msg: string) => void;
  requests = 0;

  constructor(private cfg: ClientConfig, deps: Deps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? ((m) => console.log(m));
    this.limiter = new RateLimiter(1000 / cfg.maxRps, deps.now ?? Date.now, this.sleep);
  }

  async ingestAll(patients: Patient[]): Promise<IngestResult> {
    const failed: FailedRecord[] = [];
    let accepted = 0;
    const total = Math.ceil(patients.length / this.cfg.batchSize);
    for (let i = 0; i < patients.length; i += this.cfg.batchSize) {
      const batch = patients.slice(i, i + this.cfg.batchSize);
      accepted += await this.ingestBatch(batch, failed);
      this.log(`batch ${i / this.cfg.batchSize + 1}/${total} done (accepted so far: ${accepted}, failed: ${failed.length})`);
    }
    return { accepted, failed, requests: this.requests };
  }

  /**
   * A 400 doesn't say which record is bad, so bisect the batch until the offending
   * record(s) are isolated. Good records still get loaded; bad ones go to failed_records.
   * Cost is O(k log n) extra requests for k bad records. Assumes the API rejects a 400 batch atomically.
   */
  private async ingestBatch(batch: Patient[], failed: FailedRecord[]): Promise<number> {
    const r = await this.post(batch);
    if (r.kind === 'ok') return batch.length;
    if (r.kind === 'exhausted') {
      for (const rec of batch) failed.push({ reason: 'retries_exhausted', status: r.status, error: r.body, record: rec });
      return 0;
    }
    if (batch.length === 1) {
      failed.push({ reason: 'bad_request', status: r.status, error: r.body, record: batch[0] });
      return 0;
    }
    const mid = Math.ceil(batch.length / 2);
    const left = await this.ingestBatch(batch.slice(0, mid), failed);
    const right = await this.ingestBatch(batch.slice(mid), failed);
    return left + right;
  }

  private backoffMs(attempt: number, retryAfterHeader: string | null): number {
    const exp = Math.min(this.cfg.maxDelayMs, this.cfg.baseDelayMs * 2 ** attempt);
    const jittered = this.random() * exp; // full jitter avoids thundering herd
    const ra = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 0;
    return Math.max(Number.isFinite(ra) ? ra : 0, Math.min(jittered + this.cfg.baseDelayMs / 2, this.cfg.maxDelayMs));
  }

  private async post(batch: Patient[]): Promise<PostOutcome> {
    let lastStatus: number | undefined;
    let lastBody = '';
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      await this.limiter.acquire(); // every attempt, including retries, is rate limited
      this.requests++;
      let retryAfter: string | null = null;
      try {
        const res = await this.fetchImpl(this.cfg.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.token}` },
          body: buildPayload(batch),
          signal: AbortSignal.timeout(this.cfg.requestTimeoutMs),
        });
        if (res.ok) return { kind: 'ok' };
        lastStatus = res.status;
        lastBody = (await res.text().catch(() => '')).slice(0, 500);
        if (res.status === 401 || res.status === 403) {
          throw new AuthError(`Authentication failed (HTTP ${res.status}); aborting run`);
        }
        const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
        if (!retryable) return { kind: 'rejected', status: res.status, body: lastBody };
        retryAfter = res.headers.get('retry-after');
      } catch (e) {
        if (e instanceof AuthError) throw e;
        // Network error / timeout: treat as transient.
        lastStatus = undefined;
        lastBody = e instanceof Error ? e.message : String(e);
      }
      if (attempt < this.cfg.maxRetries) {
        const wait = this.backoffMs(attempt, retryAfter);
        this.log(`retry ${attempt + 1}/${this.cfg.maxRetries} in ${Math.round(wait)}ms (status: ${lastStatus ?? 'network'})`);
        await this.sleep(wait);
      }
    }
    return { kind: 'exhausted', status: lastStatus, body: lastBody };
  }
}
