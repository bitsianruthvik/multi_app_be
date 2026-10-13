/**
 * batch.js — a bulk run, and what a service may skip inside one.
 * (TM/CF_HRMS_HIRING_SPEC.md §13.4: a round trip to production costs ~49 ms.)
 *
 * The Excel apply calls the SAME service functions a screen does, two hundred
 * times in one transaction. Each of those functions ends by reading the record
 * back — four or five queries the screen needs and a bulk run throws away — and
 * each code issued re-reads the company's code rules, which cannot change
 * between one row and the next.
 *
 * So a bulk run MARKS ITS CONNECTION (`asBatch`), and inside it:
 *   - a service that has finished its write returns the id (and the code)
 *     instead of the full record: `if (inBatch(db)) return …` — every rule
 *     above that line has run exactly as on a screen;
 *   - codeService reads the code rules once (services/codeService.js).
 *
 * Nothing else changes. The mark is taken off when the run ends, whatever
 * happens, so a pooled connection never carries it into the next request.
 */

export const inBatch = (db) => Boolean(db?.hrmsBatch);

/** Runs `fn` with the connection marked as a bulk run. Nested calls share the one mark. */
export async function asBatch(db, fn) {
  if (db.hrmsBatch) return fn();
  db.hrmsBatch = new Map();
  try {
    return await fn();
  } finally {
    delete db.hrmsBatch;
  }
}

/**
 * The connection as codeService reads through it during a bulk run, to choose
 * a rule and to read what it prints (the code of a department, a role, a
 * shift): a plain SELECT is answered from memory the second time it is asked.
 * Those things do not change between one row of a file and the next — codes
 * never change at all, and a run works on one kind of record.
 *
 * NEVER remembered: anything FOR UPDATE, the counters (the running number is
 * always taken from its table, under its lock), and "is this code taken"
 * (codeService asks that on the connection itself). A write to a rule clears
 * what is remembered.
 */
export function ruleReader(db) {
  if (!db?.hrmsBatch) return db;
  const memo = db.hrmsBatch;
  const RULES = /\bcf_code_scheme(s|_conditions|_segments)\b/;
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== 'query') { const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v; }
      return async (sql, params) => {
        const text = String(sql);
        if (/\bcf_code_sequences\b/.test(text) || /FOR UPDATE/i.test(text)) return target.query(sql, params);
        if (!/^\s*SELECT\b/i.test(text)) { if (RULES.test(text)) for (const k of [...memo.keys()]) if (String(k).startsWith('rule:')) memo.delete(k); return target.query(sql, params); }
        const key = `rule:${text}|${JSON.stringify(params ?? [])}`;
        if (!memo.has(key)) memo.set(key, await target.query(sql, params));
        return memo.get(key);
      };
    },
  });
}

export default { inBatch, asBatch, ruleReader };
