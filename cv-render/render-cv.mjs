#!/usr/bin/env node
/**
 * render-cv.mjs — cv.md → house-style HTML (and optionally PDF). Zero LLM tokens.
 *
 *   node cv-render/render-cv.mjs                      # cv.md  → output/cv-master.html
 *   node cv-render/render-cv.mjs --pdf                # also renders the PDF via Playwright
 *   node cv-render/render-cv.mjs --in x.md --out y.html
 *
 * cv.md is the source of truth. Hand-edit the markdown, re-run this, never edit the HTML.
 *
 * Markdown contract (see cv.md):
 *   # Name
 *   **Tagline | with | separators**
 *   Location | phone | email | linkedin
 *   ## Summary                  → paragraphs
 *   ## Core Competencies        → single line of ` | `-separated items, rendered as a labelled strip
 *   ## Key Achievements         → `- bullet` list
 *   ## Experience
 *     ### Company — Location
 *     **Role** | Dates          → followed by `- bullet` list
 *     ### Earlier Career        → single trailing paragraph, rendered in the muted "beyond" style
 *   ## Platform Initiatives     → `**Label** — description` paragraphs
 *   ## Education & Beyond       → `**Degree** — School | Years` lines, paired two at a time
 *
 * Inline: **bold** → <b>; ` | ` renders as a middot separator. HTML comments are stripped
 * (they carry provenance notes). Separators may be `|` (preferred, markdown-friendly) or a
 * literal `·` — both parse.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const IN = resolve(ROOT, flag('in', 'cv.md'));
const OUT = resolve(ROOT, flag('out', 'output/cv-master.html'));
const TEMPLATE = resolve(HERE, 'template.html');
const WANT_PDF = argv.includes('--pdf');

/* ---------- helpers ---------- */

const esc = (s) =>
  s.replace(/&(?!(?:[a-zA-Z]+|#\d+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// **bold** → <b>. Escaping happens first so markup we emit survives.
const inline = (s) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/ \| /g, '<span class="dot">&middot;</span>');

const dotted = (items) =>
  items.map(esc).join('<span class="dot">&middot;</span>');

/* ---------- parse ---------- */

const raw = readFileSync(IN, 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '')       // provenance comments never render
  .replace(/^---$/gm, '');               // horizontal rules are markdown-only furniture

const lines = raw.split('\n');

const doc = { name: '', tagline: '', contact: [], sections: [] };
let section = null;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const t = line.trim();
  if (!t) continue;

  if (t.startsWith('# ')) {
    doc.name = t.slice(2).trim();
    // The two lines after the name are the tagline and the contact row.
    for (let j = i + 1; j < lines.length && (!doc.tagline || !doc.contact.length); j++) {
      const n = lines[j].trim();
      if (!n) continue;
      if (n.startsWith('#')) break;
      if (!doc.tagline && /^\*\*.+\*\*$/.test(n)) doc.tagline = n.replace(/^\*\*|\*\*$/g, '');
      else if (doc.tagline && !doc.contact.length) doc.contact = n.split('|').map((x) => x.trim());
    }
    continue;
  }

  if (t.startsWith('## ')) {
    section = { title: t.slice(3).trim(), body: [] };
    doc.sections.push(section);
    continue;
  }
  if (section) section.body.push(t);
}

const find = (title) => doc.sections.find((s) => s.title.toLowerCase() === title.toLowerCase());

/* ---------- render ---------- */

const sectionTitle = (t) => `      <h2 class="section-title"><span>${esc(t)}</span></h2>`;

function renderSummary() {
  const s = find('Summary');
  if (!s) return '';
  const paras = s.body.map((p) => `      <p>${inline(p)}</p>`);
  const comp = find('Core Competencies');
  if (comp && comp.body.length) {
    const items = comp.body.join(' ').split(/[|·]/).map((x) => x.trim()).filter(Boolean);
    paras.push(
      `      <p class="scope-block"><span class="scope-label">Core Competencies</span>${dotted(items)}</p>`
    );
  }
  return `    <section class="resume-section summary">\n${sectionTitle('Summary')}\n${paras.join('\n')}\n    </section>\n`;
}

function renderBulletSection(title, cls) {
  const s = find(title);
  if (!s) return '';
  const items = s.body
    .filter((l) => l.startsWith('- '))
    .map((l) => `        <li>${inline(l.slice(2))}</li>`);
  if (!items.length) return '';
  return `    <section class="resume-section">\n${sectionTitle(title)}\n      <ul class="${cls}">\n${items.join('\n')}\n      </ul>\n    </section>\n`;
}

function renderLabelledSection(title, listCls, itemCls) {
  const s = find(title);
  if (!s) return '';
  const items = s.body
    .map((l) => l.match(/^\*\*(.+?)\*\*\s+—\s+(.+)$/))
    .filter(Boolean)
    .map(
      ([, label, desc]) =>
        `        <li class="${itemCls}"><span class="label">${esc(label)}</span>: <span class="desc">${inline(desc)}</span></li>`
    );
  if (!items.length) return '';
  return `    <section class="resume-section">\n${sectionTitle(title)}\n      <ul class="${listCls}">\n${items.join('\n')}\n      </ul>\n    </section>\n`;
}

function renderExperience() {
  const s = find('Experience');
  if (!s) return '';
  const out = [];
  let group = null;
  let role = null;

  const closeRole = () => {
    if (role && role.bullets.length) {
      group.roles.push(role);
    } else if (role) {
      group.roles.push(role);
    }
    role = null;
  };
  const closeGroup = () => {
    closeRole();
    if (group) out.push(group);
    group = null;
  };

  for (const line of s.body) {
    if (line.startsWith('### ')) {
      closeGroup();
      const [company, location] = line.slice(4).split('—').map((x) => x.trim());
      group = { company, location: location || '', roles: [], trailing: [] };
      continue;
    }
    if (!group) continue;
    const m = line.match(/^\*\*(.+?)\*\*\s*[|·]\s*(.+)$/);
    if (m) {
      closeRole();
      role = { title: m[1].trim(), dates: m[2].trim(), bullets: [] };
      continue;
    }
    if (line.startsWith('- ')) {
      if (role) role.bullets.push(line.slice(2));
      continue;
    }
    // Free text inside a group with no role — the Earlier Career line.
    group.trailing.push(line);
  }
  closeGroup();

  const html = out
    .map((g) => {
      // A group with no roles and only prose is the muted "Earlier Career" footer.
      if (!g.roles.length && g.trailing.length) {
        return `      <div class="entry-group">\n        <p class="beyond"><b>${esc(g.company)}</b> &mdash; ${inline(g.trailing.join(' '))}</p>\n      </div>`;
      }
      const roles = g.roles
        .map((r) => {
          const bullets = r.bullets.length
            ? `\n          <ul class="role-bullets">\n${r.bullets
                .map((b) => `            <li>${inline(b)}</li>`)
                .join('\n')}\n          </ul>`
            : '';
          return `        <article class="role">\n          <div class="role-heading">\n            <h4 class="role-title">${inline(
            r.title
          )}</h4>\n            <span class="role-dates">${esc(r.dates)}</span>\n          </div>${bullets}\n        </article>`;
        })
        .join('\n');
      const trailing = g.trailing.length
        ? `\n        <p class="beyond">${inline(g.trailing.join(' '))}</p>`
        : '';
      return `      <div class="entry-group">\n        <div class="entry-heading">\n          <h3 class="entry-company">${esc(
        g.company
      )}</h3>\n          <span class="entry-location">${esc(g.location)}</span>\n        </div>\n${roles}${trailing}\n      </div>`;
    })
    .join('\n\n');

  return `    <section class="resume-section experience">\n${sectionTitle('Experience')}\n\n${html}\n    </section>\n`;
}

function renderEducation() {
  const s = find('Education & Beyond');
  if (!s) return '';
  const entries = s.body
    .map((l) => l.match(/^\*\*(.+?)\*\*\s+—\s+(.+?)\s+[|·]\s+(.+)$/))
    .filter(Boolean)
    .map(([, degree, school, dates]) => {
      const parts = school.split(',').map((x) => x.trim());
      const loc = parts.length > 1 ? parts.slice(1).join(', ') : '';
      return `      <div class="education-entry">
        <div class="education-heading">
          <h3 class="education-school">${esc(school)}</h3>
          <span class="education-location">${esc(loc)}</span>
        </div>
        <div class="education-heading">
          <h4 class="education-degree">${esc(degree)}</h4>
          <span class="education-dates">${esc(dates)}</span>
        </div>
      </div>`;
    });
  if (!entries.length) return '';
  return `    <section class="resume-section">\n${sectionTitle('Education & Beyond')}\n${entries.join('\n')}\n    </section>\n`;
}

function renderHeader() {
  const meta = doc.contact
    .map((c) => {
      if (c.includes('@')) return `<span><a href="mailto:${esc(c)}">${esc(c)}</a></span>`;
      if (/linkedin\./i.test(c)) return `<span><a href="https://${esc(c)}">${esc(c)}</a></span>`;
      if (/[a-z]/i.test(c) && !/\d{4}/.test(c) && doc.contact.indexOf(c) === 0)
        return `<span class="loc">${esc(c)}</span>`;
      return `<span>${esc(c)}</span>`;
    })
    .join('<span class="sep">|</span>');
  return `    <header class="resume-header">
      <h1 class="resume-name">${esc(doc.name)}</h1>
      <div class="resume-title">${esc(doc.tagline).replace(/\s*[|·]\s*/g, ' &middot; ')}</div>
      <div class="resume-meta">
        ${meta}
      </div>
    </header>
`;
}

/* ---------- assemble ---------- */

const body = [
  renderHeader(),
  renderSummary(),
  renderBulletSection('Key Achievements', 'impact-bullets'),
  renderExperience(),
  renderLabelledSection('Platform Initiatives', 'initiatives', 'initiative'),
  renderEducation(),
]
  .filter(Boolean)
  .join('\n');

const html = readFileSync(TEMPLATE, 'utf8').replace('{{BODY}}', body);
writeFileSync(OUT, html);
console.log(`✓ ${IN.replace(ROOT + '/', '')} → ${OUT.replace(ROOT + '/', '')}`);

if (WANT_PDF) {
  const pdfPath = OUT.replace(/\.html$/, '.pdf');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`file://${OUT}`);
  await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
  await browser.close();
  console.log(`✓ ${pdfPath.replace(ROOT + '/', '')}`);
}
