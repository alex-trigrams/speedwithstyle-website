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

const { execFileSync } = require('child_process');

const ROOT = __dirname;
// The one host the site is served from. Vercel 308s the apex to www, so every
// canonical, og:url, sitemap entry and JSON-LD id must use www or Google sees
// the site pointing at a URL that only redirects.
const SITE = 'https://www.speedwithstyle.com.au';
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
  return `{{> head }}\n{{> header }}\n${body}\n{{> footer }}\n{{> booking-modal }}\n{{> scripts }}\n`;
}

function outputPathFor(meta, file) {
  // "/" -> index.html ; "/about/" -> about/index.html
  const clean = meta.path.replace(/^\/|\/$/g, '');
  return clean === '' ? 'index.html' : path.join(clean, 'index.html');
}

/**
 * Nav links are derived from the pages themselves. Give a page a
 * "nav": { "label": "About", "order": 1 } block to have it appear, and add
 * "header": true to also put it in the top bar (which only has room for a
 * couple — everything else lives in the footer).
 *
 * Draft pages ARE linked, so the whole skeleton can be clicked through while
 * copy is still being written. Draft only controls indexing: those pages stay
 * noindex and out of sitemap.xml until the flag comes off.
 */
function navEntries(pages) {
  return pages
    .filter((p) => p.meta.nav && p.meta.nav.label)
    .sort((a, b) => (a.meta.nav.order || 99) - (b.meta.nav.order || 99));
}

function buildNav(pages) {
  const entries = navEntries(pages);
  // Desktop: one grouped dropdown. Listing every page flat overflows the bar.
  const desktop = entries
    .map(
      (p) =>
        `<a href="${p.meta.path}" role="menuitem" class="sws-dd-item">${p.meta.nav.label}</a>`
    )
    .join('\n        ');
  // The mobile panel has room for the full set, unlike the top bar.
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
      site: SITE,
      jsonld: jsonLd(meta),
    };
    const html = substitute(expandIncludes(layout(body)), data);
    const out = outputPathFor(meta, file);
    fs.mkdirSync(path.dirname(path.join(ROOT, out)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, out), html);
    built.push({ out, file, path: meta.path, draft: !!meta.draft });
  }

  built.sort((a, b) => a.path.localeCompare(b.path));
  for (const b of built) {
    console.log(`  ${b.path.padEnd(18)} -> ${b.out}${b.draft ? '   [draft: noindex, not in sitemap]' : ''}`);
  }
  const drafts = built.filter((b) => b.draft).length;
  console.log(`\nBuilt ${built.length} page${built.length === 1 ? '' : 's'}${drafts ? ` (${drafts} draft)` : ''}.`);

  writeSitemap(built);
}

/**
 * Structured data. One @graph per page: the business, its two founders, the
 * website, and this page. Business facts here must match the Google Business
 * Profile exactly (name, address, phone, hours) — change them in both places.
 * The homepage FAQPage lives inline in src/pages/index.html, next to the
 * visible questions it mirrors.
 */
const BUSINESS_ID = `${SITE}/#business`;

const graphBase = [
  {
    '@type': 'SportsActivityLocation',
    '@id': BUSINESS_ID,
    name: 'Speed With Style',
    description:
      'Learn-to-swim school and swimming squads for kids in Bateman, Perth. Technique-first lessons with a maximum of 4 kids per class, guaranteed, in heated pools at Corpus Christi College Aquatic Centre.',
    url: `${SITE}/`,
    logo: `${SITE}/assets/sws-logo.png`,
    image: `${SITE}/assets/og-cover.jpg`,
    telephone: '+61409898232',
    email: 'admin@speedwithstyle.com.au',
    slogan: 'Have fun, learn fast, swim fast.',
    foundingDate: '2019',
    address: {
      '@type': 'PostalAddress',
      streetAddress: 'Corpus Christi College Aquatic Centre, 50 Murdoch Dr',
      addressLocality: 'Bateman',
      addressRegion: 'WA',
      postalCode: '6150',
      addressCountry: 'AU',
    },
    geo: { '@type': 'GeoCoordinates', latitude: -32.0509, longitude: 115.8375 },
    hasMap: 'https://www.google.com/maps/place/Speed+with+Style/@-32.055806,115.8439295,17z/data=!4m8!3m7!1s0x2a32a282cbcf1e09:0x838adb53e9c8574',
    areaServed: { '@type': 'City', name: 'Perth', containedInPlace: { '@type': 'State', name: 'Western Australia' } },
    // The "Visit us in person" hours published on the homepage.
    openingHoursSpecification: [
      { '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], opens: '15:30', closes: '18:00' },
      { '@type': 'OpeningHoursSpecification', dayOfWeek: 'Saturday', opens: '09:00', closes: '12:00' },
    ],
    founder: [{ '@id': `${SITE}/#jj-williams` }, { '@id': `${SITE}/#nigel-williams` }],
    sameAs: [
      'https://www.instagram.com/speedwithstyle/',
      'https://www.facebook.com/p/Speed-with-Style-100063457906245/',
    ],
    hasOfferCatalog: {
      '@type': 'OfferCatalog',
      name: 'Swimming programs',
      itemListElement: [
        {
          '@type': 'Offer',
          price: '28',
          priceCurrency: 'AUD',
          description: 'Per 30-minute lesson ($26 for Corpus Christi College families).',
          itemOffered: {
            '@type': 'Service',
            name: 'Learn to Swim',
            description: 'Swimming lessons for beginners from age 4 and any child still building correct technique. 30-minute lessons in the heated 33°C pool, 4 kids maximum per class, guaranteed.',
          },
        },
        {
          '@type': 'Offer',
          itemOffered: {
            '@type': 'Service',
            name: 'Pre-Squad',
            description: 'For swimmers with solid technique who are ready to build distance: fitness and endurance, with technique held to the same standard.',
          },
        },
        {
          '@type': 'Offer',
          itemOffered: {
            '@type': 'Service',
            name: 'Squad',
            description: 'Coached squad training for swimmers training for fitness and for those who want to race.',
          },
        },
        {
          '@type': 'Offer',
          itemOffered: {
            '@type': 'Service',
            name: 'Corpus Christi Program',
            description: 'Squad and water polo for the Corpus Christi College community, with a family discount and a free first lesson.',
          },
        },
      ],
    },
  },
  {
    '@type': 'Person',
    '@id': `${SITE}/#jj-williams`,
    name: 'John (JJ) Williams',
    jobTitle: 'Head Coach & Founder',
    worksFor: { '@id': BUSINESS_ID },
    url: `${SITE}/about/`,
    knowsAbout: ['Swimming technique', 'Swim coaching', 'Open water swimming', 'Surf lifesaving'],
  },
  {
    // Never describe Nigel as a psychologist or as offering counselling.
    '@type': 'Person',
    '@id': `${SITE}/#nigel-williams`,
    name: 'Nigel Williams',
    honorificPrefix: 'Dr.',
    jobTitle: 'Child and Adolescent Behaviour Specialist & Founder',
    worksFor: { '@id': BUSINESS_ID },
    url: `${SITE}/about/`,
    knowsAbout: ['Child and adolescent development', 'Youth sport performance'],
  },
  {
    '@type': 'WebSite',
    '@id': `${SITE}/#website`,
    url: `${SITE}/`,
    name: 'Speed With Style',
    inLanguage: 'en-AU',
    publisher: { '@id': BUSINESS_ID },
  },
];

function jsonLd(meta) {
  const url = SITE + meta.path;
  const page = {
    '@type': meta.schemaType || 'WebPage',
    '@id': `${url}#webpage`,
    url,
    name: meta.title,
    description: meta.description,
    inLanguage: 'en-AU',
    isPartOf: { '@id': `${SITE}/#website` },
    about: { '@id': BUSINESS_ID },
  };
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': [...graphBase, page] }, null, 2);
  // "</script>" inside a string would end the block early.
  return `<script type="application/ld+json">\n${json.replace(/<\//g, '<\\/')}\n</script>`;
}

/**
 * Last-modified date for a page: its latest commit. Vercel builds from a
 * shallow clone, so older files may have no history there; fall back to the
 * date already in the committed sitemap, then to today.
 */
function lastmodFor(file, loc, previous) {
  try {
    const d = execFileSync('git', ['log', '-1', '--format=%cs', '--', path.join('src', 'pages', file)], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (d) return d;
  } catch (e) { /* no git available */ }
  return previous[loc] || new Date().toISOString().slice(0, 10);
}

function writeSitemap(built) {
  // Drafts are deliberately excluded — an unfinished page in the sitemap is an
  // active invitation for Google to index placeholder copy.
  // New pages are added automatically from src/pages; nothing to edit here.
  const file = path.join(ROOT, 'sitemap.xml');
  const previous = {};
  if (fs.existsSync(file)) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/<loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod>/g)) {
      previous[m[1]] = m[2];
    }
  }
  const live = built.filter((b) => !b.draft);
  const urls = live
    .map((b) => {
      const loc = SITE + b.path;
      return `  <url><loc>${loc}</loc><lastmod>${lastmodFor(b.file, loc, previous)}</lastmod></url>`;
    })
    .join('\n');
  fs.writeFileSync(
    file,
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
