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
// (C01-C09+L01, noemer 10) >=50% is, en adequacy.coa/lab beide true zijn.
function freeEvidenceScore(assessments, adequacy, gateStatus) {
  const coa = pillarStats(assessments, 'COA');
  const lab = pillarStats(assessments, 'LAB');
  const cap = coaCap(assessments);
  const candidate = (cap.final != null && lab.normal != null) ? (0.6 * cap.final + 0.4 * lab.normal) : null;
  const coverage = (100 * (coa.assessable + lab.assessable)) / 10;
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
  const coverage = (100 * (coa.assessable + lab.assessable + company.assessable + reputation.assessable)) / 17;
  return { value: value == null ? null : Math.round(value * 100) / 100, coverage, coa, lab, company, reputation, cap };
}

// Deterministische EVIDENCE GATE op basis van de intake-array die de
// coaDataset-stap teruggeeft (nooit een AI-beweerd PASS/FAIL overnemen).
function evidenceGate(intake) {
  intake = intake || [];
  const found = intake.filter((i) => i.found);
  if (!found.length) return { status: 'FAIL', code: 'NO_COA_FOUND', foundCount: 0, usableCount: 0 };
  const usable = found.filter((i) => i.access_status === 'readable' && i.parse_status !== 'failed' && (i.analytical_fields_usable || []).length > 0);
  if (!usable.length) return { status: 'FAIL', code: 'COA_ACCESS_OR_PARSE_BLOCKED', foundCount: found.length, usableCount: 0 };
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
function runScoringEngine(rawAssessments, adequacy, intake) {
  const assessments = applyDependencyRule(rawAssessments || {});
  const gate = evidenceGate(intake);
  const evidenceScore = freeEvidenceScore(assessments, adequacy, gate.status);
  const pillars = {};
  PILLARS.forEach((p) => { pillars[p] = pillarStats(assessments, p); });
  return { assessments, gate, evidenceScore, pillars, deep: supplierScore(assessments) };
}

module.exports = {
  CATEGORY_DEFS, PILLARS, categoryDef, pillarCategoryIds, pillarStats,
  applyDependencyRule, coaCap, freeEvidenceScore, supplierScore, evidenceGate,
  computeQuantity, runScoringEngine
};
