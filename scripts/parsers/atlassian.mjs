// Atlassian careers parser for career-ops scan.mjs (local-parser contract).
//
// Atlassian isn't on Greenhouse/Lever/Ashby/Workday — it serves all open roles
// as JSON from its own endpoint:
//   https://www.atlassian.com/endpoint/careers/listings
//
// Wire it in portals.yml:
//   - name: Atlassian
//     careers_url: https://www.atlassian.com/company/careers/all-jobs
//     parser:
//       command: node
//       script: scripts/parsers/atlassian.mjs
//     enabled: true
//
// Emits a JSON array of { title, url, location } to stdout. scan.mjs then applies
// title_filter (leadership-only) + location_filter (India) + dedup. Prints [] on error.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function pickJobsArray(data) {
  if (Array.isArray(data)) return data;
  for (const k of ["jobs", "careers", "listings", "data"]) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  // Fallback: largest array property.
  let best = [];
  for (const k in data) if (Array.isArray(data[k]) && data[k].length > best.length) best = data[k];
  return best;
}

// "Bengaluru - India -   Bengaluru,  560071 India,Remote - Remote" -> trim noise,
// keep the first readable segment so the location filter still matches India.
function cleanLocation(raw) {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .replace(/,?\s*Remote - Remote/gi, "")
    .replace(/\b\d{5,6}\b/g, "")
    .trim();
}

async function main() {
  const out = [];
  try {
    const r = await fetch("https://www.atlassian.com/endpoint/careers/listings", {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!r.ok) {
      process.stderr.write(`atlassian parser: HTTP ${r.status}\n`);
      console.log("[]");
      return;
    }
    const jobs = pickJobsArray(await r.json());
    for (const j of jobs) {
      const title = (j.title || j.name || "").trim();
      const url = j.applyUrl || j.url || "";
      const location = cleanLocation(j.locations || j.location || j.city || "");
      if (title && url) out.push({ title, url, location, company: "Atlassian" });
    }
  } catch (e) {
    process.stderr.write(`atlassian parser error: ${e.message}\n`);
  }
  console.log(JSON.stringify(out));
}

main();
