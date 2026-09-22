// Labverificatie: lost een rapportverwijzing op bij het lab zelf.
//
// Kernprincipe uit het protocol: een task-ID is pas bewijs als het oplost naar
// een record op de server van het lab. Alles daarvoor is leveranciersclaim.
//
// Bewezen geval (validatieset): task 164849 van MyPept.eu resolvet naar een
// echt rapport waarin staat dat er GEEN Selank in zit maar Semax, bij 99,133%
// purity. Authentiek document, vernietigende uitslag. Daarom zijn C01
// (authenticiteit) en C02 (identity) aparte categorieen en mag dit nooit tot
// een groene score leiden.

const { isPublicHttpUrl } = require('./urlGuard');

const TIMEOUT_MS = Number(process.env.LAB_VERIFY_TIMEOUT_MS) || 15000;

// Harde allowlist. In zoekresultaten kwamen lookalikes voorbij
// (janoshilk.com, jano-shik.com). Een rapport dat in zijn eigen voettekst naar
// zo'n domein verwijst is een concrete rode vlag, geen technische storing.
// Daarom exacte hostnamen, geen string-match op "janoshik".
const OFFICIELE_HOSTS = new Set([
  'janoshik.com', 'www.janoshik.com', 'verify.janoshik.com', 'public.janoshik.com'
]);

function isOfficieleHost(url) {
  try { return OFFICIELE_HOSTS.has(new URL(url).hostname.toLowerCase()); } catch (e) { return false; }
}

// De verificatiereferentie ziet eruit als:  164849-selank_10mg_E7US5H3NA1RL
//                                           task  -sample     _sleutel
//
// LET OP: het sampledeel is een vrij tekstveld en mag zelf underscores
// bevatten. De sleutel is dus wat na de LAATSTE underscore staat, niet na de
// eerste. Een parser die op de eerste splitst breekt op dit echte geval.
function parseReferentie(input) {
  const s = String(input || '').trim();
  if (!s) return null;

  // Hele URL meegekregen? Pak het laatste pad-segment.
  let ref = s;
  const m = /\/tests\/([^/?#]+)/i.exec(s);
  if (m) ref = m[1];
  else if (/^https?:\/\//i.test(s)) {
    try { ref = new URL(s).pathname.split('/').filter(Boolean).pop() || ''; } catch (e) { return null; }
  }
  ref = decodeURIComponent(ref);

  const streep = ref.indexOf('-');
  const underscore = ref.lastIndexOf('_');
  if (streep < 1 || underscore < streep + 2 || underscore === ref.length - 1) return null;

  const taskNumber = ref.slice(0, streep);
  const sample = ref.slice(streep + 1, underscore);
  const key = ref.slice(underscore + 1);
  if (!/^\d+$/.test(taskNumber)) return null;
  if (!/^[A-Za-z0-9]+$/.test(key)) return null;

  return { taskNumber, sample, key, referentie: ref };
}

// Bouw de referentie op uit losse velden zoals de leeslaag ze uit het rapport
// haalt. Zonder sleutel is er geen resolutie mogelijk - dat is klasse C.
function bouwReferentie(velden) {
  const v = velden || {};
  if (v.verificationUrl) {
    const p = parseReferentie(v.verificationUrl);
    if (p) return p;
  }
  const task = String(v.reportId || v.taskNumber || '').replace(/^#/, '').trim();
  const key = String(v.verificationKey || '').trim();
  const sample = String(v.sampleLabel || v.sample || '').trim();
  if (!/^\d+$/.test(task) || !/^[A-Za-z0-9]+$/.test(key)) return null;
  // Het sampledeel is NIET nodig om op te lossen: getest op 15 sep 2026,
  // '164849-_E7US5H3NA1RL' en '164849-x_E7US5H3NA1RL' geven allebei hetzelfde
  // rapport als de volledige referentie. Dat maakt verificatie mogelijk zodra
  // je tasknummer en sleutel hebt - en die staan allebei op het rapport.
  // Eerder was sample verplicht, waardoor 21 geldige Janoshik-rapporten van
  // nextgenpeptides.nl onterecht op klasse C bleven staan.
  return { taskNumber: task, sample: sample || null, key, referentie: task + '-' + (sample || '') + '_' + key };
}

function resolveUrl(ref) {
  return 'https://verify.janoshik.com/tests/' + ref.referentie;
}

async function haalVerificatiepagina(url) {
  const veilig = isPublicHttpUrl(url);
  if (!veilig.ok) return { fout: 'geweigerd: ' + veilig.reden };
  if (!isOfficieleHost(url)) return { fout: 'niet-officieel verificatiedomein' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { Accept: 'text/html' } });
    if (!res.ok) return { fout: 'http_' + res.status };
    const html = await res.text();
    // Een bestaande referentie rendert het rapport als afbeelding. Een
    // onbekende referentie stuurt door naar de homepage: dan staat er geen
    // rapportafbeelding op de pagina.
    const afbeeldingen = [];
    const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      try { afbeeldingen.push(new URL(m[1], res.url || url).toString()); } catch (e) { /* overslaan */ }
    }
    return { html, finalUrl: res.url || url, afbeeldingen };
  } catch (e) {
    const naam = (e && e.name) || 'Error';
    return { fout: naam === 'AbortError' ? 'timeout' : 'netwerkfout' };
  } finally {
    clearTimeout(timer);
  }
}

// Stap 1 van de verificatie: lost de referentie uberhaupt op?
// Klasse D (verzonnen of ingetrokken ID) is hiermee gratis vast te stellen -
// daar is geen vision voor nodig. Alleen het onderscheid A/B vraagt om het
// lezen van de teruggegeven rapportafbeelding.
async function resolveer(velden) {
  const ref = bouwReferentie(velden);
  if (!ref) {
    return {
      klasse: 'C',
      status: 'geen bruikbare verificatiereferentie op het rapport',
      resolved: false,
      taskNumber: (velden && velden.reportId) || null,
      sleutelAanwezig: !!(velden && velden.verificationKey)
    };
  }
  const url = resolveUrl(ref);
  const page = await haalVerificatiepagina(url);
  if (page.fout) {
    // Een weigering op domeinniveau is iets anders dan een storing.
    if (page.fout === 'niet-officieel verificatiedomein') {
      return { klasse: 'D', status: page.fout, resolved: false, ...ref, url };
    }
    return { klasse: null, status: 'verificatie niet uitvoerbaar: ' + page.fout, resolved: null, ...ref, url };
  }
  // Een ongeldige referentie (verkeerde sleutel, verzonnen nummer, of alleen
  // een nummer) stuurt door naar navigation.php en levert nul afbeeldingen.
  // Een geldige blijft op /tests/<ref> staan met het rapport onder /images/.
  // Het logo staat onder /img/ - die mag niet als rapport tellen, anders
  // lijkt elke ongeldige verwijzing alsnog opgelost.
  const doorgestuurd = /navigation\.php/i.test(page.finalUrl || '');
  const rapportAfbeelding = (page.afbeeldingen || []).find((u) => /\/images\//i.test(u));
  if (doorgestuurd || !rapportAfbeelding) {
    return { klasse: 'D', status: 'referentie lost niet op naar een rapport bij het lab', resolved: false, ...ref, url };
  }
  return {
    klasse: null, // A of B volgt pas na de veldvergelijking
    status: 'rapport gevonden bij het lab; velden nog te vergelijken',
    resolved: true, ...ref, url, rapportAfbeelding
  };
}

// Stap 2: vergelijk wat de leverancier toont met wat het lab teruggeeft.
// Alleen velden die aan beide kanten ingevuld zijn worden vergeleken; een
// ontbrekend veld is geen conflict.
// Elk veld heeft zijn eigen soort, want tekstvergelijking op een datum of een
// percentage levert vals-positieve verschillen op. Gemeten op 20 september:
// "2026-07-20" tegen "20 July 2026" en 99.4 tegen "99.4%" telden allebei als
// verschil, terwijl er niets verschilt. Annemarie wees hier terecht op.
const TE_VERGELIJKEN = [
  ['client', 'Client', 'naam'], ['manufacturer', 'Manufacturer', 'naam'],
  ['batchnummer', 'Batch', 'code'], ['product', 'Sample', 'productnaam'],
  ['purityPercent', 'Purity', 'getal'], ['orderDate', 'Testing ordered', 'datum'],
  ['receivedDate', 'Sample received', 'datum'], ['analysisDate', 'Analysis conducted', 'datum']
];

const MAANDEN = {
  jan: 1, feb: 2, mar: 3, mrt: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7,
  aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12
};

// Naar JJJJ-MM-DD, of null als het niet eenduidig te lezen is. Een datum die
// we niet zeker weten wordt NIET vergeleken - liever geen oordeel dan een
// verkeerd oordeel. 07/08/2026 kan 7 augustus of 8 juli zijn; dat raden we
// niet.
function naarDatum(v) {
  if (v == null) return null;
  const t = String(v).trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(m[1], m[2], m[3]);
  m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    // Allebei <= 12: niet te zeggen welke de dag is.
    if (a <= 12 && b <= 12 && a !== b) return null;
    return a > 12 ? iso(m[3], b, a) : iso(m[3], a, b);
  }
  m = t.match(/^(\d{1,2})\s+([a-z]{3,})\.?,?\s+(\d{4})$/i);
  if (m) { const mm = MAANDEN[m[2].slice(0, 3).toLowerCase()]; return mm ? iso(m[3], mm, m[1]) : null; }
  m = t.match(/^([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (m) { const mm = MAANDEN[m[1].slice(0, 3).toLowerCase()]; return mm ? iso(m[3], mm, m[2]) : null; }
  return null;
}
function iso(j, m, d) {
  const mm = Number(m), dd = Number(d);
  if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
  return String(j) + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
}

// Losse achtervoegsels en domeinvormen die bedrijfsnamen laten verschillen
// zonder dat er iets verschilt. Wordt NOOIT gebruikt om iets gelijk te
// verklaren - alleen om een bijna-gelijk geval te markeren voor een mens.
function kaleNaam(v) {
  return String(v == null ? '' : v).toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '')
    .replace(/\.(com|net|org|eu|nl|co\.uk)\b/g, '')
    .replace(/\b(b\.?v\.?|ltd\.?|llc|inc\.?|gmbh|s\.?r\.?o\.?|labs?|laboratories|analytical)\b/g, '')
    .replace(/[^a-z0-9]+/g, '').trim();
}

// Productnamen: de shop noemt de dosering mee, het lab meestal niet.
// "SS-31 50mg" tegenover "SS-31" is geen verschil maar een schrijfwijze.
// Gemeten op 20 september: vier van de zes vergelijkingen sloegen hierop aan.
//
// We maken ze NIET gelijk - "BPC-157" tegenover "Tirzepatide" moet een verschil
// blijven. In plaats daarvan blijft het een verschil met een vlag erbij, zodra
// elk woord van de kortste kant in de langste terugkomt. Zo verdwijnt er niets
// uit beeld en schreeuwt de telling niet onnodig.
function tokensVan(v) {
  return String(v == null ? '' : v).toLowerCase()
    .replace(/\b\d+(?:[.,]\d+)?\s*(mg|mcg|ug|µg|g|iu|ml)\b/g, ' ')   // dosering eruit
    .split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

function naamLijktOp(a, b) {
  const ta = tokensVan(a), tb = tokensVan(b);
  if (!ta.length || !tb.length) return false;
  // Beide richtingen proberen: bij evenveel woorden is niet te zeggen welke
  // kant de uitgebreide schrijfwijze is. "cjc1295 no dac" en "cjc no dac"
  // hebben er allebei drie, en alleen een van de twee richtingen klopt.
  const past = (kort, lang) => kort.every((t) => lang.join('').includes(t));
  return past(ta, tb) || past(tb, ta);
}

function normaliseerVeld(v, soort) {
  if (v == null || v === '') return null;
  if (soort === 'datum') return naarDatum(v);
  if (soort === 'getal') {
    const n = Number(String(v).replace('%', '').replace(',', '.').trim());
    return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : null;
  }
  if (soort === 'productnaam') return normaliseer(v);
  if (soort === 'code') {
    const c = String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return c || null;
  }
  return normaliseer(v);
}

function normaliseer(v) {
  if (v == null) return null;
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  return String(v).toLowerCase().replace(/[\s ]+/g, ' ').replace(/[.,;:]+$/, '').trim() || null;
}

function vergelijkVelden(leverancier, lab) {
  const verschillen = [];
  const gelijk = [];
  for (const [sleutel, label, soort] of TE_VERGELIJKEN) {
    const a = normaliseerVeld(leverancier && leverancier[sleutel], soort);
    const b = normaliseerVeld(lab && lab[sleutel], soort);
    if (a == null || b == null) continue;
    if (a === b) { gelijk.push(label); continue; }
    const rij = { veld: label, opKopieLeverancier: leverancier[sleutel], bijHetLab: lab[sleutel] };
    // Verschillen namen alleen in schrijfwijze, achtervoegsel of domein? Dan
    // blijft het een verschil, maar met een vlag erbij. Dat oordeel is voor
    // een mens, niet voor een reguliere expressie.
    if (soort === 'naam') {
      const ka = kaleNaam(leverancier && leverancier[sleutel]);
      const kb = kaleNaam(lab && lab[sleutel]);
      if (ka && kb && ka === kb) rij.bijnaGelijk = true;
    }
    if (soort === 'productnaam' && naamLijktOp(leverancier && leverancier[sleutel], lab && lab[sleutel])) {
      rij.bijnaGelijk = true;
    }
    verschillen.push(rij);
  }
  return { gelijk, verschillen };
}

// --- A15b: waar landt een verschil tussen shopkopie en labrapport? --------
//
// BESLUIT ANNEMARIE, 22 SEPTEMBER. Zij koos optie 3 en scherpte A15 aan:
//
//   "As 1 moet de authenticiteit van het oorspronkelijke labrapport
//   beschrijven, niet de betrouwbaarheid van alles wat een shop daaromheen
//   publiceert."
//
// En: "niet alle verschillen hetzelfde behandelen." Drie soorten, met drie
// verschillende gevolgen:
//
//   presentatie  schrijfwijze, dosering in de naam. Geen gevolg.
//   labwaarde    het lab zegt 98,933%, de shop toont 99,533%. Het rapport
//                blijft authentiek, maar de shopkopie wijkt inhoudelijk af
//                van de bron. De LABBRON is leidend; de shopwaarde mag niet
//                als bewijs worden overgenomen. Los daarvan een negatief
//                transparantiesignaal over de leverancier.
//   koppeling    batch, lot, product, opdrachtgever, datums. Het rapport
//                blijft authentiek, maar de vraag is of het bij DEZE partij
//                hoort. Dat is as 2.
//
// Uitdrukkelijk geen conclusie over waarom een getal afwijkt of of het bewust
// is aangepast. Wel de harde vaststelling dat de leverancier iets anders
// toont dan het lab.
//
// Welke velden waar horen. Annemarie noemde drie voorbeelden; de overige
// velden zijn daarnaartoe gelegd langs haar eigen scheidslijn: een
// MEETRESULTAAT hoort bij labwaarde, alles wat zegt WELK rapport dit is en
// van WIE het is hoort bij de koppeling.
const AFWIJKINGSSOORT = {
  Purity: 'labwaarde',
  Batch: 'koppeling',
  Sample: 'koppeling',
  Client: 'koppeling',
  Manufacturer: 'koppeling',
  'Testing ordered': 'koppeling',
  'Sample received': 'koppeling',
  'Analysis conducted': 'koppeling'
};

function beoordeelAfwijkingen(vergelijking) {
  const uit = { presentatie: [], labwaarde: [], koppeling: [], onbekendVeld: [] };
  ((vergelijking && vergelijking.verschillen) || []).forEach((v) => {
    // bijnaGelijk betekent: de normalisatie stelt vast dat dit inhoudelijk
    // hetzelfde is, alleen anders opgeschreven. Dat is haar geval 1 en heeft
    // geen gevolg - ook niet als het veld anders bij de koppeling zou horen.
    if (v.bijnaGelijk) { uit.presentatie.push(v); return; }
    const soort = AFWIJKINGSSOORT[v.veld];
    if (!soort) { uit.onbekendVeld.push(v); return; }
    uit[soort].push(v);
  });

  uit.shopkopieWijktAf = uit.labwaarde.length > 0;
  // De stand van as 2. Annemarie: "zwak of geen/tegenstrijdig", zonder te
  // zeggen wanneer welke. Wij kiezen die grens niet zelf - dat is precies de
  // fout die bij A18 is teruggedraaid - en houden de mildste van de twee. Het
  // gevolg is hetzelfde: het rapport telt niet als bewijs voor deze batch.
  uit.koppelingsstand = uit.koppeling.length ? 'zwak' : null;
  uit.telling = {
    presentatie: uit.presentatie.length,
    labwaarde: uit.labwaarde.length,
    koppeling: uit.koppeling.length
  };
  return uit;
}

// LET OP - HERZIEN 22 SEPTEMBER, BESLUIT A15b.
//
// Hier stond: referentie lost op en de velden kloppen -> A, lost op maar een
// veld wijkt af -> B. Die B betekende "het rapport is echt, maar de kopie die
// de shop toont is bewerkt".
//
// Bij Annemarie betekent B iets anders, bijna het tegenovergestelde:
// authentiek met sterke verificatie, maar NIET rechtstreeks bij het lab
// bevestigd. En juist in dit geval is het rapport wel rechtstreeks bij het
// lab opgehaald.
//
// Haar regel: "Als Janoshik rechtstreeks oplost, is het rapport op as 1 A."
// De veldvergelijking zegt dus niets meer over as 1. Wat zij wel zegt staat
// nu in beoordeelAfwijkingen, en dat is drie antwoorden in plaats van een
// letter.
//
// De tweede parameter blijft staan zodat bestaande aanroepers niet breken,
// maar hij doet niets meer. Dat is met opzet zichtbaar gelaten: stilletjes
// een argument laten vallen maakt later onvindbaar waarom het er ooit was.
function bepaalKlasse(resolutie, vergelijkingNietMeerGebruikt) {  // eslint-disable-line no-unused-vars
  if (!resolutie || resolutie.resolved !== true) return (resolutie && resolutie.klasse) || null;
  // resolveer() geeft alleen resolved:true terug als het lab een echt rapport
  // teruggaf - doorgestuurd of zonder rapportafbeelding is al D. Dat is de
  // authenticiteit van het labrapport, en dus as 1 = A.
  return 'A';
}

module.exports = {
  parseReferentie, bouwReferentie, resolveUrl, resolveer,
  vergelijkVelden, bepaalKlasse, beoordeelAfwijkingen, AFWIJKINGSSOORT,
  isOfficieleHost, OFFICIELE_HOSTS,
  // Gedeeld met de handmatige route, zodat een menselijke vergelijking exact
  // dezelfde velden en dezelfde normalisatie gebruikt als de resolver.
  TE_VERGELIJKEN, normaliseer, normaliseerVeld, kaleNaam, naarDatum, naamLijktOp
};
