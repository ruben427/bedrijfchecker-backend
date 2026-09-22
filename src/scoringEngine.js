// ---------------------------------------------------------------------------
// Centrale scoring engine (Supplier Evidence Scoring & Result Logic v1.0).
// 1-op-1 geport uit bedrijfchecker.html (de Claude Artifact-versie) — puur
// deterministische JS, geen model-call. Welke KLEUR elke categorie krijgt
// komt uit een AI-beoordeling (de 'categorize'-stap in pipeline.js), maar al
// het rekenwerk hierna (afhankelijkheidsregel, cap, scores, coverage, gate)
// gebeurt hier en alleen hier.
// ---------------------------------------------------------------------------

const CATEGORY_DEFS = [
  { id: 'C01', pillar: 'COA', label: 'COA-authenticiteit' },
  { id: 'C02', pillar: 'COA', label: 'Identity' },
  { id: 'C03', pillar: 'COA', label: 'Purity' },
  { id: 'C04', pillar: 'COA', label: 'Quantity' },
  { id: 'C05', pillar: 'COA', label: 'Batchtraceerbaarheid' },
  { id: 'C06', pillar: 'COA', label: 'Sample→COA' },
  { id: 'C07', pillar: 'COA', label: 'Sterility' },
  { id: 'C08', pillar: 'COA', label: 'Endotoxin' },
  { id: 'C09', pillar: 'COA', label: 'Overige contaminantentests' },
  // A19 - BESLUIT ANNEMARIE, 21 SEPTEMBER. Zware metalen uit de verzamelbak
  // C09 gehaald en een eigen categorie gegeven: "achttien in plaats van
  // zeventien". Reden: een shop die lood, cadmium, kwik en arseen laat meten
  // was niet te onderscheiden van een shop die een willekeurige extra
  // parameter rapporteert. C09 houdt de contaminanten zonder eigen categorie.
  { id: 'C10', pillar: 'COA', label: 'Zware metalen' },
  { id: 'L01', pillar: 'LAB', label: 'Lab' },
  { id: 'B01', pillar: 'COMPANY', label: 'Juridische transparantie' },
  { id: 'B02', pillar: 'COMPANY', label: 'Eigenaren/bestuurders' },
  { id: 'B03', pillar: 'COMPANY', label: 'Bedrijfshistorie' },
  { id: 'B04', pillar: 'COMPANY', label: 'Domein/websitehistorie' },
  { id: 'B05', pillar: 'COMPANY', label: 'Regelgeving/toezicht' },
  { id: 'R01', pillar: 'REPUTATION', label: 'Reputatie' },
  { id: 'R02', pillar: 'REPUTATION', label: 'Affiliate/commerciële transparantie' }
];
const PILLARS = ['COA', 'LAB', 'COMPANY', 'REPUTATION'];

function categoryDef(id) {
  return CATEGORY_DEFS.find((c) => c.id === id) || null;
}
function pillarCategoryIds(pillar) {
  return CATEGORY_DEFS.filter((c) => c.pillar === pillar).map((c) => c.id);
}
function pillarStats(assessments, pillar) {
  let green = 0, orange = 0, red = 0, white = 0;
  const ids = pillarCategoryIds(pillar);
  ids.forEach((id) => {
    const a = assessments[id];
    const color = a && a.color;
    if (color === 'green') green++;
    else if (color === 'orange') orange++;
    else if (color === 'red') red++;
    else white++;
  });
  const assessable = green + orange + red;
  const achieved = 3 * green + 2 * orange;
  const maximum = 3 * assessable;
  const normal = maximum > 0 ? (100 * achieved) / maximum : null;
  const coverage = (100 * assessable) / ids.length;
  return { green, orange, red, white, total: ids.length, assessable, achieved, maximum, normal, coverage };
}

// ANALYTICAL DEPENDENCY RULE: C02/C03/C04 worden wit als hun enige
// analytische onderbouwing komt van onvoldoende onafhankelijk verifieerbare
// labs. Mutaties gebeuren op een kopie, niet op het origineel.
function applyDependencyRule(assessmentsIn) {
  const assessments = {};
  Object.keys(assessmentsIn).forEach((k) => { assessments[k] = Object.assign({}, assessmentsIn[k]); });
  ['C02', 'C03', 'C04'].forEach((id) => {
    const a = assessments[id];
    if (a && a.independentlyAssessable === false) {
      a.color = 'white';
      a.dependencyApplied = true;
    }
  });
  return assessments;
}

function coaCap(assessments) {
  const blocked = ['C02', 'C03', 'C04'].every((id) => {
    const a = assessments[id];
    return a && a.color === 'white' && a.dependencyApplied === true;
  });
  const coaStats = pillarStats(assessments, 'COA');
  const applicable = blocked;
  const applied = applicable && coaStats.normal != null;
  const final = applied ? Math.min(coaStats.normal, 33.33) : coaStats.normal;
  const reduced = applied && final < coaStats.normal;
  return {
    applicable, applied, reduced,
    normal: coaStats.normal, final,
    reason: applicable ? 'ONVOLDOENDE ONAFHANKELIJKE ANALYTISCHE BEWIJSBASIS' : null
  };
}

// Free Evidence Score: 60% COA (na cap) + 40% LAB, alleen gepubliceerd als de
// gate PASS/PARTIAL is, beide pijlers berekenbaar zijn, de gedeelde coverage
// (alle COA-categorieen + L01, noemer uit de lijst zelf) >=50% is, en adequacy.coa/lab beide true zijn.
function freeEvidenceScore(assessments, adequacy, gateStatus) {
  const coa = pillarStats(assessments, 'COA');
  const lab = pillarStats(assessments, 'LAB');
  const cap = coaCap(assessments);
  const candidate = (cap.final != null && lab.normal != null) ? (0.6 * cap.final + 0.4 * lab.normal) : null;
  // Noemer uit de lijst zelf. Stond als 10 ingetypt en klopte niet meer zodra
  // A19 een categorie toevoegde.
  const gedeeldeNoemer = pillarCategoryIds('COA').length + pillarCategoryIds('LAB').length;
  const coverage = (100 * (coa.assessable + lab.assessable)) / gedeeldeNoemer;
  const gateOk = gateStatus === 'PASS' || gateStatus === 'PARTIAL';
  const adequacyOk = !!(adequacy && adequacy.coa === true && adequacy.lab === true);
  const canPublish = gateOk && candidate != null && coverage >= 50 && adequacyOk;
  return {
    candidate, coverage, published: canPublish,
    value: canPublish ? Math.round(candidate * 100) / 100 : null,
    cap, coaStats: coa, labStats: lab,
    reason: canPublish ? null : (!gateOk ? 'Evidence Gate is niet PASS/PARTIAL' : candidate == null ? 'COA- of labpijler niet berekenbaar' : coverage < 50 ? 'Coverage onder 50%' : 'Onvoldoende onderbouwde adequacy (COA/lab)')
  };
}

// Deep Supplier Score — dormant tot Deep Dive actief is (vereist KvK-koppeling).
function supplierScore(assessments) {
  const coa = pillarStats(assessments, 'COA'), lab = pillarStats(assessments, 'LAB');
  const company = pillarStats(assessments, 'COMPANY'), reputation = pillarStats(assessments, 'REPUTATION');
  const cap = coaCap(assessments);
  const parts = [{ w: 0.45, v: cap.final }, { w: 0.3, v: lab.normal }, { w: 0.15, v: company.normal }, { w: 0.1, v: reputation.normal }];
  const anyNull = parts.some((p) => p.v == null);
  const value = anyNull ? null : parts.reduce((s, p) => s + p.w * p.v, 0);
  const coverage = (100 * (coa.assessable + lab.assessable + company.assessable + reputation.assessable)) / CATEGORY_DEFS.length;
  return { value: value == null ? null : Math.round(value * 100) / 100, coverage, coa, lab, company, reputation, cap };
}

// Deterministische EVIDENCE GATE op basis van de intake-array die de
// coaDataset-stap teruggeeft (nooit een AI-beweerd PASS/FAIL overnemen).
function evidenceGate(intake) {
  intake = intake || [];
  const found = intake.filter((i) => i.found);
  if (!found.length) return { status: 'FAIL', code: 'NO_COA_FOUND', foundCount: 0, usableCount: 0 };
  const leesbaar = found.filter((i) => i.access_status === 'readable' && i.parse_status !== 'failed');
  const usable = leesbaar.filter((i) => (i.analytical_fields_usable || []).length > 0);
  if (!usable.length) {
    // WAAROM is er niets bruikbaars? Dat waren twee heel verschillende
    // situaties in een code. Op 20 september viel peptidekliniek.nl om als
    // COA_ACCESS_OR_PARSE_BLOCKED - 'we konden de bestanden niet openen' -
    // terwijl alle dertig rapporten prima gelezen waren. Ze telden niet mee
    // omdat het laboratorium niet te verifieren is. De gebruiker kreeg
    // daardoor de raad om zijn documenten te uploaden, en dat lost niets op:
    // hetzelfde lab staat er dan nog steeds onder.
    //
    // Een rapport dat is gelezen maar waarvan de velden zijn onderdrukt heeft
    // analytical_fields_gelezen gevuld en analytical_fields_usable leeg.
    const doorLab = leesbaar.filter((i) => i.bewijskracht === 'onbevestigd' &&
      (i.analytical_fields_gelezen || []).length > 0);
    if (doorLab.length) {
      return {
        status: 'FAIL', code: 'LAB_NOT_VERIFIABLE',
        foundCount: found.length, usableCount: 0,
        gelezenCount: leesbaar.length, doorLabCount: doorLab.length,
        // De reden zoals die bij het labooordeel is vastgelegd, zodat de
        // uitleg naar buiten niet opnieuw wordt bedacht.
        labReden: doorLab[0].bewijskracht_reden || null
      };
    }
    // A16, dezelfde les als hierboven. Zonder deze tak viel een leverancier
    // waarvan de productnaam afwijkt van de getoetste stof om als
    // COA_ACCESS_OR_PARSE_BLOCKED - "wij konden de bestanden niet openen" -
    // terwijl de rapporten prima gelezen zijn. Ze tellen niet mee omdat nog
    // niet is vastgesteld dat ze over DIT product gaan. De gebruiker kreeg
    // dan het advies zijn documenten te uploaden, en dat lost niets op.
    // Twee wegen naar dezelfde stand: de productnaam wijkt af van de getoetste
    // stof (A16), of batch/lot/product wijkt af van het labrapport (A15b). In
    // beide gevallen is het rapport gelezen en authentiek, maar is niet
    // vastgesteld dat het over DIT product of DEZE batch gaat.
    const koppelingTeltNiet = (i) =>
      (i.naamkoppeling && i.naamkoppeling.telt === false) ||
      (i.koppeling && ['zwak', 'geen/tegenstrijdig'].indexOf(i.koppeling.stand) !== -1);
    const doorKoppeling = leesbaar.filter((i) => koppelingTeltNiet(i) &&
      (i.analytical_fields_gelezen || []).length > 0);
    if (doorKoppeling.length) {
      const wacht = doorKoppeling.filter((i) => i.naamkoppeling && i.naamkoppeling.wacht).length;
      return {
        status: 'FAIL', code: 'KOPPELING_NIET_VASTGESTELD',
        foundCount: found.length, usableCount: 0,
        gelezenCount: leesbaar.length, doorKoppelingCount: doorKoppeling.length,
        wachtOpBeoordeling: wacht,
        koppelingReden: (doorKoppeling[0].naamkoppeling && doorKoppeling[0].naamkoppeling.reden) ||
          (doorKoppeling[0].koppeling && doorKoppeling[0].koppeling.reden) || null
      };
    }
    return { status: 'FAIL', code: 'COA_ACCESS_OR_PARSE_BLOCKED', foundCount: found.length, usableCount: 0, gelezenCount: leesbaar.length };
  }
  const core = ['identity', 'purity', 'quantity'];
  const coreOk = core.every((f) => usable.some((i) => (i.analytical_fields_usable || []).indexOf(f) !== -1));
  return { status: coreOk ? 'PASS' : 'PARTIAL', code: null, foundCount: found.length, usableCount: usable.length };
}

// Deterministische quantity-wiskunde — nooit door het model laten berekenen.
function computeQuantity(claimed, measured) {
  if (claimed == null || measured == null || Number.isNaN(claimed) || Number.isNaN(measured) || claimed <= 0) {
    return {
      signedDifference: null, absoluteDifference: null, deviationPct: null, signalGt10: null, signalGt20: null,
      reason: claimed <= 0 ? 'claim niet positief' : 'ontbrekende of onvergelijkbare waarde'
    };
  }
  const signed = measured - claimed;
  const abs = Math.abs(signed);
  const pct = (signed / claimed) * 100;
  return { signedDifference: signed, absoluteDifference: abs, deviationPct: pct, signalGt10: Math.abs(pct) > 10, signalGt20: Math.abs(pct) > 20, reason: null };
}

// Volledig engine-resultaat voor een case: dependency rule -> cap -> gate -> evidence score.
// ROODFILTER: rood is een uitspraak, geen gebrek aan uitspraak.
//
// Op 21 september bleek uit de werklijst dat twee van de negen rode gevallen
// rood stonden op grond van iets dat NIET kon worden vastgesteld. Bij
// rcpeptides noemde de onderbouwing het zelf: klasse C, bestand onleesbaar,
// externe verificatie niet beschikbaar - en dat werd C01 rood. Dat is
// ontbrekend bewijs, en ontbrekend bewijs is wit.
//
// Het model blijft de kleur voorstellen, maar deze filter is deterministisch
// en staat erachter. Zakt een rood door de toets, dan wordt het wit met een
// reden, zodat na te lopen is wat er gebeurde en waarom.
const ROOD_ZONDER_BEWIJS = [
  /niet (te )?verif/i,            // niet te verifieren, niet verifieerbaar
  /niet beschikbaar/i,
  /onleesbaar/i,
  /unreadable/i,
  /unavailable/i,
  /ontbre(e)?k/i,                 // ontbreekt, ontbrekend, het ontbreken van
  /geen bruikbare/i,
  /niet gevonden/i,
  /klasse ['"]?C['"]?/i,
  /niet vermeld/i
];
// Woorden die wél op een vaststelling wijzen. Staat er zo'n aanwijzing bij,
// dan blijft rood staan ook als de tekst daarnaast over ontbreken gaat.
const ROOD_MET_BEWIJS = [
  /afwijking van \d/i, /\d+[,.]\d+\s*%/, /aangetroffen/i, /niet aangetroffen/i,
  /spreekt .* tegen/i, /tegengesproken/i, /weerlegd/i, /komt niet overeen/i,
  /lost niet op/i, /bestaat aantoonbaar niet/i, /verbod/i, /handhaving/i
];
function roodGedragen(rationale) {
  const t = String(rationale || '');
  if (!t.trim()) return false;
  if (ROOD_MET_BEWIJS.some((re) => re.test(t))) return true;
  return !ROOD_ZONDER_BEWIJS.some((re) => re.test(t));
}
// Alleen de COA-categorieen: daar gaat het mis, en daar raakt rood de
// leverancier het hardst. L01, B* en R* blijven zoals beoordeeld.
function filterRood(assessmentsIn) {
  const assessments = {};
  Object.keys(assessmentsIn).forEach((k) => { assessments[k] = Object.assign({}, assessmentsIn[k]); });
  Object.keys(assessments).forEach((id) => {
    if (!/^C(0[1-9]|1[0-9])$/.test(id)) return;
    const a = assessments[id];
    if (!a || a.color !== 'red') return;
    if (roodGedragen(a.rationale)) return;
    a.color = 'white';
    a.roodAfgekeurd = true;
    a.roodAfgekeurdReden = 'rood rustte uitsluitend op wat niet kon worden vastgesteld; ontbrekend bewijs is geen aangetoond probleem';
  });
  return assessments;
}

// A17 - BESLUIT ANNEMARIE, 21 SEPTEMBER.
//
// "Registreren als uitgevoerd, nooit automatisch pass. Onderscheid tussen
// testdekking en testresultaat. Gebruikersweergave: getest, geen norm
// beschikbaar."
//
// Een rapport dat endotoxinen meet en "0.05 EU/mg" noemt zegt niet of dat
// goed is. Zonder norm is er een meting en geen uitslag. Het model gaf zo een
// categorie tot nu toe gewoon groen - begrijpelijk, want er is getest - en
// daarmee gaven wij een geslaagd-oordeel dat nergens staat.
//
// Deze rem is deterministisch en staat achter het model, net als filterRood.
// Groen kan niet als wij voor die categorie NERGENS een norm hebben gelezen.
// Het wordt oranje: de test is uitgevoerd, dat is iets, alleen geen geslaagde
// uitslag. Rood blijft rood; dit is geen strafregel maar een rem op
// automatisch goedkeuren.
function filterZonderNorm(assessmentsIn, normbeeld) {
  const assessments = {};
  Object.keys(assessmentsIn).forEach((k) => { assessments[k] = Object.assign({}, assessmentsIn[k]); });
  if (!normbeeld) return assessments;
  Object.keys(normbeeld).forEach((id) => {
    const beeld = normbeeld[id];
    const a = assessments[id];
    if (!a || !beeld || !beeld.uitsluitendZonderNorm) return;
    if (a.color !== 'green') return;
    a.color = 'orange';
    a.zonderNorm = true;
    a.zonderNormReden = 'de test is aantoonbaar uitgevoerd, maar in de rapporten staat geen norm ' +
      'om de uitkomst tegen af te zetten; getest is niet hetzelfde als geslaagd';
  });
  return assessments;
}

function runScoringEngine(rawAssessments, adequacy, intake, normbeeld) {
  const assessments = applyDependencyRule(filterZonderNorm(filterRood(rawAssessments || {}), normbeeld));
  const gate = evidenceGate(intake);
  const evidenceScore = freeEvidenceScore(assessments, adequacy, gate.status);
  const pillars = {};
  PILLARS.forEach((p) => { pillars[p] = pillarStats(assessments, p); });
  return { assessments, gate, evidenceScore, pillars, deep: supplierScore(assessments) };
}

module.exports = {
  CATEGORY_DEFS, PILLARS, categoryDef, pillarCategoryIds, pillarStats,
  applyDependencyRule, coaCap, freeEvidenceScore, supplierScore, evidenceGate,
  computeQuantity, runScoringEngine, filterRood, roodGedragen, filterZonderNorm
};
