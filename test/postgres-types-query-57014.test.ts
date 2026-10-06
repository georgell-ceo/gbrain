import { describe, expect, test } from 'bun:test';
import net from 'node:net';
import postgres from '#postgres';

function pgMessage(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, 1, 'latin1');
  head.writeUInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

function error57014(): Buffer {
  const body = Buffer.concat([
    Buffer.from('SERROR\0'),
    Buffer.from('VERROR\0'),
    Buffer.from('C57014\0'),
    Buffer.from('Mcanceling statement due to statement timeout\0'),
    Buffer.from([0]),
  ]);
  return pgMessage('E', body);
}

describe('postgres startup types query', () => {
  test('a 57014 on the types query rejects the caller and is not unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    const seen: Buffer[] = [];
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      let startup = false;
      socket.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        seen.push(bytes);
        buf = Buffer.concat([buf, bytes]);
        if (!startup && buf.length >= 4) {
          const len = buf.readUInt32BE(0);
          if (buf.length < len) return;
          startup = true;
          buf = buf.subarray(len);
          const auth = Buffer.alloc(4);
          auth.writeInt32BE(0, 0);
          socket.write(Buffer.concat([
            pgMessage('R', auth),
            pgMessage('Z', Buffer.from('I')),
          ]));
        }
        if (startup && buf.includes(Buffer.from('typarray'))) {
          socket.write(Buffer.concat([error57014(), pgMessage('Z', Buffer.from('I'))]));
          buf = Buffer.alloc(0);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind a port');
    const sql = postgres({
      host: '127.0.0.1',
      port: address.port,
      database: 'postgres',
      username: 'postgres',
      password: 'postgres',
      ssl: false,
      max: 1,
      connect_timeout: 2,
      fetch_types: true,
    });
    try {
      const outcome = await Promise.race([
        sql`select 1`.then(
          () => ({ ok: true as const }),
          (err: unknown) => ({ ok: false as const, err }),
        ),
        new Promise<{ ok: false; err: Error }>((resolve) => {
          setTimeout(() => resolve({ ok: false, err: new Error(`hung; bytes=${Buffer.concat(seen).toString('utf8')}`) }), 2_000);
        }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        const err = outcome.err as { code?: string; message?: string };
        expect(err.code).toBe('57014');
        expect(err.message).toContain('statement timeout');
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      try { await sql.end({ timeout: 1 }); } catch { /* the mock closes the socket */ }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
