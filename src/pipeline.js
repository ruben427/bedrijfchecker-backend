// Audit-pipeline — 1-op-1 geport uit bedrijfchecker.html (de Claude Artifact),
// met sample.json/mcp.callTool vervangen door anthropicClient/tavilyClient.
// Alle rekenwerk (gate, cap, scores) blijft in scoringEngine.js — hier alleen
// research-stappen, categorisatie-prompt en narratieve synthese.

const { sampleJsonSafe } = require('./anthropicClient');
const { tavilySearch, tavilyExtract, tavilyResearch } = require('./tavilyClient');
const { fetchRemoteDocument } = require('./docFetcher');
const coaStore = require('./coaStore');
const coaCrawler = require('./coaCrawler');
const siteShot = require('./siteShot');
const janoshik = require('./janoshik');

// Versie van de COA-leeslaag. Analyseresultaten worden gecachet op
// (documenthash, deze versie). Verhoog dit ALLEEN bewust: elke wijziging
// betekent dat alle eerder gelezen COA's opnieuw door vision gaan.
const COA_EXTRACTOR_VERSION = 'coa-read-1';
const { runScoringEngine, computeQuantity } = require('./scoringEngine');
const db = require('./db');

// Hoeveel kandidaat-COA-URL's we per case maximaal automatisch proberen te
// downloaden en te laten uitlezen. Elke poging is een extra fetch + een
// Claude-call, dus bewust begrensd zodat één leverancier met veel
// COA-vermeldingen de stap niet onnodig lang maakt.
const COA_AUTOFETCH_MAX = Number(process.env.COA_AUTOFETCH_MAX) || 30;
const LAB_VERIFY_MAX = Number(process.env.LAB_VERIFY_MAX) || 30;

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
  { key: 'coaDataset', label: 'COA-dataset en -authenticiteit' },
  { key: 'laboratorium', label: 'Laboratorium' },
  { key: 'socialAffiliates', label: 'Social media, affiliates en commerciële relaties' },
  { key: 'reputatie', label: 'Reputatie' },
  { key: 'regelgeving', label: 'Regelgeving en toezicht' },
  { key: 'tegenbewijs', label: 'Tegenbewijs en positieve signalen' },
  { key: 'categorize', label: 'Categoriebeoordeling (17 categorieën)' },
  { key: 'reportA', label: 'Evidence Check samenstellen (1/2)' },
  { key: 'reportB', label: 'Evidence Check samenstellen (2/2)' }
];
const RESEARCH_STEP_KEYS = ['identiteit', 'domein', 'coaDataset', 'laboratorium', 'socialAffiliates', 'reputatie', 'regelgeving', 'tegenbewijs'];

// De knip tussen gratis en betaald (14 sep): FREE draait alleen de stappen
// die freeEvidenceScore ook daadwerkelijk gebruikt (60% COA + 40% LAB, zie
// scoringEngine.js) — precies wat in het projectdocument als "FREE ≈
// coaDataset + laboratorium" is vastgelegd. Alle overige onderzoeksstappen
// (incl. identiteit/KvK, nog niet gesplitst in een lichte/zware variant)
// draaien pas als de gebruiker bewust doorgaat naar de Deep Dive.
// Volgorde is hier geen detail: coaDataset draait eerst, omdat de
// laboratoriumstap leest welke labs er op de gelezen rapporten staan.
const FREE_STEP_KEYS = ['coaDataset', 'laboratorium'];
const DEEP_STEP_KEYS = RESEARCH_STEP_KEYS.filter((k) => FREE_STEP_KEYS.indexOf(k) === -1);

function stepLabel(key) {
  const d = STEP_DEFS.find((s) => s.key === key);
  return d ? d.label : key;
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; }
}

// ---- Labsignalen uit de COA-stap ----
// De laboratoriumstap zocht tot nu toe blind: "welk lab test voor <shopnaam>".
// Zoekmachines weten dat vrijwel nooit, dus de stap kwam leeg terug terwijl de
// labnaam gewoon op de rapporten stond die de COA-stap net gelezen had. Wat
// hieronder gebeurt is niet slim: het telt alleen wat er letterlijk op de
// gelezen rapporten staat. Die telling is het vertrekpunt voor het onderzoek,
// niet het onderzoek zelf.
const LAB_RUIS = /\b(laboratories|laboratory|laboratorium|labs|lab|analytical|analytics|analysis|testing|services|company|group|international|inc|llc|ltd|limited|bv|gmbh|corp|co)\b/g;

function normaliseerLabnaam(naam) {
  const kaal = String(naam || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(LAB_RUIS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return kaal || String(naam || '').toLowerCase().trim();
}

// Leest de uitkomst van de COA-stap en bundelt per laboratorium wat we
// feitelijk gezien hebben. Geen interpretatie, geen conclusie.
function labsUitCoaData(coaData) {
  const records = (coaData && coaData.coaRecords) || [];
  const perLab = new Map();
  let gelezenRapporten = 0;
  let zonderLabnaam = 0;

  records.forEach((r) => {
    if (!r) return;
    const leesbaar = r.accessStatus === 'readable';
    if (leesbaar) gelezenRapporten++;
    const ruw = r.laboratorium ? String(r.laboratorium).trim() : '';
    if (!ruw) {
      if (leesbaar && r.uit !== 'labverwijzing') zonderLabnaam++;
      return;
    }
    const sleutel = normaliseerLabnaam(ruw);
    let l = perLab.get(sleutel);
    if (!l) {
      l = {
        naam: ruw, spellingen: {}, rapporten: 0, directeVerificatielinks: 0,
        verificatieOpgelost: 0, verificatieMislukt: 0, zonderReferentie: 0,
        klassen: {}, opdrachtgevers: [], voorbeeldBronnen: []
      };
      perLab.set(sleutel, l);
    }
    l.spellingen[ruw] = (l.spellingen[ruw] || 0) + 1;
    l.rapporten++;
    if (r.uit === 'labverwijzing') l.directeVerificatielinks++;
    const v = r.verificatie;
    if (v) {
      if (v.opgelost === true) l.verificatieOpgelost++;
      else if (v.opgelost === false) {
        if (/geen bruikbare verificatiereferentie/i.test(v.status || '')) l.zonderReferentie++;
        else l.verificatieMislukt++;
      }
      // Het veld Client op het originele labrapport zegt wie de test heeft
      // laten doen. Staat daar de leverancier zelf, dan is dat een feit voor
      // de onafhankelijkheidsvraag - geen oordeel, wel relevant.
      [v.client, v.manufacturer].forEach((naam) => {
        const n = naam ? String(naam).trim() : '';
        if (n && l.opdrachtgevers.indexOf(n) === -1 && l.opdrachtgevers.length < 5) l.opdrachtgevers.push(n);
      });
    }
    if (r.authenticiteitsklasse) l.klassen[r.authenticiteitsklasse] = (l.klassen[r.authenticiteitsklasse] || 0) + 1;
    const bron = r.bronUrl || r.verificationUrl || null;
    if (bron && l.voorbeeldBronnen.indexOf(bron) === -1 && l.voorbeeldBronnen.length < 3) l.voorbeeldBronnen.push(bron);
  });

  const labs = Array.from(perLab.values()).map((l) => {
    // De meest voorkomende schrijfwijze wint, zodat "ILS Laboratories" en
    // "ILS Labs" niet als twee labs in het rapport belanden.
    const beste = Object.keys(l.spellingen).sort((a, b) => l.spellingen[b] - l.spellingen[a])[0];
    const kopie = Object.assign({}, l, { naam: beste || l.naam });
    delete kopie.spellingen;
    return kopie;
  }).sort((a, b) => b.rapporten - a.rapporten);

  return { labs, gelezenRapporten, zonderLabnaam };
}

// Zet de telling om in bevindingen in het vaste format van de andere stappen.
// Alles hier is FEIT: het is geteld, niet geconcludeerd.
function labBevindingenUitWaarneming(w) {
  const uit = [];
  (w.labs || []).forEach((l) => {
    const delen = [l.rapporten + ' gelezen rapport(en) noemen ' + l.naam + ' als uitvoerend laboratorium'];
    if (l.directeVerificatielinks) delen.push(l.directeVerificatielinks + ' daarvan staan als directe link naar de verificatiepagina van het lab op de site van de leverancier');
    if (l.verificatieOpgelost) delen.push(l.verificatieOpgelost + ' rapportnummer(s) losten op bij het lab zelf');
    if (l.verificatieMislukt) delen.push(l.verificatieMislukt + ' rapportnummer(s) losten niet op');
    if (l.zonderReferentie) delen.push(l.zonderReferentie + ' rapport(en) bevatten geen bruikbare verificatiereferentie');
    uit.push({
      claim: delen.join('; ') + '.',
      classificatie: 'FEIT',
      onderbouwing: 'Geteld over de certificaten die in de COA-stap daadwerkelijk zijn opgehaald en gelezen.',
      bronUrl: l.voorbeeldBronnen[0] || null
    });
    if (l.opdrachtgevers.length) {
      uit.push({
        claim: 'Op het originele labrapport van ' + l.naam + ' staat als opdrachtgever/fabrikant: ' + l.opdrachtgevers.join(', ') + '.',
        classificatie: 'FEIT',
        onderbouwing: 'Letterlijk overgenomen uit het rapport zoals het lab dat zelf op zijn verificatiepagina teruggeeft.',
        bronUrl: l.voorbeeldBronnen[0] || null
      });
    }
  });
  if (w.zonderLabnaam) {
    uit.push({
      claim: w.zonderLabnaam + ' gelezen rapport(en) vermelden geen laboratoriumnaam.',
      classificatie: 'FEIT',
      onderbouwing: 'Vastgesteld bij het lezen van de documenten zelf; ontbreken van een labnaam is geen bewijs dat er niet getest is.',
      bronUrl: null
    });
  }
  if (!(w.labs || []).length && w.gelezenRapporten) {
    uit.push({
      claim: 'Er zijn ' + w.gelezenRapporten + ' certificaten gelezen, maar geen daarvan noemt een laboratorium bij naam.',
      classificatie: 'FEIT',
      onderbouwing: 'Vastgesteld bij het lezen van de documenten zelf.',
      bronUrl: null
    });
  }
  return uit;
}

// Plakt het externe onderzoek per lab terug op de telling. Matcht op de
// genormaliseerde naam, zodat een andere schrijfwijze in het zoekresultaat
// niet tot een tweede lab leidt.
function koppelLabBeoordelingen(labs, beoordelingen) {
  const perNaam = new Map();
  (beoordelingen || []).forEach((b) => {
    if (b && b.naam) perNaam.set(normaliseerLabnaam(b.naam), b);
  });
  return (labs || []).map((l) => Object.assign({}, l, { extern: perNaam.get(normaliseerLabnaam(l.naam)) || null }));
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
    // De laboratoriumstap begint met geteld feitenmateriaal uit de COA-stap;
    // bij zes zou het externe onderzoek daarachter wegvallen.
    const maxBevindingen = key === 'laboratorium' ? 10 : 6;
    ['bevindingen', 'verbanden'].forEach((arrKey) => {
      if (Array.isArray(d[arrKey])) {
        slim[arrKey] = d[arrKey].slice(0, maxBevindingen).map((item) => {
          const c = {};
          for (const k in item) c[k] = typeof item[k] === 'string' ? item[k].slice(0, 220) : item[k];
          return c;
        });
      }
    });
    if (Array.isArray(d.positieveBevindingen)) slim.positieveBevindingen = d.positieveBevindingen.slice(0, 6).map((s) => String(s).slice(0, 220));
    if (Array.isArray(d.opvallendeAfwezigheid)) slim.opvallendeAfwezigheid = d.opvallendeAfwezigheid.slice(0, 6);
    if (Array.isArray(d.documenten)) slim.documenten = d.documenten.slice(0, 6);
    if (Array.isArray(d.labs)) {
      slim.labs = d.labs.slice(0, 6).map((l) => ({
        naam: l.naam,
        rapportenDieDitLabNoemen: l.rapporten,
        directeVerificatielinks: l.directeVerificatielinks,
        rapportnummersOpgelostBijLab: l.verificatieOpgelost,
        rapportnummersNietOpgelost: l.verificatieMislukt,
        klassen: l.klassen,
        opdrachtgeverOpRapport: l.opdrachtgevers,
        extern: l.extern ? {
          bestaatAantoonbaar: l.extern.bestaatAantoonbaar,
          land: l.extern.land,
          accreditaties: l.extern.accreditaties,
          publiekVerificatiesysteem: l.extern.publiekVerificatiesysteem,
          onafhankelijkVanLeverancier: l.extern.onafhankelijkVanLeverancier,
          onderbouwing: typeof l.extern.onderbouwing === 'string' ? l.extern.onderbouwing.slice(0, 220) : null,
          bronUrl: l.extern.bronUrl || null
        } : null
      }));
    }
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

  const data = await sampleJsonSafe(prompt, { label: opts.key });
  return { key: opts.key, title: opts.title, data };
}

// Voor de admin-COA-pagina: dezelfde uitleesstap als de autofetch verderop,
// maar dan voor een document dat een staflid met de hand heeft geupload,
// voordat de menselijke labverificatie plaatsvindt. Geeft alleen terug wat er
// letterlijk in het document staat. De authenticiteitsklasse komt hier
// nadrukkelijk niet uit - die mag alleen van een mens komen, via
// coaStore.saveVerification. Zie correctie 3 in het Janoshik-protocol.
async function extractCoaFromUpload(naam, doc) {
  const prompt = EVIDENCE_RULES + '\n\nBekijk het bijgevoegde document, handmatig geupload door een staflid, dat een COA (certificate of analysis) zou moeten bevatten voor leverancier ' + naam + '. Lees uitsluitend letterlijk wat in het document staat; gebruik null waar een veld niet vermeld of onleesbaar is.\n\n' +
    'Antwoord met JSON: {"coaRecords":[{"product":string,"claimedQuantity":number|null,"claimedUnit":string,"measuredQuantity":number|null,"measuredUnit":string,"purityPercent":number|null,"purityMethod":string,"batchnummer":string,"reportId":string,"verificationKey":string,"sample":string,"laboratorium":string,"orderDate":string,"receivedDate":string,"analysisDate":string,"reportDate":string,"sterility":{"tested":true|false|null,"result":string,"method":string},"endotoxin":{"tested":true|false|null,"result":string,"unit":string},"overigeContaminanten":[{"parameter":string,"resultaat":string,"unit":string}]}]}';
  const isPdf = /pdf/i.test(doc.mediaType || '');
  const opts = { label: 'admin-coa-upload' };
  if (isPdf) opts.documents = [{ data: doc.data, mediaType: doc.mediaType }];
  else opts.images = [{ data: doc.data, mediaType: doc.mediaType }];
  return sampleJsonSafe(prompt, opts);
}

function stepOpts(key, ctx, waarneming) {
  const domain = domainOf(ctx.website);
  switch (key) {
    case 'identiteit': return {
      key: 'identiteit', title: 'Juridische identiteit',
      searchQueries: [ctx.naam + ' KvK nummer bedrijfsgegevens', ctx.naam + ' adres contactgegevens'],
      extractUrls: [ctx.website, ctx.website.replace(/\/$/, '') + '/contact', ctx.website.replace(/\/$/, '') + '/terms',
        ctx.website.replace(/\/$/, '') + '/privacy', ctx.website.replace(/\/$/, '') + '/about', ctx.website.replace(/\/$/, '') + '/help-center'],
      schemaHint: 'Antwoord met JSON: {"bevindingen":[{"claim":string,"classificatie":"FEIT|BRONCLAIM|ONDERBOUWDE HYPOTHESE|ONBEKEND|TEGENGESPROKEN","onderbouwing":string,"bronUrl":string}],"opvallendeAfwezigheid":[string],"vastgesteldeNaam":string,"kortSamenvatting":string}. Zet vastgesteldeNaam op de officiële bedrijfs- of handelsnaam zoals die uit de brondata blijkt (footer, KvK-vermelding, voorwaarden); laat leeg als dat niet met redelijke zekerheid valt vast te stellen.'
    };
    case 'laboratorium': {
      // Namen komen uit de COA-stap: die heeft de rapporten al gelezen. Zonder
      // die namen valt de stap terug op de oude, zwakke zoekopdracht.
      const gezien = ((waarneming && waarneming.labs) || []).map((l) => l.naam).filter(Boolean).slice(0, 3);
      const schema = 'Antwoord met JSON: {"bevindingen":[{"claim":string,"classificatie":"FEIT|BRONCLAIM|ONDERBOUWDE HYPOTHESE|ONBEKEND|TEGENGESPROKEN","onderbouwing":string,"bronUrl":string}],"labBeoordelingen":[{"naam":string,"bestaatAantoonbaar":true|false|null,"land":string,"accreditaties":[string],"publiekVerificatiesysteem":true|false|null,"werktOokVoorAndereOpdrachtgevers":true|false|null,"onafhankelijkVanLeverancier":true|false|null,"onderbouwing":string,"bronUrl":string}],"laboratoriumNaam":string,"kortSamenvatting":string}. Neem in labBeoordelingen exact de labnamen over die hieronder genoemd zijn; voeg geen labs toe die je niet in de brondata terugziet. Zet een veld op null als de brondata er niets over zegt; niet gevonden is niet hetzelfde als niet bestaand.';
      if (!gezien.length) {
        return {
          key: 'laboratorium', title: 'Laboratorium',
          searchQueries: [ctx.naam + ' laboratorium COA test', ctx.naam + ' independent lab ISO 17025', ctx.naam + ' lab accreditation testing partner'],
          researchQuery: 'Welk(e) laboratorium(s) test(en) de producten van "' + ctx.naam + '" (website: ' + ctx.website + ')? Zoek naar de naam van het laboratorium, land, accreditaties (zoals ISO/IEC 17025) en of dit laboratorium ook voor andere, niet-gelieerde leveranciers werkt. Onderzoek geen koppeling tussen leverancier en laboratorium zonder concreet bewijs zoals een gedeeld adres, bestuurder of domein.',
          schemaHint: schema
        };
      }
      const queries = [];
      gezien.slice(0, 2).forEach((naam) => {
        queries.push(naam + ' laboratory ISO 17025 accreditation');
        queries.push(naam + ' laboratory peptide testing clients');
      });
      queries.push(ctx.naam + ' ' + gezien[0] + ' lab');
      return {
        key: 'laboratorium', title: 'Laboratorium',
        searchQueries: queries,
        researchQuery: 'Op de certificaten van leverancier "' + ctx.naam + '" (website: ' + ctx.website + ') staan deze laboratoriumnamen: ' + gezien.join(', ') + '. Onderzoek per laboratorium: bestaat het aantoonbaar (eigen website, vestigingsadres, registratie), in welk land, welke accreditaties het voert (bijvoorbeeld ISO/IEC 17025, met certificaatnummer en accreditatie-instantie als die te vinden zijn), of het ook voor andere, niet-gelieerde opdrachtgevers werkt, en of er een publiek verificatiesysteem is waarmee een rapportnummer te controleren is. Onderzoek daarnaast of er een aanwijsbare band bestaat tussen ' + ctx.naam + ' en het laboratorium: gedeeld adres, gedeelde bestuurder, gedeeld domein of gedeelde eigenaar. Leg zo\'n band nooit op basis van alleen een gelijkende naam.',
        schemaHint: schema
      };
    }
    case 'coaDataset': return {
      key: 'coaDataset', title: 'COA-dataset en -authenticiteit',
      searchQueries: [ctx.naam + ' COA certificate of analysis', ctx.naam + ' COA verification lab report number', ctx.naam + ' lab results batch'],
      researchQuery: 'Zoek alle publiek vindbare COA\'s (certificates of analysis) van leverancier "' + ctx.naam + '" (website: ' + ctx.website + '). Verzamel per COA: product, geclaimde en gemeten hoeveelheid met eenheid, purity-percentage en meetmethode, batchnummer, report/task-ID, verification key, laboratoriumnaam, order/ontvangst/analyse/rapportdatum, sterility- en endotoxin-testresultaten indien vermeld, overige contaminantentests, en of het rapport extern controleerbaar is (bijv. via een verification key of publiek opzoeksysteem bij het lab).',
      schemaHint: 'Antwoord met JSON: {"coaRecords":[{"product":string,"claimedQuantity":number|null,"claimedUnit":string,"measuredQuantity":number|null,"measuredUnit":string,"purityPercent":number|null,"purityMethod":string,"batchnummer":string,"reportId":string,"verificationKey":string,"sample":string,"laboratorium":string,"orderDate":string,"receivedDate":string,"analysisDate":string,"reportDate":string,"sterility":{"tested":true|false|null,"result":string,"method":string},"endotoxin":{"tested":true|false|null,"result":string,"unit":string},"overigeContaminanten":[{"parameter":string,"resultaat":string,"unit":string}],"authenticiteitsklasse":"A|B|C|D","authenticiteitsonderbouwing":string,"externalVerification":"verified|pending|unavailable|failed|contradicted","accessStatus":"readable|inaccessible|unreadable|error","bronUrl":string}],"zoekactieVoltooid":boolean,"kortSamenvatting":string}. Verzin geen cijfers: onbekende velden worden null. Gebruik authenticiteitsklasse A (authentiek + goede batchtraceerbaarheid), B (authentiek maar koppeling beperkt), C (niet onafhankelijk verifieerbaar) of D (concreet bewijs van afwijking) exact per het hoofdprotocol; gebruik D alleen met overtuigend bewijs.'
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

    // Deterministische crawl van de eigen COA-bibliotheek van de leverancier.
    // De AI-zoekstap hierboven leunt op zoekmachine-snippets en vindt daardoor
    // een willekeurige greep - bij een testrun 2 documenten waarvan 1 van een
    // andere leverancier, terwijl er 26 op de eigen site stonden. Deze stap
    // haalt de site zelf op en pakt alles wat er werkelijk staat.
    const crawl = await coaCrawler.crawlCoaIndex(ctx.website).catch(() => null);
    const bestaandeBronnen = new Set(records.map((r) => r && r.bronUrl).filter(Boolean));
    const crawlRecords = ((crawl && crawl.documents) || [])
      .filter((d) => !bestaandeBronnen.has(d.url))
      .map((d) => ({
        product: null, batchnummer: null, purityPercent: null, laboratorium: null,
        reportId: null, verificationKey: null, authenticiteitsklasse: null,
        bronUrl: d.url,
        accessStatus: 'pending',
        uit: 'crawl',
        // Rijtekst van de COA-tabel: product, batch, purity en labnaam zoals de
        // leverancier ze zelf opgeeft. Nuttig als vergelijkingsmateriaal met wat
        // er straks in het rapport zelf blijkt te staan - niet als bewijs.
        geclaimdeContext: d.context || null,
        gevondenOp: d.gevondenOp || null
      }));
    // Directe verwijzingen naar de verificatiepagina van het lab. Hier is
    // geen leesopdracht voor nodig: de referentie staat al in de URL, dus
    // deze gaan rechtstreeks door naar de resolver. Sterker bewijs dan een
    // gehoste kopie, want er valt niets aan te bewerken.
    const verwijzingRecords = ((crawl && crawl.verificatieLinks) || []).map((v) => ({
      product: v.context || null, batchnummer: null, purityPercent: null, laboratorium: 'Janoshik',
      reportId: null, verificationKey: null, authenticiteitsklasse: null,
      verificationUrl: v.url,
      bronUrl: null,
      accessStatus: 'readable',
      uit: 'labverwijzing',
      gevondenOp: v.gevondenOp || null
    }));
    records = records.concat(crawlRecords).concat(verwijzingRecords);
    if (ctx.images && ctx.images.length) {
      const docPrompt = EVIDENCE_RULES + '\n\nBekijk de bijgevoegde afbeelding(en) van door de gebruiker geuploade documenten (COA, screenshot, productfoto) voor leverancier ' + ctx.naam + '. Beschrijf per afbeelding alleen wat letterlijk zichtbaar is. Verzin niets; gebruik null waar iets onleesbaar of niet zichtbaar is. Dit is geen onafhankelijke verificatie op zichzelf, maar telt als direct geziene brondata (accessStatus readable, parseStatus valid).\n\nAntwoord met JSON: {"coaRecords":[{"product":string,"claimedQuantity":number|null,"claimedUnit":string,"measuredQuantity":number|null,"measuredUnit":string,"purityPercent":number|null,"purityMethod":string,"batchnummer":string,"reportId":string,"verificationKey":string,"laboratorium":string,"orderDate":string,"receivedDate":string,"analysisDate":string,"reportDate":string,"sterility":{"tested":true|false|null,"result":string,"method":string},"endotoxin":{"tested":true|false|null,"result":string,"unit":string},"overigeContaminanten":[{"parameter":string,"resultaat":string,"unit":string}],"authenticiteitsklasse":"A|B|C|D","authenticiteitsonderbouwing":string,"externalVerification":"verified|pending|unavailable|failed|contradicted"}]}';
      const docData = await sampleJsonSafe(docPrompt, { images: ctx.images, label: 'coaDataset-upload' });
      const uploadedRecords = ((docData && docData.coaRecords) || []).map((r) => Object.assign({}, r, { accessStatus: 'readable', bronUrl: null, uit: 'upload' }));
      records = records.concat(uploadedRecords);
    }
    // Automatisch ophalen: voor COA's die de AI zelf al aanwees met een
    // bronUrl maar (nog) niet als 'readable' kon classificeren — vaak omdat
    // Tavily alleen een tekst-snippet van de pagina teruggaf, niet de
    // achterliggende PDF zelf — proberen we die PDF/afbeelding hier direct
    // te downloaden en als echte documentbytes aan Claude voor te leggen.
    // Zelfde mechanisme als het KvK-uittreksel-upload hierboven, alleen is
    // de bron nu een automatisch gevonden URL i.p.v. een handmatige upload.
    // Nooit fataal: een mislukte download of onleesbaar document laat de
    // oorspronkelijke AI-inschatting gewoon staan.
    const seenAutofetchUrls = new Set();
    const autofetchCandidates = [];
    records.forEach((r, idx) => {
      if (!r || !r.bronUrl || r.accessStatus === 'readable') return;
      if (seenAutofetchUrls.has(r.bronUrl)) return;
      seenAutofetchUrls.add(r.bronUrl);
      autofetchCandidates.push({ url: r.bronUrl, idx, prioriteit: r.uit === 'crawl' ? 0 : 1 });
    });
    const supplierKey = coaStore.supplierKeyFromUrl(ctx.website || ctx.naam);
    const archiveNotes = [];
    // Wat er deze run uit het archief kwam en wat opnieuw gelezen moest
    // worden. Stond alleen in de losse notities; zo is het ook op te tellen
    // en in het rapport te tonen.
    const archiefTelling = { hergebruikt: 0, opnieuwGelezen: 0, vervangen: 0, verdwenen: 0, terug: 0 };
    // Volgorde bepaalt welke documenten binnen de limiet vallen, en dat is
    // geen detail. Documenten van de eigen site van de leverancier gaan voor
    // op zoekmachinevondsten: dat volgt de bronhierarchie uit het protocol
    // (officiele bedrijfssite en originele labrapporten boven zoekresultaten).
    // Binnen de crawl blijft de paginavolgorde staan - COA-pagina's zetten de
    // nieuwste bovenaan, dus een limiet levert dan 'de N nieuwste' op. Dat is
    // een uitlegbare steekproef; 'de eerste N die toevallig langskwamen' niet.
    autofetchCandidates.sort((a, b) => (a.prioriteit - b.prioriteit));
    const lusLog = {
      recordsVoorLus: records.length,
      kandidaten: autofetchCandidates.length,
      kandidatenUitCrawl: autofetchCandidates.filter((k) => k.prioriteit === 0).length,
      limiet: COA_AUTOFETCH_MAX,
      behandeld: 0,
      uitkomsten: []
    };
    const noteer = (url, wat) => { if (lusLog.uitkomsten.length < 40) lusLog.uitkomsten.push({ url: String(url).slice(-60), wat }); };
    for (const { url, idx } of autofetchCandidates.slice(0, COA_AUTOFETCH_MAX)) {
      lusLog.behandeld++;
      // Stap 1: kennen we dit document al? Zo ja, hergebruik de analyse en
      // sla zowel de download als de (dure) vision-call over. Dit is het hele
      // punt van het archief — elk uniek COA-document gaat exact één keer
      // door vision, ooit, voor alle gebruikers en leveranciers samen.
      let cached = null;
      const head = await coaStore.checkUnchanged(url).catch(() => null);
      if (head && head.unchanged && head.sha256) {
        cached = await coaStore.getExtraction(head.sha256, COA_EXTRACTOR_VERSION);
        if (cached) { archiveNotes.push({ url, status: 'hergebruikt', reden: 'ongewijzigd (' + (head.reason || 'fingerprint') + ')' }); noteer(url, 'hergebruikt uit archief'); }
      }

      let doc = null;
      let observation = null;
      if (!cached) {
        doc = await fetchRemoteDocument(url);
        if (!doc) {
          noteer(url, 'ophalen mislukt');
          if (records[idx] && records[idx].uit === 'crawl') {
            records[idx] = Object.assign({}, records[idx], { accessStatus: 'inaccessible' });
          }
          continue;
        }
        observation = await coaStore.recordObservation({
          url, supplierKey, buffer: doc.buffer, mimetype: doc.mediaType,
          etag: doc.etag, lastModified: doc.lastModified
        });
        if (observation) {
          if (observation.change === 'replaced') {
            // Ander bestand op dezelfde URL. Dit is een bevinding, geen
            // technisch detail: een stil vervangen rapport.
            archiveNotes.push({ url, status: 'vervangen', reden: 'zelfde URL, andere inhoud dan bij de vorige controle' });
            archiefTelling.vervangen++;
          } else if (observation.change === 'moved') {
            archiveNotes.push({ url, status: 'gedeeld rapport', reden: 'zelfde document stond eerder op ' + observation.alsoSeenAt });
          }
          // Ook bij een nieuwe URL kan de analyse er al zijn: hetzelfde
          // fabrikantsrapport wordt vaak door meerdere shops gehost.
          cached = await coaStore.getExtraction(observation.sha256, COA_EXTRACTOR_VERSION);
          if (cached && observation.change !== 'replaced') {
            archiveNotes.push({ url, status: 'hergebruikt', reden: 'dit document was al eerder gelezen' });
          }
        }
      }

      if (cached) {
        archiefTelling.hergebruikt++;
        noteer(url, 'uit archief');
        const cachedRecords = ((cached && cached.coaRecords) || []).map((r) => Object.assign({}, r, { accessStatus: 'readable', bronUrl: url, uit: 'archief' }));
        if (cachedRecords.length) {
          records[idx] = cachedRecords[0];
          if (cachedRecords.length > 1) records = records.concat(cachedRecords.slice(1));
        } else if (records[idx] && records[idx].uit === 'crawl') {
          // Eerder gelezen en toen bleek het geen COA. Niet opnieuw lezen,
          // maar ook niet op 'pending' laten staan alsof er nog werk is.
          records[idx] = Object.assign({}, records[idx], { accessStatus: 'unreadable' });
        }
        continue;
      }
      try {
        const autofetchPrompt = EVIDENCE_RULES + '\n\nBekijk het bijgevoegde document, automatisch opgehaald van ' + url + ', dat volgens eerder onderzoek een COA (certificate of analysis) zou moeten bevatten voor leverancier ' + ctx.naam + '. Lees uitsluitend letterlijk wat in het document staat; gebruik null waar een veld niet vermeld of onleesbaar is. Blijkt dit document GEEN COA te zijn (bijv. een algemene productpagina of iets anders), geef dan een lege coaRecords-array terug.\n\nAntwoord met JSON: {"coaRecords":[{"product":string,"claimedQuantity":number|null,"claimedUnit":string,"measuredQuantity":number|null,"measuredUnit":string,"purityPercent":number|null,"purityMethod":string,"batchnummer":string,"reportId":string,"verificationKey":string,"laboratorium":string,"orderDate":string,"receivedDate":string,"analysisDate":string,"reportDate":string,"sterility":{"tested":true|false|null,"result":string,"method":string},"endotoxin":{"tested":true|false|null,"result":string,"unit":string},"overigeContaminanten":[{"parameter":string,"resultaat":string,"unit":string}],"authenticiteitsklasse":"A|B|C|D","authenticiteitsonderbouwing":string,"externalVerification":"verified|pending|unavailable|failed|contradicted"}]}';
        noteer(url, 'wordt gelezen');
        const autofetchData = await sampleJsonSafe(autofetchPrompt, { documents: [doc], label: 'coaDataset-autofetch' });
        const autofetchRecords = ((autofetchData && autofetchData.coaRecords) || []).map((r) => Object.assign({}, r, { accessStatus: 'readable', bronUrl: url, uit: 'auto-fetch' }));
        if (observation && observation.sha256) {
          const first = autofetchRecords[0] || {};
          await coaStore.saveExtraction(observation.sha256, COA_EXTRACTOR_VERSION, autofetchData || { coaRecords: [] }, {
            lab: first.laboratorium || null,
            taskNumber: first.reportId || null,
            keyHash: first.verificationKey ? coaStore.sha256Of(Buffer.from(String(first.verificationKey))) : null
          });
        }
        if (autofetchRecords.length) {
          records[idx] = autofetchRecords[0];
          if (autofetchRecords.length > 1) records = records.concat(autofetchRecords.slice(1));
          archiefTelling.opnieuwGelezen++;
          noteer(url, 'gelezen: ' + autofetchRecords.length + ' record(s)');
        } else if (records[idx] && records[idx].uit === 'crawl') {
          records[idx] = Object.assign({}, records[idx], { accessStatus: 'unreadable' });
          noteer(url, 'gelezen maar geen COA erin');
        } else {
          noteer(url, 'gelezen, geen record en geen crawl-placeholder');
        }
      } catch (e) {
        noteer(url, 'fout tijdens lezen: ' + ((e && e.message) || 'onbekend').slice(0, 80));
        if (records[idx] && records[idx].uit === 'crawl' && records[idx].accessStatus === 'pending') {
          records[idx] = Object.assign({}, records[idx], { accessStatus: 'error' });
        }
        // Document kon niet gelezen worden (bv. kapotte/gescande PDF) — laat
        // de oorspronkelijke AI-inschatting voor deze COA ongewijzigd staan.
      }
    }
    // ---- Labverificatie ----
    // Een task-ID is pas bewijs als het oplost naar een record op de server
    // van het lab. Klasse D (verzonnen of ingetrokken ID) kost niets om vast
    // te stellen: je hoeft alleen te zien of er een rapport terugkomt. Alleen
    // het onderscheid A (kopie klopt) tegen B (kopie is bewerkt) vraagt om het
    // lezen van de rapportafbeelding die het lab teruggeeft.
    const verificaties = [];
    let verificatieTeller = 0;
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r || (!r.reportId && !r.verificationKey && !r.verificationUrl)) continue;
      if (verificatieTeller >= LAB_VERIFY_MAX) break;
      verificatieTeller++;
      const res = await janoshik.resolveer(r).catch(() => null);
      if (!res) continue;

      let vergelijking = null;
      if (res.resolved === true && res.rapportAfbeelding) {
        const labDoc = await fetchRemoteDocument(res.rapportAfbeelding);
        if (labDoc) {
          // De labkant gaat door hetzelfde archief: de verificatieafbeelding
          // is ook maar een document, en hoeft dus maar een keer gelezen.
          const obs = await coaStore.recordObservation({
            url: res.rapportAfbeelding, supplierKey: 'lab:janoshik',
            buffer: labDoc.buffer, mimetype: labDoc.mediaType, etag: labDoc.etag, lastModified: labDoc.lastModified
          });
          let labData = obs ? await coaStore.getExtraction(obs.sha256, COA_EXTRACTOR_VERSION) : null;
          if (!labData) {
            const labPrompt = EVIDENCE_RULES + '\n\nDit is het originele testrapport zoals het laboratorium het zelf teruggeeft op zijn verificatiepagina (' + res.url + '). Lees uitsluitend letterlijk wat er staat; gebruik null waar een veld niet vermeld of onleesbaar is. Neem het veld Client over zoals het er staat, ook als dat een andere partij is dan de onderzochte leverancier.\n\n' +
              'Antwoord met JSON: {"coaRecords":[{"product":string,"batchnummer":string,"reportId":string,"verificationKey":string,"client":string,"manufacturer":string,"laboratorium":string,"purityPercent":number|null,"claimedQuantity":number|null,"measuredQuantity":number|null,"orderDate":string,"receivedDate":string,"analysisDate":string,"resultaten":[{"parameter":string,"waarde":string}]}]}';
            labData = await sampleJsonSafe(labPrompt, { documents: [labDoc], label: 'labverificatie' });
            if (obs && labData) {
              const eerste = (labData.coaRecords || [])[0] || {};
              await coaStore.saveExtraction(obs.sha256, COA_EXTRACTOR_VERSION, labData, {
                lab: 'Janoshik', taskNumber: res.taskNumber || eerste.reportId || null
              });
            }
          }
          const labRec = (labData && labData.coaRecords && labData.coaRecords[0]) || null;
          if (labRec) {
            vergelijking = janoshik.vergelijkVelden(r, labRec);
            res.labRecord = labRec;
          }
        }
      }

      const klasse = janoshik.bepaalKlasse(res, vergelijking);
      // 'failed' betekent: geprobeerd bij het lab en het lag er niet. Dat is
      // iets heel anders dan 'er stond geen verwijzing op het rapport' of
      // 'dit lab heeft geen verificatiesysteem dat wij aankunnen'. Die twee
      // zijn 'unavailable' - anders lezen ze als een verwijt dat we niet
      // kunnen onderbouwen.
      const geenReferentie = res.resolved === false && /geen bruikbare verificatiereferentie/i.test(res.status || '');
      const extern = res.resolved === true
        ? (klasse === 'B' ? 'contradicted' : (klasse === 'A' ? 'verified' : 'pending'))
        : (res.resolved === false && !geenReferentie ? 'failed' : 'unavailable');

      records[i] = Object.assign({}, r, {
        // Een eerder door het model geraden klasse wordt hier overschreven:
        // resolutie bij het lab weegt zwaarder dan een inschatting.
        // Alleen de resolver mag klasse D toekennen: D betekent 'verzonnen of
        // ingetrokken ID' en dat is een concrete beschuldiging. Een inschatting
        // van het model wordt daarom afgetopt op C.
        authenticiteitsklasse: klasse || (r.authenticiteitsklasse === 'D' ? 'C' : r.authenticiteitsklasse) || null,
        externalVerification: extern,
        verificatie: {
          url: res.url || null,
          taskNumber: res.taskNumber || null,
          status: res.status,
          opgelost: res.resolved,
          client: (res.labRecord && res.labRecord.client) || null,
          manufacturer: (res.labRecord && res.labRecord.manufacturer) || null,
          vergelekenVelden: (vergelijking && vergelijking.gelijk) || [],
          verschillen: (vergelijking && vergelijking.verschillen) || [],
          labResultaten: (res.labRecord && res.labRecord.resultaten) || null
        }
      });
      verificaties.push({
        product: r.product || null, taskNumber: res.taskNumber || null,
        klasse: klasse || null, status: res.status,
        verschillen: (vergelijking && vergelijking.verschillen.length) || 0
      });
    }

    // Menselijk geverifieerde COA's van deze leverancier altijd meenemen,
    // ongeacht of de crawl ze deze keer opnieuw vond. Dat is het hele punt van
    // de admin-pagina: wat een staflid een keer met de hand bij het lab heeft
    // nagetrokken, moet elke volgende audit van dezelfde leverancier blijven
    // verrijken - niet alleen de run waarin het is toegevoegd.
    const bekendeBronUrls = new Set(records.map((r) => r && r.bronUrl).filter(Boolean));
    const geverifieerdeDocs = await coaStore.listVerifiedDocumentsForSupplier(supplierKey).catch(() => []);
    const klasseNaarVerificatie = { A: 'verified', B: 'contradicted', C: 'unavailable', D: 'failed' };
    geverifieerdeDocs.forEach((d) => {
      const publiekeUrl = d.url && /^https?:\/\//i.test(d.url) ? d.url : null;
      if (publiekeUrl && bekendeBronUrls.has(publiekeUrl)) return;
      const ext = (d.extraction && d.extraction.coaRecords && d.extraction.coaRecords[0]) || {};
      const v = d.verification || {};
      records.push(Object.assign({}, ext, {
        laboratorium: ext.laboratorium || d.lab || null,
        reportId: ext.reportId || d.task_number || null,
        authenticiteitsklasse: d.authenticity_class || null,
        authenticiteitsonderbouwing: v.note || ('Handmatig geverifieerd bij het lab door ' + (v.checkedBy || 'een staflid') + '.'),
        externalVerification: klasseNaarVerificatie[d.authenticity_class] || 'pending',
        accessStatus: 'readable',
        bronUrl: publiekeUrl,
        // Methodegebonden herkomstlabel (M34): wie het natrok, wanneer, welke
        // officiele bron is geopend en welke velden zijn vergeleken. Zonder
        // die vier is een handmatige verificatie niet na te lopen.
        uit: 'external_verification_manual',
        verified_by: v.checkedBy || null,
        verified_at: v.checkedAt || d.verification_checked_at || null,
        officieleBron: v.resolvedUrl || null,
        matchvelden: { lab: v.lab || null, task: v.task || null, sample: v.sample || null, key: v.key || null }
      }));
    });
    if (geverifieerdeDocs.length) archiefTelling.handmatigGeverifieerd = geverifieerdeDocs.length;

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
    // Welke COA-URLs zagen we deze keer? Wat er eerder was en nu niet meer,
    // wordt op 'gone' gezet — niet verwijderd. Een leverancier die stil een
    // rapport weghaalt is een bevinding.
    const seenUrls = records.map((r) => r && r.bronUrl).filter(Boolean);
    const reconciled = await coaStore.reconcileSupplierIndex(supplierKey, seenUrls).catch(() => ({ gone: [], reappeared: [] }));
    (reconciled.gone || []).forEach((u) => archiveNotes.push({ url: u, status: 'verdwenen', reden: 'stond bij een eerdere controle wel op de site, nu niet meer' }));
    (reconciled.reappeared || []).forEach((u) => archiveNotes.push({ url: u, status: 'terug', reden: 'was eerder verdwenen, staat er nu weer' }));
    archiefTelling.verdwenen = (reconciled.gone || []).length;
    archiefTelling.terug = (reconciled.reappeared || []).length;
    const nietGeprobeerd = records.filter((r) => r && r.uit === 'crawl' && r.accessStatus === 'pending').length;
    const crawlInfo = {
      indexPaginas: (crawl && crawl.indexPages) || [],
      documentenGevonden: ((crawl && crawl.documents) || []).length,
      directeLabverwijzingen: ((crawl && crawl.verificatieLinks) || []).length,
      nieuwTenOpzichteVanZoekstap: crawlRecords.length,
      maximaalOpgehaald: COA_AUTOFETCH_MAX,
      nietGeprobeerdWegensLimiet: nietGeprobeerd,
      lus: lusLog,
      archief: archiefTelling,
      beperkingen: (crawl && crawl.notes) || ['crawl niet uitgevoerd'],
      diagnose: (crawl && crawl.diagnose) || []
    };
    result = { key: 'coaDataset', title: 'COA-dataset en -authenticiteit', data: Object.assign({}, phase.data, { coaRecords: records, intake, archief: archiveNotes, crawl: crawlInfo, labverificatie: verificaties }) };
  } else if (key === 'laboratorium') {
    // Begin bij wat de COA-stap al gezien heeft. Draait deze stap zonder
    // voorafgaande COA-stap, dan is waarneming gewoon leeg en valt stepOpts
    // terug op de oude zoekopdracht.
    const bestaand = await db.getCase(caseId).catch(() => null);
    const coaData = (bestaand && bestaand.phaseData && bestaand.phaseData.coaDataset && bestaand.phaseData.coaDataset.data) || null;
    const waarneming = labsUitCoaData(coaData);
    const fase = await runPhase(ctx, stepOpts('laboratorium', ctx, waarneming));
    const data = Object.assign({}, (fase && fase.data) || {});
    const gevonden = Array.isArray(data.bevindingen) ? data.bevindingen : [];
    // Waarnemingen eerst: die zijn geteld, de rest is onderzoek.
    data.bevindingen = labBevindingenUitWaarneming(waarneming).concat(gevonden);
    data.labs = koppelLabBeoordelingen(waarneming.labs, data.labBeoordelingen);
    data.labWaarneming = { gelezenRapporten: waarneming.gelezenRapporten, rapportenZonderLabnaam: waarneming.zonderLabnaam };
    if (!data.laboratoriumNaam && waarneming.labs.length) data.laboratoriumNaam = waarneming.labs[0].naam;
    delete data.labBeoordelingen;
    result = { key: 'laboratorium', title: 'Laboratorium', data };
  } else if (key === 'identiteit') {
    result = await runPhase(ctx, stepOpts('identiteit', ctx));
    if (ctx.kvkDocument) {
      const kvkPrompt = EVIDENCE_RULES + '\n\nBekijk het bijgevoegde, door de gebruiker geüploade KvK-uittreksel (PDF) voor leverancier ' + ctx.naam + '. Lees uitsluitend letterlijk wat in het document staat; gebruik null waar een veld niet vermeld of onleesbaar is. Dit telt als direct geziene brondata (niet zelf op te zoeken, geen bronUrl).\n\n' +
        'Antwoord met JSON: {"leesbaar":boolean,"kvkGegevens":{"bedrijfsnaam":string,"handelsnamen":[string],"kvkNummer":string,"rechtsvorm":string,"adres":string,"vestigingsplaats":string,"oprichtingsdatum":string,"status":string,"bestuurders":[string]}}';
      const kvkData = await sampleJsonSafe(kvkPrompt, { documents: [ctx.kvkDocument], label: 'identiteit-kvkUpload' });
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

async function runCategorize(caseId, ctx, tier) {
  const startedAt = Date.now();
  await beginStep(caseId, 'categorize');
  const c = await db.getCase(caseId);
  const phaseData = c.phaseData || {};
  const slimPhases = trimPhasesForPrompt(phaseData);
  const coaRecords = (phaseData.coaDataset && phaseData.coaDataset.data && phaseData.coaDataset.data.coaRecords) || [];
  // L01 kreeg tot nu toe geen enkele instructie mee, terwijl het 40% van de
  // gratis score is. Zonder uitleg leest een leeg labveld als "fout" in plaats
  // van "niet gevonden".
  const l01Note = 'Voor L01 (Lab): oordeel op het veld labs uit de laboratoriumstap. Rapportnummers die daadwerkelijk oplossen op de eigen verificatiepagina van het lab zijn het sterkste bewijs dat hier te halen valt. Ontbrekende of onvindbare accreditatiegegevens zijn oranje of wit, nooit rood. Rood alleen bij een concreet aantoonbaar probleem, bijvoorbeeld rapportnummers die bij het lab niet oplossen of een laboratorium waarvan aantoonbaar is dat het niet bestaat. Dat de leverancier zelf als opdrachtgever op het rapport staat is in deze branche gebruikelijk en op zichzelf geen minpunt; het beperkt wel de onafhankelijkheid van de monstername, wat bij C06 hoort.';
  const b02Note = tier === 'deep'
    ? 'Beoordeel B02 (Eigenaren/bestuurders) net als de andere categorieën inhoudelijk, op basis van de aangeleverde fasegegevens (identiteitsstap, eventueel KvK-uittreksel).'
    : 'B02 (Eigenaren/bestuurders) hoort bij Deep en blijft in deze gratis check "white" met reden "buiten scope van de gratis check", tenzij een van de fasegegevens toevallig al een bestuurder/eigenaar noemt.';
  const prompt = EVIDENCE_RULES + '\n\nWijs voor leverancier ' + ctx.naam + ' (' + ctx.website + ') een kleur en onderbouwing toe aan elk van de 17 vaste categorieën, uitsluitend gegrond op de aangeleverde fasegegevens. Gebruik exact: "green" (sterk/goed verifieerbaar), "orange" (beoordeelbaar met aandachtspunten), "red" (concreet aantoonbaar probleem, nooit alleen wegens ontbrekende informatie), "white" (onvoldoende informatie). Voor C02 (Identity), C03 (Purity), C04 (Quantity): zet independentlyAssessable op false als de ENIGE analytische onderbouwing van onvoldoende onafhankelijk verifieerbare labs komt (bijv. alleen het lab zelf, geen externe verificatie) — de score-engine zet die dan automatisch op wit. ' + l01Note + ' ' + b02Note + ' Beoordeel ook adequacy: kunnen authenticiteit, identiteit en monster-naar-rapport-naar-verkochte-batch inhoudelijk beoordeeld worden (adequacy.coa), en zijn de relevante labs/rapporten onafhankelijk voldoende verifieerbaar (adequacy.lab)? Geef bij elke categorie een korte (1-2 zinnen) onderbouwing.\n\n' +
    'Samengevatte fasegegevens (JSON):\n' + JSON.stringify(slimPhases) + '\n\n' +
    'Ruwe COA-dataset (JSON, voor C01-C09):\n' + JSON.stringify(trimList(coaRecords, 12, 400)) + '\n\n' +
    'Antwoord met compacte JSON, exact dit schema: {"categories":{"C01":{"color":string,"rationale":string},"C02":{"color":string,"rationale":string,"independentlyAssessable":boolean},"C03":{"color":string,"rationale":string,"independentlyAssessable":boolean},"C04":{"color":string,"rationale":string,"independentlyAssessable":boolean},"C05":{"color":string,"rationale":string},"C06":{"color":string,"rationale":string},"C07":{"color":string,"rationale":string},"C08":{"color":string,"rationale":string},"C09":{"color":string,"rationale":string},"L01":{"color":string,"rationale":string},"B01":{"color":string,"rationale":string},"B02":{"color":string,"rationale":string},"B03":{"color":string,"rationale":string},"B04":{"color":string,"rationale":string},"B05":{"color":string,"rationale":string},"R01":{"color":string,"rationale":string},"R02":{"color":string,"rationale":string}},"adequacy":{"coa":boolean|null,"lab":boolean|null,"rationale":string}}';
  const data = await sampleJsonSafe(prompt, { label: 'categorize' });
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

async function runSynthesis(caseId, ctx, tier) {
  const c = await db.getCase(caseId);
  const phaseData = c.phaseData || {};
  const slimJson = JSON.stringify(trimPhasesForPrompt(phaseData));
  const categorySummary = JSON.stringify(c.categoryAssessments || {});
  const engineSummary = JSON.stringify(Object.assign(
    {
      gate: c.engineResult && c.engineResult.gate,
      evidenceScore: c.engineResult && c.engineResult.evidenceScore && {
        published: c.engineResult.evidenceScore.published, value: c.engineResult.evidenceScore.value,
        coverage: c.engineResult.evidenceScore.coverage, reason: c.engineResult.evidenceScore.reason
      }
    },
    tier === 'deep' ? {
      supplierScore: c.engineResult && c.engineResult.deep && {
        value: c.engineResult.deep.value, coverage: c.engineResult.deep.coverage
      }
    } : {}
  ));
  const contextHeader = EVIDENCE_RULES + '\n\nSamengevatte per-fase bevindingen voor leverancier ' + ctx.naam + ' (' + ctx.website + '), JSON:\n' + slimJson + '\n\n' +
    'Reeds vastgestelde categoriebeoordelingen (kleur/onderbouwing per categorie, door een eerdere stap bepaald, JSON):\n' + categorySummary + '\n\n' +
    'Reeds berekende gate/score (deterministisch, niet herinterpreteren of een eigen score noemen, JSON):\n' + engineSummary + '\n\n';

  const scopeNote = tier === 'deep'
    ? 'Dit is de betaalde Deep Dive: naast het productbewijs is nu ook de leverancier zelf onderzocht (bedrijfsidentiteit, eigenaren/bestuurders, bedrijfshistorie, domein-tijdlijn, regelgeving/toezicht). Beoordeel dit volledig mee, inclusief eventuele rode vlaggen die daaruit blijken.'
    : 'Een ontbrekend KvK-uittreksel of B02 (eigenaren/bestuurders, dat is Deep-scope) is nooit op zichzelf reden voor een rode vlag of aandachtspunt in deze gratis check.';

  const startedA = Date.now();
  await beginStep(caseId, 'reportA');
  const promptA = contextHeader +
    'Stel op basis hiervan het EERSTE deel van het tussenrapport samen: een narratieve duiding van de al vastgestelde categoriebeoordelingen en gate/score, GEEN eigen scorekaart of cijfer. Noem geen percentage of score die niet letterlijk in de aangeleverde engine-uitkomst staat. ' + scopeNote + ' Houd elk tekstveld kort (1-2 zinnen).\n\n' +
    'Antwoord met compacte JSON, exact dit schema: {"executiveSummary":string,"sterkstePositieveBevindingen":[string],"belangrijksteAandachtspunten":[string],"rodeVlaggen":[{"omschrijving":string,"bron":string}],"nietVerifieerbaar":[string],"documentanalyse":[{"omschrijving":string,"product":string,"batchnummer":string,"purity":string,"laboratorium":string}]}';
  const reportA = await sampleJsonSafe(promptA, { label: 'reportA' });
  await finishStep(caseId, 'reportA', startedA);

  const startedB = Date.now();
  await beginStep(caseId, 'reportB');
  const promptB = contextHeader +
    'Stel op basis hiervan het TWEEDE deel van het tussenrapport samen: vervolgvragen aan de leverancier, eindconclusie en bronnenregister (verzamel de bronUrl-velden uit de fasegegevens). Houd elk tekstveld kort.\n\n' +
    'Antwoord met compacte JSON, exact dit schema: {"top5Vragen":[string],"eindconclusie":string,"bronnenregister":[{"url":string,"titel":string}]}';
  const reportB = await sampleJsonSafe(promptB, { label: 'reportB' });
  await finishStep(caseId, 'reportB', startedB);

  const report = Object.assign({}, reportA, reportB);
  await db.updateCase(caseId, { report });
}

// Gratis tier: alleen FREE_STEP_KEYS (coaDataset + laboratorium), dan
// categorize/engine/synthese in "gratis"-stand. Eindigt op status
// 'gratis_klaar' (niet 'klaar') zodat de UI een bewuste "ga door naar Deep
// Dive"-stap kan tonen in plaats van de audit als volledig afgerond te laten
// lijken. Draait async (fire-and-forget vanuit de route); de client volgt
// voortgang via GET /api/audits/:id.
async function runFreeTier(caseId, ctx) {
  try {
    // Schermafdruk van de website, los van de stappen: hij hoort bij het
    // rapport maar mag de audit niet vertragen of laten vallen. De uitkomst
    // gaat naar de log, zodat in Railway te zien is wat hier gebeurde.
    siteShot.ensureShot(ctx.website)
      .then((r) => { if (r && r.status) console.log('schermafdruk ' + ctx.website + ': ' + r.status); })
      .catch((e) => console.log('schermafdruk ' + ctx.website + ' mislukt: ' + ((e && e.message) || e)));
    for (const key of FREE_STEP_KEYS) {
      await ensureNotStopped(caseId);
      await runResearchStep(caseId, ctx, key);
    }
    await ensureNotStopped(caseId);
    await runCategorize(caseId, ctx, 'gratis');
    await ensureNotStopped(caseId);
    await applyScoringEngine(caseId);
    await ensureNotStopped(caseId);
    await runSynthesis(caseId, ctx, 'gratis');
    await db.updateCase(caseId, { status: 'gratis_klaar', tier: 'gratis', currentStep: null });
  } catch (e) {
    if (!e || !e.stopped) {
      await db.updateCase(caseId, { status: 'fout', error: (e && e.message) || 'onbekende fout', currentStep: null });
    }
  }
}

// Betaalde vervolgstap (nog zonder betaalstraat, zie server.js
// /continue-deep): draait de resterende DEEP_STEP_KEYS boven op de al
// aanwezige gratis fasegegevens van dezelfde case, en herberekent daarna
// categorize/engine/synthese in "deep"-stand over de volledige, gecombineerde
// dataset — dus geen apart "deep-rapport", hetzelfde rapport wordt verrijkt.
async function runDeepTier(caseId, ctx) {
  try {
    for (const key of DEEP_STEP_KEYS) {
      await ensureNotStopped(caseId);
      await runResearchStep(caseId, ctx, key);
    }
    await ensureNotStopped(caseId);
    await runCategorize(caseId, ctx, 'deep');
    await ensureNotStopped(caseId);
    await applyScoringEngine(caseId);
    await ensureNotStopped(caseId);
    await runSynthesis(caseId, ctx, 'deep');
    await db.updateCase(caseId, { status: 'klaar', tier: 'deep', currentStep: null });
  } catch (e) {
    if (!e || !e.stopped) {
      await db.updateCase(caseId, { status: 'fout', error: (e && e.message) || 'onbekende fout', currentStep: null });
    }
  }
}

module.exports = {
  runFreeTier, runDeepTier, runResearchStep, runCategorize, applyScoringEngine, runSynthesis,
  ensureNotStopped, stopAudit, RESEARCH_STEP_KEYS, FREE_STEP_KEYS, DEEP_STEP_KEYS, STEP_DEFS,
  extractCoaFromUpload, COA_EXTRACTOR_VERSION
};
