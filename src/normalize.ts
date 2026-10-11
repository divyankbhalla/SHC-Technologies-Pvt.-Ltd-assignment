export interface Patient {
  patient_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  dob: string | null; // YYYY-MM-DD
  account_balance: number | null;
  last_modified: string | null; // ISO 8601 UTC
}

export interface FailedRecord {
  reason: string;
  status?: number;
  error?: string;
  record: unknown;
}

export interface TransformReport {
  rowsRead: number;
  rowsRejected: number;
  missingEmail: number;
  invalidEmail: number;
  missingPhone: number;
  invalidPhone: number;
  missingDob: number;
  unparseableDob: number;
  unparseableBalance: number;
  unparseableLastModified: number;
  duplicatesRemoved: number;
  uniquePatients: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

function validYMD(y: number, m: number, d: number): boolean {
  if (y < 1900 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Round-trip check rejects 02/31 etc.
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Parse a calendar date in one of: YYYY-MM-DD (also / .), MM/DD/YYYY, DD-MM-YYYY.
 *
 * Disambiguation rules (documented in README):
 *  1. 4-digit year first            -> ISO (Y-M-D)
 *  2. Slash separator, year last    -> US convention MM/DD/YYYY
 *  3. Dash or dot separator, year last -> DD-MM-YYYY
 *  4. If a rule's "month" is > 12 and the other part is <= 12, swap (self-correcting).
 *  5. Must be a real calendar date, year >= 1900. Otherwise null (never guess).
 */
export function parseCalendarDate(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  let y: number, m: number, d: number;

  let match = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) {
    y = +match[1]!; m = +match[2]!; d = +match[3]!;
  } else if ((match = s.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/))) {
    const a = +match[1]!;
    const sep = match[2]!;
    const b = +match[3]!;
    y = +match[4]!;
    if (sep === '/') { m = a; d = b; if (m > 12 && d <= 12) { m = b; d = a; } }
    else { d = a; m = b; if (m > 12 && d <= 12) { m = a; d = b; } }
  } else {
    return null;
  }
  return validYMD(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/** DOB = calendar date that is not in the future. Tolerates a trailing time part. */
export function parseDob(raw: string | null | undefined, now: Date = new Date()): string | null {
  const datePart = raw?.trim().split(/[T\s]/)[0];
  const iso = parseCalendarDate(datePart);
  if (!iso) return null;
  return new Date(`${iso}T00:00:00Z`).getTime() > now.getTime() ? null : iso;
}

/** last_modified -> ISO 8601 UTC. Naive timestamps are assumed UTC for determinism. */
export function parseTimestamp(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const m = s.match(/^(\S+)(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const date = parseCalendarDate(m[1]);
  if (!date) return null;
  const hh = +(m[2] ?? 0), mm = +(m[3] ?? 0), ss = +(m[4] ?? 0);
  if (hh > 23 || mm > 59 || ss > 59) return null;
  return `${date}T${pad(hh)}:${pad(mm)}:${pad(ss)}.000Z`;
}

/** "$1,250.50", "€ 99.9", "(320.75)", "-$300" -> float. null if not numeric. */
export function parseMoney(raw: string | null | undefined): number | null {
  const s = raw?.trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || s.includes('-');
  const cleaned = s.replace(/[^0-9.]/g, '');
  if (!cleaned || (cleaned.match(/\./g) ?? []).length > 1) return null;
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function normalizeEmail(raw: string | null | undefined): string | null {
  const s = raw?.trim().toLowerCase();
  return s && EMAIL_RE.test(s) ? s : null;
}

/** Light E.164-style normalisation. Ambiguous numbers become null rather than guesses. */
export function normalizePhone(raw: string | null | undefined, countryCode = '1'): string | null {
  const s = raw?.trim().split(/\s*(?:x|ext\.?)\s*\d+$/i)[0];
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (s.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+${countryCode}${digits}`;
  if (digits.length === 11 && digits.startsWith(countryCode)) return `+${digits}`;
  return null;
}

const blank = (v: string | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

export interface TransformResult {
  patients: Patient[];
  rejected: FailedRecord[];
  report: TransformReport;
}

export function transformRows(
  rows: Record<string, string | undefined>[],
  opts: { defaultCountryCode?: string; now?: Date } = {},
): TransformResult {
  const report: TransformReport = {
    rowsRead: rows.length, rowsRejected: 0, missingEmail: 0, invalidEmail: 0,
    missingPhone: 0, invalidPhone: 0, missingDob: 0, unparseableDob: 0,
    unparseableBalance: 0, unparseableLastModified: 0, duplicatesRemoved: 0, uniquePatients: 0,
  };
  const rejected: FailedRecord[] = [];
  const byId = new Map<string, Patient>();

  for (const row of rows) {
    const id = blank(row.patient_id);
    if (!id) {
      report.rowsRejected++;
      rejected.push({ reason: 'missing_patient_id', record: row });
      continue;
    }

    const rawEmail = blank(row.email), rawPhone = blank(row.phone);
    const rawDob = blank(row.dob), rawBal = blank(row.account_balance), rawMod = blank(row.last_modified);

    const email = normalizeEmail(rawEmail);
    if (!rawEmail) report.missingEmail++; else if (!email) report.invalidEmail++;

    const phone = normalizePhone(rawPhone, opts.defaultCountryCode);
    if (!rawPhone) report.missingPhone++; else if (!phone) report.invalidPhone++;

    const dob = parseDob(rawDob, opts.now);
    if (!rawDob) report.missingDob++; else if (!dob) report.unparseableDob++;

    const balance = parseMoney(rawBal);
    if (rawBal && balance === null) report.unparseableBalance++;

    const lastModified = parseTimestamp(rawMod);
    if (rawMod && !lastModified) report.unparseableLastModified++;

    const candidate: Patient = {
      patient_id: id,
      first_name: blank(row.first_name),
      last_name: blank(row.last_name),
      email, phone, dob,
      account_balance: balance,
      last_modified: lastModified,
    };

    const existing = byId.get(id);
    if (!existing) { byId.set(id, candidate); continue; }

    // Duplicate: keep the most recent last_modified. Missing timestamp loses.
    // Tie -> later row in the file wins (exports are usually appended chronologically).
    report.duplicatesRemoved++;
    const ts = (p: Patient) => (p.last_modified ? Date.parse(p.last_modified) : -Infinity);
    if (ts(candidate) >= ts(existing)) byId.set(id, candidate);
  }

  const patients = [...byId.values()];
  report.uniquePatients = patients.length;
  return { patients, rejected, report };
}
