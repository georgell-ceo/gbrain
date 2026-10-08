import { describe, expect, test } from 'bun:test';
import { createHostedHttpGuards } from '../src/core/http-hosted-guards.ts';
import {
  HTTP_POOL_STARVATION_EXIT,
  createHttpPoolWatchdog,
  type HttpPoolWatchdogEngine,
} from '../src/core/http-pool-watchdog.ts';
import type { DbProbeResult } from '../src/core/minions/db-probe.ts';
import {
  jobPoolOwner,
  mcpPoolOwner,
  notePoolHold,
  notePoolSql,
  resetPoolHoldsForTests,
  withPoolOwner,
} from '../src/core/pool-holds.ts';

const engine: HttpPoolWatchdogEngine = {
  kind: 'postgres',
  executeRaw: async () => [],
};

function starved(): DbProbeResult {
  return { ok: false, verdict: 'pool_starved', detail: 'read pool timed out' };
}

function healthy(): DbProbeResult {
  return { ok: true };
}

function directUnready(): DbProbeResult {
  return {
    ok: false,
    verdict: 'unknown',
    directUnready: true,
    detail: 'read probe succeeded; required direct probe failed',
  };
}

function plainUnknown(): DbProbeResult {
  return { ok: false, verdict: 'unknown', detail: 'read probe failed; no direct lane' };
}

describe('http pool watchdog', () => {
  test('sustained pool starvation exits after N failures', async () => {
    const exits: number[] = [];
    const logs: string[] = [];
    const wd = createHttpPoolWatchdog(engine, {
      everyMs: 15_000,
      maxFails: 4,
      fatalExit: true,
      graceMs: 0,
      now: () => 1_000_000,
      exit: (code) => { exits.push(code); },
      log: (line) => { logs.push(line); },
      probe: async () => starved(),
    });
    for (let i = 0; i < 3; i++) await wd.tick();
    expect(exits).toEqual([]);
    await wd.tick();
    expect(exits).toEqual([HTTP_POOL_STARVATION_EXIT]);
    expect(logs.some(line => line.includes('pool watchdog miss (pool_starved) 1/4'))).toBe(true);
    expect(logs.some(line => line.includes('pool_starved') && line.includes('exiting so the host can restart'))).toBe(true);
    await wd.tick();
    expect(exits).toEqual([HTTP_POOL_STARVATION_EXIT]);
  });

  test('a starved pool exit logs who holds each connection', async () => {
    resetPoolHoldsForTests();
    expect(mcpPoolOwner(9, 'search')).toBe('mcp:9:search');
    expect(jobPoolOwner('embed')).toBe('job:embed');
    expect(jobPoolOwner('autopilot-cycle')).toBe('autopilot:autopilot-cycle');
    const secret = 'super-secret-token';
    withPoolOwner('persistence:idle-lane', () => {
      notePoolHold('read', 4, 'acquire');
    });
    withPoolOwner('mcp:9:search', () => {
      notePoolSql('read', 5, 'select slug from pages where slug = $1');
      notePoolHold('read', 5, 'acquire');
    });
    withPoolOwner('job:embed', () => {
      notePoolHold('read', 6, 'acquire');
    });
    notePoolSql('read', 6, `select 'postgres://app:${secret}@db.example/brain'`);
    withPoolOwner('autopilot:autopilot-cycle', () => {
      notePoolHold('read', 7, 'acquire');
    });
    notePoolHold('read', 7, 'release');
    const exits: number[] = [];
    const logs: string[] = [];
    const wd = createHttpPoolWatchdog({
      kind: 'postgres',
      executeRaw: async () => [],
      poolCensus: () => ({ max: 6, idle: 0, in_use: 3, waiting: 4 }),
    }, {
      everyMs: 15_000,
      maxFails: 4,
      fatalExit: true,
      graceMs: 0,
      now: () => 1_000_000,
      exit: (code) => { exits.push(code); },
      log: (line) => { logs.push(line); },
      probe: async () => starved(),
    });
    for (let i = 0; i < 4; i++) await wd.tick();
    expect(exits).toEqual([HTTP_POOL_STARVATION_EXIT]);
    const lines = logs.filter(line => line.startsWith('[hosted-http] pool_starved holders '));
    expect(lines).toHaveLength(1);
    const body = JSON.parse(lines[0]!.slice('[hosted-http] pool_starved holders '.length)) as {
      size: number; in_use: number; idle: number; waiting: number;
      holds: { holder: string; age_ms: number; last_sql: string }[];
    };
    expect(body).toMatchObject({ size: 6, in_use: 3, idle: 0, waiting: 4 });
    const idle = body.holds.find(hold => hold.holder === 'persistence:idle-lane');
    const mcp = body.holds.find(hold => hold.holder === 'mcp:9:search');
    const job = body.holds.find(hold => hold.holder === 'job:embed');
    expect(idle?.last_sql).toBe('none');
    expect(idle?.age_ms).toBeGreaterThanOrEqual(0);
    expect(idle?.age_ms).toBeLessThan(10_000);
    expect(mcp?.last_sql).toBe('select slug from pages where slug = $1');
    expect(job?.last_sql).toBe("select 'postgres://[redacted]'");
    expect(body.holds.some(hold => hold.holder.startsWith('autopilot:'))).toBe(false);
    expect(lines[0]).not.toContain(secret);
    resetPoolHoldsForTests();
  });

  test('a healthy probe between misses resets the streak', async () => {
    const exits: number[] = [];
    const plan = ['ok', 'miss', 'ok', 'miss', 'miss', 'miss'] as const;
    let n = 0;
    const wd = createHttpPoolWatchdog(engine, {
      everyMs: 15_000,
      maxFails: 4,
      fatalExit: true,
      graceMs: 0,
      now: () => 1_000_000,
      exit: (code) => { exits.push(code); },
      log: () => {},
      probe: async () => (plan[n++] === 'ok' ? healthy() : starved()),
    });
    for (let i = 0; i < plan.length; i++) await wd.tick();
    expect(exits).toEqual([]);
    await wd.tick();
    expect(exits).toEqual([HTTP_POOL_STARVATION_EXIT]);
  });

  test('GBRAIN_HTTP_POOL_WATCHDOG_MS=0 does not exit', async () => {
    const exits: number[] = [];
    const wd = createHttpPoolWatchdog(engine, {
      env: { GBRAIN_HTTP_POOL_WATCHDOG_MS: '0', GBRAIN_HTTP_FATAL_EXIT: '1' },
      graceMs: 0,
      now: () => 1_000_000,
      exit: (code) => { exits.push(code); },
      probe: async () => starved(),
    });
    expect(wd.label).toBe('off');
    for (let i = 0; i < 6; i++) await wd.tick();
    expect(exits).toEqual([]);
  });

  test('GBRAIN_HTTP_FATAL_EXIT=0 does not exit', async () => {
    const exits: number[] = [];
    const wd = createHttpPoolWatchdog(engine, {
      env: { GBRAIN_HTTP_FATAL_EXIT: '0' },
      graceMs: 0,
      now: () => 1_000_000,
      exit: (code) => { exits.push(code); },
      probe: async () => starved(),
    });
    expect(wd.label).toBe('off');
    for (let i = 0; i < 6; i++) await wd.tick();
    expect(exits).toEqual([]);
  });

  test('startup grace ignores verdicts', async () => {
    const exits: number[] = [];
    let t = 0;
    const wd = createHttpPoolWatchdog(engine, {
      everyMs: 15_000,
      maxFails: 1,
      fatalExit: true,
      graceMs: 60_000,
      now: () => t,
      exit: (code) => { exits.push(code); },
      log: () => {},
      probe: async () => starved(),
    });
    t = 1_000;
    await wd.tick();
    expect(exits).toEqual([]);
    t = 60_000;
    await wd.tick();
    expect(exits).toEqual([HTTP_POOL_STARVATION_EXIT]);
  });

  test('a plain unknown still uses the fast budget', async () => {
    const exits: number[] = [];
    const wd = createHttpPoolWatchdog(engine, {
      everyMs: 15_000,
      maxFails: 4,
      fatalExit: true,
      graceMs: 0,
      now: () => 1_000_000,
      exit: (code) => { exits.push(code); },
      log: () => {},
      probe: async () => plainUnknown(),
    });
    for (let i = 0; i < 3; i++) await wd.tick();
    expect(exits).toEqual([]);
    await wd.tick();
    expect(exits).toEqual([HTTP_POOL_STARVATION_EXIT]);
  });

  test('read success with a failed direct lane uses the slower budget', async () => {
    const exits: number[] = [];
    const logs: string[] = [];
    const wd = createHttpPoolWatchdog(engine, {
      everyMs: 15_000,
      maxFails: 4,
      fatalExit: true,
      graceMs: 0,
      now: () => 1_000_000,
      exit: (code) => { exits.push(code); },
      log: (line) => { logs.push(line); },
      probe: async () => directUnready(),
    });
    for (let i = 0; i < 4; i++) await wd.tick();
    expect(exits).toEqual([]);
    for (let i = 0; i < 7; i++) await wd.tick();
    expect(exits).toEqual([]);
    expect(logs.some(line => line.includes('pool watchdog miss (unknown) 1/12'))).toBe(true);
    await wd.tick();
    expect(exits).toEqual([HTTP_POOL_STARVATION_EXIT]);
  });

  test('a tick still in flight is not started again', async () => {
    let active = 0;
    let maxActive = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const wd = createHttpPoolWatchdog(engine, {
      everyMs: 15,
      maxFails: 4,
      fatalExit: true,
      graceMs: 0,
      exit: () => {},
      log: () => {},
      probe: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        active -= 1;
        return healthy();
      },
    });
    const stop = wd.start();
    try {
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(maxActive).toBe(1);
    } finally {
      release();
      stop();
    }
  });

  test('a probe that finishes after stop does not exit', async () => {
    const exits: number[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const wd = createHttpPoolWatchdog(engine, {
      everyMs: 15_000,
      maxFails: 1,
      fatalExit: true,
      graceMs: 0,
      now: () => 1_000_000,
      exit: (code) => { exits.push(code); },
      log: () => {},
      probe: async () => {
        await gate;
        return starved();
      },
    });
    const pending = wd.tick();
    const stop = wd.start();
    stop();
    release();
    await pending;
    expect(exits).toEqual([]);
  });

  test('hosted guards leave the pool watchdog off when fatal exit is off', () => {
    const guards = createHostedHttpGuards(
      { GBRAIN_HTTP_FATAL_EXIT: '0', GBRAIN_HTTP_POOL_WATCHDOG_MS: '15000' },
      () => {},
      engine,
    );
    const stop = guards.arm(true);
    try {
      const line = guards.readyLine(9);
      expect(line).toContain('fatal_exit=off');
      expect(line).toContain('pool_watchdog=off');
    } finally {
      stop();
    }
  });

  test('hosted guards arm the pool watchdog only while fatal exit is on', () => {
    const guards = createHostedHttpGuards(
      { GBRAIN_HTTP_FATAL_EXIT: '1', GBRAIN_HTTP_POOL_WATCHDOG_MS: '15000', GBRAIN_HTTP_POOL_WATCHDOG_FAILS: '4' },
      () => {},
      engine,
    );
    const stop = guards.arm(true);
    try {
      expect(guards.readyLine(9)).toContain('pool_watchdog=15000ms fails=4');
      expect(guards.readyLine(9)).toContain('fatal_exit=on');
    } finally {
      stop();
    }
  });
});
