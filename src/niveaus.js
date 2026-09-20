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
const KERNVELDEN = ['product', 'claimedQuantity', 'measuredQuantity'];

function leeszekerheid(r) {
  if (!r) return { niveau: 'L0', reden: 'geen record' };
  const mist = KERNVELDEN.filter((k) => r[k] == null || r[k] === '');
  if (mist.length) return { niveau: 'L0', reden: 'kernvelden ontbreken: ' + mist.join(', ') };

  // Zonder vergelijkbare eenheden is elk percentage onzin.
  const ce = String(r.claimedUnit || '').toLowerCase().trim();
  const me = String(r.measuredUnit || '').toLowerCase().trim();
  if (!ce || !me) return { niveau: 'L0', reden: 'eenheid ontbreekt aan een van beide kanten' };
  if (ce !== me) return { niveau: 'L0', reden: 'eenheden verschillen (' + ce + ' tegen ' + me + ')' };

  // L2 vraagt om onafhankelijke ANKERS elders in het document, niet om "twee
  // velden die elkaar bevestigen" - dat is vaak dezelfde regel twee keer
  // gelezen en bevestigt niets. Batchnummer, analysedatum en meetmethode komen
  // uit verschillende delen van het rapport. Staan die er, dan is het document
  // als geheel uitgelezen en niet half geraden.
  const ankers = [r.batchnummer, r.analysisDate || r.reportDate, r.purityMethod || r.identiteitsmethode]
    .filter((x) => x != null && String(x).trim() !== '').length;
  if (ankers >= 2) return { niveau: 'L2', ankers, reden: ankers + ' onafhankelijke ankers in het document' };
  return { niveau: 'L1', ankers, reden: 'kernvelden gelezen, weinig houvast in de rest van het document' };
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
function beoordeelRecord(r, controle, labVoldoendeVerifieerbaar) {
  const L = leeszekerheid(r);
  const V = verificatiegraad(r, controle);
  const m = magGetoondWorden(L.niveau, V.niveau, labVoldoendeVerifieerbaar);
  return {
    leeszekerheid: L, verificatie: V, uitkomst: m,
    toelichting: m.tonen === TONEN.GERAPPORTEERD ? GERAPPORTEERD_TOELICHTING : null
  };
}

module.exports = {
  leeszekerheid, verificatiegraad, magGetoondWorden, beoordeelRecord,
  TONEN, GERAPPORTEERD_TOELICHTING, KERNVELDEN
};
