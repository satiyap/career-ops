// LinkedIn discovery parser for career-ops scan.mjs (local-parser contract).
//
// Uses LinkedIn's public guest job-search endpoint (no auth) to surface roles
// that aren't on Greenhouse/Lever/Ashby/Workday (e.g. FRND, many India product
// cos). It is a MULTI-company source: each returned job carries its own
// `company`, so wire it as a single tracked_companies entry:
//
//   - name: LinkedIn — India Leadership
//     careers_url: https://www.linkedin.com/jobs
//     parser:
//       command: node
//       script: scripts/parsers/linkedin.mjs
//       # args: "keyword1|keyword2|..."  then  "location"
//       args:
//         - "VP Engineering|Head of Engineering|Director of Engineering|Head of AI|VP AI|CTO|Chief Architect|Engineering Leader"
//         - "India"
//     enabled: true
//
// scan.mjs then applies title_filter + location_filter + dedup as usual.
// JD bodies on LinkedIn are partly login-walled; this returns title/company/url/
// location for DISCOVERY — the pipeline step extracts the JD later.
// Outputs JSON array of { title, url, company, location }. Prints [] on error.

const kwArg = process.argv[2] ||
  "VP Engineering|Head of Engineering|Director of Engineering|Head of AI|CTO|Chief Architect|Engineering Leader";
const location = process.argv[3] || "India";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const decode = (s) =>
  (s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

function extractCards(html) {
  const jobs = [];
  for (const card of html.split("<li>").slice(1)) {
    const title = (card.match(/base-search-card__title[^>]*>([\s\S]*?)<\//) || [])[1];
    const company =
      (card.match(/base-search-card__subtitle[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) ||
        card.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\//) ||
        [])[1];
    const url = (card.match(/base-card__full-link"[^>]*href="([^"?]+)/) ||
      card.match(/href="(https:\/\/[a-z.]*linkedin\.com\/jobs\/view\/[^"?]+)/) || [])[1];
    const loc = (card.match(/job-search-card__location[^>]*>([\s\S]*?)<\//) || [])[1];
    if (title && url) {
      jobs.push({
        title: decode(title),
        url: url.trim(),
        company: decode(company || ""),
        location: decode(loc || ""),
      });
    }
  }
  return jobs;
}

async function search(keyword) {
  const u =
    "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search" +
    `?keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(location)}&start=0`;
  const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!r.ok) {
    process.stderr.write(`linkedin "${keyword}": HTTP ${r.status}\n`);
    return [];
  }
  return extractCards(await r.text());
}

async function main() {
  const keywords = kwArg.split("|").map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const kw of keywords) {
    try {
      for (const job of await search(kw)) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        out.push(job);
      }
    } catch (e) {
      process.stderr.write(`linkedin "${kw}": ${e.message}\n`);
    }
    // Be gentle with the guest endpoint to avoid 429s.
    await new Promise((r) => setTimeout(r, 800));
  }
  console.log(JSON.stringify(out));
}

main();
