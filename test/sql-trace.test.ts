import { expect, test } from 'bun:test';
import { traceSqlOptions } from '../src/core/sql-trace.ts';
import { withEnv } from './helpers/with-env.ts';

test('the SQL trace is off by default and does not wrap the socket', async () => {
  await withEnv({ GBRAIN_SQL_TRACE: undefined }, async () => {
    const options = { max: 2, connection: { statement_timeout: '5000' } };
    const traced = traceSqlOptions(options, 'read') as typeof options & { socket?: unknown; onhold?: unknown; onsql?: unknown };
    expect(traced.max).toBe(2);
    expect(traced.connection).toEqual(options.connection);
    expect(traced.socket).toBeUndefined();
    expect(typeof traced.onhold).toBe('function');
    expect(typeof traced.onsql).toBe('function');
  });
});

test('GBRAIN_SQL_TRACE adds the tracing socket and labels application_name, keeping other connection parameters', async () => {
  await withEnv({ GBRAIN_SQL_TRACE: '/tmp/gbrain-sql-trace-unit.jsonl', GBRAIN_SQL_TRACE_LABEL: 'cli-sync' }, async () => {
    const traced = traceSqlOptions({ max: 2, connection: { statement_timeout: '5000' } } as Record<string, unknown>, 'direct');
    expect(typeof traced.socket).toBe('function');
    expect(traced.connection).toEqual({ statement_timeout: '5000', application_name: `gbrain:cli-sync:${process.pid}:direct` });
    expect(traced.max).toBe(2);
  });
});
