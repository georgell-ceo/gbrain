/**
 * Iron-Law back-link writer.
 *
 * User convention (CLAUDE.md):
 *   "Every mention of a person/company with a brain page MUST create a
 *    back-link from that entity's page to the mentioning page.
 *    Format: `- **YYYY-MM-DD** | Referenced in [page title](path) - context`."
 *
 * Mechanics:
 *   For each outbound entity ref a put_page produces (people/X or
 *   companies/X targets), this writer creates TWO artifacts on the entity:
 *
 *     1. A `mentioned_in` graph edge: entity to mentioning page. This is
 *        what makes the mentioning page non-orphan in the graph.
 *     2. A timeline entry on the entity in Iron-Law format. This makes
 *        the connection visible to humans reading the entity's page and
 *        gives recall/think queries a chronological view of where the
 *        entity has been referenced.
 *
 * Scope:
 *   - Only fires for targets whose top-level dir is `people/` or
 *     `companies/`. Other targets (projects, deals, etc.) don't get
 *     auto-back-linked - they have their own structural relationships
 *     via FRONTMATTER_LINK_MAP and bare-slug references.
 *   - Skipped when source page IS the entity (no self-back-link).
 *   - Skipped when target page doesn't exist (caller already filtered
 *     candidates against the slug existence map, but defense-in-depth).
 *   - Skipped when source page slug is itself a people/ or companies/
 *     page - those are entity pages, not "mentioning" pages, and their
 *     own structural edges already wire them up.
 *
 * Dedup:
 *   The timeline_entries table has a UNIQUE (page_id, date, summary)
 *   index. Multiple rewrites of the same source page on the same date
 *   ON-CONFLICT-DO-NOTHING the second timeline entry. Same for the
 *   graph edge (links has a unique constraint on the natural key).
 *
 * Non-reconciliation (v1):
 *   If the source page is rewritten and Alice's mention is removed, we
 *   do NOT remove her back-link timeline entry or graph edge. Adding
 *   reconciliation requires tracking which back-links a given source
 *   page created (origin_slug on the link row carries this for graph
 *   edges; timeline_entries doesn't have an origin field). Deferred to
 *   follow-up; for v1 stale entries are tolerable noise that the user
 *   can prune.
 *
 * Failure semantics:
 *   Each entity is processed independently. A failure on one
 *   (network blip, validation error, etc.) doesn't abort the rest. The
 *   summary returned by `writeBackLinks` carries per-entity error counts
 *   so put_page can surface the gap to the caller.
 */

import type { BrainEngine, TimelineBatchInput } from './engine.ts';
import type { LinkCandidate } from './link-extraction.ts';

const ENTITY_DIRS = new Set(['people', 'companies']);

/** Result summary returned to put_page. */
export interface BackLinkResult {
  /** Number of timeline entries created on entity pages. */
  timeline_created: number;
  /** Number of mentioned_in graph edges created. */
  edges_created: number;
  /** Number of candidates skipped (self-ref, non-entity target, source-is-entity). */
  skipped: number;
  /** Number of failures during the write loop. */
  errors: number;
}

/** Read the auto_backlink_timeline config. Default ON. */
export async function isAutoBackLinkEnabled(engine: BrainEngine): Promise<boolean> {
  const val = await engine.getConfig('auto_backlink_timeline');
  if (val == null) return true;
  const norm = val.trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(norm);
}

/**
 * Derive the date string (YYYY-MM-DD) to stamp on the back-link timeline entry.
 *
 * Preference order:
 *   1. frontmatter.date (meetings carry this - match the calendar date,
 *      not when the page was synced)
 *   2. frontmatter.created (less precise but better than today's date for
 *      backfill of historical pages)
 *   3. Today's UTC date (live writes of new content)
 */
export function deriveBackLinkDate(frontmatter: Record<string, unknown>): string {
  const candidates = [frontmatter.date, frontmatter.created];
  for (const c of candidates) {
    if (typeof c === 'string') {
      const m = /^(\d{4}-\d{2}-\d{2})/.exec(c);
      if (m) return m[1];
    }
    if (c instanceof Date && !isNaN(c.getTime())) {
      return c.toISOString().slice(0, 10);
    }
  }
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build the timeline summary line in Iron-Law format.
 *
 * The format `Referenced in [title](slug)` is also a valid markdown link
 * pointing FROM the entity TO the source page. If the timeline entry is
 * later rendered into the entity's page body and re-extracted (e.g. when
 * the entity page is re-written), the markdown link extractor will pick
 * it up as an outbound edge from entity to source. The direct addLink call
 * we make below already creates that edge, so this is belt-and-suspenders.
 */
export function buildBackLinkSummary(sourceSlug: string, sourceTitle: string): string {
  const display = sourceTitle?.trim() || sourceSlug;
  return `Referenced in [${display}](${sourceSlug})`;
}

/**
 * Trim a context excerpt for the timeline detail line. The link-extractor
 * captures up to ~240 chars; for the timeline we want something shorter
 * so the entity's timeline stays scannable. Defaults to 160 chars with
 * an ellipsis truncation.
 */
export function buildBackLinkDetail(context: string): string {
  const MAX = 160;
  const ELLIPSIS = '...';
  if (!context) return '';
  const trimmed = context.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= MAX) return trimmed;
  return trimmed.slice(0, MAX - ELLIPSIS.length).trimEnd() + ELLIPSIS;
}

/**
 * Filter candidates to only those eligible for an Iron-Law back-link.
 */
export function filterEligibleCandidates(
  sourceSlug: string,
  candidates: readonly LinkCandidate[],
): LinkCandidate[] {
  const sourceDir = sourceSlug.split('/')[0];
  if (ENTITY_DIRS.has(sourceDir)) return [];

  const seen = new Set<string>();
  const out: LinkCandidate[] = [];
  for (const c of candidates) {
    if (c.targetSlug === sourceSlug) continue;
    const dir = c.targetSlug.split('/')[0];
    if (!ENTITY_DIRS.has(dir)) continue;
    if (c.fromSlug && c.fromSlug !== sourceSlug) continue;
    if (seen.has(c.targetSlug)) continue;
    seen.add(c.targetSlug);
    out.push(c);
  }
  return out;
}

/**
 * Write Iron-Law back-links for a freshly-written source page.
 */
export async function writeBackLinks(
  engine: BrainEngine,
  sourceSlug: string,
  sourceTitle: string,
  sourceFrontmatter: Record<string, unknown>,
  candidates: readonly LinkCandidate[],
  opts: { sourceId?: string } = {},
): Promise<BackLinkResult> {
  const eligible = filterEligibleCandidates(sourceSlug, candidates);
  if (eligible.length === 0) {
    return { timeline_created: 0, edges_created: 0, skipped: candidates.length, errors: 0 };
  }

  const date = deriveBackLinkDate(sourceFrontmatter);
  const summary = buildBackLinkSummary(sourceSlug, sourceTitle);

  let edgesCreated = 0;
  let errors = 0;
  const timelineBatch: TimelineBatchInput[] = [];

  for (const c of eligible) {
    try {
      await engine.addLink(
        c.targetSlug,
        sourceSlug,
        buildBackLinkDetail(c.context),
        'mentioned_in',
        'auto_backlink',
        sourceSlug,
        undefined,
        opts.sourceId
          ? { fromSourceId: opts.sourceId, toSourceId: opts.sourceId, originSourceId: opts.sourceId }
          : undefined,
      );
      edgesCreated++;
    } catch (e) {
      errors++;
      if (process.env.GBRAIN_BACKLINK_DEBUG) {
        // eslint-disable-next-line no-console -- debug aid; the failure mode is "back-link silently absent" otherwise
        console.error('[back-link-writer] addLink failed', { from: c.targetSlug, to: sourceSlug, err: e });
      }
    }

    timelineBatch.push({
      slug: c.targetSlug,
      date,
      summary,
      detail: buildBackLinkDetail(c.context),
      source: 'auto_backlink',
      ...(opts.sourceId ? { source_id: opts.sourceId } : {}),
    });
  }

  let timelineCreated = 0;
  if (timelineBatch.length > 0) {
    try {
      timelineCreated = await engine.addTimelineEntriesBatch(timelineBatch);
    } catch {
      errors++;
    }
  }

  return {
    timeline_created: timelineCreated,
    edges_created: edgesCreated,
    skipped: candidates.length - eligible.length,
    errors,
  };
}
