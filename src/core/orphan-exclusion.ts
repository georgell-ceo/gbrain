/**
 * Canonical orphan-exclusion lists.
 *
 * A single source of truth for slugs that should be EXCLUDED from
 * orphan-style reporting (find_orphans MCP, gbrain orphans CLI, and the
 * orphan_pages count that feeds brain_score's no_orphans_score component).
 *
 * Used by:
 *   - src/commands/orphans.ts (shouldExclude — TS filter applied post-query)
 *   - src/core/postgres-engine.ts findOrphanPages + getHealth (SQL fragment)
 *   - src/core/pglite-engine.ts findOrphanPages + getHealth (SQL fragment)
 *
 * Why both TS and SQL: TS filter is used by find_orphans which returns the
 * full list (engine can stream raw rows and TS filters cheaply). SQL filter
 * is used by getHealth's orphan_pages count which is a `count(*)` — keeping
 * it in SQL avoids materializing all islanded slugs just to filter them in
 * memory.
 *
 * Categories:
 *   - PSEUDO_SLUGS: exact-match pseudo-pages (claude, _atlas, _index, etc.)
 *   - AUTO_SUFFIX_PATTERNS: slugs ending with auto-generated suffixes
 *     (/_index, /log, /readme)
 *   - RAW_SEGMENT: slugs containing /raw/
 *   - DENY_PREFIXES: slug prefixes where no inbound is expected. Limited
 *     to truly inbound-impossible page trees (output/, dashboards/,
 *     scripts/, templates/, openclaw/config/). NOT used to exclude
 *     collector-imported sources — those get back-links via the Iron-Law
 *     writer in src/core/back-link-writer.ts.
 *   - FIRST_SEGMENT_EXCLUSIONS: first-segment match. Limited to scratch/,
 *     thoughts/, catalog/, entities/. meetings/ and transcripts/ are NOT
 *     excluded — they're expected to receive entity back-links via the
 *     Iron-Law writer.
 *
 * Why the narrow exclusion: collector-imported pages (meetings, sources/
 * slack, sources/jira, transcripts, etc.) SHOULD be connected to the
 * graph via Iron-Law back-links. The back-link writer creates a
 * `mentioned_in` edge from each entity → the page, so the page is no
 * longer orphaned. If you find an orphan that should be back-linked but
 * isn't, the bug is in the writer (or the page lacks resolvable entity
 * refs), not in this exclusion list.
 */

export const PSEUDO_SLUGS: ReadonlySet<string> = new Set([
  '_atlas',
  '_index',
  '_stats',
  '_orphans',
  '_scratch',
  'claude',
]);

export const AUTO_SUFFIX_PATTERNS: readonly string[] = ['/_index', '/log', '/readme'];

export const RAW_SEGMENT = '/raw/';

export const DENY_PREFIXES: readonly string[] = [
  'output/',
  'dashboards/',
  'scripts/',
  'templates/',
  'openclaw/config/',
];

export const FIRST_SEGMENT_EXCLUSIONS: ReadonlySet<string> = new Set([
  'scratch',
  'thoughts',
  'catalog',
  'entities',
]);

/**
 * Returns true if a slug should be excluded from orphan reporting by default.
 * Pages where having no inbound links is expected / not a content problem.
 */
export function shouldExclude(slug: string): boolean {
  if (PSEUDO_SLUGS.has(slug)) return true;
  for (const suffix of AUTO_SUFFIX_PATTERNS) {
    if (slug.endsWith(suffix)) return true;
  }
  if (slug.includes(RAW_SEGMENT)) return true;
  for (const prefix of DENY_PREFIXES) {
    if (slug.startsWith(prefix)) return true;
  }
  const firstSegment = slug.split('/')[0];
  if (FIRST_SEGMENT_EXCLUSIONS.has(firstSegment)) return true;
  return false;
}

/**
 * Build a SQL WHERE-clause fragment that EXCLUDES the same slugs that
 * `shouldExclude` filters out. The fragment starts with " AND " so it can be
 * appended to an existing WHERE.
 *
 * The fragment uses parameterized arrays for the IN/NOT IN check on
 * PSEUDO_SLUGS but inlines the LIKE/NOT-LIKE patterns (Postgres bind params
 * can't be used inside LIKE patterns without ugly concatenation). The
 * inlined patterns are constants — no user input is concatenated, so this
 * is not a SQL-injection surface.
 *
 * Caller convention: the page row alias is `p`. If you need a different
 * alias, pass it.
 */
export function buildOrphanExclusionSql(alias = 'p'): string {
  const a = alias;
  const pseudoList = [...PSEUDO_SLUGS].map(s => `'${s}'`).join(', ');
  const suffixClauses = AUTO_SUFFIX_PATTERNS.map(s => `${a}.slug NOT LIKE '%${s}'`).join(' AND ');
  const denyClauses = DENY_PREFIXES.map(p => `${a}.slug NOT LIKE '${p}%'`).join(' AND ');
  const firstSegClauses = [...FIRST_SEGMENT_EXCLUSIONS]
    .map(s => `${a}.slug NOT LIKE '${s}/%'`)
    .join(' AND ');
  return [
    ` AND ${a}.slug NOT IN (${pseudoList})`,
    ` AND ${suffixClauses}`,
    ` AND ${a}.slug NOT LIKE '%${RAW_SEGMENT}%'`,
    ` AND ${denyClauses}`,
    ` AND ${firstSegClauses}`,
  ].join('');
}
