// Methodescheiding: wat gaat de deur uit, en aan wie.
//
// Drie vormen:
//   caseSummary  — regel in het overzicht, geen inhoudelijke uitslag
//   ownerCase    — volledige case voor de eigenaar (zijn eigen onderzoek)
//   publicCase   — uitslag zonder methode, voor een gedeelde/publieke weergave
//
// publicCase is bewust een WHITELIST. Nooit "case minus een paar velden"
// bouwen: een blacklist lekt bij het eerste nieuwe veld dat iemand toevoegt.

// Velden die nooit naar buiten mogen, in welke vorm dan ook. Defensief: als
// de pipeline ooit ruwe modeluitvoer of promptfragmenten meeschrijft onder
// een van deze namen, valt het hier af in plaats van in de response.
const NEVER_EXPOSE = ['prompt', 'prompts', 'systemPrompt', 'rawResponse', 'raw', 'modelOutput', 'protocolText', 'instructions'];

function stripInternal(value, depth) {
  if (depth > 12 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripInternal(v, depth + 1));
  const out = {};
  for (const key of Object.keys(value)) {
    if (NEVER_EXPOSE.indexOf(key) !== -1) continue;
    out[key] = stripInternal(value[key], depth + 1);
  }
  return out;
}

// Overzichtsregel. Bewust smal: geen phaseData, geen rekentrace, geen
// rapporttekst — alleen wat het dashboard nodig heeft om een statuschip te
// tonen. De volledige case komt pas bij GET /api/audits/:id.
function caseSummary(c) {
  if (!c) return null;
  const er = c.engineResult || {};
  const score = er.evidenceScore || null;
  const rode = (c.report && Array.isArray(c.report.rodeVlaggen)) ? c.report.rodeVlaggen : null;
  return {
    id: c.id,
    naam: c.naam,
    website: c.website,
    land: c.land,
    status: c.status,
    tier: c.tier,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    // Alleen de titels, zodat het dashboard kan tellen zonder de onderbouwing
    // van elke rode vlag mee te sturen.
    report: rode ? { rodeVlaggen: rode.map((v) => ({ titel: (v && (v.titel || v.title)) || null })) } : null,
    engineResult: {
      evidenceScore: score ? { value: score.value == null ? null : score.value, published: !!score.published } : null,
      gate: er.gate ? { status: er.gate.status, code: er.gate.code, gelezenCount: er.gate.gelezenCount != null ? er.gate.gelezenCount : null, doorLabCount: er.gate.doorLabCount != null ? er.gate.doorLabCount : null, labReden: er.gate.labReden || null } : null
    }
  };
}

// De eigenaar ziet zijn eigen onderzoek volledig, inclusief bronnen en
// zoeklog — dat is zijn onderbouwing. Alleen echt interne zaken vallen weg.
function ownerCase(c) {
  if (!c) return null;
  const out = stripInternal(c, 0);
  delete out.ownerTokenHash;
  return out;
}

// Uitslag zonder methode. Alles wat laat zien HOE er gerekend wordt
// (achieved/maximum/normal per pijler, regel-ID's, zoeklog, ruwe fasedata)
// blijft weg; alles wat de gebruiker nodig heeft om de uitslag te begrijpen
// en te controleren blijft staan — inclusief bronnen, want dat is het punt.
function publicCase(c) {
  if (!c) return null;
  const er = c.engineResult || {};
  const score = er.evidenceScore || {};
  return {
    id: c.id,
    naam: c.naam,
    website: c.website,
    land: c.land,
    status: c.status,
    tier: c.tier,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    // Versies mogen naar buiten: dat is reproduceerbaarheid, geen recept.
    versions: {
      engine: er.engineVersion || null,
      protocol: er.protocolVersion || null,
      workflow: er.workflowVersion || null
    },
    gate: er.gate ? { status: er.gate.status, code: er.gate.code, gelezenCount: er.gate.gelezenCount != null ? er.gate.gelezenCount : null, doorLabCount: er.gate.doorLabCount != null ? er.gate.doorLabCount : null, labReden: er.gate.labReden || null } : null,
    assessments: Array.isArray(er.assessments)
      ? er.assessments.map((a) => ({
          id: a.id,
          pillar: a.pillar,
          label: a.label,
          color: a.color,
          executionStatus: a.executionStatus,
          rationale: a.rationale,
          unknownReason: a.unknownReason
        }))
      : [],
    evidenceScore: {
      value: score.value == null ? null : score.value,
      coverage: score.coverage == null ? null : score.coverage,
      // Alleen of de cap gold en waarom, niet de rekenweg ernaartoe.
      cap: score.cap ? { applied: !!score.cap.applied, reason: score.cap.reason || null } : null
    },
    report: stripInternal(c.report, 0),
    coaDataset: c.phaseData && c.phaseData.coaDataset ? stripInternal(c.phaseData.coaDataset, 0) : null
  };
}

// Foutafhandeling: de aanroeper krijgt een code, nooit e.message.
// Ruwe fouten bevatten paden, SQL, promptfragmenten en API-antwoorden.
function sanitizeError(e, req) {
  const ref = Math.random().toString(36).slice(2, 10);
  const where = req ? req.method + ' ' + req.originalUrl : 'onbekend';
  console.error('[' + ref + '] ' + where + ' —', (e && e.stack) || e);
  return { error: 'internal_error', message: 'Er ging iets mis bij het verwerken van deze aanvraag.', ref };
}

module.exports = { caseSummary, ownerCase, publicCase, sanitizeError, stripInternal };
