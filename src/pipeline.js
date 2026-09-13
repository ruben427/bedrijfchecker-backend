// Audit-pipeline — 1-op-1 geport uit bedrijfchecker.html (de Claude Artifact),
// met sample.json/mcp.callTool vervangen door anthropicClient/tavilyClient.
// Alle rekenwerk (gate, cap, scores) blijft in scoringEngine.js — hier alleen
// research-stappen, categorisatie-prompt en narratieve synthese.

const { sampleJsonSafe } = require('./anthropicClient');
const { tavilySearch, tavilyExtract, tavilyResearch } = require('./tavilyClient');
const { runScoringEngine, computeQuantity } = require('./scoringEngine');
const db = require('./db');

const EVIDENCE_RULES = [
  'Je bent een kritische, neutrale onderzoeksassistent voor leveranciers-due-diligence van peptiden en research chemicals.',
  'Harde regels:',
  '1. Verzin nooit een bron, naam, datum, cijfer of feit. Gebruik uitsluitend de aangeleverde brondata hieronder.',
  '2. Onderscheid altijd: FEIT (rechtstreeks in de bron), BRONCLAIM (leverancier of derde beweert dit, niet onafhankelijk geverifieerd), ONDERBOUWDE HYPOTHESE, ONBEKEND, TEGENGESPROKEN (bron spreekt eerdere claim tegen).',
  "3. Koppel personen of bedrijven NOOIT aan elkaar op basis van alleen een gelijkende naam, adres of toeval. Vereis een concrete gedeelde identificator (KvK-nummer, e-mailadres, telefoonnummer, letterlijke tekstvermelding). Een naamovereenkomst alleen is hoogstens 'MOGELIJK VERBAND'.",
  '4. Gebruik termen als fraude, scam, vervalst of oplichting NOOIT tenzij een bron dit expliciet en overtuigend bewijst.',
  '5. Ontbrekende informatie is geen bewijs van afwezigheid; zeg dat iets niet gevonden is in plaats van te concluderen dat het niet bestaat.',
  '6. Geef bij elke individuele claim de bron-URL waar die vandaan komt. Geen bron beschikbaar betekent classificatie ONBEKEND.',
  '7. Schrijf beknopt, zakelijk Nederlands zonder em-dashes.',
  'Antwoord UITSLUITEND met geldige JSON volgens het gevraagde schema hieronder. Geen andere tekst, geen markdown-codeblok.'
].join('\n');

const STEP_DEFS = [
  { key: 'identiteit', label: 'Juridische identiteit' },
  { key: 'domein', label: 'Domein- en websitegeschiedenis' },
  { key: 'laboratorium', label: 'Laboratorium' },
  { key: 'coaDataset', label: 'COA-dataset en -authenticiteit' },
  { key: 'socialAffiliates', label: 'Social media, affiliates en commerciële relaties' },
  { key: 'reputatie', label: 'Reputatie' },
  { key: 'regelgeving', label: 'Regelgeving en toezicht' },
  { key: 'tegenbewijs', label: 'Tegenbewijs en positieve signalen' },
  { key: 'categorize', label: 'Categoriebeoordeling (17 categorieën)' },
  { key: 'reportA', label: 'Evidence Check samenstellen (1/2)' },
  { key: 'reportB', label: 'Evidence Check samenstellen (2/2)' }
];
const RESEARCH_STEP_KEYS = ['identiteit', 'domein', 'laboratorium', 'coaDataset', 'socialAffiliates', 'reputatie', 'regelgeving', 'tegenbewijs'];

function stepLabel(key) {
  const d = STEP_DEFS.find((s) => s.key === key);
  return d ? d.label : key;
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; }
}

function trimList(arr, maxItems, maxChars) {
  return (arr || []).slice(0, maxItems).map((item) => {
    const clone = Object.assign({}, item);
    if (typeof clone.content === 'string') clone.content = clone.content.slice(0, maxChars);
    return clone;
  });
}

// Shrink phase output before it goes into de synthesis-prompt.
function trimPhasesForPrompt(phases) {
  const out = {};
  Object.keys(phases).forEach((key) => {
    const p = phases[key];
    if (!p || !p.data) { out[key] = null; return; }
    const d = p.data;
    const slim = { title: p.title };
    if (d.kortSamenvatting) slim.kortSamenvatting = String(d.kortSamenvatting).slice(0, 300);
    ['bevindingen', 'verbanden'].forEach((arrKey) => {
      if (Array.isArray(d[arrKey])) {
        slim[arrKey] = d[arrKey].slice(0, 6).map((item) => {
          const c = {};
          for (const k in item) c[k] = typeof item[k] === 'string' ? item[k].slice(0, 220) : item[k];
          return c;
        });
      }
    });
    if (Array.isArray(d.positieveBevindingen)) slim.positieveBevindingen = d.positieveBevindingen.slice(0, 6).map((s) => String(s).slice(0, 220));
    if (Array.isArray(d.opvallendeAfwezigheid)) slim.opvallendeAfwezigheid = d.opvallendeAfwezigheid.slice(0, 6);
    if (Array.isArray(d.documenten)) slim.documenten = d.documenten.slice(0, 6);
    out[key] = slim;
  });
  return out;
}

async function runPhase(ctx, opts) {
  const searchResults = opts.searchQueries && opts.searchQueries.length ? await tavilySearch(opts.searchQueries) : [];
  const extractResults = opts.extractUrls && opts.extractUrls.length ? await tavilyExtract(opts.extractUrls) : { ok: [], failed: [] };
  const researchResult = opts.researchQuery ? await tavilyResearch(opts.researchQuery) : null;

  const raw = {
    zoekresultaten: trimList(searchResults, 8, 500),
    paginaExtracties: trimList(extractResults.ok, 5, 1200),
    nietOpgehaaldePaginas: extractResults.failed,
    aanvullendOnderzoek: researchResult ? { samenvatting: (researchResult.content || '').slice(0, 3000), bronnen: researchResult.sources } : null
  };

  const prompt = EVIDENCE_RULES + '\n\nOnderzoeksfase: ' + opts.title + '\nLeverancier: ' + ctx.naam + '\nWebsite: ' + ctx.website + '\n\n' +
    'Ruwe brondata (JSON):\n' + JSON.stringify(raw) + '\n\n' + opts.schemaHint;

  const data = await sampleJsonSafe(prompt, {});
  return { key: opts.key, title: opts.title, data };
}

function stepOpts(key, ctx) {
  const domain = domainOf(ctx.website);
  switch (key) {
    case 'identiteit': return {
      key: 'identiteit', title: 'Juridische identiteit',
      searchQueries: [ctx.naam + ' KvK nummer bedrijfsgegevens', ctx.naam + ' adres contactgegevens'],
      extractUrls: [ctx.website, ctx.website.replace(/\/$/, '') + '/contact', ctx.website.replace(/\/$/, '') + '/terms',
        ctx.website.replace(/\/$/, '') + '/privacy', ctx.website.replace(/\/$/, '') + '/about', ctx.website.replace(/\/$/, '') + '/help-center'],
      schemaHint: 'Antwoord met JSON: {"bevindingen":[{"claim":string,"classificatie":"FEIT|BRONCLAIM|ONDERBOUWDE HYPOTHESE|ONBEKEND|TEGENGESPROKEN","onderbouwing":string,"bronUrl":string}],"opvallendeAfwezigheid":[string],"vastgesteldeNaam":string,"kortSamenvatting":string}. Zet vastgesteldeNaam op de officiële bedrijfs- of handelsnaam zoals die uit de brondata blijkt (footer, KvK-vermelding, voorwaarden); laat leeg als dat niet met redelijke zekerheid valt vast te stellen.'
    };
    case 'laboratorium': return {
      key: 'laboratorium', title: 'Laboratorium',
      searchQueries: [ctx.naam + ' laboratorium COA test', ctx.naam + ' independent lab ISO 17025', ctx.naam + ' lab accreditation testing partner'],
      researchQuery: 'Welk(e) laboratorium(s) test(en) de producten van "' + ctx.naam + '" (website: ' + ctx.website + ')? Zoek naar de naam van het laboratorium, land, accreditaties (zoals ISO/IEC 17025) en of dit laboratorium ook voor andere, niet-gelieerde leveranciers werkt. Onderzoek geen koppeling tussen leverancier en laboratorium zonder concreet bewijs zoals een gedeeld adres, bestuurder of domein.',
      schemaHint: 'Antwoord met JSON: {"bevindingen":[{"claim":string,"classificatie":"FEIT|BRONCLAIM|ONDERBOUWDE HYPOTHESE|ONBEKEND|TEGENGESPROKEN","onderbouwing":string,"bronUrl":string}],"laboratoriumNaam":string,"kortSamenvatting":string}'
    };
    case 'coaDataset': return {
      key: 'coaDataset', title: 'COA-dataset en -authenticiteit',
      searchQueries: [ctx.naam + ' COA certificate of analysis', ctx.naam + ' COA verification lab report number', ctx.naam + ' lab results batch'],
      researchQuery: 'Zoek alle publiek vindbare COA\'s (certificates of analysis) van leverancier "' + ctx.naam + '" (website: ' + ctx.website + '). Verzamel per COA: product, geclaimde en gemeten hoeveelheid met eenheid, purity-percentage en meetmethode, batchnummer, report/task-ID, verification key, laboratoriumnaam, order/ontvangst/analyse/rapportdatum, sterility- en endotoxin-testresultaten indien vermeld, overige contaminantentests, en of het rapport extern controleerbaar is (bijv. via een verification key of publiek opzoeksysteem bij het lab).',
      schemaHint: 'Antwoord met JSON: {"coaRecords":[{"product":string,"claimedQuantity":number|null,"claimedUnit":string,"measuredQuantity":number|null,"measuredUnit":string,"purityPercent":number|null,"purityMethod":string,"batchnummer":string,"reportId":string,"verificationKey":string,"laboratorium":string,"orderDate":string,"receivedDate":string,"analysisDate":string,"reportDate":string,"sterility":{"tested":true|false|null,"result":string,"method":string},"endotoxin":{"tested":true|false|null,"result":string,"unit":string},"overigeContaminanten":[{"parameter":string,"resultaat":string,"unit":string}],"authenticiteitsklasse":"A|B|C|D","authenticiteitsonderbouwing":string,"externalVerification":"verified|pending|unavailable|failed|contradicted","accessStatus":"readable|inaccessible|unreadable|error","bronUrl":string}],"zoekactieVoltooid":boolean,"kortSamenvatting":string}. Verzin geen cijfers: onbekende velden worden null. Gebruik authenticiteitsklasse A (authentiek + goede batchtraceerbaarheid), B (authentiek maar koppeling beperkt), C (niet onafhankelijk verifieerbaar) of D (concreet bewijs van afwijking) exact per het hoofdprotocol; gebruik D alleen met overtuigend bewijs.'
    };
    case 'socialAffiliates': return {
      key: 'socialAffiliates', title: 'Social media, affiliates en commerciële relaties',
      searchQueries: [ctx.naam + ' affiliate program kortingscode', ctx.naam + ' instagram OR twitter OR tiktok officieel account', ctx.naam + ' influencer partnership'],
      schemaHint: 'Antwoord met JSON: {"verbanden":[{"omschrijving":string,"classificatie":"BEWEZEN COMMERCIËLE RELATIE|WAARSCHIJNLIJKE RELATIE|ONBEKENDE RELATIE","onderbouwing":string,"bronUrl":string}],"kortSamenvatting":string}'
    };
    case 'regelgeving': return {
      key: 'regelgeving', title: 'Regelgeving en handhaving',
      searchQueries: [ctx.naam + ' IGJ', ctx.naam + ' NVWA', ctx.naam + ' verkoopverbod OR waarschuwing OR dwangsom OR recall'],
      schemaHint: 'Antwoord met JSON: {"bevindingen":[{"claim":string,"classificatie":"FEIT|BRONCLAIM|ONDERBOUWDE HYPOTHESE|ONBEKEND|TEGENGESPROKEN","onderbouwing":string,"bronUrl":string,"datum":string}],"kortSamenvatting":string}'
    };
    case 'domein': return {
      key: 'domein', title: 'Domein- en bedrijfsgeschiedenis',
      searchQueries: [domain + ' domeinregistratie whois', domain + ' wayback machine archief eerste versie', ctx.naam + ' opgericht sinds jaar'],
      schemaHint: 'Antwoord met JSON: {"bevindingen":[{"claim":string,"classificatie":"FEIT|BRONCLAIM|ONDERBOUWDE HYPOTHESE|ONBEKEND|TEGENGESPROKEN","onderbouwing":string,"bronUrl":string}],"kortSamenvatting":string}'
    };
    case 'reputatie': return {
      key: 'reputatie', title: 'Reputatie',
      searchQueries: [ctx.naam + ' trustpilot reviews', ctx.naam + ' reddit ervaring', ctx.naam + ' klachten'],
      schemaHint: 'Antwoord met JSON: {"bevindingen":[{"claim":string,"classificatie":"FEIT|BRONCLAIM|ONDERBOUWDE HYPOTHESE|ONBEKEND|TEGENGESPROKEN","onderbouwing":string,"bronUrl":string}],"kortSamenvatting":string}'
    };
    case 'tegenbewijs': return {
      key: 'tegenbewijs', title: 'Tegenbewijs en positieve signalen',
      searchQueries: [ctx.naam + ' transparant OR onafhankelijk getest OR kwaliteit', ctx.naam + ' recall OR correctie OR verbetering'],
      schemaHint: 'Antwoord met JSON: {"positieveBevindingen":[string],"kortSamenvatting":string}'
    };
    default: return null;
  }
}

async function ensureNotStopped(caseId) {
  const c = await db.getCase(caseId);
  if (c && c.status === 'gestopt') {
    const err = new Error('Audit gestopt door gebruiker');
    err.stopped = true;
    throw err;
  }
}
async function stopAudit(caseId) {
  await db.updateCase(caseId, { status: 'gestopt', currentStep: null });
}

async function beginStep(caseId, key) {
  await db.updateCase(caseId, { currentStep: { key, label: stepLabel(key), startedAt: Date.now() } });
}
async function finishStep(caseId, key, startedAt) {
  const durationMs = Date.now() - startedAt;
  const c = await db.getCase(caseId);
  const prev = (c && c.progress) || [];
  const withoutKey = prev.filter((p) => p.key !== key);
  const entry = { key, label: stepLabel(key), ts: Date.now(), durationMs };
  await db.updateCase(caseId, { progress: withoutKey.concat([entry]) });
  await db.updateStepStats(key, durationMs);
}

async function runResearchStep(caseId, ctx, key) {
  const startedAt = Date.now();
  await beginStep(caseId, key);
  let result;
  if (key === 'coaDataset') {
    const phase = await runPhase(ctx, stepOpts('coaDataset', ctx));
    let records = (phase.data && phase.data.coaRecords) || [];
    if (ctx.images && ctx.images.length) {
      const docPrompt = EVIDENCE_RULES + '\n\nBekijk de bijgevoegde afbeelding(en) van door de gebruiker geuploade documenten (COA, screenshot, productfoto) voor leverancier ' + ctx.naam + '. Beschrijf per afbeelding alleen wat letterlijk zichtbaar is. Verzin niets; gebruik null waar iets onleesbaar of niet zichtbaar is. Dit is geen onafhankelijke verificatie op zichzelf, maar telt als direct geziene brondata (accessStatus readable, parseStatus valid).\n\nAntwoord met JSON: {"coaRecords":[{"product":string,"claimedQuantity":number|null,"claimedUnit":string,"measuredQuantity":number|null,"measuredUnit":string,"purityPercent":number|null,"purityMethod":string,"batchnummer":string,"reportId":string,"verificationKey":string,"laboratorium":string,"orderDate":string,"receivedDate":string,"analysisDate":string,"reportDate":string,"sterility":{"tested":true|false|null,"result":string,"method":string},"endotoxin":{"tested":true|false|null,"result":string,"unit":string},"overigeContaminanten":[{"parameter":string,"resultaat":string,"unit":string}],"authenticiteitsklasse":"A|B|C|D","authenticiteitsonderbouwing":string,"externalVerification":"verified|pending|unavailable|failed|contradicted"}]}';
      const docData = await sampleJsonSafe(docPrompt, { images: ctx.images });
      const uploadedRecords = ((docData && docData.coaRecords) || []).map((r) => Object.assign({}, r, { accessStatus: 'readable', bronUrl: null, uit: 'upload' }));
      records = records.concat(uploadedRecords);
    }
    records = records.map((r) => {
      const q = computeQuantity(
        typeof r.claimedQuantity === 'number' ? r.claimedQuantity : null,
        typeof r.measuredQuantity === 'number' ? r.measuredQuantity : null
      );
      return Object.assign({}, r, { quantity: q });
    });
    const intake = records.map((r, i) => {
      const fields = [];
      if (r.purityPercent != null) fields.push('purity');
      if (r.quantity && r.quantity.deviationPct != null) fields.push('quantity');
      if (r.authenticiteitsklasse) fields.push('identity');
      if (r.sterility && r.sterility.tested) fields.push('sterility');
      if (r.endotoxin && r.endotoxin.tested) fields.push('endotoxin');
      if (r.overigeContaminanten && r.overigeContaminanten.length) fields.push('other');
      return {
        intake_id: 'coa-' + i, found: true,
        access_status: r.accessStatus || (r.reportId || r.verificationKey ? 'readable' : 'unreadable'),
        parse_status: (r.product || r.purityPercent != null) ? 'valid' : 'partial',
        analytical_fields_usable: fields
      };
    });
    result = { key: 'coaDataset', title: 'COA-dataset en -authenticiteit', data: Object.assign({}, phase.data, { coaRecords: records, intake }) };
  } else if (key === 'identiteit') {
    result = await runPhase(ctx, stepOpts('identiteit', ctx));
    if (ctx.kvkDocument) {
      const kvkPrompt = EVIDENCE_RULES + '\n\nBekijk het bijgevoegde, door de gebruiker geüploade KvK-uittreksel (PDF) voor leverancier ' + ctx.naam + '. Lees uitsluitend letterlijk wat in het document staat; gebruik null waar een veld niet vermeld of onleesbaar is. Dit telt als direct geziene brondata (niet zelf op te zoeken, geen bronUrl).\n\n' +
        'Antwoord met JSON: {"leesbaar":boolean,"kvkGegevens":{"bedrijfsnaam":string,"handelsnamen":[string],"kvkNummer":string,"rechtsvorm":string,"adres":string,"vestigingsplaats":string,"oprichtingsdatum":string,"status":string,"bestuurders":[string]}}';
      const kvkData = await sampleJsonSafe(kvkPrompt, { documents: [ctx.kvkDocument] });
      const g = (kvkData && kvkData.kvkGegevens) || {};
      const bevindingen = (result.data && result.data.bevindingen) || [];
      if (kvkData && kvkData.leesbaar && (g.bedrijfsnaam || g.kvkNummer)) {
        const claim = 'KvK-uittreksel vermeldt: ' + [g.bedrijfsnaam, g.kvkNummer ? 'KvK-nummer ' + g.kvkNummer : null, g.rechtsvorm, g.status ? 'status ' + g.status : null].filter(Boolean).join(', ') + '.';
        bevindingen.push({ claim, classificatie: 'FEIT', onderbouwing: 'Rechtstreeks gelezen uit het door de gebruiker geüploade KvK-uittreksel.', bronUrl: null });
        result.data = Object.assign({}, result.data, { bevindingen, kvkUittrekselGegevens: g });
        if (!result.data.vastgesteldeNaam && g.bedrijfsnaam) result.data.vastgesteldeNaam = g.bedrijfsnaam;
      } else {
        result.data = Object.assign({}, result.data, { kvkUittrekselOnleesbaar: true });
      }
    }
  } else {
    result = await runPhase(ctx, stepOpts(key, ctx));
  }
  await db.mergePhaseData(caseId, key, result);
  if (key === 'identiteit' && result.data && result.data.vastgesteldeNaam) {
    await db.updateCase(caseId, { naam: String(result.data.vastgesteldeNaam).slice(0, 200) });
  }
  await finishStep(caseId, key, startedAt);
}

async function runCategorize(caseId, ctx) {
  const startedAt = Date.now();
  await beginStep(caseId, 'categorize');
  const c = await db.getCase(caseId);
  const phaseData = c.phaseData || {};
  const slimPhases = trimPhasesForPrompt(phaseData);
  const coaRecords = (phaseData.coaDataset && phaseData.coaDataset.data && phaseData.coaDataset.data.coaRecords) || [];
  const prompt = EVIDENCE_RULES + '\n\nWijs voor leverancier ' + ctx.naam + ' (' + ctx.website + ') een kleur en onderbouwing toe aan elk van de 17 vaste categorieën, uitsluitend gegrond op de aangeleverde fasegegevens. Gebruik exact: "green" (sterk/goed verifieerbaar), "orange" (beoordeelbaar met aandachtspunten), "red" (concreet aantoonbaar probleem, nooit alleen wegens ontbrekende informatie), "white" (onvoldoende informatie). Voor C02 (Identity), C03 (Purity), C04 (Quantity): zet independentlyAssessable op false als de ENIGE analytische onderbouwing van onvoldoende onafhankelijk verifieerbare labs komt (bijv. alleen het lab zelf, geen externe verificatie) — de score-engine zet die dan automatisch op wit. B02 (Eigenaren/bestuurders) hoort bij Deep en blijft in deze gratis check "white" met reden "buiten scope van de gratis check", tenzij een van de fasegegevens toevallig al een bestuurder/eigenaar noemt. Beoordeel ook adequacy: kunnen authenticiteit, identiteit en monster-naar-rapport-naar-verkochte-batch inhoudelijk beoordeeld worden (adequacy.coa), en zijn de relevante labs/rapporten onafhankelijk voldoende verifieerbaar (adequacy.lab)? Geef bij elke categorie een korte (1-2 zinnen) onderbouwing.\n\n' +
    'Samengevatte fasegegevens (JSON):\n' + JSON.stringify(slimPhases) + '\n\n' +
    'Ruwe COA-dataset (JSON, voor C01-C09):\n' + JSON.stringify(trimList(coaRecords, 12, 400)) + '\n\n' +
    'Antwoord met compacte JSON, exact dit schema: {"categories":{"C01":{"color":string,"rationale":string},"C02":{"color":string,"rationale":string,"independentlyAssessable":boolean},"C03":{"color":string,"rationale":string,"independentlyAssessable":boolean},"C04":{"color":string,"rationale":string,"independentlyAssessable":boolean},"C05":{"color":string,"rationale":string},"C06":{"color":string,"rationale":string},"C07":{"color":string,"rationale":string},"C08":{"color":string,"rationale":string},"C09":{"color":string,"rationale":string},"L01":{"color":string,"rationale":string},"B01":{"color":string,"rationale":string},"B02":{"color":string,"rationale":string},"B03":{"color":string,"rationale":string},"B04":{"color":string,"rationale":string},"B05":{"color":string,"rationale":string},"R01":{"color":string,"rationale":string},"R02":{"color":string,"rationale":string}},"adequacy":{"coa":boolean|null,"lab":boolean|null,"rationale":string}}';
  const data = await sampleJsonSafe(prompt, {});
  await db.updateCase(caseId, { categoryAssessments: (data && data.categories) || {}, adequacy: (data && data.adequacy) || {} });
  await finishStep(caseId, 'categorize', startedAt);
}

async function applyScoringEngine(caseId) {
  const c = await db.getCase(caseId);
  const intake = (c.phaseData && c.phaseData.coaDataset && c.phaseData.coaDataset.data && c.phaseData.coaDataset.data.intake) || [];
  const engineResult = runScoringEngine(c.categoryAssessments || {}, c.adequacy || {}, intake);
  await db.updateCase(caseId, { engineResult });
  return engineResult;
}

async function runSynthesis(caseId, ctx) {
  const c = await db.getCase(caseId);
  const phaseData = c.phaseData || {};
  const slimJson = JSON.stringify(trimPhasesForPrompt(phaseData));
  const categorySummary = JSON.stringify(c.categoryAssessments || {});
  const engineSummary = JSON.stringify({
    gate: c.engineResult && c.engineResult.gate,
    evidenceScore: c.engineResult && c.engineResult.evidenceScore && {
      published: c.engineResult.evidenceScore.published, value: c.engineResult.evidenceScore.value,
      coverage: c.engineResult.evidenceScore.coverage, reason: c.engineResult.evidenceScore.reason
    }
  });
  const contextHeader = EVIDENCE_RULES + '\n\nSamengevatte per-fase bevindingen voor leverancier ' + ctx.naam + ' (' + ctx.website + '), JSON:\n' + slimJson + '\n\n' +
    'Reeds vastgestelde categoriebeoordelingen (kleur/onderbouwing per categorie, door een eerdere stap bepaald, JSON):\n' + categorySummary + '\n\n' +
    'Reeds berekende gate/score (deterministisch, niet herinterpreteren of een eigen score noemen, JSON):\n' + engineSummary + '\n\n';

  const startedA = Date.now();
  await beginStep(caseId, 'reportA');
  const promptA = contextHeader +
    'Stel op basis hiervan het EERSTE deel van het tussenrapport samen: een narratieve duiding van de al vastgestelde categoriebeoordelingen en gate/score, GEEN eigen scorekaart of cijfer. Noem geen percentage of score die niet letterlijk in de aangeleverde engine-uitkomst staat. Een ontbrekend KvK-uittreksel of B02 (eigenaren/bestuurders, dat is Deep-scope) is nooit op zichzelf reden voor een rode vlag of aandachtspunt in deze gratis check. Houd elk tekstveld kort (1-2 zinnen).\n\n' +
    'Antwoord met compacte JSON, exact dit schema: {"executiveSummary":string,"sterkstePositieveBevindingen":[string],"belangrijksteAandachtspunten":[string],"rodeVlaggen":[{"omschrijving":string,"bron":string}],"nietVerifieerbaar":[string],"documentanalyse":[{"omschrijving":string,"product":string,"batchnummer":string,"purity":string,"laboratorium":string}]}';
  const reportA = await sampleJsonSafe(promptA, {});
  await finishStep(caseId, 'reportA', startedA);

  const startedB = Date.now();
  await beginStep(caseId, 'reportB');
  const promptB = contextHeader +
    'Stel op basis hiervan het TWEEDE deel van het tussenrapport samen: vervolgvragen aan de leverancier, eindconclusie en bronnenregister (verzamel de bronUrl-velden uit de fasegegevens). Houd elk tekstveld kort.\n\n' +
    'Antwoord met compacte JSON, exact dit schema: {"top5Vragen":[string],"eindconclusie":string,"bronnenregister":[{"url":string,"titel":string}]}';
  const reportB = await sampleJsonSafe(promptB, {});
  await finishStep(caseId, 'reportB', startedB);

  const report = Object.assign({}, reportA, reportB);
  await db.updateCase(caseId, { report });
}

// Volledige pipeline vanaf nul: elke research-stap, dan categorize, dan de
// engine, dan de narratieve synthese. Draait async (fire-and-forget vanuit
// de route); de client volgt voortgang via GET /api/audits/:id.
async function runAudit(caseId, ctx) {
  try {
    for (const key of RESEARCH_STEP_KEYS) {
      await ensureNotStopped(caseId);
      await runResearchStep(caseId, ctx, key);
    }
    await ensureNotStopped(caseId);
    await runCategorize(caseId, ctx);
    await ensureNotStopped(caseId);
    await applyScoringEngine(caseId);
    await ensureNotStopped(caseId);
    await runSynthesis(caseId, ctx);
    await db.updateCase(caseId, { status: 'klaar', currentStep: null });
  } catch (e) {
    if (!e || !e.stopped) {
      await db.updateCase(caseId, { status: 'fout', error: (e && e.message) || 'onbekende fout', currentStep: null });
    }
  }
}

module.exports = { runAudit, runResearchStep, runCategorize, applyScoringEngine, runSynthesis, ensureNotStopped, stopAudit, RESEARCH_STEP_KEYS, STEP_DEFS };
