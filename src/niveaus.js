// ---------------------------------------------------------------------------
// Twee assen, apart gehouden. Vastgesteld door Annemarie en Ruben op
// 20 september 2026, op het voorstel "verificatieniveaus en wat de FREE
// automatisch mag tonen".
//
//   LEESZEKERHEID  - heeft het systeem dit document betrouwbaar uitgelezen?
//   VERIFICATIE    - is wat erin staat onafhankelijk bevestigd?
//
// Ruben: "heeft het systeem het document betrouwbaar uitgelezen?" en "is de
// informatie in het document onafhankelijk geverifieerd?" zijn voor mij twee
// verschillende dingen. Ze lopen ook niet parallel: een perfect gelezen
// document van een onbekend lab is goed gelezen en niet geverifieerd; een
// matige scan waarvan een mens de sleutel natrok is slecht gelezen en wel
// geverifieerd. Op een as samengeperst gaat er altijd een van de twee
// verloren - dezelfde fout als bij A15, waar authenticiteit en koppeling in
// een letter werden geduwd.
// ---------------------------------------------------------------------------

// --- as 1: leeszekerheid ---------------------------------------------------
//
// LET OP - dit is uitgebreid bij het aanhangen aan de pijplijn, 21 september.
// Het besluit van 20 september sprak over "heeft het systeem dit DOCUMENT
// betrouwbaar uitgelezen". De eerste uitwerking mat dat aan drie velden:
// product, geclaimde hoeveelheid en gemeten hoeveelheid. Dat zijn de velden
// van de VULLING. Een rapport dat alleen zuiverheid meet - en dat zijn de
// meeste - heeft geen geclaimde hoeveelheid en kwam daardoor op L0, waarmee
// ook de zuiverheid zou verstommen. Een goed gelezen zuiverheidsrapport
// wegzetten als "niet betrouwbaar uitgelezen" is niet wat er is besloten.
//
// Daarom is leeszekerheid nu per UITSPRAAK, niet per document. Elke uitspraak
// heeft zijn eigen kernvelden; de ankers zijn gedeeld, want die gaan wel over
// het document als geheel.
//
// Dit is een invulling van een plek waar het besluit niet reikte, geen
// wijziging ervan. Hij hoort langs Annemarie (A24).
const KERNVELDEN = ['product', 'claimedQuantity', 'measuredQuantity'];

const ONDERDELEN = ['vulling', 'zuiverheid', 'identiteit'];

// Is de identiteit van de stof echt bepaald, of staat er alleen een naam?
//
// Deze test stond in pipeline.js en wordt nu van hieruit gebruikt, zodat er
// niet twee definities naast elkaar leven: eentje die bepaalt of de Evidence
// Gate het veld telt, en eentje die bepaalt of wij er iets over zeggen. Dat
// lopen twee antwoorden uiteen die dezelfde vraag beantwoorden, en dan is
// achteraf niet te zeggen welke gold.
//
// Streng met opzet. "HPLC" bewijst zuiverheid, geen identiteit. Een
// massaspectrum, een moleculair gewicht of een aminozuuranalyse wel.
function heeftIdentiteitsbepaling(r) {
  if (!r) return false;
  if (r.identiteitBevestigd === true) return true;
  if (r.blindTest === true && r.product) return true;
  const m = r.identiteitsmethode ? String(r.identiteitsmethode).toLowerCase() : '';
  if (!m) return false;
  return /(^|[^a-z])ms([^a-z]|$)|mass spec|massaspec|lc-?ms|ms\/ms|moleculair|molecular weight|aminozuur|amino acid|referentiestandaard|reference standard/.test(m);
}

function heeftIets(v) {
  return v != null && String(v).trim() !== '';
}

// De ankers gaan over het document, niet over een enkele uitspraak: komen
// batchnummer, analysedatum en meetmethode uit verschillende delen van het
// rapport terug, dan is het document als geheel uitgelezen en niet half
// geraden. Bewust geen "twee velden die elkaar bevestigen" - dat is vaak
// dezelfde regel twee keer gelezen en bevestigt niets.
function ankersVan(r) {
  return [r.batchnummer, r.analysisDate || r.reportDate, r.purityMethod || r.identiteitsmethode]
    .filter(heeftIets).length;
}

function metAnkers(r, reden) {
  const ankers = ankersVan(r);
  if (ankers >= 2) return { niveau: 'L2', ankers, reden: ankers + ' onafhankelijke ankers in het document' };
  return { niveau: 'L1', ankers, reden: reden };
}

// Leeszekerheid voor een van de drie uitspraken. Onbekend onderdeel valt
// bewust terug op L0: liever zwijgen dan een uitspraak doen waarvan hier geen
// kernvelden zijn vastgelegd.
function leeszekerheidVoor(r, onderdeel) {
  if (!r) return { niveau: 'L0', reden: 'geen record' };

  if (onderdeel === 'vulling') {
    const mist = KERNVELDEN.filter((k) => r[k] == null || r[k] === '');
    if (mist.length) return { niveau: 'L0', reden: 'kernvelden voor vulling ontbreken: ' + mist.join(', ') };
    // Zonder vergelijkbare eenheden is elk percentage onzin.
    const ce = String(r.claimedUnit || '').toLowerCase().trim();
    const me = String(r.measuredUnit || '').toLowerCase().trim();
    if (!ce || !me) return { niveau: 'L0', reden: 'eenheid ontbreekt aan een van beide kanten' };
    if (ce !== me) return { niveau: 'L0', reden: 'eenheden verschillen (' + ce + ' tegen ' + me + ')' };
    return metAnkers(r, 'hoeveelheden gelezen, weinig houvast in de rest van het document');
  }

  if (onderdeel === 'zuiverheid') {
    if (!heeftIets(r.product)) return { niveau: 'L0', reden: 'geen productnaam bij de zuiverheidswaarde' };
    if (typeof r.purityPercent !== 'number') return { niveau: 'L0', reden: 'geen zuiverheidspercentage gelezen' };
    return metAnkers(r, 'zuiverheid gelezen, weinig houvast in de rest van het document');
  }

  if (onderdeel === 'identiteit') {
    if (!heeftIets(r.product)) return { niveau: 'L0', reden: 'geen productnaam bij de identiteitsbepaling' };
    if (!heeftIdentiteitsbepaling(r)) return { niveau: 'L0', reden: 'geen identiteitsbepaling in het document' };
    return metAnkers(r, 'identiteitsbepaling gelezen, weinig houvast in de rest van het document');
  }

  return { niveau: 'L0', reden: 'onbekend onderdeel: ' + onderdeel };
}

// De oude ingang blijft bestaan en betekent nog steeds wat hij betekende:
// de leeszekerheid van de VULLING.
function leeszekerheid(r) {
  return leeszekerheidVoor(r, 'vulling');
}

// --- as 2: verificatiegraad ------------------------------------------------
//
// V1 is bewust laag. Een sleutel op een document is een belofte van de
// aanbieder, geen bevestiging. Ruben: een verificatiesleutel die rechtstreeks
// bij het lab klopt weegt veel zwaarder dan twee velden die elkaar binnen
// hetzelfde document bevestigen. Het verschil tussen V1 en V2 is precies dat.
function verificatiegraad(r, controle) {
  const c = controle || null;
  if (c && c.methode === 'handmatig') return { niveau: 'V4', reden: 'door een mens bij het lab gecontroleerd' };
  if (c && c.resolvet === true && Number(c.veldenVergeleken) > 0 && Number(c.veldenAfwijkend) === 0) {
    return { niveau: 'V3', reden: 'referentie lost op en de velden komen overeen met de kopie van de shop' };
  }
  if (c && c.resolvet === true) return { niveau: 'V2', reden: 'referentie lost op bij het lab' };
  if (r && (r.verificationKey || r.reportId) && r.verificatieDomein) {
    return { niveau: 'V1', reden: 'het document noemt een verificatieadres en een sleutel, niet nagetrokken' };
  }
  if (r && (r.verificationKey || r.reportId)) {
    return { niveau: 'V1', reden: 'het document noemt een sleutel, niet nagetrokken' };
  }
  return { niveau: 'V0', reden: 'geen verwijzing om mee te controleren' };
}

// --- wat mag hiermee naar buiten -------------------------------------------
//
// GERAPPORTEERD is geen halfbakken feit maar een andere uitspraak. "De
// aanbieder rapporteert 99,8%" is waar zodra we het document goed hebben
// gelezen. "De zuiverheid is 99,8%" vraagt verificatie.
//
// Annemarie, bij het besluit: "'Gerapporteerd' mag wat mij betreft in de FREE,
// zolang voor de gebruiker heel duidelijk is dat dit een waarde uit het
// document is en niet hetzelfde is als onafhankelijk geverifieerd bewijs. Ik
// vind dat juist sterker dan de informatie helemaal niet tonen."
//
// LET OP - haar correctie op mijn eerste opzet, en hij is wezenlijk. Ik
// schreef dat "gerapporteerd" de standaardstand is voor een COA van een ERKEND
// lab. Fout. Haar woorden: "bij punt 3 liever niet spreken over een 'erkend
// lab'. Of een lab voldoende onafhankelijk te verifieren is, is weer een
// aparte beoordeling. De reported/verified-regel moet daar los van blijven."
//
// Dus de regel is:
//   goed genoeg gelezen          -> mag als GERAPPORTEERD worden getoond
//   onafhankelijk bevestigd      -> mag als GEVERIFIEERD worden getoond
//   lab onvoldoende verifieerbaar-> die waarde kan nooit VIA DAT LAB
//                                   promoveren naar geverifieerd
//
// Het labooordeel blokkeert dus alleen de promotie. Het raakt "gerapporteerd"
// niet, want dat gaat over ons lezen van het document en niet over het lab.
const TONEN = { NIETS: 'niets', GERAPPORTEERD: 'gerapporteerd', GEVERIFIEERD: 'geverifieerd' };

function magGetoondWorden(L, V, labVoldoendeVerifieerbaar) {
  // L0 zwijgt altijd. Een document dat we niet betrouwbaar hebben uitgelezen
  // levert geen uitspraak, ook niet als de sleutel klopt.
  if (L === 'L0') return { tonen: TONEN.NIETS, reden: 'document niet betrouwbaar uitgelezen' };

  // Zou deze waarde op eigen kracht geverifieerd zijn?
  const zouGeverifieerd = (V === 'V4' || V === 'V3' || (V === 'V2' && L === 'L2'));

  if (zouGeverifieerd) {
    // De enige plek waar het labooordeel iets doet: het houdt de promotie
    // tegen. false is een vastgesteld oordeel dat het lab niet deugt; null is
    // "nog niet beoordeeld" en blokkeert niets - anders zou elk onbeoordeeld
    // lab stilletjes als afkeuring werken.
    if (labVoldoendeVerifieerbaar === false) {
      return {
        tonen: TONEN.GERAPPORTEERD,
        geblokkeerdeUpgrade: true,
        reden: 'het laboratorium is onvoldoende verifieerbaar; een waarde kan niet via dat lab ' +
          'promoveren naar onafhankelijk geverifieerd bewijs'
      };
    }
    return { tonen: TONEN.GEVERIFIEERD, reden: 'onafhankelijk bevestigd' };
  }

  // Alles wat leesbaar is maar niet bevestigd. Geen labvoorwaarde: dit gaat
  // over ons lezen van het document, niet over het lab.
  return {
    tonen: TONEN.GERAPPORTEERD,
    reden: V === 'V2'
      ? 'referentie lost op, maar het document is mager gelezen'
      : 'niet onafhankelijk nagetrokken'
  };
}

// De zin die bij "gerapporteerd" hoort. Annemarie's voorwaarde was dat voor de
// gebruiker heel duidelijk is dat dit een waarde uit het document is. De tekst
// stond al in de frontend (UI_STATES.sourceClaimDetail) en werd nergens
// gebruikt; hier is hij, zodat frontend en backend hem niet los formuleren.
const GERAPPORTEERD_TOELICHTING =
  'Dit is een waarde zoals die in het document van de aanbieder staat. ' +
  'Wij hebben hem niet onafhankelijk bevestigd; het is geen zelfstandig geverifieerd productbewijs.';

// Alles in een keer, voor een record met zijn eventuele controle.
//
// De verificatiegraad geldt voor het hele rapport - of de referentie oplost
// bij het lab zegt niets over welk veld je leest. De leeszekerheid verschilt
// wel per uitspraak. Daarom een V en drie L'en.
function beoordeelRecord(r, controle, labVoldoendeVerifieerbaar) {
  const V = verificatiegraad(r, controle);
  const perOnderdeel = {};
  ONDERDELEN.forEach((onderdeel) => {
    const L = leeszekerheidVoor(r, onderdeel);
    const m = magGetoondWorden(L.niveau, V.niveau, labVoldoendeVerifieerbaar);
    perOnderdeel[onderdeel] = {
      leeszekerheid: L, uitkomst: m,
      toelichting: m.tonen === TONEN.GERAPPORTEERD ? GERAPPORTEERD_TOELICHTING : null
    };
  });
  const vulling = perOnderdeel.vulling;
  return {
    verificatie: V,
    perOnderdeel,
    // Wat er over dit rapport te zeggen valt: de hoogste stand van de drie.
    // Een rapport waarvan de zuiverheid geverifieerd is en de vulling zwijgt,
    // is geen zwijgend rapport.
    hoogste: ONDERDELEN
      .map((o) => perOnderdeel[o].uitkomst.tonen)
      .reduce((beste, t) => (RANG[t] > RANG[beste] ? t : beste), TONEN.NIETS),
    // De oude velden blijven staan en gaan nog steeds over de vulling, zodat
    // bestaande aanroepers niet stilletjes iets anders gaan betekenen.
    leeszekerheid: vulling.leeszekerheid,
    uitkomst: vulling.uitkomst,
    toelichting: vulling.toelichting
  };
}

const RANG = { [TONEN.NIETS]: 0, [TONEN.GERAPPORTEERD]: 1, [TONEN.GEVERIFIEERD]: 2 };

module.exports = {
  leeszekerheid, leeszekerheidVoor, verificatiegraad, magGetoondWorden, beoordeelRecord,
  heeftIdentiteitsbepaling,
  TONEN, RANG, GERAPPORTEERD_TOELICHTING, KERNVELDEN, ONDERDELEN
};
