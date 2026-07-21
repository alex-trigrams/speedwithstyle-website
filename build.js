#!/usr/bin/env node
/**
 * Speed With Style — static site builder.
 *
 * No framework, no dependencies. Assembles pages from reusable partials so the
 * header, footer, styles and scripts live in exactly one place, while every page
 * still ships complete HTML to crawlers (important: the nav must be in the served
 * markup, not injected at runtime).
 *
 * Usage:  node build.js
 *
 * Adding a page:
 *   1. Create src/pages/<name>.html
 *   2. Start it with a JSON front-matter block (see below)
 *   3. Run the build. It outputs <name>/index.html so the URL is /<name>/
 *
 * Front matter (first block in the file, fenced by ---):
 *   ---
 *   { "title": "...", "description": "...", "path": "/about/" }
 *   ---
 *
 * Partial syntax inside any page or partial:
 *   {{> header }}          include src/partials/header.html
 *   {{title}}              substitute a front-matter value
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PAGES = path.join(ROOT, 'src', 'pages');
const PARTIALS = path.join(ROOT, 'src', 'partials');

const readPartial = (name) =>
  fs.readFileSync(path.join(PARTIALS, `${name}.html`), 'utf8');

/** Expand {{> partial }} includes recursively (depth-capped to catch cycles). */
function expandIncludes(html, depth = 0) {
  if (depth > 10) throw new Error('Partial include depth exceeded — circular include?');
  return html.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name) =>
    expandIncludes(readPartial(name), depth + 1)
  );
}

/** Substitute {{var}} from front-matter data. Unknown vars become empty strings. */
function substitute(html, data) {
  return html.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_, key) =>
    data[key] !== undefined ? String(data[key]) : ''
  );
}

function parsePage(file) {
  const raw = fs.readFileSync(path.join(PAGES, file), 'utf8');
  const fm = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!fm) throw new Error(`${file}: missing front-matter block`);
  let meta;
  try {
    meta = JSON.parse(fm[1]);
  } catch (e) {
    throw new Error(`${file}: front matter is not valid JSON — ${e.message}`);
  }
  for (const key of ['title', 'description', 'path']) {
    if (!meta[key]) throw new Error(`${file}: front matter missing "${key}"`);
  }
  return { meta, body: raw.slice(fm[0].length) };
}

/** The page shell every route shares. */
function layout(body) {
  return `{{> head }}\n{{> header }}\n${body}\n{{> footer }}\n{{> scripts }}\n`;
}

function outputPathFor(meta, file) {
  // "/" -> index.html ; "/about/" -> about/index.html
  const clean = meta.path.replace(/^\/|\/$/g, '');
  return clean === '' ? 'index.html' : path.join(clean, 'index.html');
}

/**
 * Nav links are derived from the pages themselves, so a page can never be
 * linked before it is ready: drafts are skipped everywhere. Give a page a
 * "nav": { "label": "About", "order": 1 } block to have it appear once its
 * draft flag comes off.
 */
function navEntries(pages) {
  return pages
    .filter((p) => !p.meta.draft && p.meta.nav && p.meta.nav.label)
    .sort((a, b) => (a.meta.nav.order || 99) - (b.meta.nav.order || 99));
}

function buildNav(pages) {
  const entries = navEntries(pages);
  const desktop = entries
    .map(
      (p) =>
        `<a href="${p.meta.path}" style="font-weight:700;font-size:16px;color:#0A0A0A;text-decoration:none">${p.meta.nav.label}</a>`
    )
    .join('\n      ');
  const mobile = entries
    .map(
      (p, i) =>
        `<a href="${p.meta.path}" class="mm-item" style="--d:.${19 + i * 5}s">${p.meta.nav.label}</a>`
    )
    .join('\n      ');
  const footer = entries
    .map(
      (p) =>
        `<a href="${p.meta.path}" style="color:#D6E6F4;text-decoration:none;font-size:16px;min-height:44px;display:inline-flex;align-items:center">${p.meta.nav.label}</a>`
    )
    .join('\n        ');
  return { navdesktop: desktop, navmobile: mobile, navfooter: footer };
}

function build() {
  const files = fs.readdirSync(PAGES).filter((f) => f.endsWith('.html'));
  if (!files.length) throw new Error('No pages found in src/pages/');

  // Two passes: parse everything first so nav can be derived from the full set.
  const pages = files.map((file) => ({ file, ...parsePage(file) }));
  const nav = buildNav(pages);

  const built = [];
  for (const { file, meta, body } of pages) {
    const data = {
      ...meta,
      ...nav,
      // Unfinished pages must never be indexed. This is derived from the draft
      // flag rather than hand-written per page so the two can't drift apart.
      robots: meta.draft
        ? '<meta name="robots" content="noindex,nofollow">'
        : '',
    };
    const html = substitute(expandIncludes(layout(body)), data);
    const out = outputPathFor(meta, file);
    fs.mkdirSync(path.dirname(path.join(ROOT, out)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, out), html);
    built.push({ out, path: meta.path, draft: !!meta.draft });
  }

  built.sort((a, b) => a.path.localeCompare(b.path));
  for (const b of built) {
    console.log(`  ${b.path.padEnd(18)} -> ${b.out}${b.draft ? '   [draft: noindex, not in sitemap]' : ''}`);
  }
  const drafts = built.filter((b) => b.draft).length;
  console.log(`\nBuilt ${built.length} page${built.length === 1 ? '' : 's'}${drafts ? ` (${drafts} draft)` : ''}.`);

  writeSitemap(built);
}

function writeSitemap(built) {
  // Drafts are deliberately excluded — an unfinished page in the sitemap is an
  // active invitation for Google to index placeholder copy.
  const live = built.filter((b) => !b.draft);
  const urls = live
    .map((b) => `  <url><loc>https://speedwithstyle.com.au${b.path}</loc></url>`)
    .join('\n');
  fs.writeFileSync(
    path.join(ROOT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  );
  console.log(`Wrote sitemap.xml (${live.length} live URL${live.length === 1 ? '' : 's'})`);
}

try {
  build();
} catch (err) {
  console.error(`\nBuild failed: ${err.message}\n`);
  process.exit(1);
}
