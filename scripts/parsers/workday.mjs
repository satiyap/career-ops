// Generic Workday job-board parser for career-ops scan.mjs (local-parser contract).
//
// scan.mjs only speaks Greenhouse/Ashby/Lever natively; this covers Workday
// tenants too. Wire it in portals.yml:
//
//   - name: CrowdStrike
//     careers_url: https://crowdstrike.wd5.myworkdayjobs.com/en-US/crowdstrikecareers
//     parser:
//       command: node
//       script: scripts/parsers/workday.mjs
//       args: ["{careers_url}"]
//     enabled: true
//
// Outputs a JSON array of { title, url, location } to stdout (the contract in
// providers/local-parser.mjs). On any error it prints [] so the scan continues.

const careersUrl = process.argv[2];

// careers_url forms handled:
//   https://uniphore.wd503.myworkdayjobs.com/Uniphore
//   https://crowdstrike.wd5.myworkdayjobs.com/en-US/crowdstrikecareers
function parseTenant(u) {
  const url = new URL(u);
  const host = url.hostname;                 // tenant.shard.myworkdayjobs.com
  const [tenant] = host.split(".");
  // Drop a leading locale segment like "en-US" / "en_US"; the site is the last real segment.
  const segs = url.pathname
    .split("/")
    .filter(Boolean)
    .filter((s) => !/^[a-z]{2}([-_][A-Za-z]{2})?$/.test(s));
  const site = segs[segs.length - 1];
  if (!host.includes("myworkdayjobs.com") || !tenant || !site) {
    throw new Error(`not a Workday careers_url: ${u}`);
  }
  return { host, tenant, site };
}

async function main() {
  if (!careersUrl) {
    console.log("[]");
    return;
  }
  let cfg;
  try {
    cfg = parseTenant(careersUrl);
  } catch (e) {
    process.stderr.write(`workday parser: ${e.message}\n`);
    console.log("[]");
    return;
  }

  const { host, tenant, site } = cfg;
  const api = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
  const out = [];
  const limit = 20;
  let offset = 0;
  let total = Infinity;

  try {
    // Cap pages so a huge tenant can't hang the scan; the title/location filters
    // in scan.mjs narrow afterwards.
    while (offset < total && offset < 400) {
      const r = await fetch(api, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText: "" }),
      });
      if (!r.ok) break;
      const j = await r.json();
      total = typeof j.total === "number" ? j.total : 0;
      const posts = j.jobPostings || [];
      if (!posts.length) break;
      for (const p of posts) {
        const path = p.externalPath || "";
        const url = path ? `https://${host}/en-US/${site}${path}` : careersUrl;
        out.push({ title: p.title || "", url, location: p.locationsText || "" });
      }
      offset += limit;
    }
  } catch (e) {
    process.stderr.write(`workday parser fetch error: ${e.message}\n`);
  }

  console.log(JSON.stringify(out));
}

main();
