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
const TE_VERGELIJKEN = [
  ['client', 'Client'], ['manufacturer', 'Manufacturer'], ['batchnummer', 'Batch'],
  ['product', 'Sample'], ['purityPercent', 'Purity'], ['orderDate', 'Testing ordered'],
  ['receivedDate', 'Sample received'], ['analysisDate', 'Analysis conducted']
];

function normaliseer(v) {
  if (v == null) return null;
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  return String(v).toLowerCase().replace(/[\s ]+/g, ' ').replace(/[.,;:]+$/, '').trim() || null;
}

function vergelijkVelden(leverancier, lab) {
  const verschillen = [];
  const gelijk = [];
  for (const [sleutel, label] of TE_VERGELIJKEN) {
    const a = normaliseer(leverancier && leverancier[sleutel]);
    const b = normaliseer(lab && lab[sleutel]);
    if (a == null || b == null) continue;
    if (a === b) gelijk.push(label);
    else verschillen.push({ veld: label, opKopieLeverancier: leverancier[sleutel], bijHetLab: lab[sleutel] });
  }
  return { gelijk, verschillen };
}

function bepaalKlasse(resolutie, vergelijking) {
  if (!resolutie || resolutie.resolved !== true) return (resolutie && resolutie.klasse) || null;
  if (!vergelijking) return null;
  if (vergelijking.verschillen.length) return 'B';
  if (!vergelijking.gelijk.length) return null; // niets vergelijkbaars: nog geen oordeel
  return 'A';
}

module.exports = {
  parseReferentie, bouwReferentie, resolveUrl, resolveer,
  vergelijkVelden, bepaalKlasse, isOfficieleHost, OFFICIELE_HOSTS
};
