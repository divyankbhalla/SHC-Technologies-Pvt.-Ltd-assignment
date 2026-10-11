# SHC Patient Ingestion Pipeline (internal)

ETL job: GlobalHealth Corp legacy CSV -> normalize -> SHC `POST /v1/patients`, packaged as a hardened container.

## Layout
| File | Responsibility |
|---|---|
| `src/config.ts` | Env-var config; hard-caps batch size (100) and RPS (5) so misconfiguration can't violate the API contract |
| `src/normalize.ts` | Pure functions: dates, money, phone, email, dedupe. No I/O, so trivially unit-testable |
| `src/client.ts` | Rate limiter, batching, retry/backoff, 400 isolation |
| `src/index.ts` | Orchestration: read CSV -> transform -> load -> write `failed_records.json` |

## Architectural decisions
- **Pure transform, side-effecting edges.** All cleaning logic is pure; only `index.ts` and `client.ts` touch disk/network. Dependencies (fetch, sleep, clock, RNG) are injectable, so tests run instantly with no real waits.
- **Never guess on bad data.** Unparseable dates/phones/balances become `null` and are counted in the transform report, rather than being silently "fixed" into plausible-but-wrong clinical data. Missing email/phone are sent as `null`, since the spec lists them as expected anomalies.
- **Dedupe by `patient_id`, keep max `last_modified`.** Order-independent. A missing/unparseable timestamp always loses; exact ties go to the later row. Records are *not* field-merged: merging fields across versions could resurrect stale values (e.g. an old email the patient replaced).
- **Rate limiting.** A limiter spaces request *starts* >= 200 ms apart, which guarantees <= 5 requests in any 1 s window. Retries go through the same limiter, so backoff can't cause a burst.
- **Retries.** 429, 408, 5xx and network errors: exponential backoff with full jitter, capped, honouring `Retry-After`. After `MAX_RETRIES`, that batch is written to `failed_records.json` (`reason: retries_exhausted`) and the pipeline continues.
- **400 handling: bisection.** A 400 on a batch doesn't identify the bad record, so the batch is split in halves recursively until the offender is isolated. Good records still load; bad ones are logged with the API's error text (`reason: bad_request`). Cost is O(k log n) extra requests for k bad records.
- **401/403 abort the run.** Retrying a bad token 100 times helps nobody. `failed_records.json` is still flushed first.
- **Exit codes:** `0` clean, `2` finished but some records failed, `1` fatal. Lets the client's scheduler alert on partial failure.
- **PHI hygiene.** Logs contain counts only. `failed_records.json` *does* contain patient data, so it goes to a mounted volume the client controls.
- **Container:** 3-stage build (compile / prod-deps / runtime), alpine, non-root `node` user, no secrets in the image, token via env or mounted secret file.

## Date parsing logic (`parseCalendarDate`)
Sources mix `MM/DD/YYYY`, `YYYY-MM-DD`, `DD-MM-YYYY`. Dates like `04-05-1980` are inherently ambiguous, so the rules are explicit and by separator:
1. 4-digit year first -> ISO `Y-M-D`.
2. Year last with `/` -> US `MM/DD/YYYY`.
3. Year last with `-` or `.` -> `DD-MM-YYYY`.
4. Self-correction: if the assumed month is > 12 and the other part is <= 12, swap (so `15/03/1985` and `12-25-1978` still parse).
5. Round-trip validation rejects impossible dates (`02/30/1990`); years < 1900 and future DOBs are rejected; 2-digit years are rejected.
6. Anything else -> `null` and counted as `unparseableDob`.

**Known residual risk:** a `/` date with both parts <= 12 that was really `DD/MM` is silently misread under rule 2. Only the source system owner can resolve that; see the upstream recommendation in `client_communication.md`. `last_modified` uses the same date logic; naive timestamps are assumed UTC.

## Assumptions to confirm with the client / SHC
- CSV headers: `patient_id, first_name, last_name, email, phone, dob, account_balance, last_modified` (case/space-insensitive).
- Request body is a JSON array of patient objects (one `buildPayload` change in `client.ts` if the API wants `{ "patients": [...] }`).
- A 400 rejects the whole batch atomically (needed for safe bisection), and `patient_id` upserts, so re-runs are safe.
- Phones: 10-digit numbers get `DEFAULT_COUNTRY_CODE` (default `1`); anything ambiguous becomes `null`.
- Currency symbols are stripped without conversion; European `1.234,56` formatting is not supported (flagged as `unparseableBalance`, not misread).
- The CSV is read into memory. Fine for hundreds of thousands of rows; swap to a streaming parser beyond that.

## Running
```bash
npm install          # generates package-lock.json (commit it; Docker uses `npm ci`)
npm test             # unit tests (vitest)
npm run typecheck

# Local dry run (no network, no token needed)
DRY_RUN=true INPUT_FILE=./data/sample_patients.csv FAILED_RECORDS_FILE=./failed_records.json npm run dev

# Real run
cp .env.example .env   # fill in token, then export the vars
npm run build && npm start
```

### Docker
```bash
docker build -t shc-ingest .
docker run --rm \
  -e SHC_API_TOKEN="$SHC_API_TOKEN" \
  -v "$PWD/data/sample_patients.csv:/data/patients.csv:ro" \
  -v "$PWD/output:/output" \
  shc-ingest
```

## Config reference
`SHC_API_TOKEN` | `SHC_API_TOKEN_FILE` | `SHC_API_URL` | `INPUT_FILE` | `FAILED_RECORDS_FILE` | `BATCH_SIZE` (<=100) | `MAX_RPS` (<=5) | `MAX_RETRIES` | `BACKOFF_BASE_MS` | `BACKOFF_MAX_MS` | `REQUEST_TIMEOUT_MS` | `DEFAULT_COUNTRY_CODE` | `DRY_RUN`

## Tests
`tests/normalize.test.ts` covers all three date formats plus ambiguous/invalid dates, currency parsing, phone/email, and dedupe ordering. `tests/client.test.ts` covers batch sizing, 429/5xx backoff, retry exhaustion, 400 isolation, 401 abort, and a fake-clock proof that the limiter never exceeds 5 starts/second.

## End-to-end test with the local mock API
```bash
npm run mock                          # terminal 1: simulates auth, 429s, 503s, 400s
SHC_API_TOKEN=test-token SHC_API_URL=http://localhost:3000/v1/patients \
INPUT_FILE=./data/sample_patients.csv FAILED_RECORDS_FILE=./failed_records.json npm run dev
```
Verified locally: 34 unit tests pass; against the mock, transient 503s are retried, the bad record (P005) is isolated and written to `failed_records.json` while the other records load; the Docker image builds, runs as non-root (`node`), and is ~196MB on disk.