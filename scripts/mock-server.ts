/**
 * Local stand-in for the SHC API so the pipeline can be tested end to end.
 * Run: npm run mock   (listens on http://localhost:3000/v1/patients)
 *
 * Simulates: Bearer auth (401), max 100 records (400), 5 req/s limit (429 + Retry-After),
 * ~15% random 503s, and rejects any batch containing a record with a null `dob` (400),
 * which exercises the pipeline's bad-record isolation using the sample CSV.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 3000);
const TOKEN = process.env.MOCK_TOKEN ?? 'test-token';
const FLAKY = Number(process.env.MOCK_FLAKY ?? 0.15);
const hits: number[] = [];
let accepted = 0;

createServer((req, res) => {
  const send = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST' || req.url !== '/v1/patients') return send(404);
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });

  const now = Date.now();
  while (hits.length && now - hits[0]! > 1000) hits.shift();
  hits.push(now);
  if (hits.length > 5) {
    console.log('429 rate limited');
    return send(429, { error: 'rate limit' }, { 'Retry-After': '1' });
  }
  if (Math.random() < FLAKY) {
    console.log('503 simulated outage');
    return send(503, { error: 'unavailable' });
  }

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let batch: any[];
    try { batch = JSON.parse(raw); } catch { return send(400, { error: 'invalid JSON' }); }
    if (!Array.isArray(batch) || batch.length === 0 || batch.length > 100) {
      return send(400, { error: 'batch must contain 1-100 records' });
    }
    const bad = batch.find((p) => p.dob === null || !p.patient_id);
    if (bad) {
      console.log(`400 rejected batch of ${batch.length} (bad record: ${bad.patient_id})`);
      return send(400, { error: `invalid record ${bad.patient_id}: dob required` });
    }
    accepted += batch.length;
    console.log(`201 accepted ${batch.length} (total ${accepted})`);
    send(201, { accepted: batch.length });
  });
}).listen(PORT, () => console.log(`mock SHC API on :${PORT}, token="${TOKEN}"`));