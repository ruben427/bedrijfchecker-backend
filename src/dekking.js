// ---------------------------------------------------------------------------
// Testdekking per batch. Besluiten A13, A17, A19, A20 en A23 van Annemarie,
// 21 september 2026.
//
// Alles hier is deterministisch: tellen en groeperen, geen model, geen kleur.
// Dat is met opzet. Dit bestand beantwoordt de vraag "wat is er aantoonbaar
// getest voor welke batch", en die vraag is te tellen. Hoe zwaar dat weegt is
// een andere vraag en staat elders.
// ---------------------------------------------------------------------------

function tekst(v) {
  return v == null ? '' : String(v).trim();
}
function heeftIets(v) {
  return tekst(v) !== '';
}

// --- A17: uitgevoerd is niet hetzelfde als geslaagd ------------------------
//
// "Registreren als uitgevoerd, nooit automatisch pass. Onderscheid tussen
// testdekking en testresultaat. Gebruikersweergave: getest, geen norm
// beschikbaar."
//
// Waarom dit een besluit nodig had: een rapport dat endotoxinen meet en
// "0.05 EU/mg" vermeldt zegt niet of dat goed is. Zonder norm is er geen
// uitspraak te doen, alleen een meting. Wij telden zo een regel tot nu toe
// als een uitgevoerde test die verder geen vragen opriep, en daarmee sloop er
// een geslaagd-oordeel in dat niemand had gegeven.
//
// Twee vragen dus, en ze worden apart bewaard:
//   DEKKING    - is deze test uitgevoerd voor deze batch?
//   RESULTAAT  - is er een norm om de uitkomst tegen af te zetten?
const TESTSTAND = {
  NIET_GETEST: 'niet getest',
  ZONDER_NORM: 'getest, geen norm beschikbaar',
  MET_NORM: 'getest, norm vermeld'
};

// Een norm hoeft niet in een eigen veld te staan. Labs schrijven hem vaak in
// de resultaatregel: "< 0.5 EU/mg (limit 1.0)", "Pass, spec <= 10 ppm".
const NORM_IN_TEKST = /\b(limit|limiet|norm|spec(ification)?|max(imum)?|nmt|not more than|usp|ph\.?\s*eur)\b|[<≤]\s*\d|\d\s*-\s*\d\s*(ppm|ppb|eu\/)/i;

function normUit(velden) {
  for (const v of velden) {
    if (heeftIets(v) && NORM_IN_TEKST.test(tekst(v))) return tekst(v);
  }
  return null;
}

// Een test, drie standen. Nooit 'geslaagd'.
function testStand(getest, normbron) {
  if (!getest) return { getest: false, stand: TESTSTAND.NIET_GETEST, norm: null };
  const norm = normUit(normbron || []);
  return {
    getest: true,
    stand: norm ? TESTSTAND.MET_NORM : TESTSTAND.ZONDER_NORM,
    norm: norm
  };
}

// --- A19: zware metalen als eigen categorie --------------------------------
//
// "Achttien in plaats van zeventien. Binnen de categorie vastleggen wat er
// getest is: een volledig paneel is iets anders dan een losse metaalmeting.
// C09 blijft over voor contaminanten zonder eigen categorie."
//
// Wat 'volledig paneel' betekent moest ergens vastgelegd worden, anders is de
// term niet te tellen. Aangehouden: de vier elementaire verontreinigingen die
// in USP <232> en ICH Q3D als klasse 1 gelden - lood, cadmium, kwik, arseen.
// Staan die er alle vier, dan is het een paneel; staan er minder, dan is het
// een losse meting en zeggen wij dat ook zo.
const PANEELMETALEN = [
  ['lood', /\blood\b|\blead\b|\bpb\b/i],
  ['cadmium', /\bcadmium\b|\bcd\b/i],
  ['kwik', /\bkwik\b|\bmercury\b|\bhg\b/i],
  ['arseen', /\barse(e)?n\b|\barsenic\b|\bas\b/i]
];

function zwareMetalenUit(r) {
  const zm = (r && r.zwareMetalen) || null;
  const rijen = (zm && Array.isArray(zm.resultaten)) ? zm.resultaten.filter(Boolean) : [];
  const getest = !!(zm && (zm.tested === true || rijen.length));
  if (!getest) return { getest: false, stand: TESTSTAND.NIET_GETEST, norm: null, metalen: [], paneel: null, gedekt: [] };

  const namen = rijen.map((x) => tekst(x.metaal)).filter(Boolean);
  const gedekt = PANEELMETALEN.filter((p) => namen.some((n) => p[1].test(n))).map((p) => p[0]);
  const stand = testStand(true, rijen.map((x) => tekst(x.norm) + ' ' + tekst(x.resultaat)));
  return Object.assign(stand, {
    metalen: namen,
    // null als er wel 'tested' staat maar geen enkele regel: dan weten we niet
    // wat er gemeten is en is 'losse meting' net zo goed geraden als 'paneel'.
    paneel: rijen.length ? (gedekt.length === PANEELMETALEN.length) : null,
    gedekt
  });
}

// --- de drie bewijscomponenten per batch (A20) -----------------------------
//
// "Drie bewijscomponenten per batch: purity/identity + quantity, heavy metals,
// endotoxins. Of die op een of drie certificaten staan maakt niet uit.
// Dezelfde testsoort levert ook geen extra punten door meerdere documenten."
//
// Dat laatste is de kern en het was echt een gat: een leverancier die per
// batch drie losse certificaten publiceert kwam er beter uit dan een die
// dezelfde drie tests in een rapport zet. Wij telden documenten.
const COMPONENTEN = ['analyse', 'zwareMetalen', 'endotoxinen'];
const COMPONENT_WOORD = {
  analyse: 'zuiverheid, identiteit en hoeveelheid',
  zwareMetalen: 'zware metalen',
  endotoxinen: 'endotoxinen'
};

// Waar hoort dit rapport bij? Het batchnummer, en anders niets. Raden is hier
// erger dan niet groeperen: een fout batchnummer voegt rapporten samen die
// niets met elkaar te maken hebben. Rapporten zonder batchnummer komen in een
// eigen bak en worden apart gemeld.
function batchSleutel(r) {
  const b = tekst(r && r.batchnummer).toLowerCase();
  return b || null;
}

// A13: welk DOCUMENT is dit? Twee rapporten met dezelfde inhoud zijn een
// analyse, niet twee. Sha256 is het hardste antwoord; daarna de bron-URL en
// als laatste de labreferentie.
function documentSleutel(r) {
  if (!r) return null;
  return tekst(r.sha256).toLowerCase() || tekst(r.bronUrl).toLowerCase() ||
    (tekst(r.laboratorium) + '|' + (tekst(r.reportId) || tekst(r.verificationKey))).toLowerCase() || null;
}

// Telt het bewijs van dit rapport mee? Een rapport dat op een lab rust dat
// niet als onafhankelijk geverifieerd geldt, is bij Annemarie geen
// geaccepteerd labbewijs: "volledig getest betekent straks: alle door ons
// vereiste testcategorieen voor die batch zijn aantoonbaar afgedekt door
// GEACCEPTEERD labbewijs."
function geaccepteerd(r) {
  return !!r && r.bewijskracht !== 'onbevestigd';
}

function componentenVan(r, heeftIdentiteitsbepaling) {
  const uit = {};
  const zm = zwareMetalenUit(r);
  const endo = testStand(!!(r.endotoxin && r.endotoxin.tested),
    [r.endotoxin && r.endotoxin.norm, r.endotoxin && r.endotoxin.result]);

  // De analysecomponent is gedekt zodra een van de drie analytische uitspraken
  // in dit rapport staat. Welke van de drie het precies zijn staat eronder, en
  // wordt per batch samengevoegd - dat is het hele punt van A20.
  const analyse = {
    zuiverheid: r.purityPercent != null,
    identiteit: !!(heeftIdentiteitsbepaling && heeftIdentiteitsbepaling(r)),
    hoeveelheid: !!(r.quantity && r.quantity.deviationPct != null)
  };
  uit.analyse = Object.assign({ getest: analyse.zuiverheid || analyse.identiteit || analyse.hoeveelheid }, analyse);
  uit.zwareMetalen = zm;
  uit.endotoxinen = endo;
  // Buiten de drie componenten, wel geteld: steriliteit en de restbak.
  uit.steriliteit = testStand(!!(r.sterility && r.sterility.tested),
    [r.sterility && r.sterility.norm, r.sterility && r.sterility.result]);
  const overig = Array.isArray(r.overigeContaminanten) ? r.overigeContaminanten.filter(Boolean) : [];
  uit.overige = Object.assign(
    testStand(overig.length > 0, overig.map((x) => tekst(x.norm) + ' ' + tekst(x.resultaat))),
    { parameters: overig.map((x) => tekst(x.parameter)).filter(Boolean) }
  );
  return uit;
}

// Alles bij elkaar: per batch welke componenten gedekt zijn, door hoeveel
// UNIEKE documenten, en of er gedeeld labbewijs onder zit.
function dekkingPerBatch(recordsIn, opties) {
  const o = opties || {};
  const records = (recordsIn || []).filter(Boolean);
  const heeftId = o.heeftIdentiteitsbepaling || null;

  const batches = new Map();
  let zonderBatch = 0;
  const gezieneDocs = new Set();
  let dubbeleDocumenten = 0;

  records.forEach((r) => {
    const sleutel = batchSleutel(r);
    if (!sleutel) zonderBatch++;
    const id = sleutel || ('(zonder batchnummer) ' + (documentSleutel(r) || Math.random()));
    if (!batches.has(id)) {
      batches.set(id, {
        batch: sleutel, batchBekend: !!sleutel,
        product: tekst(r.product) || null,
        documenten: new Set(), componenten: {}, standen: {},
        gedeeldMet: new Set(), geaccepteerdeDocumenten: 0
      });
    }
    const b = batches.get(id);
    const doc = documentSleutel(r);
    // A13: hetzelfde document twee keer in de lijst is een analyse, niet twee.
    if (doc) {
      if (gezieneDocs.has(doc)) dubbeleDocumenten++;
      gezieneDocs.add(doc);
      b.documenten.add(doc);
    }
    (r.gedeeldMet || []).forEach((k) => b.gedeeldMet.add(k));

    const ok = geaccepteerd(r);
    if (ok) b.geaccepteerdeDocumenten++;
    const comp = componentenVan(r, heeftId);
    Object.keys(comp).forEach((k) => {
      const c = comp[k];
      if (!c.getest) return;
      // Alleen geaccepteerd labbewijs dekt een component af. Een gelezen test
      // op een onbevestigd rapport blijft wel zichtbaar als uitgevoerd.
      if (!b.componenten[k]) b.componenten[k] = { gedekt: false, gezien: false, standen: new Set(), details: [] };
      const vak = b.componenten[k];
      vak.gezien = true;
      if (ok) vak.gedekt = true;
      if (c.stand) vak.standen.add(c.stand);
      if (k === 'zwareMetalen') vak.details.push({ paneel: c.paneel, metalen: c.metalen, gedekt: c.gedekt });
      if (k === 'analyse') vak.details.push({ zuiverheid: c.zuiverheid, identiteit: c.identiteit, hoeveelheid: c.hoeveelheid });
    });
  });

  const lijst = [];
  batches.forEach((b) => {
    const comp = {};
    Object.keys(b.componenten).forEach((k) => {
      const vak = b.componenten[k];
      comp[k] = {
        gedekt: vak.gedekt, gezien: vak.gezien,
        standen: Array.from(vak.standen),
        // A17 naar buiten: is er voor deze component ergens een norm gelezen?
        zonderNorm: vak.standen.size > 0 && !vak.standen.has(TESTSTAND.MET_NORM),
        details: vak.details
      };
    });
    // A20: volledig getest = alle drie de componenten gedekt door geaccepteerd
    // labbewijs. Niet: veel certificaten.
    const ontbreekt = COMPONENTEN.filter((k) => !(comp[k] && comp[k].gedekt));
    lijst.push({
      batch: b.batch, batchBekend: b.batchBekend, product: b.product,
      documenten: b.documenten.size,
      geaccepteerdeDocumenten: b.geaccepteerdeDocumenten,
      componenten: comp,
      volledigGetest: ontbreekt.length === 0,
      ontbrekendeComponenten: ontbreekt,
      gedeeldMet: Array.from(b.gedeeldMet).sort()
    });
  });
  lijst.sort((a, b) => (a.batch || '').localeCompare(b.batch || ''));

  const volledig = lijst.filter((b) => b.volledigGetest).length;
  return {
    batches: lijst,
    aantalBatches: lijst.length,
    batchesMetNummer: lijst.filter((b) => b.batchBekend).length,
    rapportenZonderBatchnummer: zonderBatch,
    volledigGetest: volledig,
    dubbeleDocumenten,
    componenten: COMPONENTEN,
    // Per component: bij hoeveel batches is hij gedekt?
    perComponent: COMPONENTEN.reduce((acc, k) => {
      acc[k] = lijst.filter((b) => b.componenten[k] && b.componenten[k].gedekt).length;
      return acc;
    }, {}),
    werkregel: lijst.length
      ? volledig + ' van de ' + lijst.length + ' batches is op alle drie de bewijscomponenten afgedekt'
      : 'geen batches te onderscheiden in de gevonden rapporten'
  };
}

// --- A23: testpatroon over tijd --------------------------------------------
//
// "Voor 'wie heeft deze test besteld' is zendingsgrootte te indirect om
// zelfstandig iets te concluderen. Voor batchtraceerbaarheid en structureel
// testgedrag juist wel relevant: regelmaat over tijd, aantal batches, welke
// testcategorieen terugkomen, of analyses structureel samen worden
// uitgevoerd."
//
// En haar reden: "Daarmee belonen we niet simpelweg een leverancier die veel
// COA's online heeft staan, maar een leverancier waarbij uit de data
// daadwerkelijk een consistent en traceerbaar testpatroon blijkt."
//
// LET OP - dit is ONDERSTEUNEND. Geen eigen gebruikersscore ("hoeft voor de
// eerste versie nog geen aparte gebruikersscore te zijn"), en uitdrukkelijk
// nooit een argument over wie de test heeft besteld. Die grens staat hier
// omdat hij anders bij de eerste gelegenheid wordt overschreden.
function testpatroon(recordsIn, dekking) {
  const records = (recordsIn || []).filter(Boolean);
  const maanden = new Map();
  records.forEach((r) => {
    const d = tekst(r.analysisDate) || tekst(r.reportDate);
    const m = d.match(/(\d{4})[-/.](\d{1,2})/);
    if (!m) return;
    const sleutel = m[1] + '-' + String(m[2]).padStart(2, '0');
    maanden.set(sleutel, (maanden.get(sleutel) || 0) + 1);
  });
  const reeks = Array.from(maanden.keys()).sort();
  const d = dekking || { batches: [], aantalBatches: 0 };
  const meerdereComponenten = (d.batches || []).filter((b) =>
    Object.keys(b.componenten || {}).filter((k) => b.componenten[k].gedekt).length > 1).length;

  return {
    geldt: 'ondersteunend',
    gebruikVoor: ['batchtraceerbaarheid', 'structureel testgedrag'],
    nooitVoor: ['wie de test heeft besteld'],
    maandenMetRapporten: reeks.length,
    eersteMaand: reeks[0] || null,
    laatsteMaand: reeks[reeks.length - 1] || null,
    perMaand: Object.fromEntries(reeks.map((k) => [k, maanden.get(k)])),
    aantalBatches: d.aantalBatches || 0,
    batchesMetMeerdereComponenten: meerdereComponenten,
    // Samen uitgevoerd of los: een leverancier die per batch structureel
    // dezelfde combinatie laat doen, laat iets anders zien dan een die af en
    // toe een los rapport publiceert.
    structureelSamen: (d.aantalBatches || 0) > 0 &&
      meerdereComponenten * 2 > (d.aantalBatches || 0),
    werkregel: reeks.length
      ? 'rapporten verspreid over ' + reeks.length + ' maand(en), van ' + reeks[0] + ' tot ' + reeks[reeks.length - 1]
      : 'geen datums gelezen waarmee een patroon over tijd te zien is'
  };
}

// --- A13: gedeeld labbewijs ------------------------------------------------
//
// "Wanneer twee shops exact hetzelfde Janoshik-rapport publiceren, hebben we
// feitelijk maar een laboratoriumanalyse, niet twee onafhankelijke bewijzen."
//
// Tonen mag, concluderen niet: "geen conclusie over de leverancier zolang we
// niet kunnen aantonen waarom het gedeeld wordt, maar wel een signaal voor
// nader onderzoek."
function gedeeldBeeld(recordsIn, eigenSleutel) {
  const records = (recordsIn || []).filter(Boolean);
  const gedeeld = records.filter((r) => (r.gedeeldMet || []).some((k) => k && k !== eigenSleutel));
  const anderen = new Set();
  gedeeld.forEach((r) => (r.gedeeldMet || []).forEach((k) => { if (k && k !== eigenSleutel) anderen.add(k); }));
  if (!gedeeld.length) {
    return { aantal: 0, leveranciers: [], zin: null, signaalVoorOnderzoek: false };
  }
  return {
    aantal: gedeeld.length,
    leveranciers: Array.from(anderen).sort(),
    // De zin die Annemarie zelf voorschreef, letterlijk.
    zin: gedeeld.length === 1
      ? 'Dit labrapport wordt ook door een andere leverancier gebruikt.'
      : gedeeld.length + ' van deze labrapporten worden ook door een andere leverancier gebruikt.',
    toelichting: 'Hetzelfde rapport bij twee leveranciers is een laboratoriumanalyse, geen twee ' +
      'onafhankelijke bewijzen. Waarom het gedeeld wordt, hebben wij niet vastgesteld.',
    signaalVoorOnderzoek: true
  };
}

// Welke COA-categorieen rusten uitsluitend op tests zonder norm? Dat is de
// invoer voor de A17-rem in de scoring engine: een categorie waarvan wij geen
// enkele norm hebben gelezen kan niet groen worden, want dan zouden wij een
// geslaagd-oordeel geven dat nergens staat.
//
// C07 steriliteit, C08 endotoxinen, C09 overige contaminanten, C10 zware
// metalen (die laatste is nieuw, besluit A19).
const CATEGORIE_VAN_TEST = { steriliteit: 'C07', endotoxinen: 'C08', overige: 'C09', zwareMetalen: 'C10' };

function normbeeldPerCategorie(recordsIn, opties) {
  const records = (recordsIn || []).filter(Boolean);
  const uit = {};
  Object.keys(CATEGORIE_VAN_TEST).forEach((k) => {
    uit[CATEGORIE_VAN_TEST[k]] = { getest: false, metNorm: 0, zonderNorm: 0 };
  });
  records.forEach((r) => {
    const comp = componentenVan(r, (opties || {}).heeftIdentiteitsbepaling || null);
    Object.keys(CATEGORIE_VAN_TEST).forEach((k) => {
      const c = comp[k];
      if (!c || !c.getest) return;
      const vak = uit[CATEGORIE_VAN_TEST[k]];
      vak.getest = true;
      if (c.stand === TESTSTAND.MET_NORM) vak.metNorm++; else vak.zonderNorm++;
    });
  });
  Object.keys(uit).forEach((id) => {
    const v = uit[id];
    v.uitsluitendZonderNorm = v.getest && v.metNorm === 0;
    v.stand = !v.getest ? TESTSTAND.NIET_GETEST
      : (v.metNorm ? TESTSTAND.MET_NORM : TESTSTAND.ZONDER_NORM);
  });
  return uit;
}

module.exports = {
  TESTSTAND, COMPONENTEN, COMPONENT_WOORD, PANEELMETALEN,
  testStand, zwareMetalenUit, componentenVan, batchSleutel, documentSleutel,
  dekkingPerBatch, testpatroon, gedeeldBeeld,
  normbeeldPerCategorie, CATEGORIE_VAN_TEST
};
