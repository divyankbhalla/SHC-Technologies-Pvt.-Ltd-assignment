import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse } from 'csv-parse/sync';
import { loadConfig } from './config';
import { transformRows, type FailedRecord } from './normalize';
import { AuthError, ShcClient } from './client';

const normHeader = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, '_');

function writeFailed(path: string, failed: FailedRecord[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(failed, null, 2));
}

async function main(): Promise<number> {
  const cfg = loadConfig();

  // Extract
  const raw = readFileSync(cfg.inputFile, 'utf8');
  const rows = parse(raw, {
    columns: (h: string[]) => h.map(normHeader),
    skip_empty_lines: true,
    relax_column_count: true, // legacy exports often have ragged rows
    relax_quotes: true,
    trim: true,
    bom: true,
  }) as Record<string, string | undefined>[];

  // Transform (logs counts only, never patient data: this is PHI)
  const { patients, rejected, report } = transformRows(rows, { defaultCountryCode: cfg.defaultCountryCode });
  console.log('transform report:', JSON.stringify(report));

  const failed: FailedRecord[] = [...rejected];

  // Load
  if (cfg.dryRun) {
    console.log(`DRY_RUN: would send ${patients.length} records in ${Math.ceil(patients.length / cfg.batchSize)} batches`);
  } else {
    try {
      const client = new ShcClient(cfg);
      const result = await client.ingestAll(patients);
      failed.push(...result.failed);
      console.log(`load complete: accepted=${result.accepted} failed=${result.failed.length} requests=${result.requests}`);
    } catch (e) {
      writeFailed(cfg.failedRecordsFile, failed); // keep what we have before aborting
      throw e;
    }
  }

  writeFailed(cfg.failedRecordsFile, failed);
  if (failed.length > 0) console.warn(`${failed.length} record(s) written to ${cfg.failedRecordsFile}`);
  return failed.length > 0 ? 2 : 0; // non-zero lets schedulers/CI notice partial failures
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof AuthError ? `FATAL: ${e.message}` : e);
    process.exit(1);
  },
);
