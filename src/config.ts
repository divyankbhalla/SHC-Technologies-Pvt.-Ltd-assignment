import { readFileSync } from 'node:fs';

export interface Config {
  apiUrl: string;
  token: string;
  inputFile: string;
  failedRecordsFile: string;
  batchSize: number;
  maxRps: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  requestTimeoutMs: number;
  defaultCountryCode: string;
  dryRun: boolean;
}

const posInt = (v: string | undefined, def: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

/** All configuration comes from env vars so the image holds no secrets. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dryRun = env.DRY_RUN === 'true';
  let token = env.SHC_API_TOKEN;
  // Support Docker/K8s secrets mounted as files.
  if (!token && env.SHC_API_TOKEN_FILE) token = readFileSync(env.SHC_API_TOKEN_FILE, 'utf8').trim();
  if (!token && !dryRun) {
    throw new Error('SHC_API_TOKEN (or SHC_API_TOKEN_FILE) is required unless DRY_RUN=true');
  }
  return {
    apiUrl: env.SHC_API_URL ?? 'https://api.mock-shc.com/v1/patients',
    token: token ?? '',
    inputFile: env.INPUT_FILE ?? '/data/patients.csv',
    failedRecordsFile: env.FAILED_RECORDS_FILE ?? '/output/failed_records.json',
    // Hard caps from the API contract: never exceed 100 records / 5 rps.
    batchSize: Math.min(posInt(env.BATCH_SIZE, 100), 100),
    maxRps: Math.min(posInt(env.MAX_RPS, 5), 5),
    maxRetries: posInt(env.MAX_RETRIES, 5),
    baseDelayMs: posInt(env.BACKOFF_BASE_MS, 500),
    maxDelayMs: posInt(env.BACKOFF_MAX_MS, 30_000),
    requestTimeoutMs: posInt(env.REQUEST_TIMEOUT_MS, 15_000),
    defaultCountryCode: env.DEFAULT_COUNTRY_CODE ?? '1',
    dryRun,
  };
}
