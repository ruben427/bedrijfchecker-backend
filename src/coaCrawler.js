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
// Vier was te krap zodra een shop per product een eigen COA-subpagina heeft.
// Bij europapeptides staan de labverwijzingen niet op /lab-results maar op
// /lab-results/<product>, vijf stuks. Met vier pagina's haalden we de
// overzichtspagina op, vonden daar nul verwijzingen, en stopten.
const MAX_INDEX_PAGES = Number(process.env.COA_CRAWL_MAX_PAGES) || 12;
// Hoeveel subpagina's we maximaal bijzetten vanaf een gevonden COA-pagina.
const MAX_SUBPAGINAS = Number(process.env.COA_CRAWL_MAX_SUBPAGES) || 24;
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

// Site-inrichting: logo's, iconen, themabestanden. Bij een testrun op
// lumopeptides.com leverde de afbeeldingsterugval 9 'documenten' op die
// in werkelijkheid het logo en wat iconen waren - en die gingen daarna
// alle negen door een leesopdracht. Duur en waardeloos.
const SITE_INRICHTING = /\/(icons?|logos?|brand|branding|themes?|assets|sprites?|flags?|badges?|ui)\//i;
const INRICHTING_NAAM = /(logo|icon|sprite|favicon|placeholder|banner|avatar|thumb|shield|truck|cart|star|arrow|check)[-_.]?/i;

// Omgekeerd: een bestandsnaam die zelf zegt dat het een rapport is.
// Test-Report-199613.png, COA_BPC157.pdf, lab-result-2026.jpg.
const RAPPORT_NAAM = /(coa|certificate|certificaat|analysis|analyse|test[-_]?report|testrapport|lab[-_]?(result|report)|labresultaat|hplc|purity)/i;

// Sommige leveranciers hosten helemaal geen COA-bestand maar linken
// rechtstreeks naar de verificatiepagina van het lab. Dat is de sterkste
// publicatievorm die er is: er is geen kopie om te bewerken. Lumopeptides
// doet dit met 14 rapporten; de crawler liep er straal voorbij omdat het
// geen .pdf of .png is.
// Vingerafdruk van een pagina, om soft-404's te herkennen. Sommige sites
// geven op ELK pad een 200 terug met dezelfde 'niet gevonden'-pagina. De
// crawler denkt dan dat achttien pagina's bestaan en vindt op geen enkele
// documenten - dat gebeurde bij mypept.eu, pepsresearch.com en
// peptidemeester.org. Alle drie hebben wel degelijk COA's.
//
// Aanpak: vraag eerst een onzinpad op. Wat daarop terugkomt IS per definitie
// de niet-gevonden-pagina. Alles wat daar sterk op lijkt behandelen we
// daarna als niet bestaand, ook al zegt de server 200.
function vingerafdruk(html) {
  const tekst = stripTags(html);
  return {
    lengte: tekst.length,
    // Eerste stuk tekst plus de titel: genoeg om twee foutpagina's aan elkaar
    // gelijk te zien zonder te struikelen over een wisselend jaartal of
    // sessie-id ergens onderin.
    kop: (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [, ''])[1].trim().slice(0, 120),
    begin: tekst.slice(0, 400)
  };
}

function lijktOpFoutpagina(kandidaat, fout) {
  if (!kandidaat || !fout) return false;
  if (kandidaat.kop && fout.kop && kandidaat.kop === fout.kop) return true;
  if (!fout.begin) return false;
  // Lengte binnen 10% en dezelfde openingstekst: dan is het dezelfde pagina
  // met hooguit een ander pad erin.
  const lengteLijkt = Math.abs(kandidaat.lengte - fout.lengte) <= Math.max(200, fout.lengte * 0.1);
  return lengteLijkt && kandidaat.begin.slice(0, 200) === fout.begin.slice(0, 200);
}

// Verificatielinks van laboratoria. Dit was tot 19 september alleen Janoshik,
// en dat bleek een blinde vlek: lumopeptides.com publiceert 71 van deze links,
// waarvan er 45 naar Bridge Analytical gaan. Die zagen we dus geen van alle.
//
// Voorwaarde om hier op te mogen staan: de URL moet een identificator van het
// rapport zelf bevatten. Een linkje naar een algemene "verify"-pagina zonder
// referentie zegt niets en hoort hier niet.
const LAB_VERIFICATIELINKS = [
  // LET OP: alleen verify.janoshik.com matchen was te smal. Shops linken net
  // zo vaak naar janoshik.com/tests/... zonder subdomein. Gemeten op 20
  // september bij balticpeptides: 20 van de 37 verwijzingen gebruiken de
  // kale host, en bij zeuspeptides alle vijf. Die vielen stil weg.
  // janoshik.js accepteerde die hosts allang; alleen dit filter niet.
  { lab: 'Janoshik', patroon: /^https:\/\/(?:verify\.|www\.|public\.)?janoshik\.com\/tests\/\d+-[^/?#]*_[A-Za-z0-9]+$/i },
  { lab: 'Bridge Analytical', patroon: /^https:\/\/(?:www\.)?bridgeanalytical\.com\/verify\/?\?key=[A-Za-z0-9][A-Za-z0-9-]{4,}$/i },
  { lab: 'Vanguard Laboratory', patroon: /^https:\/\/(?:www\.)?verifiedbyvanguard\.com\/verify\/[A-Za-z0-9-]{8,}$/i },
  { lab: 'ILS Laboratories', patroon: /^https:\/\/portal\.ils-lab\.com\/[^?#]*[A-Za-z0-9-]{6,}$/i }
];

function labVanVerificatielink(url) {
  for (const l of LAB_VERIFICATIELINKS) {
    if (l.patroon.test(url)) return l.lab;
  }
  return null;
}

// Blijft bestaan omdat andere modules hem importeren; betekent nu "is dit een
// verificatielink van een lab dat we herkennen".
const LAB_VERIFICATIELINK = { test: (url) => labVanVerificatielink(url) !== null };

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

// Haalt de echte bestands-URL uit een beeldproxy. Werkt voor Next.js
// (/_next/image?url=...), Shopify- en WordPress-varianten, en elke andere
// die de bron in een url/src/image-parameter meegeeft.
function pakBeeldproxyUit(url) {
  try {
    const u = new URL(url);
    for (const sleutel of ['url', 'src', 'image', 'file', 'path']) {
      const waarde = u.searchParams.get(sleutel);
      if (!waarde) continue;
      const echt = /^https?:\/\//i.test(waarde) ? waarde : (waarde.startsWith('/') ? u.origin + waarde : null);
      if (echt && DOC_EXT.test(echt.split('?')[0])) return echt;
    }
  } catch (e) { /* geen geldige URL */ }
  return null;
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
  // LET OP: veel WordPress-sites laden afbeeldingen lui in. In de ruwe HTML
  // staat dan een base64-placeholder in src en de echte bestandsnaam in
  // data-src. Bij lumopeptides.com zag de crawler daardoor nul documenten op
  // een pagina die er veertien had staan. Daarom alle gangbare lazy-attributen
  // meenemen, plus srcset.
  const imgTag = /<img\b[^>]*>/gi;
  const bronAttr = /\b(?:src|data-src|data-lazy-src|data-original|data-lazy|data-echo)\s*=\s*["']([^"']+)["']/gi;
  const srcsetAttr = /\b(?:srcset|data-srcset|data-lazy-srcset)\s*=\s*["']([^"']+)["']/gi;
  while ((m = imgTag.exec(html)) !== null) {
    const tag = m[0];
    const kandidaten = [];
    let a;
    bronAttr.lastIndex = 0;
    while ((a = bronAttr.exec(tag)) !== null) kandidaten.push(a[1]);
    srcsetAttr.lastIndex = 0;
    while ((a = srcsetAttr.exec(tag)) !== null) {
      // srcset is 'url 300w, url 600w' - alleen de URL's eruit.
      a[1].split(',').forEach((deel) => { const u = deel.trim().split(/\s+/)[0]; if (u) kandidaten.push(u); });
    }
    for (const kandidaat of kandidaten) {
      if (/^data:/i.test(kandidaat)) continue; // placeholder, geen bestand
      let url = absolutise(baseUrl, kandidaat);
      if (!url) continue;
      const uitgepakt = pakBeeldproxyUit(url);
      if (uitgepakt) url = uitgepakt;
      if (DOC_EXT.test(url) && !out.some((o) => o.url === url)) {
        out.push({ url, text: '', uitAfbeelding: true });
      }
    }
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
  const verificatieLinks = new Map();
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

  // Meet hoe deze site reageert op een pad dat zeker niet bestaat.
  let foutpagina = null;
  const onzinpad = root + '/bedrijfchecker-bestaat-niet-' + Date.now().toString(36) + '/';
  const proef = await fetchHtml(onzinpad);
  if (proef && proef.html) {
    // 200 op een onzinpad: deze site doet aan soft-404.
    foutpagina = vingerafdruk(proef.html);
    notes.push('site geeft een 200 op niet-bestaande paden (soft-404); pagina-inhoud wordt vergeleken in plaats van de statuscode');
  }

  // 2. Plus de gebruikelijke paden, ook als er nergens naar gelinkt wordt.
  for (const p of COMMON_PATHS) {
    candidates.push(root + p);
    // Zonder afsluitende slash is een andere pagina op veel frameworks.
    if (p.endsWith('/')) candidates.push(root + p.slice(0, -1));
  }

  // 3. Kandidaten aflopen tot we er genoeg hebben die echt documenten bevatten.
  const tried = new Set();
  let subpaginas = 0;
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

    if (foutpagina && lijktOpFoutpagina(vingerafdruk(page.html), foutpagina)) {
      if (diagnose.length < 20) diagnose.push({ url, resultaat: 'soft-404: pagina bestaat niet echt' });
      continue;
    }

    const rows = rowContextFor(page.html);
    const links = extractLinks(page.html, page.finalUrl);
    for (const l of links) {
      if (verificatieLinks.size >= MAX_DOCUMENTS) break;
      const labVanLink = labVanVerificatielink(l.url);
      if (labVanLink && !verificatieLinks.has(l.url)) {
        // LET OP: de linktekst zelf is vaak niets - bij omegapeptides is het
        // een pijltje. Alles wat we willen weten (product, batch, testsoort,
        // zuiverheid) staat in de RIJ eromheen. Documenten gebruikten die
        // rijtekst allang; verificatielinks niet, en daar ging de context dus
        // verloren.
        let context = (l.text || '').trim();
        for (const [href, text] of rows) {
          if (absolutise(page.finalUrl, href) === l.url) { context = (text || context); break; }
        }
        verificatieLinks.set(l.url, {
          url: l.url, lab: labVanLink,
          context: String(context || '').slice(0, 300),
          gevondenOp: page.finalUrl
        });
      }
    }
    // Een COA-overzichtspagina die zelf geen verwijzingen draagt, linkt ze vaak
    // per product door: /lab-results -> /lab-results/ghk-cu. Die kinderen liepen
    // we nooit af, want kandidaten kwamen alleen van de homepage. Gemeten bij
    // europapeptides: twee Janoshik-verwijzingen die we zo volledig misten.
    // Alleen echte kinderen van DEZE pagina, zodat dit geen sitebrede crawl wordt.
    if (INDEX_HINT.test(url) && subpaginas < MAX_SUBPAGINAS) {
      let basispad = null;
      try { basispad = new URL(page.finalUrl).pathname.replace(/\/+$/, ''); } catch (e) { basispad = null; }
      if (basispad && basispad !== '') {
        for (const l of links) {
          if (subpaginas >= MAX_SUBPAGINAS) break;
          if (DOC_EXT.test(l.url) || !sameSite(l.url, root)) continue;
          let pad;
          try { pad = new URL(l.url).pathname.replace(/\/+$/, ''); } catch (e) { continue; }
          if (pad === basispad || !pad.startsWith(basispad + '/')) continue;
          const norm2 = l.url.replace(/\/+$/, '/');
          if (tried.has(norm2)) continue;
          candidates.push(l.url);
          subpaginas++;
        }
      }
    }

    const bruikbaar = links.filter((l) => DOC_EXT.test(l.url) && !THUMBNAIL.test(l.url) &&
      !SITE_INRICHTING.test(l.url) && !INRICHTING_NAAM.test(l.url.split('/').pop() || ''));
    const aangelinkt = bruikbaar.filter((l) => !l.uitAfbeelding);
    // Aangeklikte documenten hebben voorrang. PDF's zijn altijd goed: niemand
    // zet zijn siteframework in een PDF. Losse afbeeldingen zijn alleen
    // bruikbaar als de bestandsnaam zelf zegt dat het een rapport is - anders
    // haal je het logo op en stuur je dat door een leesopdracht.
    // LET OP: eisen dat de bestandsnaam zelf 'coa' of 'report' bevat werkt
    // niet. Bij nextgenpeptides.nl viel daarmee de hele bibliotheek weg (21
    // documenten naar 0) omdat hun rapporten gewoon een uploadnaam hebben.
    // De inrichtingsfilters hierboven doen het werk al: logo's en iconen
    // staan in /brand/ en /icons/ of heten ernaar. Een rapportnaam is een
    // bonus, geen eis.
    const docs = aangelinkt.length ? aangelinkt : bruikbaar.filter((l) => l.uitAfbeelding);
    if (!docs.length) {
      // Geen bestanden, maar wel directe labverwijzingen? Dan is dit wel
      // degelijk de COA-pagina - en een betere dan een met kopieen.
      const verwijzingenHier = [...verificatieLinks.values()].filter((v) => v.gevondenOp === page.finalUrl).length;
      if (verwijzingenHier) { indexPages.push(page.finalUrl); continue; }
      if (diagnose.length < 20) diagnose.push({ url, resultaat: 'pagina bestaat, maar bevat geen documentlinks' });
      continue;
    }

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
  if (verificatieLinks.size) notes.push(verificatieLinks.size + ' directe verwijzingen naar de verificatiepagina van het lab gevonden');
  if (documents.size >= MAX_DOCUMENTS) notes.push('limiet van ' + MAX_DOCUMENTS + ' documenten bereikt; niet alles is meegenomen');

  return { indexPages, documents: Array.from(documents.values()), verificatieLinks: Array.from(verificatieLinks.values()), notes, diagnose };
}

module.exports = { crawlCoaIndex, extractLinks, rowContextFor, stripTags, absolutise, sameSite, vingerafdruk, lijktOpFoutpagina, pakBeeldproxyUit, DOC_EXT, THUMBNAIL, SITE_INRICHTING, INRICHTING_NAAM, RAPPORT_NAAM, LAB_VERIFICATIELINK, LAB_VERIFICATIELINKS, labVanVerificatielink, INDEX_HINT };
