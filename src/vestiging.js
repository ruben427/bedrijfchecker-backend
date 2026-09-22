// ---------------------------------------------------------------------------
// Vestigingsland van een laboratorium of leverancier.
//
// BESLUIT RUBEN, 22 september 2026: "EU" gaat over de JURIDISCHE VESTIGING -
// waar het bedrijf staat ingeschreven. Niet het verzendland. Dat is wat telt
// voor aansprakelijkheid en of je iemand kunt aanspreken.
//
// HARDE GRENS: dit bestand LEIDT AF, het stelt niets vast. Een afgeleid land
// is een voorstel met een reden erbij, en het hoort op het scherm nooit
// hetzelfde te lezen als een vastgesteld land. Een .cz-domein is een goede
// aanwijzing dat een bedrijf in Tsjechie is ingeschreven, maar het is geen
// uittreksel. En .com zegt helemaal niets: Janoshik draait op .com en is
// Tsjechisch.
//
// Daarom: alleen afleiden uit een LANDDOMEIN, en alles anders onbekend. Geen
// gok uit de bedrijfsnaam, geen aanname uit de taal van de site, geen
// herinnering aan wat wij ergens gelezen zouden hebben. Wie meer wil weten,
// zoekt het op en legt het vast - daar is het vastgestelde veld voor.
// ---------------------------------------------------------------------------

// De 27 lidstaten. Los van de EER-landen hieronder, want de vraag was EU.
const EU_LANDEN = {
  at: 'Oostenrijk', be: 'Belgie', bg: 'Bulgarije', cy: 'Cyprus', cz: 'Tsjechie',
  de: 'Duitsland', dk: 'Denemarken', ee: 'Estland', es: 'Spanje', fi: 'Finland',
  fr: 'Frankrijk', gr: 'Griekenland', hr: 'Kroatie', hu: 'Hongarije', ie: 'Ierland',
  it: 'Italie', lt: 'Litouwen', lu: 'Luxemburg', lv: 'Letland', mt: 'Malta',
  nl: 'Nederland', pl: 'Polen', pt: 'Portugal', ro: 'Roemenie', se: 'Zweden',
  si: 'Slovenie', sk: 'Slowakije'
};

// Niet-EU, maar wel vaak verward met EU. Ze krijgen eu:false en een notitie,
// zodat "niet-EU" hier niet leest als "ver weg en onbereikbaar".
const EER_EN_BUUR = {
  no: 'Noorwegen', is: 'IJsland', li: 'Liechtenstein', ch: 'Zwitserland',
  gb: 'Verenigd Koninkrijk', uk: 'Verenigd Koninkrijk'
};

// Landdomeinen buiten Europa die we in deze markt tegenkomen. Alleen om een
// duidelijker antwoord te geven dan "niet-EU"; de lijst hoeft niet compleet te
// zijn, want een onbekend landdomein levert gewoon onbekend op.
const OVERIG = {
  us: 'Verenigde Staten', ca: 'Canada', cn: 'China', hk: 'Hongkong', in: 'India',
  au: 'Australie', nz: 'Nieuw-Zeeland', jp: 'Japan', kr: 'Zuid-Korea',
  sg: 'Singapore', th: 'Thailand', ae: 'Verenigde Arabische Emiraten',
  za: 'Zuid-Afrika', br: 'Brazilie', mx: 'Mexico', tr: 'Turkije', ru: 'Rusland',
  ua: 'Oekraine', rs: 'Servie', md: 'Moldavie', to: 'Tonga', io: null, co: null,
  me: null, tv: null, cc: null, ai: null, ly: null, sh: null, am: null
};

// Landdomeinen die in de praktijk als merknaam worden gebruikt in plaats van
// als landaanduiding. .io, .co, .me, .tv, .cc, .ai, .ly, .sh en .am worden
// wereldwijd verkocht als "korte domeinnaam" - peptidekoning.to zit niet in
// Tonga. Die leveren uitdrukkelijk ONBEKEND op, geen land.
const MERKDOMEINEN = new Set(['io', 'co', 'me', 'tv', 'cc', 'ai', 'ly', 'sh', 'am', 'to', 'gg', 'fm', 'st']);

// Generieke domeinen: zeggen niets over een land.
const GENERIEK = new Set([
  'com', 'net', 'org', 'info', 'biz', 'shop', 'store', 'online', 'site', 'xyz',
  'pro', 'club', 'life', 'world', 'app', 'dev', 'health', 'care', 'lab', 'labs'
]);

function hostVan(url) {
  const t = String(url || '').trim();
  if (!t) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : 'https://' + t);
    return u.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch (e) {
    return null;
  }
}

// Het landdomein uit een hostnaam. Houdt rekening met samengestelde vormen als
// co.uk en com.au: daar zit het land op de LAATSTE plek, niet op de een na
// laatste.
function tldVan(host) {
  if (!host) return null;
  const delen = host.split('.').filter(Boolean);
  if (delen.length < 2) return null;
  return delen[delen.length - 1];
}

// .eu is geen land maar wel een harde EU-aanwijzing: het domein wordt alleen
// uitgegeven aan partijen die in de EU, IJsland, Liechtenstein of Noorwegen
// gevestigd zijn. Dus wel eu:true, maar geen land - en dat verschil blijft
// zichtbaar in de reden.
function leidAfUitDomein(url) {
  const host = hostVan(url);
  if (!host) return { land: null, landcode: null, eu: null, zeker: false, reden: 'geen webadres bekend' };
  const tld = tldVan(host);
  if (!tld) return { land: null, landcode: null, eu: null, zeker: false, reden: 'geen bruikbaar webadres: ' + host };

  if (tld === 'eu') {
    return {
      land: null, landcode: null, eu: true, zeker: false,
      reden: 'het domein eindigt op .eu, dat alleen wordt uitgegeven aan partijen gevestigd in de EU, IJsland, Liechtenstein of Noorwegen; welk land precies volgt er niet uit'
    };
  }
  if (MERKDOMEINEN.has(tld)) {
    return {
      land: null, landcode: null, eu: null, zeker: false,
      reden: '.' + tld + ' is een landdomein dat wereldwijd als merknaam wordt verkocht en dus niets over de vestiging zegt'
    };
  }
  if (GENERIEK.has(tld)) {
    return {
      land: null, landcode: null, eu: null, zeker: false,
      reden: '.' + tld + ' is een generiek domein en zegt niets over het land'
    };
  }
  if (EU_LANDEN[tld]) {
    return {
      land: EU_LANDEN[tld], landcode: tld, eu: true, zeker: false,
      reden: 'het domein eindigt op .' + tld + ', het landdomein van ' + EU_LANDEN[tld]
    };
  }
  if (EER_EN_BUUR[tld]) {
    return {
      land: EER_EN_BUUR[tld], landcode: tld, eu: false, zeker: false,
      reden: 'het domein eindigt op .' + tld + ' (' + EER_EN_BUUR[tld] + '), geen EU-lidstaat'
    };
  }
  if (Object.prototype.hasOwnProperty.call(OVERIG, tld) && OVERIG[tld]) {
    return {
      land: OVERIG[tld], landcode: tld, eu: false, zeker: false,
      reden: 'het domein eindigt op .' + tld + ' (' + OVERIG[tld] + '), geen EU-lidstaat'
    };
  }
  return {
    land: null, landcode: null, eu: null, zeker: false,
    reden: '.' + tld + ' is een landdomein dat wij niet op de lijst hebben; niet afgeleid'
  };
}

// Een door een mens ingevuld land omzetten naar dezelfde vorm. Accepteert een
// landcode ("nl", "CZ") of een naam zoals hij in de lijsten staat.
function normaliseerLand(invoer) {
  const t = String(invoer || '').trim();
  if (!t) return { land: null, landcode: null, eu: null };
  const kort = t.toLowerCase();
  if (EU_LANDEN[kort]) return { land: EU_LANDEN[kort], landcode: kort, eu: true };
  if (EER_EN_BUUR[kort]) return { land: EER_EN_BUUR[kort], landcode: kort, eu: false };
  if (OVERIG[kort]) return { land: OVERIG[kort], landcode: kort, eu: false };
  const alleLijsten = [[EU_LANDEN, true], [EER_EN_BUUR, false], [OVERIG, false]];
  for (const [lijst, isEu] of alleLijsten) {
    for (const code of Object.keys(lijst)) {
      if (lijst[code] && lijst[code].toLowerCase() === kort) {
        return { land: lijst[code], landcode: code, eu: isEu };
      }
    }
  }
  // Onbekend land: wel bewaren zoals ingevuld, maar geen EU-uitspraak doen.
  return { land: t, landcode: null, eu: null };
}

// Wat er uiteindelijk getoond moet worden. Een vastgesteld land wint altijd
// van een afgeleid land, en de uitkomst draagt altijd mee HOE we eraan komen.
function stand(afgeleid, vastgesteld) {
  if (vastgesteld && (vastgesteld.land || vastgesteld.eu != null)) {
    return {
      land: vastgesteld.land || null,
      landcode: vastgesteld.landcode || null,
      eu: vastgesteld.eu,
      herkomst: 'vastgesteld',
      signaal: null,
      door: vastgesteld.vastgelegdDoor || null,
      reden: vastgesteld.onderbouwing || null,
      bronnen: vastgesteld.bronnen || null
    };
  }
  const a = afgeleid || { land: null, landcode: null, eu: null, reden: 'niet afgeleid' };
  return {
    land: a.land || null,
    landcode: a.landcode || null,
    eu: a.eu,
    herkomst: a.eu == null && !a.land ? 'onbekend' : 'afgeleid',
    signaal: a.signaal || null,
    door: null,
    reden: a.reden || null,
    bronnen: null
  };
}

// Korte tekst voor op het scherm. Bewust anders van vorm voor afgeleid en
// vastgesteld, zodat ze nooit op elkaar lijken.
function etiket(s) {
  if (!s) return 'onbekend';
  if (s.herkomst === 'onbekend') return 'land onbekend';
  const kern = s.eu === true ? 'EU' : (s.eu === false ? 'niet-EU' : 'land bekend');
  const plaats = s.land ? ' - ' + s.land : '';
  return s.herkomst === 'vastgesteld' ? (kern + plaats) : (kern + plaats + ' (afgeleid)');
}

// ---- afleiden uit wat er op het rapport zelf staat ------------------------
//
// De uitleesstap zet in het labveld alles wat op het briefhoofd staat. Dat
// leverde eerder alleen last op (elke schrijfwijze werd een eigen lab, zie
// korteLabnaam in coaStore), maar er zit iets waardevols in: het ADRES.
//
//   "ILS Laboratories, 8222 Vickers St, Suite 106, San Diego, CA 92111"
//   "MZ Biolabs, 2102 N Country Club Rd, Tucson, AZ 85716"
//
// Dat is een veel harder signaal dan een domeinnaam. Het staat op het rapport
// dat het lab zelf heeft uitgegeven, en het gaat over de plek waar het lab
// zit - niet over waar iemand toevallig een domein kocht.
//
// Blijft afgeleid, geen vaststelling: een adres op een briefhoofd is niet
// hetzelfde als een inschrijving in een handelsregister.

// Staat + postcode aan het eind, de Amerikaanse en Canadese vorm.
const US_STAAT = /\b(A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|P[AR]|RI|S[CD]|T[NX]|UT|V[AIT]|W[AIVY])\s+\d{5}(-\d{4})?\b/;
const CA_PROVINCIE = /\b(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i;

// Rechtsvormen die maar in een land voorkomen. Bewust GEEN "Ltd", "SA", "AB"
// of "AS": die bestaan in te veel landen, of vallen samen met gewone woorden.
const RECHTSVORMEN = [
  { patroon: /\bLLC\b|\bL\.L\.C\.|\bInc\.?\b|\bCorp\.?\b/i, landcode: 'us', wat: 'LLC/Inc/Corp' },
  { patroon: /\bGmbH\b/i, landcode: 'de', wat: 'GmbH' },
  { patroon: /\bB\.?V\.?\b(?!\w)/, landcode: 'nl', wat: 'B.V.' },
  { patroon: /\bs\.?r\.?o\.?\b/i, landcode: 'cz', wat: 's.r.o.' },
  { patroon: /\bSp\.?\s?z\s?o\.?o\.?\b/i, landcode: 'pl', wat: 'Sp. z o.o.' },
  { patroon: /\bSIA\b/, landcode: 'lv', wat: 'SIA' },
  { patroon: /\bUAB\b/, landcode: 'lt', wat: 'UAB' },
  { patroon: /\bd\.?o\.?o\.?\b/i, landcode: 'si', wat: 'd.o.o.' },
  { patroon: /\bOy\b/, landcode: 'fi', wat: 'Oy' },
  { patroon: /\bApS\b|\bA\/S\b/, landcode: 'dk', wat: 'ApS/A-S' },
  { patroon: /\bKft\.?\b/i, landcode: 'hu', wat: 'Kft.' },
  { patroon: /\bS\.?L\.?U?\.?\b(?=\s*$)/, landcode: 'es', wat: 'S.L.' }
];

// Landnamen voluit, aan het eind van een adresregel.
const LANDNAAM = [
  [/\b(verenigde staten|united states|u\.?s\.?a\.?)\b/i, 'us'],
  [/\b(canada)\b/i, 'ca'],
  [/\b(czech(ia| republic)?|tsjechie|ceska)\b/i, 'cz'],
  [/\b(germany|deutschland|duitsland)\b/i, 'de'],
  [/\b(netherlands|nederland)\b/i, 'nl'],
  [/\b(poland|polska|polen)\b/i, 'pl'],
  [/\b(united kingdom|england|scotland|wales)\b/i, 'gb'],
  [/\b(china|p\.?r\.?\s?china)\b/i, 'cn'],
  [/\b(india)\b/i, 'in'],
  [/\b(latvia|letland)\b/i, 'lv'],
  [/\b(lithuania|litouwen)\b/i, 'lt'],
  [/\b(slovakia|slowakije)\b/i, 'sk'],
  [/\b(spain|espana|spanje)\b/i, 'es'],
  [/\b(france|frankrijk)\b/i, 'fr'],
  [/\b(italy|italia|italie)\b/i, 'it'],
  [/\b(ireland|ierland)\b/i, 'ie'],
  [/\b(sweden|zweden)\b/i, 'se'],
  [/\b(denmark|denemarken)\b/i, 'dk'],
  [/\b(finland)\b/i, 'fi'],
  [/\b(austria|oostenrijk)\b/i, 'at'],
  [/\b(belgium|belgie|belgique)\b/i, 'be'],
  [/\b(switzerland|zwitserland|schweiz)\b/i, 'ch'],
  [/\b(hungary|hongarije)\b/i, 'hu'],
  [/\b(slovenia|slovenie)\b/i, 'si'],
  [/\b(croatia|kroatie)\b/i, 'hr'],
  [/\b(romania|roemenie)\b/i, 'ro'],
  [/\b(bulgaria|bulgarije)\b/i, 'bg'],
  [/\b(portugal)\b/i, 'pt'],
  [/\b(greece|griekenland)\b/i, 'gr'],
  [/\b(estonia|estland)\b/i, 'ee'],
  [/\b(cyprus)\b/i, 'cy'],
  [/\b(malta)\b/i, 'mt'],
  [/\b(luxembourg|luxemburg)\b/i, 'lu']
];

function uitLandcode(code, reden) {
  if (EU_LANDEN[code]) return { land: EU_LANDEN[code], landcode: code, eu: true, zeker: false, reden };
  if (EER_EN_BUUR[code]) return { land: EER_EN_BUUR[code], landcode: code, eu: false, zeker: false, reden };
  if (OVERIG[code]) return { land: OVERIG[code], landcode: code, eu: false, zeker: false, reden };
  return { land: null, landcode: null, eu: null, zeker: false, reden: 'landcode ' + code + ' niet op de lijst' };
}

// Een ruwe labnaam zoals hij op het briefhoofd stond. Volgorde van zekerheid:
// een landnaam voluit is het sterkst, dan een staat met postcode, dan een
// rechtsvorm.
function leidAfUitBriefhoofd(ruw) {
  const t = String(ruw || '').trim();
  if (!t) return { land: null, landcode: null, eu: null, zeker: false, reden: 'geen briefhoofdtekst' };

  for (const [re, code] of LANDNAAM) {
    const m = t.match(re);
    if (m) return uitLandcode(code, 'op het rapport staat "' + m[0] + '" in de adresregel van het laboratorium');
  }
  const us = t.match(US_STAAT);
  if (us) return uitLandcode('us', 'het adres op het rapport eindigt op "' + us[0] + '", een Amerikaanse staat met postcode');
  const ca = t.match(CA_PROVINCIE);
  if (ca) return uitLandcode('ca', 'het adres op het rapport eindigt op "' + ca[0] + '", een Canadese provincie met postcode');
  for (const r of RECHTSVORMEN) {
    if (r.patroon.test(t)) {
      return uitLandcode(r.landcode, 'de naam draagt de rechtsvorm ' + r.wat + ', die alleen in dat land voorkomt');
    }
  }
  return { land: null, landcode: null, eu: null, zeker: false, reden: 'geen adres of rechtsvorm in de naam op het rapport' };
}

// Alles bij elkaar. Het briefhoofd gaat VOOR het domein: het staat op het
// document dat het lab zelf uitgaf, terwijl een domein overal gekocht kan
// worden. Levert het briefhoofd niets, dan pas het domein.
function leidAf(opties) {
  const o = opties || {};
  const namen = [].concat(o.briefhoofden || []).filter(Boolean);
  for (const n of namen) {
    const uit = leidAfUitBriefhoofd(n);
    if (uit.land || uit.eu != null) return Object.assign(uit, { signaal: 'briefhoofd' });
  }
  const uitDomein = leidAfUitDomein(o.url);
  return Object.assign(uitDomein, { signaal: 'domein' });
}

// ---- wat de vestiging betekent voor het product ---------------------------
//
// BESLUIT RUBEN, 22 september 2026: de Deep Dive draait alleen op Nederlandse
// leveranciers, omdat de verdieping op het KvK-handelsregister leunt.
//
// LET OP: een .nl-domein bewijst geen Nederlandse inschrijving - dat domein is
// aan iedereen te koop - en een Nederlands bedrijf op .com zou er dan buiten
// vallen. De echte voorwaarde is dus niet "is dit .nl" maar "is er een
// KvK-nummer". Het land is het signaal dat die route kansrijk is; het nummer
// is het bewijs. Daarom telt een bekend KvK-nummer altijd, ook zonder land.
function deepDive(s, kvkNummer) {
  const heeftKvk = !!String(kvkNummer || '').trim();
  if (heeftKvk) {
    return {
      mogelijk: true, grond: 'kvk',
      reden: 'er is een KvK-nummer bekend, dus het handelsregister is te raadplegen'
    };
  }
  if (s && s.landcode === 'nl') {
    return {
      mogelijk: true, grond: s.herkomst === 'vastgesteld' ? 'land-vastgesteld' : 'land-afgeleid',
      reden: s.herkomst === 'vastgesteld'
        ? 'vastgesteld als Nederlandse vestiging; het KvK-nummer wordt bij de verdieping opgezocht'
        : 'waarschijnlijk Nederlands (' + (s.reden || 'afgeleid') + '); het KvK-nummer wordt bij de verdieping opgezocht'
    };
  }
  if (s && s.eu === true) {
    return {
      mogelijk: false, grond: 'eu-niet-nl',
      reden: 'deze leverancier zit in de EU maar niet in Nederland; de verdieping in het handelsregister kunnen we voorlopig alleen voor Nederlandse bedrijven doen'
    };
  }
  if (s && s.eu === false) {
    return {
      mogelijk: false, grond: 'buiten-eu',
      reden: 'deze leverancier is buiten de EU gevestigd; er is geen handelsregister dat wij kunnen raadplegen'
    };
  }
  return {
    mogelijk: false, grond: 'land-onbekend',
    reden: 'we konden niet vaststellen waar deze leverancier gevestigd is, en zonder land is er geen register om in te kijken'
  };
}

// De vier toestanden voor het rapport, met de tekst die erbij hoort. Staan
// hier en niet in de frontend, zodat beide pagina's hetzelfde zeggen en een
// wijziging op een plek gebeurt.
const VESTIGING_TEKST = {
  nl: {
    kop: 'Nederlandse leverancier',
    tekst: 'Deze leverancier is in Nederland gevestigd. Dat betekent dat we het bedrijf achter de webshop kunnen natrekken in het handelsregister: wie de eigenaren zijn, sinds wanneer het bestaat en of het adres klopt.'
  },
  eu: {
    kop: 'EU-leverancier',
    tekst: 'Deze leverancier is in de EU gevestigd. Je hebt daardoor Europese consumentenrechten en een partij die aanspreekbaar is binnen de EU. De verdieping in het handelsregister kunnen we voorlopig alleen voor Nederlandse bedrijven doen.'
  },
  buiten: {
    kop: 'Buiten de EU',
    tekst: 'Deze leverancier is buiten de EU gevestigd. Dat is niet verboden en zegt niets over de kwaliteit van het product, maar het verandert wel je positie als koper: Europese consumentenrechten gelden hier niet, een geschil valt onder buitenlands recht, en er kunnen invoerrechten bijkomen.'
  },
  onbekend: {
    kop: 'Land onbekend',
    tekst: 'We konden niet vaststellen waar deze leverancier gevestigd is. Er staat geen adres op de site en het webadres zegt niets over een land. Dat is zelf een waarneming: een winkel die niet laat zien wie erachter zit, is moeilijker aan te spreken als er iets misgaat.'
  }
};

// Hoe hard staat dit? In gewone taal, want dit leest een bezoeker.
// Besluit Ruben 23 september: niet "afgeleid" maar "nog niet gecontroleerd",
// en de uitleg erbij hoort in de uitklap te staan - een tekst die alleen bij
// hover verschijnt, leest niemand op een telefoon.
const HERKOMST_LABEL = 'nog niet gecontroleerd';

const HERKOMST_UITLEG = {
  briefhoofd: 'Waar dit bedrijf zit, lezen we af van het adres op een labrapport van deze leverancier. Wij hebben dat niet nagetrokken bij een register.',
  domein: 'Waar dit bedrijf zit, leiden we af uit de landcode van het webadres. Zo\'n domein is aan iedereen te koop, ook aan een bedrijf in een ander land, dus zeker is het niet. Wij hebben het niet nagetrokken bij een register.',
  onbekend: 'Waar dit bedrijf zit, hebben we zelf afgeleid en niet nagetrokken bij een register.'
};

function tekstVoor(s) {
  const basis = kiesTekst(s);
  if (!s || s.herkomst !== 'afgeleid') return basis;
  return Object.assign({}, basis, {
    herkomstLabel: HERKOMST_LABEL,
    herkomstUitleg: HERKOMST_UITLEG[s.signaal] || HERKOMST_UITLEG.onbekend
  });
}

function kiesTekst(s) {
  if (!s || s.herkomst === 'onbekend') return Object.assign({ sleutel: 'onbekend' }, VESTIGING_TEKST.onbekend);
  if (s.landcode === 'nl') return Object.assign({ sleutel: 'nl' }, VESTIGING_TEKST.nl);
  if (s.eu === true) return Object.assign({ sleutel: 'eu' }, VESTIGING_TEKST.eu);
  if (s.eu === false) return Object.assign({ sleutel: 'buiten' }, VESTIGING_TEKST.buiten);
  return Object.assign({ sleutel: 'onbekend' }, VESTIGING_TEKST.onbekend);
}

module.exports = {
  EU_LANDEN, EER_EN_BUUR, OVERIG, MERKDOMEINEN, GENERIEK,
  hostVan, tldVan, leidAfUitDomein, leidAfUitBriefhoofd, leidAf,
  normaliseerLand, stand, etiket, deepDive, tekstVoor, VESTIGING_TEKST,
  HERKOMST_LABEL, HERKOMST_UITLEG
};
