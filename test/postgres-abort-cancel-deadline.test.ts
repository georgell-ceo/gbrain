import { afterEach, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { finishAbortedUnsafe } from '../src/core/postgres-engine/cancellation.ts';

const envKey = 'GBRAIN_HTTP_ABORT_CANCEL_MS';
const previous = process.env[envKey];

afterEach(() => {
  if (previous === undefined) delete process.env[envKey];
  else process.env[envKey] = previous;
});

describe('finishAbortedUnsafe', () => {
  test('a cancel that never settles discards the connection at the deadline', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => { unhandled.push(err); };
    process.on('unhandledRejection', onUnhandled);
    let discarded = 0;
    let released = 0;
    let rejectPending: (err: unknown) => void = () => {};
    const pending = new Promise((_resolve, reject) => { rejectPending = reject; });
    try {
      await finishAbortedUnsafe({
        cancellation: new Promise(() => {}),
        pending,
        retired: false,
        owner: { discard() { discarded++; } },
        reserved: { release() { released++; } },
        deadlineMs: 20,
      });
      rejectPending(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
      await Promise.resolve();
      await Promise.resolve();
      expect(discarded).toBe(1);
      expect(released).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a cancel that settles without retiring the connection does not discard it', async () => {
    let discarded = 0;
    let released = 0;
    await finishAbortedUnsafe({
      cancellation: Promise.resolve(),
      pending: Promise.resolve([]),
      retired: false,
      owner: { discard() { discarded++; } },
      reserved: { release() { released++; } },
      deadlineMs: 1_000,
    });
    expect(discarded).toBe(0);
    expect(released).toBe(1);
  });
});

describe('runUnsafe abort deadline', () => {
  test('an aborted statement discards the reserved connection when cancel never settles', async () => {
    process.env[envKey] = '30';
    const ac = new AbortController();
    let discarded = 0;
    let released = 0;
    let sawUnsafe = false;
    const reserved = {
      discard() { discarded++; },
      release() { released++; },
      unsafe() {
        sawUnsafe = true;
        const query = new Promise(() => {});
        return Object.assign(query, { cancel: () => new Promise(() => {}) });
      },
    };
    const engine = new PostgresEngine();
    Object.defineProperty(engine, '_sql', {
      value: {
        discard() { discarded++; },
        reserve: async () => reserved,
        unsafe() { throw new Error('pool unsafe should not run for a signalled statement'); },
      },
    });
    const pending = engine.executeRaw('select 1', [], { signal: ac.signal });
    for (let i = 0; i < 20 && !sawUnsafe; i++) await Promise.resolve();
    expect(sawUnsafe).toBe(true);
    ac.abort();
    const outcome = await Promise.race([
      pending.then(() => 'resolved' as const, (err: unknown) => err),
      new Promise<Error>((resolve) => setTimeout(() => resolve(new Error('cancel deadline did not settle')), 500)),
    ]);
    expect(outcome).toMatchObject({ name: 'AbortError' });
    expect(discarded).toBe(1);
    expect(released).toBe(1);
  });
});
