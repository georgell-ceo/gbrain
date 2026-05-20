/**
 * Tests for the Iron-Law back-link writer (src/core/back-link-writer.ts).
 *
 * Two layers:
 *   - Unit tests for the pure helpers (filterEligibleCandidates,
 *     deriveBackLinkDate, buildBackLinkSummary, buildBackLinkDetail).
 *   - Integration tests against a real PGLite engine, asserting that
 *     writeBackLinks creates both the graph edges and timeline entries,
 *     dedups on rewrite, and respects scope rules.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import {
  filterEligibleCandidates,
  deriveBackLinkDate,
  buildBackLinkSummary,
  buildBackLinkDetail,
  writeBackLinks,
  isAutoBackLinkEnabled,
} from '../src/core/back-link-writer.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { LinkCandidate } from '../src/core/link-extraction.ts';

describe('filterEligibleCandidates', () => {
  test('keeps people/ and companies/ targets', () => {
    const candidates: LinkCandidate[] = [
      { targetSlug: 'people/alice', linkType: 'mentions', context: 'a' },
      { targetSlug: 'companies/acme', linkType: 'mentions', context: 'b' },
    ];
    const filtered = filterEligibleCandidates('meetings/2026-04-15', candidates);
    expect(filtered.map(c => c.targetSlug).sort()).toEqual(['companies/acme', 'people/alice']);
  });

  test('drops non-entity targets (projects, deals, concepts, sources)', () => {
    const candidates: LinkCandidate[] = [
      { targetSlug: 'projects/foo', linkType: 'mentions', context: 'a' },
      { targetSlug: 'deals/bar', linkType: 'mentions', context: 'b' },
      { targetSlug: 'concepts/baz', linkType: 'mentions', context: 'c' },
      { targetSlug: 'sources/slack/x', linkType: 'mentions', context: 'd' },
    ];
    expect(filterEligibleCandidates('meetings/m1', candidates)).toEqual([]);
  });

  test('drops self-reference', () => {
    const candidates: LinkCandidate[] = [
      { targetSlug: 'people/alice', linkType: 'mentions', context: 'a' },
    ];
    expect(filterEligibleCandidates('people/alice', candidates)).toEqual([]);
  });

  test('returns empty when source page is itself an entity (people/ or companies/)', () => {
    const candidates: LinkCandidate[] = [
      { targetSlug: 'people/bob', linkType: 'mentions', context: 'a' },
      { targetSlug: 'companies/acme', linkType: 'works_at', context: 'b' },
    ];
    expect(filterEligibleCandidates('people/alice', candidates)).toEqual([]);
    expect(filterEligibleCandidates('companies/acme', candidates)).toEqual([]);
  });

  test('dedupes multiple mentions of the same target - first wins', () => {
    const candidates: LinkCandidate[] = [
      { targetSlug: 'people/alice', linkType: 'mentions', context: 'first mention' },
      { targetSlug: 'people/alice', linkType: 'mentions', context: 'second mention' },
      { targetSlug: 'people/alice', linkType: 'mentions', context: 'third mention' },
    ];
    const filtered = filterEligibleCandidates('meetings/m1', candidates);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].context).toBe('first mention');
  });

  test('drops incoming candidates (fromSlug != sourceSlug)', () => {
    const candidates: LinkCandidate[] = [
      { fromSlug: 'people/alice', targetSlug: 'meetings/m1', linkType: 'attended', context: 'a' },
    ];
    expect(filterEligibleCandidates('meetings/m1', candidates)).toEqual([]);
  });
});

describe('deriveBackLinkDate', () => {
  test('uses frontmatter.date when set as YYYY-MM-DD', () => {
    expect(deriveBackLinkDate({ date: '2026-04-15' })).toBe('2026-04-15');
  });

  test('uses frontmatter.date when set as full ISO timestamp', () => {
    expect(deriveBackLinkDate({ date: '2026-04-15T10:30:00.000Z' })).toBe('2026-04-15');
  });

  test('uses frontmatter.date when set as Date object', () => {
    const d = new Date('2026-04-15T00:00:00Z');
    expect(deriveBackLinkDate({ date: d })).toBe('2026-04-15');
  });

  test('falls back to frontmatter.created when date missing', () => {
    expect(deriveBackLinkDate({ created: '2026-03-20' })).toBe('2026-03-20');
  });

  test('falls back to today when no usable frontmatter dates', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(deriveBackLinkDate({})).toBe(today);
    expect(deriveBackLinkDate({ date: 'not-a-date' })).toBe(today);
  });
});

describe('buildBackLinkSummary', () => {
  test('uses title with markdown link to slug', () => {
    expect(buildBackLinkSummary('meetings/m1', 'All Hands'))
      .toBe('Referenced in [All Hands](meetings/m1)');
  });

  test('falls back to slug when title missing', () => {
    expect(buildBackLinkSummary('meetings/m1', ''))
      .toBe('Referenced in [meetings/m1](meetings/m1)');
  });

  test('trims whitespace-only titles', () => {
    expect(buildBackLinkSummary('meetings/m1', '   '))
      .toBe('Referenced in [meetings/m1](meetings/m1)');
  });
});

describe('buildBackLinkDetail', () => {
  test('returns trimmed context as-is when under 160 chars', () => {
    expect(buildBackLinkDetail('  Alice mentioned this in the kickoff. ')).toBe(
      'Alice mentioned this in the kickoff.',
    );
  });

  test('truncates to 160 chars with ellipsis when longer', () => {
    const long = 'word '.repeat(50);
    const result = buildBackLinkDetail(long);
    expect(result.length).toBeLessThanOrEqual(160);
    expect(result.endsWith('...')).toBe(true);
  });

  test('collapses internal whitespace', () => {
    expect(buildBackLinkDetail('Alice   said\n\nhello')).toBe('Alice said hello');
  });

  test('returns empty string for empty input', () => {
    expect(buildBackLinkDetail('')).toBe('');
  });
});

describe('writeBackLinks (integration with PGLite engine)', () => {
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

  test('writes a mentioned_in edge AND a timeline entry for each entity mention', async () => {
    await engine.putPage('people/alice', { type: 'person', title: 'Alice Chen', compiled_truth: '', frontmatter: {} });
    await engine.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: '', frontmatter: {} });
    await engine.putPage('meetings/2026-04-15-1-1', {
      type: 'meeting',
      title: '1:1 with Alice',
      compiled_truth: 'Discussion with Alice about the Acme deal.',
      frontmatter: { date: '2026-04-15' },
    });

    const candidates: LinkCandidate[] = [
      { targetSlug: 'people/alice', linkType: 'mentions', context: 'Discussion with Alice' },
      { targetSlug: 'companies/acme', linkType: 'mentions', context: 'Acme deal context' },
    ];

    const result = await writeBackLinks(
      engine,
      'meetings/2026-04-15-1-1',
      '1:1 with Alice',
      { date: '2026-04-15' },
      candidates,
    );

    expect(result.edges_created).toBe(2);
    expect(result.timeline_created).toBe(2);
    expect(result.errors).toBe(0);

    const backlinks = await engine.getBacklinks('meetings/2026-04-15-1-1');
    const fromSlugs = backlinks.map(b => b.from_slug).sort();
    expect(fromSlugs).toEqual(['companies/acme', 'people/alice']);
    expect(backlinks.every(b => b.link_type === 'mentioned_in')).toBe(true);
    expect(backlinks.every(b => b.link_source === 'auto_backlink')).toBe(true);
  });

  test('dedupes within a single writeBackLinks call when a target is mentioned twice', async () => {
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', frontmatter: {} });
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'M1', compiled_truth: '', frontmatter: { date: '2026-04-15' } });

    const candidates: LinkCandidate[] = [
      { targetSlug: 'people/alice', linkType: 'mentions', context: 'first' },
      { targetSlug: 'people/alice', linkType: 'mentions', context: 'second' },
    ];

    const result = await writeBackLinks(engine, 'meetings/m1', 'M1', { date: '2026-04-15' }, candidates);
    expect(result.edges_created).toBe(1);
    expect(result.timeline_created).toBe(1);
    const backlinks = await engine.getBacklinks('meetings/m1');
    expect(backlinks.length).toBe(1);
  });

  test('idempotent on repeat - re-running with the same input creates 0 new edges/entries', async () => {
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', frontmatter: {} });
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'M1', compiled_truth: '', frontmatter: { date: '2026-04-15' } });

    const candidates: LinkCandidate[] = [
      { targetSlug: 'people/alice', linkType: 'mentions', context: 'first call' },
    ];

    const first = await writeBackLinks(engine, 'meetings/m1', 'M1', { date: '2026-04-15' }, candidates);
    expect(first.edges_created).toBe(1);
    expect(first.timeline_created).toBe(1);

    const second = await writeBackLinks(engine, 'meetings/m1', 'M1', { date: '2026-04-15' }, candidates);
    expect(second.timeline_created).toBe(0);

    const backlinks = await engine.getBacklinks('meetings/m1');
    expect(backlinks.length).toBe(1);
  });

  test('skips when source page is itself an entity (people/ or companies/)', async () => {
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', frontmatter: {} });
    await engine.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: '', frontmatter: {} });

    const candidates: LinkCandidate[] = [
      { targetSlug: 'people/bob', linkType: 'mentions', context: 'Alice mentions Bob' },
    ];

    const result = await writeBackLinks(engine, 'people/alice', 'Alice', {}, candidates);
    expect(result.edges_created).toBe(0);
    expect(result.timeline_created).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('skips when target dir is not people/ or companies/', async () => {
    await engine.putPage('projects/foo', { type: 'project', title: 'Foo', compiled_truth: '', frontmatter: {} });
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'M1', compiled_truth: '', frontmatter: { date: '2026-04-15' } });

    const candidates: LinkCandidate[] = [
      { targetSlug: 'projects/foo', linkType: 'mentions', context: 'discussed Foo project' },
    ];

    const result = await writeBackLinks(engine, 'meetings/m1', 'M1', { date: '2026-04-15' }, candidates);
    expect(result.edges_created).toBe(0);
    expect(result.timeline_created).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test('handles missing target page without throwing', async () => {
    await engine.putPage('meetings/m1', { type: 'meeting', title: 'M1', compiled_truth: '', frontmatter: { date: '2026-04-15' } });

    const candidates: LinkCandidate[] = [
      { targetSlug: 'people/missing', linkType: 'mentions', context: 'ref to missing' },
    ];

    const result = await writeBackLinks(engine, 'meetings/m1', 'M1', { date: '2026-04-15' }, candidates);
    expect(result.edges_created).toBe(0);
    expect(result.errors).toBeGreaterThanOrEqual(0);
  });
});

describe('isAutoBackLinkEnabled', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('defaults to true when config is unset', async () => {
    expect(await isAutoBackLinkEnabled(engine)).toBe(true);
  });

  test('returns false when config is set to "false"', async () => {
    await engine.setConfig('auto_backlink_timeline', 'false');
    expect(await isAutoBackLinkEnabled(engine)).toBe(false);
  });

  test('returns false for "0", "no", "off"', async () => {
    for (const v of ['0', 'no', 'off', 'OFF', '  No  ']) {
      await engine.setConfig('auto_backlink_timeline', v);
      expect(await isAutoBackLinkEnabled(engine)).toBe(false);
    }
  });

  test('returns true for any other value', async () => {
    for (const v of ['true', '1', 'yes', 'on', 'garbage', '']) {
      await engine.setConfig('auto_backlink_timeline', v);
      expect(await isAutoBackLinkEnabled(engine)).toBe(true);
    }
  });
});
