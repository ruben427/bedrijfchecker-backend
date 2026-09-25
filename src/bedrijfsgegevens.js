'use strict';

// BEDRIJFSGEGEVENS UIT DE SITE VAN DE SHOP ZELF
//
// Wat deze module doet: de pagina's ophalen waar een webwinkel wettelijk zijn
// bedrijfsgegevens moet noemen - contact, algemene voorwaarden, privacy, over
// ons - en daaruit voorstellen maken voor de velden bij een leverancier.
//
// DRIE REGELS DIE HIER VASTLIGGEN, en ze zijn geen van de drie cosmetisch:
//
//  1. ALLES KOMT BINNEN ALS VOORSTEL. Nooit als "vermeld" en al helemaal niet
//     als "vastgesteld". Een voorstel is: het systeem heeft dit ergens gelezen,
//     nog door niemand bekeken. Pas als een mens erop klikt gaat het omhoog.
//  2. EEN VOORSTEL OVERSCHRIJFT NOOIT MENSENWERK. Staat een veld al op vermeld
//     of vastgesteld, dan blijft het staan. Anders kan een run van vannacht het
//     KvK-nummer dat iemand in het Handelsregister heeft nagekeken terugzetten
//     naar een gok van een contactpagina.
//  3. GEEN BRON, GEEN VELD. Het model moet de pagina noemen waar het iets zag,
//     en die pagina moet een van de opgehaalde pagina's zijn. Een waarde
//     zonder na te gaan herkomst is over een half jaar onbruikbaar, en dit vak
//     leest als nagegaan terwijl het dat niet is.
//
// Wat deze module NIET doet: het Handelsregister bevragen, whois opvragen of
// zoeken. Dit leest uitsluitend wat de partij zelf publiceert. Een KvK-nummer
// van hun eigen voorwaardenpagina is een BEWERING VAN DE SHOP OVER ZICHZELF -
// dat het nummer er staat betekent niet dat het klopt.

const { tavilyExtract } = require('./tavilyClient');
const { sampleJsonSafe } = require('./anthropicClient');
const coaStore = require('./coaStore');

// Waar het pleegt te staan. Ruim genomen, in beide talen: mislukte pagina's
// kosten niets extra en een gemiste voorwaardenpagina kost het hele veld.
const PADEN = ['', '/contact', '/contact-us', '/contactgegevens',
  '/algemene-voorwaarden', '/terms', '/terms-and-conditions', '/voorwaarden',
  '/privacy', '/privacybeleid', '/privacy-policy',
  '/over-ons', '/about', '/about-us', '/legal/company',
  '/disclaimer', '/retourneren', '/returns', '/verzenden', '/shipping'];

function paginasVoor(website) {
  let basis = String(website || '').trim();
  if (!basis) return [];
  if (!/^https?:\/\//i.test(basis)) basis = 'https://' + basis;
  basis = basis.replace(/\/+$/, '');
  return PADEN.map((p) => basis + p);
}

// De velden komen uit de database, niet uit een lijst hier: voegt iemand er in
// de admin een veld bij, dan gaat de crawler er vanzelf achteraan.
function veldenBlok(velden) {
  return velden.map((v) => '- ' + v.id + ' — ' + v.label +
    (v.hulp ? ' (' + v.hulp + ')' : '')).join('\n');
}

function prompt(velden, naam, pagina) {
  return [
    'Je leest de eigen pagina\'s van een webwinkel en haalt daar de',
    'bedrijfsgegevens uit die er LETTERLIJK op staan.',
    '',
    'Leverancier: ' + naam,
    '',
    'DE REGELS, en ze zijn strikt:',
    '1. Neem alleen over wat er letterlijk staat. Niets afleiden, niets aanvullen,',
    '   niets uit eigen kennis toevoegen. Weet je het niet, dan null.',
    '2. Bij elk veld dat je vult hoort de URL van de pagina waar je het zag, uit',
    '   de lijst hieronder. Kun je die niet noemen, laat het veld dan leeg.',
    '3. Een adres uit een sjabloon is geen adres. Staat er iets als',
    '   "123 Research Park Drive, City, State, ZIP" of "Straat 1, 1234 AB Plaats",',
    '   dan is dat een niet-ingevulde voorbeeldtekst: laat het veld leeg en zet',
    '   het in sjabloonadres.',
    '4. Splits een adres in straat met huisnummer, postcode en plaats. Staat',
    '   alleen een plaats, vul dan alleen plaats.',
    '5. adresVermeld is "ja" zodra er ergens een echt fysiek adres staat, en',
    '   "nee" als je de pagina\'s hebt gelezen en er geen adres op stond.',
    '6. Voor voorwaarden en retourbeleid geef je de URL van die pagina als waarde.',
    '7. Bestuurders, eigenaren en dat soort gegevens staan zelden op een',
    '   webwinkel. Vul die ALLEEN als er letterlijk een naam met die functie bij',
    '   staat. Verzin nooit een naam.',
    '',
    'De velden:',
    veldenBlok(velden),
    '',
    'De pagina\'s die zijn opgehaald:',
    pagina.map((p) => '- ' + p.url).join('\n'),
    '',
    'Antwoord UITSLUITEND met geldige JSON, zonder markdown:',
    '{"velden":[{"veld":string,"waarde":string,"bron":string}],',
    ' "sjabloonadres":string|null,',
    ' "nietGevonden":[string],',
    ' "opmerking":string}',
    '',
    'velden: alleen de velden die je hebt kunnen vullen. veld is precies een van',
    'de namen hierboven. nietGevonden: velden waarvan je zeker weet dat ze op',
    'deze pagina\'s niet staan - dat is zelf een bevinding en geen leegte.'
  ].join('\n');
}

// Hoofdfunctie. Geeft een verslag terug in plaats van alleen "ok": wie dit
// aanroept moet kunnen zien wat er is gevonden, wat is overgeslagen en waarom.
async function haalVoorstellen(supplierKey, opties) {
  const o = opties || {};
  const door = String(o.door || '').trim() || 'crawler';
  const website = o.website || ('https://' + supplierKey);
  const urls = paginasVoor(website);
  if (!urls.length) return { ok: false, reden: 'geen_website' };

  const gehaald = await tavilyExtract(urls, { depth: 'basic' });
  const pagina = (gehaald.ok || []).filter((p) => p.content && p.content.trim().length > 40);
  if (!pagina.length) {
    // Geen enkele pagina gelezen is GEEN lege uitkomst maar een storing: de
    // site kan achter een botfilter zitten. Dat mag nooit als "niets gevonden"
    // in de database belanden.
    return { ok: false, reden: 'geen_pagina_gelezen',
      mislukt: (gehaald.failed || []).length, geprobeerd: urls.length };
  }

  const velden = await coaStore.veldDefinities();
  const bestaand = await coaStore.feiten(supplierKey);
  const perVeld = {};
  bestaand.forEach((f) => { perVeld[f.veld] = f; });

  const documenten = pagina.map((p) => 'PAGINA ' + p.url + '\n' + p.content).join('\n\n---\n\n');
  const antwoord = await sampleJsonSafe(
    prompt(velden, supplierKey, pagina) + '\n\nDe inhoud van de pagina\'s:\n\n' + documenten,
    { label: 'bedrijfsgegevens-' + supplierKey }
  );
  if (!antwoord || !Array.isArray(antwoord.velden)) {
    return { ok: false, reden: 'geen_bruikbaar_antwoord', paginas: pagina.length };
  }

  const bekend = new Set(velden.map((v) => v.id));
  const bronnen = new Set(pagina.map((p) => p.url));
  const opgeslagen = [], overgeslagen = [];

  for (const r of antwoord.velden) {
    const veld = String((r && r.veld) || '').trim();
    const waarde = String((r && r.waarde) || '').trim();
    const bron = String((r && r.bron) || '').trim();
    if (!bekend.has(veld)) { overgeslagen.push({ veld, reden: 'onbekend veld' }); continue; }
    if (!waarde) { overgeslagen.push({ veld, reden: 'geen waarde' }); continue; }
    // Regel 3: geen bron, geen veld. En de bron moet een pagina zijn die wij
    // werkelijk hebben opgehaald - anders staat er een adres in dat het model
    // ergens anders vandaan haalde.
    if (!bron || !bronnen.has(bron)) {
      overgeslagen.push({ veld, reden: 'bron niet uit de opgehaalde pagina\'s' });
      continue;
    }
    // Regel 2: mensenwerk gaat voor. Een voorstel mag een ouder voorstel
    // vervangen, maar nooit iets wat iemand heeft bekeken.
    const nu = perVeld[veld];
    if (nu && (nu.stand === 'vermeld' || nu.stand === 'vastgesteld')) {
      overgeslagen.push({ veld, reden: 'staat al op ' + nu.stand + ' — mensenwerk gaat voor',
        bestaand: nu.waarde, voorstel: waarde });
      continue;
    }
    const uit = await coaStore.saveFeit(supplierKey, veld, {
      waarde, stand: 'voorstel', bron, vastgelegdDoor: door,
      toelichting: antwoord.sjabloonadres && /^(straat|postcode|plaats)$/.test(veld)
        ? 'Let op: op de site staat ook een sjabloonadres: ' + antwoord.sjabloonadres
        : null
    });
    if (uit) opgeslagen.push({ veld, waarde, bron });
    else overgeslagen.push({ veld, reden: 'opslaan mislukt' });
  }

  return {
    ok: true,
    supplierKey,
    paginasGelezen: pagina.map((p) => p.url),
    paginasMislukt: (gehaald.failed || []).length,
    opgeslagen,
    overgeslagen,
    // Deze twee zijn zelf bevindingen en geen restje: een shop die geen adres
    // noemt is iets anders dan een shop die we niet hebben kunnen lezen.
    nietGevonden: Array.isArray(antwoord.nietGevonden) ? antwoord.nietGevonden : [],
    sjabloonadres: antwoord.sjabloonadres || null,
    opmerking: antwoord.opmerking || null
  };
}

module.exports = { haalVoorstellen, paginasVoor, PADEN };
