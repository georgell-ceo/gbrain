/**
 * Tests for the entity-slug auto-prefix safety net in importFromContent.
 *
 * Background: during the 2026-05-20 Iron-Law back-link rollout, 113 bare-slug
 * duplicate entity pages appeared (78 person, 35 company) imported via some
 * path that fed bare relative paths instead of the canonical dir-prefixed
 * shape. importFromContent now defensively auto-prefixes 'people/' or
 * 'companies/' when an entity-typed page is being written with a bare slug.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  for (const t of ['links', 'content_chunks', 'timeline_entries', 'raw_data', 'tags', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
});

describe('entity-slug auto-prefix', () => {
  test('type=person + bare slug auto-prefixes people/', async () => {
    const result = await importFromContent(
      engine,
      'alice-chen',
      `---\ntype: person\ntitle: Alice Chen\n---\n\nAlice is an engineer.`,
      { noEmbed: true },
    );
    expect(result.slug).toBe('people/alice-chen');
    const page = await engine.getPage('people/alice-chen');
    expect(page).toBeTruthy();
    expect(page!.type).toBe('person');
  });

  test('type=company + bare slug auto-prefixes companies/', async () => {
    const result = await importFromContent(
      engine,
      'acme',
      `---\ntype: company\ntitle: Acme Corp\n---\n\nAcme makes anvils.`,
      { noEmbed: true },
    );
    expect(result.slug).toBe('companies/acme');
    const page = await engine.getPage('companies/acme');
    expect(page).toBeTruthy();
    expect(page!.type).toBe('company');
  });

  test('does NOT auto-prefix when slug already has dir prefix', async () => {
    const result = await importFromContent(
      engine,
      'wiki/agents/12/alice-chen',
      `---\ntype: person\ntitle: Alice Chen\n---\n\nbody`,
      { noEmbed: true },
    );
    expect(result.slug).toBe('wiki/agents/12/alice-chen');
  });

  test('does NOT auto-prefix non-entity types with bare slugs', async () => {
    const result = await importFromContent(
      engine,
      'random-note',
      `---\ntype: note\ntitle: Random Note\n---\n\nbody`,
      { noEmbed: true },
    );
    expect(result.slug).toBe('random-note');
  });

  test('idempotent: re-running with bare slug + same content does NOT create duplicate', async () => {
    const first = await importFromContent(
      engine,
      'bob',
      `---\ntype: person\ntitle: Bob\n---\n\nbody`,
      { noEmbed: true },
    );
    expect(first.slug).toBe('people/bob');

    const second = await importFromContent(
      engine,
      'bob',
      `---\ntype: person\ntitle: Bob\n---\n\nbody`,
      { noEmbed: true },
    );
    expect(second.slug).toBe('people/bob');
    expect(second.status).toBe('skipped');

    const { rows } = await (engine as any).db.query(
      `SELECT slug FROM pages WHERE slug IN ('bob', 'people/bob')`,
    );
    expect(rows.map((r: any) => r.slug)).toEqual(['people/bob']);
  });
});
