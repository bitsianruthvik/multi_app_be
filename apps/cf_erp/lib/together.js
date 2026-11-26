/**
 * together.js — independent reads side by side, failing as the same reads one after another would (speed, 2026-11-26).
 *
 * On production every statement is a round trip (~100 ms to TiDB), and a read made of five independent statements
 * waited for each in turn. On the pool each statement takes its own connection, so they can run at once; on a
 * transaction's one connection mysql2 queues them, so nothing changes there but the order they are sent in.
 *
 * Unlike Promise.all it waits for every one to settle and then throws the FIRST failure in the order given — what the
 * sequential code would have thrown — never one that merely came back first, and never leaves a rejection unhandled.
 */
export async function together(...work) {
  const settled = await Promise.allSettled(work);
  for (const s of settled) if (s.status === 'rejected') throw s.reason;
  return settled.map((s) => s.value);
}
