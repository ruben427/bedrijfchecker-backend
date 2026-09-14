// Deterministisch de COA-bibliotheek van een leverancier vinden.
//
// Waarom dit bestaat: de AI-zoekstap leunt op zoekmachine-snippets en raadt
// waar de COA's staan. Bij een testrun op retaeu.nl leverde dat 2 documenten
// op, waarvan er 1 van een heel andere leverancier bleek — terwijl er 26
// COA's netjes in een tabel op hun eigen /nl/certificate-of-analysis/ staan.
//
// Dat is geen AI-taak. Haal de site op, vind de pagina die over certificaten
// gaat, pak alle links naar PDF/afbeelding. Goedkoop, herhaalbaar, volledig.
//
// Deze module gooit nooit. Een leverancier zonder COA-pagina, een trage site
// of een blokkade levert een lege lijst met een reden op — nooit een fout die
// de audit stopt.

const { isPublicHttpUrl } = require('./urlGuard');

const TIMEOUT_MS = Number(process.env.COA_CRAWL_TIMEOUT_MS) || 15000;
const MAX_HTML_BYTES = Number(process.env.COA_CRAWL_MAX_HTML) || 3 * 1024 * 1024;
const MAX_INDEX_PAGES = Number(process.env.COA_CRAWL_MAX_PAGES) || 4;
const MAX_DOCUMENTS = Number(process.env.COA_CRAWL_MAX_DOCS) || 80;

// Zelfde UA als docFetcher: eerlijk over wie we zijn.
const UA = 'Mozilla/5.0 (compatible; BedrijfcheckerBot/1.0; +https://checker.deannemethode.nl)';

// Paden die shops in deze markt vrijwel altijd gebruiken. Direct proberen is
// goedkoper en betrouwbaarder dan hopen dat er vanaf de homepage naar gelinkt
// wordt — sommige shops zetten hem alleen in de footer of in een menu dat
// pas met JavaScript verschijnt.
const COMMON_PATHS = [
  '/certificate-of-analysis/', '/nl/certificate-of-analysis/', '/en/certificate-of-analysis/',
  '/certificates-of-analysis/', '/coa/', '/coas/', '/certificates/', '/certificaten/',
  '/lab-results/', '/lab-reports/', '/test-results/', '/testresultaten/', '/testrapporten/',
  '/analysecertificaat/', '/labresultaten/', '/third-party-testing/', '/testing/'
];

const INDEX_HINT = /certificate[\s\-_]*of[\s\-_]*analysis|\bcoa\b|\bcoa'?s\b|lab[\s\-_]*(result|report|test)|test[\s\-_]*(result|report)|analysecertifica|labresultat|testrapport|third[\s\-_]*party[\s\-_]*test/i;
const DOC_EXT = /\.(pdf|png|jpe?g|webp)(\?|#|$)/i;

// COA-pagina's zijn vaak tabellen met per rij ook een productfoto. Die
// foto's zijn eveneens .png en zouden dus meetellen als 'document'.
// Twee filters: verkleinde varianten (WordPress zet -300x300 in de naam)
// vallen af, en afbeeldingen tellen alleen mee als de pagina helemaal geen
// aangeklikte documenten heeft — een echte COA wordt aangelinkt, niet
// alleen als plaatje getoond.
const THUMBNAIL = /-\d{2,4}x\d{2,4}\.(png|jpe?g|webp)(\?|#|$)/i;

function withTimeout() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function fetchHtml(url) {
  const veilig = isPublicHttpUrl(url);
  if (!veilig.ok) return { fout: 'geweigerd: ' + veilig.reden };
  const t = withTimeout();
  try {
    const res = await fetch(url, {
      signal: t.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }
    });
    if (!res.ok) {
      // 403/503 met een Cloudflare-header is iets anders dan een 404.
      const server = (res.headers.get('server') || '').toLowerCase();
      const botfilter = server.includes('cloudflare') || res.headers.has('cf-ray') || res.headers.has('cf-mitigated');
      return { fout: 'http_' + res.status + (botfilter ? '_botfilter' : '') };
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.includes('html')) return { fout: 'geen_html (' + (ct || 'onbekend') + ')' };
    const text = await res.text();
    if (!text) return { fout: 'lege_pagina' };
    if (text.length > MAX_HTML_BYTES) return { fout: 'pagina_te_groot' };
    // Een challenge-pagina geeft netjes 200 terug maar bevat geen site.
    if (/just a moment|checking your browser|cf-browser-verification|challenge-platform|verify you are human/i.test(text.slice(0, 20000))) {
      return { fout: 'botcheck_pagina' };
    }
    return { html: text, finalUrl: res.url || url };
  } catch (e) {
    const naam = (e && e.name) || 'Error';
    return { fout: naam === 'AbortError' ? 'timeout_na_' + Math.round(TIMEOUT_MS / 1000) + 's' : 'netwerkfout (' + ((e && e.message) || naam).slice(0, 80) + ')' };
  } finally {
    t.done();
  }
}

function absolutise(base, href) {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.toString();
  } catch (e) {
    return null;
  }
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Alle <a href> en <img src> met hun zichtbare tekst.
function extractLinks(html, baseUrl) {
  const out = [];
  const anchor = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchor.exec(html)) !== null) {
    const url = absolutise(baseUrl, m[1]);
    if (url) out.push({ url, text: stripTags(m[2]).slice(0, 200) });
  }
  const img = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((m = img.exec(html)) !== null) {
    const url = absolutise(baseUrl, m[1]);
    if (url && DOC_EXT.test(url)) out.push({ url, text: '', uitAfbeelding: true });
  }
  return out;
}

// Veel COA-pagina's zijn een tabel: product | batch | purity | datum | link.
// Die rijtekst is gratis context bij elk document — product- en batchnaam
// zonder dat er een model aan te pas komt.
function rowContextFor(html) {
  const map = new Map();
  const rows = String(html).split(/<tr\b/i).slice(1);
  for (const row of rows) {
    const text = stripTags(row).slice(0, 300);
    const hrefs = [];
    const re = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(row)) !== null) hrefs.push(m[1]);
    for (const h of hrefs) if (!map.has(h)) map.set(h, text);
  }
  return map;
}

function sameSite(a, b) {
  try {
    const ha = new URL(a).hostname.replace(/^www\./i, '').toLowerCase();
    const hb = new URL(b).hostname.replace(/^www\./i, '').toLowerCase();
    return ha === hb || ha.endsWith('.' + hb) || hb.endsWith('.' + ha);
  } catch (e) {
    return false;
  }
}

async function crawlCoaIndex(website) {
  const notes = [];
  const documents = new Map();
  const indexPages = [];
  let root;
  try {
    root = new URL(/^https?:\/\//i.test(website) ? website : 'https://' + website).origin;
  } catch (e) {
    return { indexPages: [], documents: [], notes: ['ongeldige website-URL'] };
  }

  // 1. Homepage ophalen en kijken waar naar certificaten gelinkt wordt.
  const candidates = [];
  const diagnose = [];
  const home = await fetchHtml(root + '/');
  if (!home || !home.html) {
    notes.push('homepage niet op te halen: ' + ((home && home.fout) || 'onbekend'));
    diagnose.push({ url: root + '/', resultaat: (home && home.fout) || 'onbekend' });
  } else {
    for (const link of extractLinks(home.html, home.finalUrl)) {
      if (DOC_EXT.test(link.url)) continue;
      if (!sameSite(link.url, root)) continue;
      if (INDEX_HINT.test(link.url) || INDEX_HINT.test(link.text)) candidates.push(link.url);
    }
  }

  // 2. Plus de gebruikelijke paden, ook als er nergens naar gelinkt wordt.
  for (const p of COMMON_PATHS) candidates.push(root + p);

  // 3. Kandidaten aflopen tot we er genoeg hebben die echt documenten bevatten.
  const tried = new Set();
  for (const url of candidates) {
    if (indexPages.length >= MAX_INDEX_PAGES) break;
    const norm = url.replace(/\/+$/, '/');
    if (tried.has(norm)) continue;
    tried.add(norm);

    const page = await fetchHtml(url);
    if (!page || !page.html) {
      if (diagnose.length < 20) diagnose.push({ url, resultaat: (page && page.fout) || 'onbekend' });
      continue;
    }

    const rows = rowContextFor(page.html);
    const links = extractLinks(page.html, page.finalUrl);
    const bruikbaar = links.filter((l) => DOC_EXT.test(l.url) && !THUMBNAIL.test(l.url));
    const aangelinkt = bruikbaar.filter((l) => !l.uitAfbeelding);
    // Aangeklikte documenten hebben voorrang; alleen als die er niet zijn
    // vallen we terug op ingesloten afbeeldingen.
    const docs = aangelinkt.length ? aangelinkt : bruikbaar.filter((l) => l.uitAfbeelding);
    if (!docs.length) { if (diagnose.length < 20) diagnose.push({ url, resultaat: 'pagina bestaat, maar bevat geen documentlinks' }); continue; }

    indexPages.push(page.finalUrl);
    for (const d of docs) {
      if (documents.size >= MAX_DOCUMENTS) break;
      if (documents.has(d.url)) continue;
      // Rijtekst opzoeken op de ruwe href zoals hij in de HTML stond.
      let context = d.text || '';
      for (const [href, text] of rows) {
        const abs = absolutise(page.finalUrl, href);
        if (abs === d.url) { context = text || context; break; }
      }
      documents.set(d.url, {
        url: d.url,
        context: context.slice(0, 300),
        gevondenOp: page.finalUrl,
        zelfdeDomein: sameSite(d.url, root)
      });
    }
  }

  if (!indexPages.length) notes.push('geen pagina met certificaatdocumenten gevonden op het eigen domein');
  if (documents.size >= MAX_DOCUMENTS) notes.push('limiet van ' + MAX_DOCUMENTS + ' documenten bereikt; niet alles is meegenomen');

  return { indexPages, documents: Array.from(documents.values()), notes, diagnose };
}

module.exports = { crawlCoaIndex, extractLinks, rowContextFor, stripTags, absolutise, sameSite, DOC_EXT, THUMBNAIL, INDEX_HINT };
