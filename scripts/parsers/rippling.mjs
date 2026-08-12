// Rippling ATS parser for career-ops scan.mjs (local-parser contract).
//
// Rippling hosts its own jobs on companies' own boards; the public board API is
//   https://api.rippling.com/platform/api/ats/v1/board/{board}/jobs
//
// Wire it in portals.yml:
//   - name: Rippling
//     careers_url: https://www.rippling.com/careers
//     parser:
//       command: node
//       script: scripts/parsers/rippling.mjs
//       args: ["rippling"]      # the board slug
//     enabled: true
//
// Outputs JSON array of { title, url, location, company }. Prints [] on error.

const board = process.argv[2] || "rippling";

async function main() {
  const out = [];
  try {
    const r = await fetch(`https://api.rippling.com/platform/api/ats/v1/board/${board}/jobs`);
    if (r.ok) {
      const j = await r.json();
      const arr = Array.isArray(j) ? j : j.jobs || j.results || j.data || [];
      for (const x of arr) {
        const locs = Array.isArray(x.workLocations)
          ? x.workLocations.map((w) => w.label || w.name || "").filter(Boolean).join("; ")
          : x.workLocation?.label || x.workLocation?.name || "";
        const url = x.url || (x.uuid ? `https://ats.rippling.com/${board}/jobs/${x.uuid}` : "");
        const title = x.name || x.title || "";
        if (title && url) {
          out.push({ title, url, location: locs, company: x.companyName || "Rippling" });
        }
      }
    } else {
      process.stderr.write(`rippling parser: HTTP ${r.status}\n`);
    }
  } catch (e) {
    process.stderr.write(`rippling parser error: ${e.message}\n`);
  }
  console.log(JSON.stringify(out));
}

main();
