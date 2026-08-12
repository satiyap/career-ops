// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Google provider — reads the server-rendered search results on
// google.com/about/careers/applications. Google retired the old
// careers.google.com/api/v3 JSON API (it now 404s), but the results page still
// ships the full result set inline as a Wiz `AF_initDataCallback` chunk keyed
// `ds:1`, so no browser and no LLM are needed:
//
//   GET https://www.google.com/about/careers/applications/jobs/results?…
//   → …AF_initDataCallback({key: 'ds:1', hash: '2', data:[[ …jobs… ], null, TOTAL, PAGE_SIZE]});
//
// Each job record is a positional array:
//   [0] id · [1] title · [2] sign-in/apply URL · [3] responsibilities (HTML)
//   [4] qualifications (HTML) · [7] company · [9] locations ·
//   [10] description (HTML) · [12] publish timestamp [seconds, nanos]
//
// A tracked_companies entry narrows the (very large) global board with a
// `google:` config block whose keys are passed through as query params:
//
//   - name: Google
//     provider: google
//     careers_url: https://www.google.com/about/careers/applications/jobs/results
//     google:
//       location: India        # free-text location facet (repeatable via array)
//       sort_by: date          # 'date' (default here) or 'relevance'
//       q: engineering         # optional keyword filter
//
// Page size is fixed by Google at 20; we page via `page` (1-based) and stop as
// soon as the reported total is covered.

const PAGE_SIZE = 20; // Google's fixed results-per-page
const MAX_PAGES = 25; // safety cap — at most 500 postings per entry
const ORIGIN = 'https://www.google.com';
const RESULTS_PATH = '/about/careers/applications/jobs/results';

/** @param {import('./_types.js').PortalEntry & {google?: Record<string, unknown>}} entry */
function buildUrl(entry, page) {
  const cfg = entry.google && typeof entry.google === 'object' ? entry.google : {};
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(cfg)) {
    if (v == null) continue;
    // Google's facets repeat the bare key (location=India&location=Ireland);
    // there is no `key[]` bracket form here.
    if (Array.isArray(v)) for (const item of v) params.append(k, String(item));
    else params.append(k, String(v));
  }
  if (!params.has('sort_by')) params.set('sort_by', 'date');
  params.set('page', String(page));
  return `${ORIGIN}${RESULTS_PATH}?${params.toString()}`;
}

// Pull the `data:[…]` array out of the ds:1 AF_initDataCallback chunk by
// scanning for its balanced bracket span — the chunk sits inside a <script>
// with sibling chunks, so a regex would over-match.
function extractDs1(html) {
  const key = html.indexOf("key: 'ds:1'");
  if (key < 0) return null;
  const start = html.indexOf('data:', key);
  if (start < 0) return null;
  const open = html.indexOf('[', start);
  if (open < 0) return null;
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') {
      esc = true;
      continue;
    }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return null;
  // The inline script escapes = and & as = / &; JSON.parse handles
  // the rest of the escaping natively.
  const raw = html.slice(open, end).replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Google links a posting as /jobs/results/{id}-{slugified-title}. The slug is
// cosmetic — Google resolves on the numeric id — but we build the real one so
// the URL matches what a human would copy out of the browser.
function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// [12] is a protobuf Timestamp as [seconds, nanos].
function toEpochMs(stamp) {
  if (!Array.isArray(stamp) || typeof stamp[0] !== 'number') return undefined;
  return stamp[0] * 1000;
}

function firstLocation(locations) {
  if (!Array.isArray(locations) || !locations.length) return '';
  const names = locations.map((l) => (Array.isArray(l) ? l[0] : '')).filter(Boolean);
  return names.join(' | ');
}

function stripHtml(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// The list payload already carries the full description, so building it costs
// no extra request — this stays zero-token and feeds scan.mjs's content_filter.
function description(rec) {
  const parts = [rec[10], rec[3], rec[4]].map((f) => (Array.isArray(f) ? f[1] : f));
  return stripHtml(parts.filter(Boolean).join(' '));
}

/** @type {Provider} */
export default {
  id: 'google',

  detect(entry) {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    try {
      const parsed = new URL(url);
      const host = parsed.host.toLowerCase();
      // Match on host + path, never a bare path segment, so a spoofed URL on
      // another host can't claim this provider.
      if (host === 'careers.google.com') return { url };
      if (
        (host === 'www.google.com' || host === 'google.com') &&
        parsed.pathname.startsWith('/about/careers/applications')
      ) {
        return { url };
      }
    } catch {
      /* not an absolute URL */
    }
    return null;
  },

  async fetch(entry, ctx) {
    const jobs = [];
    const seen = new Set();
    const cap = Math.min(MAX_PAGES, ctx.maxPages ?? MAX_PAGES);
    let total = Infinity;

    for (let page = 1; page <= cap; page++) {
      const html = await ctx.fetchText(buildUrl(entry, page), { redirect: 'follow' });
      const data = extractDs1(html);
      if (!data) break; // markup changed or a challenge page was served
      const records = Array.isArray(data[0]) ? data[0] : [];
      if (typeof data[2] === 'number') total = data[2];
      if (records.length === 0) break;

      let fresh = 0;
      for (const rec of records) {
        if (!Array.isArray(rec)) continue;
        const id = rec[0];
        const title = typeof rec[1] === 'string' ? rec[1].trim() : '';
        if (!id || !title) continue;
        const url = `${ORIGIN}${RESULTS_PATH}/${id}-${slugify(title)}`;
        if (seen.has(url)) continue;
        seen.add(url);
        fresh++;
        jobs.push({
          title,
          url,
          company: typeof rec[7] === 'string' && rec[7] ? rec[7] : entry.name,
          location: firstLocation(rec[9]),
          description: description(rec),
          postedAt: toEpochMs(rec[12]),
        });
      }

      if (fresh === 0) break; // page param ignored / results looped
      if (jobs.length >= total) break;
      if (records.length < PAGE_SIZE) break; // last page
    }
    return jobs;
  },
};
