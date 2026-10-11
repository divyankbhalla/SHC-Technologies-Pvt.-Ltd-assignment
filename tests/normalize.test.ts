import { describe, expect, it } from 'vitest';
import { normalizePhone, parseDob, parseMoney, parseTimestamp, transformRows } from '../src/normalize';

describe('parseDob', () => {
  it.each([
    ['03/15/1985', '1985-03-15'],   // MM/DD/YYYY
    ['1990-07-22', '1990-07-22'],   // ISO
    ['25-12-1978', '1978-12-25'],   // DD-MM-YYYY
    ['15/03/1985', '1985-03-15'],   // slash but day>12 -> self-correct
    ['12-25-1978', '1978-12-25'],   // dash but second part>12 -> self-correct
    ['1990-07-22T00:00:00', '1990-07-22'],
  ])('%s -> %s', (input, out) => expect(parseDob(input)).toBe(out));

  it.each(['', 'not a date', '02/30/1990', '13/13/1990', '1/1/90', '3000-01-01'])(
    'rejects %j', (input) => expect(parseDob(input)).toBeNull());
});

describe('parseMoney', () => {
  it.each([
    ['$1,250.50', 1250.5], ['-$320.75', -320.75], ['(45.10)', -45.1],
    ['€ 99.9', 99.9], ['1,000', 1000], ['0', 0],
  ])('%s -> %s', (i, o) => expect(parseMoney(i)).toBe(o));
  it.each(['', 'abc', '1.2.3'])('rejects %j', (i) => expect(parseMoney(i)).toBeNull());
});

describe('normalizePhone', () => {
  it('formats US numbers', () => expect(normalizePhone('(555) 123-4567')).toBe('+15551234567'));
  it('keeps international', () => expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958'));
  it('nulls garbage', () => expect(normalizePhone('12')).toBeNull());
});

describe('parseTimestamp', () => {
  it('assumes UTC for naive', () => expect(parseTimestamp('2024-01-10 09:00:00')).toBe('2024-01-10T09:00:00.000Z'));
  it('honours offsets', () => expect(parseTimestamp('2024-01-10T09:00:00+02:00')).toBe('2024-01-10T07:00:00.000Z'));
});

describe('transformRows', () => {
  const base = { first_name: 'A', last_name: 'B', email: 'a@b.com', phone: '5551234567', dob: '1990-01-01', account_balance: '1' };

  it('keeps the most recently modified duplicate regardless of file order', () => {
    const { patients, report } = transformRows([
      { ...base, patient_id: 'P1', last_name: 'New', last_modified: '2024-03-01 00:00:00' },
      { ...base, patient_id: 'P1', last_name: 'Old', last_modified: '2024-01-01 00:00:00' },
    ]);
    expect(patients).toHaveLength(1);
    expect(patients[0]!.last_name).toBe('New');
    expect(report.duplicatesRemoved).toBe(1);
  });

  it('rejects rows without patient_id and counts missing values', () => {
    const { patients, rejected, report } = transformRows([
      { ...base, patient_id: '', last_modified: '2024-01-01' },
      { ...base, patient_id: 'P2', email: '', phone: '', last_modified: '2024-01-01' },
    ]);
    expect(rejected).toHaveLength(1);
    expect(patients[0]!.email).toBeNull();
    expect(report.missingEmail).toBe(1);
    expect(report.missingPhone).toBe(1);
  });
});
