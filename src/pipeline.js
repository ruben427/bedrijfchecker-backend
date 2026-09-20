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
const ilsLab = require('./ilsLab');

// Versie van de COA-leeslaag. Analyseresultaten worden gecachet op
// (documenthash, deze versie). Verhoog dit ALLEEN bewust: elke wijziging
// betekent dat alle eerder gelezen COA's opnieuw door vision gaan.
const COA_EXTRACTOR_VERSION = 'coa-read-1';
const { runScoringEngine, computeQuantity, CATEGORY_DEFS } = require('./scoringEngine');
const { bouwBlokken } = require('./blokken');
// Het aantal categorieen stond op vier plekken los ingetypt. Hier komt het
// uit de lijst zelf, zodat het label niet stilletjes verloopt zodra er een
// categorie bij komt. LET OP: in bedrijfchecker.html en frontend/index.html
// staat het getal nog wel met de hand - die kunnen deze lijst niet lezen.
const AANTAL_CATEGORIEEN = CATEGORY_DEFS.length;
const db = require('./db');

// Hoeveel kandidaat-COA-URL's we per case maximaal automatisch proberen te
// downloaden en te laten uitlezen. Elke poging is een extra fetch + een
// Claude-call, dus bewust begrensd zodat één leverancier met veel
// COA-vermeldingen de stap niet onnodig lang maakt.
const COA_AUTOFETCH_MAX = Number(process.env.COA_AUTOFETCH_MAX) || 30;
// Tijdsbudget voor de documentlus. Een aantal alleen is geen begrenzing: 30
// documenten die elk een vision-call nodig hebben kunnen bij tegenslag (een
// herkansing van 120s per stuk) een uur duren. Gemeten op 20 september: de
// COA-stap van balticpeptides stond na twintig minuten nog te draaien tegen
// een gemiddelde van 45 seconden. Wat niet binnen het budget past wordt
// overgeslagen EN gemeld - stilzwijgend stoppen is erger dan lang duren.
const COA_LUS_BUDGET_MS = Number(process.env.COA_LUS_BUDGET_MS) || 6 * 60 * 1000;
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
  "8. Over de identiteitsvelden in een COA-schema, als die gevraagd worden. identiteitsmethode is de methode waarmee het rapport vaststelt WELKE stof is aangetroffen, bijvoorbeeld MS, LC-MS, MS/MS, moleculair gewicht, aminozuuranalyse of vergelijking met een referentiestandaard. Neem die letterlijk over of gebruik null. identiteitBevestigd is alleen true wanneer het rapport zelf de aangetroffen stof benoemt op grond van zo een methode; een productnaam op het etiket of een zuiverheidspercentage is GEEN identiteitsbepaling. blindTest is true wanneer het rapport vermeldt dat het lab vooraf niet wist welke stof het moest aantreffen. Bij twijfel null. vialen is voor een rapport dat HETZELFDE product in meerdere vialen meet. Zo een regel ziet eruit als '25.29 mg; 25.19 mg; 25.41 mg' met daarnaast '99.829%; 99.810%; 99.795%': drie vialen van een stof, niet drie stoffen. Zet elke viaal apart in vialen met zijn eigen gemeten milligrammen en zuiverheid. Verwar dit NIET met componenten - dat zijn verschillende stoffen in een vial. Middel de waarden niet zelf; de spreiding tussen vialen is zelf een waarneming. geclaimdMg per component is optioneel en meestal leeg: bij een blend als 'Glow 70mg' staat nergens wat die 70 per stof claimt. Laat het dan weg en vul alleen claimedQuantity op productniveau. componenten is voor blends: een vial met meer dan een stof erin, zoals GLOW of KLOW. Zo een rapport geeft per stof een eigen gemeten hoeveelheid. Neem elke regel over als eigen component met de stofnaam en de gemeten milligrammen. Is een van de componenten zelf een metaalcomplex, zet dan het metaalcomplex BIJ DIE COMPONENT. Voorbeeld: 'GHK-Cu (GHK content) [Copper Content] 68.27 mg (59.83 mg) [8.44 mg]' plus 'TB-500 (TB4) 13.20 mg' plus 'BPC-157 13.13 mg' geeft drie componenten, waarvan de eerste een kopercomplex is. Laat componenten leeg bij een vial met een enkele stof. Tel de componenten NIET bij elkaar op tot een totaal - dat doen wij verderop, en alleen als duidelijk is wat het etiket claimt. metaalcomplex is iets heel anders dan zwareMetalen: sommige peptiden WORDEN geleverd als complex met een metaal, en dan hoort dat metaal in het product. GHK-Cu is het bekendste voorbeeld. Zo een rapport toont drie getallen, bijvoorbeeld 'GHK-Cu (GHK content) [Copper Content]  61.77 mg (51.71 mg) [10.06 mg]': het totaal van het complex, het peptidegehalte, en het metaalgehalte. Neem alle drie over in metaalcomplex met de naam van het metaal. Zet ze NIET in zwareMetalen - dat veld is voor verontreiniging, en koper in GHK-Cu is geen verontreiniging maar het product. Laat metaalcomplex null als het rapport geen complex noemt. zwareMetalen hoort apart van overigeContaminanten: zet daar lood, cadmium, kwik, arseen, chroom en andere zware metalen in, met de gemeten waarde en de norm zoals ze op het rapport staan. tested is true zodra het rapport zware metalen rapporteert, ook als er geen norm bij staat. overigeContaminanten blijft voor de rest. Sommige leveranciers laten de zware metalen als APART certificaat per batch maken, los van het zuiverheidsrapport; dat is dan een eigen coaRecord waarin alleen zwareMetalen gevuld is en purityPercent null blijft. identiteitGetoetstTegen is de stof die het rapport bij de identiteitsbepaling noemt als de verwachte of aangetroffen stof, letterlijk overgenomen. Dat is NIET hetzelfde als de productnaam op het etiket: een rapport kan als product 'GLP-3' noemen terwijl de identiteit is getoetst tegen retatrutide. Neem beide velden over zoals ze er staan en maak ze niet gelijk aan elkaar. Null als het rapport geen stof bij de identiteitsbepaling noemt.",
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
  { key: 'categorize', label: 'Categoriebeoordeling (' + AANTAL_CATEGORIEEN + ' categorieën)' },
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
        klassen: {}, klassenBron: {}, opdrachtgevers: [], voorbeeldBronnen: []
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
    if (r.authenticiteitsklasse) {
      l.klassen[r.authenticiteitsklasse] = (l.klassen[r.authenticiteitsklasse] || 0) + 1;
      // Waar een klasse vandaan komt is minstens zo belangrijk als de letter.
      // Een A van de resolver en een A van een mens zijn verschillende
      // uitspraken, en tot 20 september kwam er ook nog een A van het model.
      const bron = r.klasseBron || 'onbekend';
      l.klassenBron[bron] = (l.klassenBron[bron] || 0) + 1;
    }
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
// Wat het model over een lab vond, naast wat een MENS erover heeft
// vastgesteld. De volgorde is niet vrijblijvend: het oordeel van de mens is
// het oordeel, het model levert hoogstens achtergrond.
//
// Waarom dat hier moest: op 20 september stond in het bronnenregister van
// peptidekliniek.nl een ISO 17025-accreditatie op naam van 'RCI Asia
// Assayers', en in een volgende run 'RC Testing Service (rctesting.com) -
// cleanroom en apparatuurtesting'. Geen van beide is het lab op de
// certificaten. Het model zoekt op de labnaam, vindt een bedrijf dat erop
// lijkt, en levert accreditatiemateriaal aan. Naast een menselijk oordeel
// 'onvoldoende verifieerbaar' leest dat als tegenspraak.
//
// Zodra een mens iets heeft vastgelegd dat niet 'erkend' is, gaan de
// bevestigende velden van het model eruit. Ze zijn niet weerlegd; ze slaan
// mogelijk op een ander bedrijf, en dat is precies het punt.
const MODEL_BEVESTIGT = ['bestaatAantoonbaar', 'accreditaties', 'publiekVerificatiesysteem',
  'werktOokVoorAndereOpdrachtgevers', 'onafhankelijkVanLeverancier'];

function koppelLabBeoordelingen(labs, beoordelingen, menselijkeOordelen) {
  const perNaam = new Map();
  (beoordelingen || []).forEach((b) => {
    if (b && b.naam) perNaam.set(normaliseerLabnaam(b.naam), b);
  });
  const oordelen = menselijkeOordelen || {};
  return (labs || []).map((l) => {
    const netteNaam = coaStore.normaliseerLab(l.naam).naam;
    const oordeel = oordelen[coaStore.labSleutel(netteNaam)] || null;
    let extern = perNaam.get(normaliseerLabnaam(l.naam)) || null;
    let externOnderdrukt = null;
    if (extern && oordeel && oordeel.status !== 'erkend') {
      const gestript = Object.assign({}, extern);
      MODEL_BEVESTIGT.forEach((k) => { delete gestript[k]; });
      externOnderdrukt = 'Een mens heeft dit lab beoordeeld als "' + oordeel.status +
        '". Wat het model op naam vond is daarmee geen bevestiging: de kans is reeel dat het een ander bedrijf met een gelijkende naam betreft. Alleen de omschrijving en bron zijn blijven staan.';
      extern = gestript;
    }
    return Object.assign({}, l, {
      // LEIDEND. Dit is wat naar buiten gaat.
      oordeel: oordeel ? {
        status: oordeel.status, onderbouwing: oordeel.onderbouwing,
        vastgelegdDoor: oordeel.vastgelegdDoor || oordeel.vastgelegd_door || null,
        bronnen: oordeel.bronnen || null
      } : null,
      // Achtergrond van het model. Nooit leidend.
      extern, externOnderdrukt
    });
  });
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

async function runPhase(ctx, opts, caseId) {
  // Deze functie was de stille veertig seconden aan het begin van elke stap:
  // drie zoekacties en daarna een modelaanroep, zonder een enkel teken van
  // leven. Vandaar dat er onder de lopende stap alleen "Nog geen tussenstand"
  // stond. Elke deelactie meldt zich nu.
  const melden = (t) => (caseId ? meldStap(caseId, t).catch(() => {}) : Promise.resolve());

  let searchResults = [];
  if (opts.searchQueries && opts.searchQueries.length) {
    await melden('Zoeken op het web: "' + String(opts.searchQueries[0]).slice(0, 90) + '"' +
      (opts.searchQueries.length > 1 ? (' en ' + (opts.searchQueries.length - 1) + ' andere zoekopdracht(en)') : ''));
    searchResults = await tavilySearch(opts.searchQueries);
    await melden(searchResults.length + ' zoekresultaat/resultaten binnen');
  }

  let extractResults = { ok: [], failed: [] };
  if (opts.extractUrls && opts.extractUrls.length) {
    await melden(opts.extractUrls.length + ' pagina(s) ophalen en uitlezen');
    extractResults = await tavilyExtract(opts.extractUrls);
    await melden(extractResults.ok.length + ' pagina(s) gelezen, ' + extractResults.failed.length + ' niet opgehaald');
  }

  let researchResult = null;
  if (opts.researchQuery) {
    await melden('Verdiepend onderzoek uitvoeren - dit is meestal de langste deelstap');
    researchResult = await tavilyResearch(opts.researchQuery);
    await melden(researchResult ? 'Verdiepend onderzoek afgerond' : 'Verdiepend onderzoek leverde niets op');
  }

  const raw = {
    zoekresultaten: trimList(searchResults, 8, 500),
    paginaExtracties: trimList(extractResults.ok, 5, 1200),
    nietOpgehaaldePaginas: extractResults.failed,
    aanvullendOnderzoek: researchResult ? { samenvatting: (researchResult.content || '').slice(0, 3000), bronnen: researchResult.sources } : null
  };

  const prompt = EVIDENCE_RULES + '\n\nOnderzoeksfase: ' + opts.title + '\nLeverancier: ' + ctx.naam + '\nWebsite: ' + ctx.website + '\n\n' +
    'Ruwe brondata (JSON):\n' + JSON.stringify(raw) + '\n\n' + opts.schemaHint;

  await melden('Het model laten lezen wat er is opgehaald (' + opts.title + ')');
  const data = await sampleJsonSafe(prompt, { label: opts.key });
  await melden('Antwoord van het model binnen');
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
    'Antwoord met JSON: {"coaRecords":[{"product":string,"claimedQuantity":number|null,"claimedUnit":string,"measuredQuantity":number|null,"measuredUnit":string,"purityPercent":number|null,"purityMethod":string,"identiteitsmethode":string,"identiteitBevestigd":true|false|null,"identiteitGetoetstTegen":string,"blindTest":true|false|null,"batchnummer":string,"reportId":string,"verificationKey":string,"sample":string,"laboratorium":string,"orderDate":string,"receivedDate":string,"analysisDate":string,"reportDate":string,"sterility":{"tested":true|false|null,"result":string,"method":string},"endotoxin":{"tested":true|false|null,"result":string,"unit":string},"zwareMetalen":{"tested":true|false|null,"resultaten":[{"metaal":string,"resultaat":string,"norm":string,"unit":string}]},"metaalcomplex":{"metaal":string,"totaalMg":number|null,"peptideMg":number|null,"metaalMg":number|null},"componenten":[{"stof":string,"gemetenMg":number|null,"geclaimdMg":number|null,"metaalcomplex":{"metaal":string,"totaalMg":number|null,"peptideMg":number|null,"metaalMg":number|null}}],"vialen":[{"gemetenMg":number|null,"purityPercent":number|null}],"overigeContaminanten":[{"parameter":string,"resultaat":string,"unit":string}]}]}';
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
      researchQuery: 'Zoek alle publiek vindbare COA\'s (certificates of analysis) van leverancier "' + ctx.naam + '" (website: ' + ctx.website + '). Verzamel per COA: product, geclaimde en gemeten hoeveelheid met eenheid, purity-percentage en meetmethode, batchnummer, report/task-ID, verification key, laboratoriumnaam, order/ontvangst/analyse/rapportdatum, sterility- en endotoxin-testresultaten indien vermeld, overige contaminantentests, en of het rapport extern controleerbaar is (bijv. via een verification key of publiek opzoeksysteem bij het lab). Verzamel daarnaast de kwaliteitsbeloften die de leverancier ZELF op zijn site doet over zuiverheid: elke zin waarin een drempel of ondergrens staat, bijvoorbeeld "batches below 98% purity are rejected" of "minimaal 99% zuiverheid". Neem de zin letterlijk over met de bron-URL.',
      schemaHint: 'Antwoord met JSON: {"coaRecords":[{"product":string,"claimedQuantity":number|null,"claimedUnit":string,"measuredQuantity":number|null,"measuredUnit":string,"purityPercent":number|null,"purityMethod":string,"identiteitsmethode":string,"identiteitBevestigd":true|false|null,"identiteitGetoetstTegen":string,"blindTest":true|false|null,"batchnummer":string,"reportId":string,"verificationKey":string,"sample":string,"laboratorium":string,"orderDate":string,"receivedDate":string,"analysisDate":string,"reportDate":string,"sterility":{"tested":true|false|null,"result":string,"method":string},"endotoxin":{"tested":true|false|null,"result":string,"unit":string},"zwareMetalen":{"tested":true|false|null,"resultaten":[{"metaal":string,"resultaat":string,"norm":string,"unit":string}]},"metaalcomplex":{"metaal":string,"totaalMg":number|null,"peptideMg":number|null,"metaalMg":number|null},"componenten":[{"stof":string,"gemetenMg":number|null,"geclaimdMg":number|null,"metaalcomplex":{"metaal":string,"totaalMg":number|null,"peptideMg":number|null,"metaalMg":number|null}}],"vialen":[{"gemetenMg":number|null,"purityPercent":number|null}],"overigeContaminanten":[{"parameter":string,"resultaat":string,"unit":string}],"verificatieDomein":string,"verificatieInstructie":string,"accessStatus":"readable|inaccessible|unreadable|error","bronUrl":string}],"kwaliteitsbeloften":[{"belofte":string,"drempelPercent":number|null,"bronUrl":string}],"zoekactieVoltooid":boolean,"kortSamenvatting":string}. "kwaliteitsbeloften" zijn uitspraken van de LEVERANCIER zelf over een zuiverheidsdrempel, niet van het lab: neem de zin letterlijk over in "belofte" en zet het genoemde percentage in "drempelPercent". Staat er geen percentage in de zin, dan null. Lege lijst als de site geen drempel noemt. Verzin geen cijfers: onbekende velden worden null. Ken zelf GEEN authenticiteitsklasse toe en geef geen oordeel over echtheid. Dat gebeurt verderop, door de referentie bij het laboratorium zelf op te lossen of door een mens. Lees in plaats daarvan letterlijk uit: "verificatieDomein" is het webadres dat het rapport noemt om de test te controleren (bijvoorbeeld www.janoshik.com/verify/), exact zoals het er staat - ook als het er vreemd uitziet, want een afwijkend domein is zelf een waarneming. "verificatieInstructie" is de volledige zin waarin dat staat. Null als er niets over verificatie op het rapport staat.'
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
  stapLog.delete(caseId);
  await db.updateCase(caseId, { status: 'gestopt', currentStep: null });
}

// Live-voortgang binnen een stap. Reden: een stap kan minuten duren en tot nu
// toe stond er alleen "bezig". Dan is niet te zien of er nog iets gebeurt of
// dat het vastloopt, en dat is precies het moment waarop iemand het tabblad
// sluit. Het logje gaat mee in currentStep, dus de frontend krijgt het bij
// elke poll mee zonder nieuw endpoint.
//
// In het geheugen, niet uit de database teruggelezen: een case draait in een
// proces achter elkaar. Na een herstart is het logje leeg en staat er weer
// alleen "bezig" - vervelend, niet fout.
const stapLog = new Map();
const STAP_LOG_MAX = 14;

async function meldStap(caseId, tekst) {
  if (!caseId || !tekst) return;
  const huidig = stapLog.get(caseId);
  if (!huidig) return;
  huidig.log.push({ t: Date.now(), tekst: String(tekst).slice(0, 200) });
  if (huidig.log.length > STAP_LOG_MAX) huidig.log = huidig.log.slice(-STAP_LOG_MAX);
  huidig.detail = String(tekst).slice(0, 200);
  await db.updateCase(caseId, { currentStep: Object.assign({}, huidig) }).catch(() => {});
}

async function beginStep(caseId, key) {
  const stap = { key, label: stepLabel(key), startedAt: Date.now(), detail: null, log: [] };
  stapLog.set(caseId, stap);
  await db.updateCase(caseId, { currentStep: stap });
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

// Telt dit COA als identiteitsbepaling (C02)? Uitsluitend op grond van wat er
// expliciet in het document staat. Een productnaam op het etiket en een
// zuiverheidspercentage zeggen niets over WELKE stof is aangetroffen.
//
// Bewust streng: zonder expliciet bewijs telt identity niet mee. Dat levert
// PARTIAL in plaats van PASS, en beide mogen publiceren - dit verandert dus
// geen score, alleen de eerlijkheid van het label.
//
// LET OP: wat precies als identiteitsbepaling mag gelden is een methodische
// vraag die bij Annemarie ligt (A14). Tot die beantwoord is staat hier de
// conservatieve variant.
// ---------------------------------------------------------------------------
// BELOFTE TEGENOVER EIGEN CIJFERS (20 september 2026)
//
// Gevonden bij balticpeptides: de site belooft "batches that do not meet our
// >=99% purity threshold are not released" en noemt elders op dezelfde pagina
// een >=98%-poort. In de lijst eronder staan vijf producten onder 99% en vier
// onder 98%, gewoon te koop.
//
// Dit is de zeldzame controle die geen oordeel vraagt om te signaleren: de
// leverancier levert zelf de norm en zelf de meting. Wij leggen ze naast
// elkaar. Hoe zwaar het weegt is een andere vraag, en die ligt bij Annemarie.
//
// Bij meerdere drempels toetsen we tegen de SOEPELSTE. Wie zichzelf
// tegenspreekt krijgt de voor hem gunstigste lezing; dat de drempels
// onderling verschillen staat apart gemeld in meerdereDrempels.
function toetsZuiverheidsbelofte(beloften, records) {
  const ruw = (beloften || [])
    .map((b) => Number(b && b.drempelPercent))
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 100);
  const drempels = [...new Set(ruw)].sort((a, b) => a - b);
  if (!drempels.length) return null;

  // LET OP: Number(null) is 0 en Number.isFinite(0) is true. Zonder de
  // null-check belandde elk record zonder zuiverheid als 0% in de lijst
  // 'onder de drempel'. Gevonden door de toets op de Baltic-cijfers te
  // draaien: acht records geteld waar er zeven een percentage hadden.
  const gemeten = (records || []).filter((r) =>
    r && r.purityPercent !== null && r.purityPercent !== undefined &&
    r.purityPercent !== '' && Number.isFinite(Number(r.purityPercent)));
  if (!gemeten.length) {
    return { drempels, meerdereDrempels: drempels.length > 1, metZuiverheid: 0, onder: [], aantalOnder: 0 };
  }

  const soepelste = drempels[0];
  const onder = gemeten
    .filter((r) => Number(r.purityPercent) < soepelste)
    .map((r) => ({
      product: r.product || null,
      purityPercent: Number(r.purityPercent),
      bronUrl: r.bronUrl || null
    }))
    .sort((a, b) => a.purityPercent - b.purityPercent);

  return {
    drempels,
    meerdereDrempels: drempels.length > 1,
    soepelsteDrempel: soepelste,
    strengsteDrempel: drempels[drempels.length - 1],
    metZuiverheid: gemeten.length,
    onder,
    aantalOnder: onder.length
  };
}

function heeftIdentiteitsbepaling(r) {
  if (!r) return false;
  if (r.identiteitBevestigd === true) return true;
  if (r.blindTest === true && r.product) return true;
  const m = r.identiteitsmethode ? String(r.identiteitsmethode).toLowerCase() : '';
  if (!m) return false;
  return /(^|[^a-z])ms([^a-z]|$)|mass spec|massaspec|lc-?ms|ms\/ms|moleculair|molecular weight|aminozuur|amino acid|referentiestandaard|reference standard/.test(m);
}

// ---------------------------------------------------------------------------
// LABRESOLVER (19 september 2026)
//
// Haalt een labreferentie op bij het laboratorium zelf, leest het rapport uit
// en legt vast wat erop staat. Gemeten op dezelfde dag: van de zeven
// verificatiesystemen die we kennen laat alleen Janoshik onze server niet
// binnen. Bij Bridge Analytical lost de link direct door naar de PDF.
//
// HARDE GRENS: deze resolver kent NOOIT een authenticiteitsklasse toe.
// Hij stelt vast dat het rapport bestaat en wat erop staat. Of dat een
// leverancier iets waard is, hangt af van A13 en A14 en is aan Annemarie.
// De controletabel is gebouwd op "een mens heeft dit gezien"; daarom krijgt
// een resolverregel methode 'resolver' en blijft klasse leeg. Een eerder door
// een mens gezette klasse wordt door een resolverrun nooit overschreven.
// ---------------------------------------------------------------------------

const LAB_RESOLVER_MAX = Number(process.env.LAB_RESOLVER_MAX) || 10;

async function resolveerLabReferenties(lab, max, opties) {
  const labNaam = lab || 'Bridge Analytical';
  const openstaand = await coaStore.openstaandeReferenties(labNaam, max || LAB_RESOLVER_MAX, opties);
  const uitkomsten = [];

  for (const r of openstaand) {
    // ILS geeft gestructureerde JSON terug in plaats van een PDF. Dat scheelt
    // de dure leesstap volledig - geen vision, geen kosten per rapport, en de
    // velden hoeven niet uit een plaatje geraden te worden.
    // Exacte labnaam, geen losse /ils/: dat matchte ook 'Silsbee' en elke
    // andere naam waar i-l-s toevallig in staat.
    if (/^ils laboratories$/i.test(String(labNaam).trim())) {
      const res = await ilsLab.resolveer(r.referentie).catch(() => null);
      if (!res || res.resolved !== true) {
        await coaStore.saveReferenceCheck(labNaam, r.referentie, {
          resolvet: res && res.resolved === false ? false : null,
          notitie: 'Resolver bij ILS: ' + ((res && res.status) || 'geen antwoord'),
          resolvedUrl: (res && res.url) || null, checkedBy: 'resolver', methode: 'resolver'
        });
        uitkomsten.push({ referentie: r.referentie, resolvet: false, reden: (res && res.status) || 'geen antwoord' });
        continue;
      }
      const tests = res.tests.map((t) => t.analyte).filter(Boolean);
      const notitie = 'Automatisch opgehaald bij ILS. ' +
        (tests.length ? ('Getest op: ' + tests.join(', ') + '. ') : '') +
        (res.identiteit ? ('Identiteit: ' + (res.identiteit.verwachteStof || '?') + ' - ' + (res.identiteit.resultaat || '?') + '. ') : '') +
        (res.verborgenOpCertificaat
          ? ('LET OP: ' + res.verborgenOpCertificaat + ' uitgevoerde test(en) staan niet op het gedrukte certificaat. ')
          : '') +
        (res.naamKomtOvereen === false
          ? ('LET OP: het certificaat noemt het product "' + (res.product || '?') +
             '", maar de identiteit is getoetst tegen ' + (res.getoetsteStof || '?') + '. ')
          : '') +
        (res.testsZonderNorm && res.testsZonderNorm.length
          ? ('Zonder norm gerapporteerd (kan niet zakken): ' + res.testsZonderNorm.join(', ') + '. ')
          : '') +
        'Geen klasse toegekend - dat vraagt een menselijk oordeel.';
      await coaStore.saveReferenceCheck(labNaam, r.referentie, {
        resolvet: true, client: res.client || null, product: res.product || null,
        batchnummer: res.batchnummer || null, resolvedUrl: res.url,
        notitie, checkedBy: 'resolver', methode: 'resolver',
        // Het hele labantwoord bewaren, niet alleen de samenvatting in proza.
        // Een percentage in een Nederlandse zin is niet te filteren.
        rapport: {
          bron: 'ils', opgehaaldOp: Date.now(), coaNumber: res.coaNumber || null,
          identiteit: res.identiteit, zuiverheid: res.zuiverheid, gehalte: res.gehalte,
          tests: res.tests, verborgenOpCertificaat: res.verborgenOpCertificaat,
          naamKomtOvereen: res.naamKomtOvereen, getoetsteStof: res.getoetsteStof,
          testsZonderNorm: res.testsZonderNorm,
          ondertekenaar: res.ondertekenaar || null, testType: res.testType || null,
          clientWebsite: res.clientWebsite || null
        }
      });
      uitkomsten.push({
        referentie: r.referentie, resolvet: true, client: res.client, product: res.product,
        batchnummer: res.batchnummer || null,
        identiteit: res.identiteit, zuiverheid: res.zuiverheid, gehalte: res.gehalte,
        naamKomtOvereen: res.naamKomtOvereen, getoetsteStof: res.getoetsteStof,
        testsZonderNorm: res.testsZonderNorm,
        // Niet alleen WELKE tests zijn gedaan, maar ook wat eruit kwam. Een
        // lijst testnamen zegt niets over het monster; 'Purity (HPLC)' is
        // pas informatie zodra er een percentage en een norm bij staan.
        tests: res.tests.map((t) => ({
          test: t.analyte, resultaat: t.resultaat, norm: t.limiet,
          eenheid: t.eenheid, status: t.status, verborgen: t.verborgenOpCertificaat
        })),
        verborgenOpCertificaat: res.verborgenOpCertificaat
      });
      continue;
    }

    const doc = await fetchRemoteDocument(r.url);
    if (!doc) {
      await coaStore.saveReferenceCheck(labNaam, r.referentie, {
        resolvet: false, notitie: 'Resolver kon het rapport niet ophalen op ' + r.url,
        resolvedUrl: r.url, checkedBy: 'resolver', methode: 'resolver'
      });
      uitkomsten.push({ referentie: r.referentie, resolvet: false, reden: 'niet op te halen' });
      continue;
    }

    // Door hetzelfde archief als alle andere documenten: een labrapport is ook
    // maar een document en hoeft maar een keer door de dure leesstap.
    const obs = await coaStore.recordObservation({
      url: r.url, supplierKey: 'lab:' + labNaam.toLowerCase().replace(/[^a-z0-9]/g, ''),
      buffer: doc.buffer, mimetype: doc.mediaType, etag: doc.etag, lastModified: doc.lastModified
    }).catch(() => null);

    let data = obs ? await coaStore.getExtraction(obs.sha256, COA_EXTRACTOR_VERSION) : null;
    if (!data) {
      const prompt = EVIDENCE_RULES + '\n\nDit is het originele testrapport zoals laboratorium ' + labNaam +
        ' het zelf teruggeeft op zijn verificatiepagina (' + r.url + '). Lees uitsluitend letterlijk wat er staat; ' +
        'gebruik null waar een veld niet vermeld of onleesbaar is. Neem het veld Client over zoals het er staat, ' +
        'ook als dat een andere partij is dan de verkopende shop.\n\n' +
        'Antwoord met JSON: {"coaRecords":[{"product":string,"batchnummer":string,"reportId":string,"verificationKey":string,' +
        '"client":string,"manufacturer":string,"laboratorium":string,"purityPercent":number|null,' +
        '"identiteitsmethode":string,"identiteitBevestigd":true|false|null,"identiteitGetoetstTegen":string,"blindTest":true|false|null,' +
        '"claimedQuantity":number|null,"measuredQuantity":number|null,"orderDate":string,"receivedDate":string,' +
        '"analysisDate":string,"resultaten":[{"parameter":string,"waarde":string,"status":string}]}]}';
      data = await sampleJsonSafe(prompt, { documents: [doc], label: 'labresolver' });
      if (obs && data) {
        const eerste = (data.coaRecords || [])[0] || {};
        await coaStore.saveExtraction(obs.sha256, COA_EXTRACTOR_VERSION, data, {
          lab: labNaam, taskNumber: eerste.reportId || null
        }).catch(() => {});
      }
    }

    const rec = (data && data.coaRecords && data.coaRecords[0]) || null;
    const tests = (rec && rec.resultaten || []).map((x) => x && x.parameter).filter(Boolean);
    await coaStore.saveReferenceCheck(labNaam, r.referentie, {
      resolvet: true,
      client: (rec && rec.client) || null,
      product: (rec && rec.product) || null,
      batchnummer: (rec && rec.batchnummer) || null,
      resolvedUrl: doc.finalUrl || r.url,
      notitie: rec
        ? ('Automatisch opgehaald bij het lab. ' + (tests.length ? ('Getest op: ' + tests.join(', ') + '. ') : '') +
           (rec.manufacturer ? ('Manufacturer: ' + rec.manufacturer + '. ') : '') +
           'Geen klasse toegekend - dat vraagt een menselijk oordeel.')
        : 'Rapport opgehaald maar niet uit te lezen.',
      checkedBy: 'resolver', methode: 'resolver'
    });
    uitkomsten.push({
      referentie: r.referentie, resolvet: true,
      client: (rec && rec.client) || null, product: (rec && rec.product) || null, tests
    });
  }

  return { lab: labNaam, behandeld: openstaand.length, uitkomsten };
}

// Een enkel document opnieuw laten lezen, met de cache overgeslagen.
//
// Waarom dit bestaat: het archief slaat een uitlezing op onder sha256 plus
// extractorversie, en dat is precies de bedoeling - een document gaat een
// keer door de dure leesstap, ooit, voor alle leveranciers samen. Maar het
// maakt sleutelen aan de leesprompt onmogelijk: een herdraai pakt de cache en
// je ziet nooit of je aanpassing hielp. De extractorversie ophogen leest alles
// opnieuw en dat is een botte bijl voor een gerichte vraag.
//
// Aanleiding (20 sep): 13 van de 14 ILS-rapporten van nextgenpeptides leveren
// geen verificatiesleutel op, terwijl ILS zegt dat die in de kop en de
// voettekst staat. Zonder deze functie is dat niet te onderzoeken.
//
// Het document wordt opnieuw opgehaald bij de bron - het archief bewaart de
// bytes niet. Verandert de hash, dan is het bestand bij de leverancier
// gewijzigd. Dat is zelf een bevinding en wordt als zodanig teruggegeven.
async function herleesDocument(sha256, opties) {
  const o = opties || {};
  const doc = await coaStore.getDocument(sha256);
  if (!doc) return { fout: 'onbekend_document', bericht: 'Dit sha256 staat niet in het archief.' };

  const bron = await coaStore.publiekeBronVoorDocument(sha256);
  if (!bron) {
    return {
      fout: 'geen_ophaalbare_bron',
      bericht: 'Voor dit document is geen http(s)-bron bekend; het kwam van een upload of een gedrukte referentie. Opnieuw lezen kan alleen via een nieuwe upload.'
    };
  }

  const bestand = await fetchRemoteDocument(bron.url);
  if (!bestand) {
    return { fout: 'niet_op_te_halen', bericht: 'Het document is niet meer op te halen van ' + bron.url, bronUrl: bron.url };
  }

  const nieuweHash = coaStore.sha256Of(bestand.buffer);
  const gewijzigd = nieuweHash !== sha256;

  const naam = o.naam || bron.supplier_key || 'deze leverancier';
  const prompt = EVIDENCE_RULES + '\n\nBekijk het bijgevoegde document, opgehaald van ' + bron.url +
    ', dat een COA (certificate of analysis) zou moeten bevatten voor leverancier ' + naam +
    '. Lees uitsluitend letterlijk wat in het document staat; gebruik null waar een veld niet vermeld of onleesbaar is.\n\n' +
    'Antwoord met JSON: {"coaRecords":[{"product":string,"claimedQuantity":number|null,"claimedUnit":string,"measuredQuantity":number|null,"measuredUnit":string,"purityPercent":number|null,"purityMethod":string,"identiteitsmethode":string,"identiteitBevestigd":true|false|null,"identiteitGetoetstTegen":string,"blindTest":true|false|null,"batchnummer":string,"reportId":string,"verificationKey":string,"laboratorium":string,"orderDate":string,"receivedDate":string,"analysisDate":string,"reportDate":string,"verificatieDomein":string,"verificatieInstructie":string,"sterility":{"tested":true|false|null,"result":string,"method":string},"endotoxin":{"tested":true|false|null,"result":string,"unit":string},"zwareMetalen":{"tested":true|false|null,"resultaten":[{"metaal":string,"resultaat":string,"norm":string,"unit":string}]},"metaalcomplex":{"metaal":string,"totaalMg":number|null,"peptideMg":number|null,"metaalMg":number|null},"componenten":[{"stof":string,"gemetenMg":number|null,"geclaimdMg":number|null,"metaalcomplex":{"metaal":string,"totaalMg":number|null,"peptideMg":number|null,"metaalMg":number|null}}],"vialen":[{"gemetenMg":number|null,"purityPercent":number|null}],"overigeContaminanten":[{"parameter":string,"resultaat":string,"unit":string}]}]}';

  const data = await sampleJsonSafe(prompt, { documents: [bestand], label: 'herlezen' });
  const eerste = (data && data.coaRecords && data.coaRecords[0]) || null;

  // Alleen opslaan als het nog hetzelfde bestand is. Is het gewijzigd, dan
  // hoort dat via de normale waarneemroute het archief in, niet stilletjes
  // onder de oude hash.
  let opgeslagen = false;
  if (!gewijzigd && data && !o.alleenKijken) {
    await coaStore.saveExtraction(sha256, COA_EXTRACTOR_VERSION, data, {
      lab: (eerste && eerste.laboratorium) || doc.lab || null,
      taskNumber: (eerste && eerste.reportId) || doc.task_number || null,
      keyHash: (eerste && eerste.verificationKey)
        ? coaStore.sha256Of(Buffer.from(String(eerste.verificationKey))) : null
    }).catch(() => {});
    opgeslagen = true;
  }

  const oudRec = (doc.extraction && doc.extraction.coaRecords && doc.extraction.coaRecords[0]) || {};
  return {
    sha256, bronUrl: bron.url, leverancier: bron.supplier_key,
    bestandGewijzigd: gewijzigd,
    nieuweHash: gewijzigd ? nieuweHash : null,
    opgeslagen,
    // Naast elkaar, want de vraag is meestal "leest hij het nu wel?"
    was: {
      laboratorium: oudRec.laboratorium || null, reportId: oudRec.reportId || null,
      verificationKey: oudRec.verificationKey || null, product: oudRec.product || null
    },
    nu: eerste ? {
      laboratorium: eerste.laboratorium || null, reportId: eerste.reportId || null,
      verificationKey: eerste.verificationKey || null, product: eerste.product || null,
      verificatieDomein: eerste.verificatieDomein || null,
      verificatieInstructie: eerste.verificatieInstructie || null,
      identiteitsmethode: eerste.identiteitsmethode || null,
      identiteitGetoetstTegen: eerste.identiteitGetoetstTegen || null,
      identiteitBevestigd: typeof eerste.identiteitBevestigd === 'boolean' ? eerste.identiteitBevestigd : null
    } : null
  };
}

async function runResearchStep(caseId, ctx, key) {
  const startedAt = Date.now();
  await beginStep(caseId, key);
  let result;
  if (key === 'coaDataset') {
    const phase = await runPhase(ctx, stepOpts('coaDataset', ctx), caseId);
    let records = (phase.data && phase.data.coaRecords) || [];

    // Deterministische crawl van de eigen COA-bibliotheek van de leverancier.
    // De AI-zoekstap hierboven leunt op zoekmachine-snippets en vindt daardoor
    // een willekeurige greep - bij een testrun 2 documenten waarvan 1 van een
    // andere leverancier, terwijl er 26 op de eigen site stonden. Deze stap
    // haalt de site zelf op en pakt alles wat er werkelijk staat.
    await meldStap(caseId, 'De website van de leverancier doorzoeken op een certificatenpagina');
    const crawl = await coaCrawler.crawlCoaIndex(ctx.website).catch(() => null);
    await meldStap(caseId, ((crawl && crawl.documents || []).length) + ' document(en) en ' +
      ((crawl && crawl.verificatieLinks || []).length) + ' labverwijzing(en) gevonden op de site');
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
      product: v.context || null, batchnummer: null, purityPercent: null, laboratorium: v.lab || 'Janoshik',
      reportId: null, verificationKey: null, authenticiteitsklasse: null,
      verificationUrl: v.url,
      bronUrl: null,
      accessStatus: 'readable',
      uit: 'labverwijzing',
      gevondenOp: v.gevondenOp || null
    }));
    records = records.concat(crawlRecords).concat(verwijzingRecords);

    // Verwijzingen naar de labverificatiepagina vastleggen in het archief.
    // Tot 19 sep gingen deze alleen het rapport in en verdwenen ze daarna:
    // bij astralabs en pyroxlabs vond de crawl er elk 80 en bleef er nul van
    // over. Juist deze zijn nodig om te zien of twee shops naar hetzelfde
    // labrapport wijzen - en daar is geen contact met het lab voor nodig.
    const refSupplierKey = coaStore.supplierKeyFromUrl(ctx.website || ctx.naam);
    const refOpslag = await coaStore.recordReferences(
      refSupplierKey,
      ((crawl && crawl.verificatieLinks) || []).map((v) => Object.assign({}, v, { lab: v.lab || 'Janoshik' }))
    ).catch(() => ({ opgeslagen: 0, onleesbaar: 0 }));
    if (ctx.images && ctx.images.length) {
      const docPrompt = EVIDENCE_RULES + '\n\nBekijk de bijgevoegde afbeelding(en) van door de gebruiker geuploade documenten (COA, screenshot, productfoto) voor leverancier ' + ctx.naam + '. Beschrijf per afbeelding alleen wat letterlijk zichtbaar is. Verzin niets; gebruik null waar iets onleesbaar of niet zichtbaar is. Dit is geen onafhankelijke verificatie op zichzelf, maar telt als direct geziene brondata (accessStatus readable, parseStatus valid).\n\nAntwoord met JSON: {"coaRecords":[{"product":string,"claimedQuantity":number|null,"claimedUnit":string,"measuredQuantity":number|null,"measuredUnit":string,"purityPercent":number|null,"purityMethod":string,"identiteitsmethode":string,"identiteitBevestigd":true|false|null,"identiteitGetoetstTegen":string,"blindTest":true|false|null,"batchnummer":string,"reportId":string,"verificationKey":string,"laboratorium":string,"orderDate":string,"receivedDate":string,"analysisDate":string,"reportDate":string,"sterility":{"tested":true|false|null,"result":string,"method":string},"endotoxin":{"tested":true|false|null,"result":string,"unit":string},"zwareMetalen":{"tested":true|false|null,"resultaten":[{"metaal":string,"resultaat":string,"norm":string,"unit":string}]},"metaalcomplex":{"metaal":string,"totaalMg":number|null,"peptideMg":number|null,"metaalMg":number|null},"componenten":[{"stof":string,"gemetenMg":number|null,"geclaimdMg":number|null,"metaalcomplex":{"metaal":string,"totaalMg":number|null,"peptideMg":number|null,"metaalMg":number|null}}],"vialen":[{"gemetenMg":number|null,"purityPercent":number|null}],"overigeContaminanten":[{"parameter":string,"resultaat":string,"unit":string}],"verificatieDomein":string,"verificatieInstructie":string}]}';
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
      overgeslagenDoorTijd: 0,
      budgetMs: COA_LUS_BUDGET_MS,
      recordsVoorLus: records.length,
      kandidaten: autofetchCandidates.length,
      kandidatenUitCrawl: autofetchCandidates.filter((k) => k.prioriteit === 0).length,
      limiet: COA_AUTOFETCH_MAX,
      behandeld: 0,
      uitkomsten: []
    };
    const noteer = (url, wat) => { if (lusLog.uitkomsten.length < 40) lusLog.uitkomsten.push({ url: String(url).slice(-60), wat }); };
    const teBehandelen = autofetchCandidates.slice(0, COA_AUTOFETCH_MAX);
    await meldStap(caseId, teBehandelen.length + ' document(en) ophalen en uitlezen' +
      (autofetchCandidates.length > teBehandelen.length
        ? (' (van de ' + autofetchCandidates.length + ' gevonden; de limiet staat op ' + COA_AUTOFETCH_MAX + ')')
        : ''));
    let behandeldNr = 0;
    const lusStart = Date.now();
    let overgeslagenDoorTijd = 0;
    for (const { url, idx } of teBehandelen) {
      if (Date.now() - lusStart > COA_LUS_BUDGET_MS) {
        overgeslagenDoorTijd++;
        lusLog.overgeslagenDoorTijd = overgeslagenDoorTijd;
        noteer(url, 'overgeslagen: tijdsbudget van de documentlus bereikt');
        archiveNotes.push({ url, status: 'overgeslagen', reden: 'tijdsbudget bereikt' });
        continue;
      }
      lusLog.behandeld++;
      behandeldNr++;
      // Stap 1: kennen we dit document al? Zo ja, hergebruik de analyse en
      // sla zowel de download als de (dure) vision-call over. Dit is het hele
      // punt van het archief — elk uniek COA-document gaat exact één keer
      // door vision, ooit, voor alle gebruikers en leveranciers samen.
      let cached = null;
      await meldStap(caseId, 'Document ' + behandeldNr + ' van ' + teBehandelen.length + ': ' + String(url).slice(-70));
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
        await meldStap(caseId, 'Dit rapport kenden we al uit het archief - niet opnieuw uitgelezen (' +
          archiefTelling.hergebruikt + ' hergebruikt tot nu toe)');
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
        const autofetchPrompt = EVIDENCE_RULES + '\n\nBekijk het bijgevoegde document, automatisch opgehaald van ' + url + ', dat volgens eerder onderzoek een COA (certificate of analysis) zou moeten bevatten voor leverancier ' + ctx.naam + '. Lees uitsluitend letterlijk wat in het document staat; gebruik null waar een veld niet vermeld of onleesbaar is. Blijkt dit document GEEN COA te zijn (bijv. een algemene productpagina of iets anders), geef dan een lege coaRecords-array terug.\n\nAntwoord met JSON: {"coaRecords":[{"product":string,"claimedQuantity":number|null,"claimedUnit":string,"measuredQuantity":number|null,"measuredUnit":string,"purityPercent":number|null,"purityMethod":string,"identiteitsmethode":string,"identiteitBevestigd":true|false|null,"identiteitGetoetstTegen":string,"blindTest":true|false|null,"batchnummer":string,"reportId":string,"verificationKey":string,"laboratorium":string,"orderDate":string,"receivedDate":string,"analysisDate":string,"reportDate":string,"sterility":{"tested":true|false|null,"result":string,"method":string},"endotoxin":{"tested":true|false|null,"result":string,"unit":string},"zwareMetalen":{"tested":true|false|null,"resultaten":[{"metaal":string,"resultaat":string,"norm":string,"unit":string}]},"metaalcomplex":{"metaal":string,"totaalMg":number|null,"peptideMg":number|null,"metaalMg":number|null},"componenten":[{"stof":string,"gemetenMg":number|null,"geclaimdMg":number|null,"metaalcomplex":{"metaal":string,"totaalMg":number|null,"peptideMg":number|null,"metaalMg":number|null}}],"vialen":[{"gemetenMg":number|null,"purityPercent":number|null}],"overigeContaminanten":[{"parameter":string,"resultaat":string,"unit":string}],"verificatieDomein":string,"verificatieInstructie":string}]}';
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
          await meldStap(caseId, 'Nieuw rapport uitgelezen (' + archiefTelling.opnieuwGelezen +
            ' nieuw, ' + archiefTelling.hergebruikt + ' uit het archief)');
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
    if (overgeslagenDoorTijd) {
      await meldStap(caseId, 'LET OP: ' + overgeslagenDoorTijd + ' document(en) overgeslagen - het tijdsbudget van ' +
        Math.round(COA_LUS_BUDGET_MS / 60000) + ' minuten voor deze lus was op');
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
      await meldStap(caseId, 'Verificatie bij het laboratorium, poging ' + verificatieTeller +
        (r.laboratorium ? (' (' + String(r.laboratorium).slice(0, 40) + ')') : ''));
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
        // De klasse komt uitsluitend uit de resolutie bij het lab. De
        // aftopping van een door het model geraden D op C is vervallen: het
        // model stelt sinds 20 september geen klasse meer voor, het leest
        // alleen. Zie 'Wie kent de klasse toe' in de projectdocumenten.
        authenticiteitsklasse: klasse || null,
        klasseBron: klasse ? 'resolver' : null,
        klasseReden: klasse ? res.status : ('geen klasse: ' + (res.status || 'resolutie leverde geen oordeel')),
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
        klasseBron: d.authenticity_class ? 'mens' : null,
        klasseReden: d.authenticity_class ? ('handmatig vastgesteld door ' + (v.checkedBy || 'een staflid')) : null,
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
    // Vangnet: elke record krijgt een expliciete stand van zaken. Een leeg
    // veld is geen uitspraak, en een leeg veld dat als 'geen bezwaar' gelezen
    // kan worden is precies wat de methodiek verbiedt (M5, M12).
    records = records.map((r) => {
      if (!r) return r;
      // Alleen een klasse van de resolver of van een mens telt. Alles anders
      // komt uit een uitlezing van voor 20 september, toen het model zelf nog
      // een klasse voorstelde. Die staan nog in het archief (de
      // extractorversie is bewust niet opgehoogd) en zouden anders via de
      // cache blijven meetellen in de categorisatie. Labelen is niet genoeg:
      // een gok die meeweegt is een gok die meeweegt.
      const geldigeBron = r.klasseBron === 'resolver' || r.klasseBron === 'mens';
      const klasse = geldigeBron ? r.authenticiteitsklasse : null;
      const verouderd = !!r.authenticiteitsklasse && !geldigeBron;
      return Object.assign({}, r, {
        authenticiteitsklasse: klasse || null,
        klasseBron: klasse ? r.klasseBron : null,
        klasseReden: klasse
          ? (r.klasseReden || null)
          : (verouderd
              ? 'klasse uit een oudere uitlezing genegeerd: niet bij het lab vastgesteld'
              : 'niet bij het laboratorium gecontroleerd'),
        externalVerification: klasse ? (r.externalVerification || 'pending') : 'unavailable'
      });
    });

    // Referenties die op de documenten zelf staan vastleggen. De gelinkte
    // verwijzingen gingen al eerder het archief in; dit zijn de gedrukte.
    // Voor Janoshik kennen we de URL-vorm en bouwen we een echte link; voor
    // andere labs bewaren we alleen de referentie, zodat een adapter die er
    // later komt meteen een werkvoorraad heeft.
    const docReferenties = [];
    const gezieneRefs = new Set();

    // Ook uit het ARCHIEF, niet alleen uit de records van deze run. Reden,
    // gemeten 20 sep bij nextgenpeptides: hun ILS-rapporten staan op een
    // ander domein en zijn grotendeels van de site verdwenen (status 'gone').
    // Die documenten zitten met sleutel en al in het archief, maar kwamen
    // nergens meer terug - terwijl een rapport dat is weggehaald juist het
    // document is dat je bij het lab wil natrekken.
    const archiefDocs = await coaStore.getDocumentsBySupplier(refSupplierKey).catch(() => []);
    const uitArchief = archiefDocs.map((d) => {
      const ext = (d.extraction && d.extraction.coaRecords && d.extraction.coaRecords[0]) || {};
      return {
        laboratorium: ext.laboratorium || d.lab || null,
        verificationKey: ext.verificationKey || null,
        reportId: ext.reportId || d.task_number || null,
        sample: ext.sample || d.sample_number || null,
        bronUrl: d.url && /^https?:/i.test(d.url) ? d.url : null,
        uit: 'archief'
      };
    });

    [].concat(records, uitArchief).forEach((r) => {
      if (!r || r.uit === 'labverwijzing') return;
      const lab = r.laboratorium ? String(r.laboratorium).trim() : '';
      if (!lab) return;
      const sleutel = r.verificationKey ? String(r.verificationKey).trim() : '';
      const task = r.reportId ? String(r.reportId).replace(/^#/, '').trim() : '';
      if (!sleutel && !task) return;

      let item = null;
      if (/janoshik/i.test(lab)) {
        const ref = janoshik.bouwReferentie(r);
        if (ref) {
          item = {
            lab: 'Janoshik', referentie: ref.referentie, taskNumber: ref.taskNumber,
            sample: ref.sample, key: ref.key, url: janoshik.resolveUrl(ref)
          };
        }
      }
      if (!item) {
        const referentie = sleutel || task;
        item = { lab, referentie, taskNumber: task || null, sample: null, key: sleutel || null, url: null };
      }
      const uniek = item.lab.toLowerCase() + '|' + item.referentie.toLowerCase();
      if (gezieneRefs.has(uniek)) return;
      gezieneRefs.add(uniek);
      item.gevondenOp = r.bronUrl || null;
      docReferenties.push(item);
    });
    const docRefOpslag = await coaStore.recordReferencesUitDocumenten(refSupplierKey, docReferenties)
      .catch(() => ({ opgeslagen: 0, zonderUrl: 0 }));

    // Productnaam naast geteste stof. Gevonden op 20 september bij NextGen:
    // een vial verkocht als 'GLP-3' waarvan ILS de identiteit toetste tegen
    // retatrutide. Het rapport liegt niet - de identiteitsregel noemt de stof -
    // maar het etiket zegt iets anders. Alleen een waarneming: geen oordeel,
    // geen invloed op de Evidence Gate. Die weging ligt bij Annemarie (A16).
    records.forEach((r) => {
      if (!r) return;
      r.naamKomtOvereen = r.identiteitGetoetstTegen
        ? ilsLab.zelfdeStof(r.product, r.identiteitGetoetstTegen)
        : null;
    });

    // Welke soorten tests heeft deze leverancier laten doen? Bij een shop die
    // per batch splitst in losse rapporten is dat de enige eerlijke telling.
    const testdekking = await coaStore.testsoortDekking(refSupplierKey).catch(() => null);

    // ---- Handmatige labcontroles teruglezen ----
    //
    // Tot nu deed de pijplijn dit niet, en dat was een gat: iemand controleert
    // met de hand vijftig referenties bij het lab, en de eerstvolgende run van
    // die leverancier weet daar niets van. Het duurste bewijs dat we hebben -
    // een mens die de labpagina echt heeft geopend - kwam nergens terug.
    //
    // Alleen teruglezen en tonen. Geen klasse, geen score: hoe zwaar dit weegt
    // is A15/A16 en ligt bij Annemarie.
    const controles = await coaStore.referentiesVanLeverancier(refSupplierKey, 500).catch(() => []);
    const metControle = controles.filter((r) => r.controle);
    const handmatig = metControle.filter((r) => r.controle.methode === 'handmatig');
    const opdrachtgevers = {};
    let derdePartij = 0, veldverschillen = 0, alleenSchrijfwijze = 0;
    metControle.forEach((r) => {
      const c = r.controle;
      if (c.client) {
        opdrachtgevers[c.client] = (opdrachtgevers[c.client] || 0) + 1;
        const oordeel = coaStore.wieBesteldeDeTest(c.client, [refSupplierKey]);
        if (oordeel && oordeel.derdePartij) derdePartij++;
      }
      (c.veldvergelijking || []).forEach((v) => {
        if (v.gelijk === false) { if (v.bijnaGelijk) alleenSchrijfwijze++; else veldverschillen++; }
      });
    });
    const handmatigeControles = metControle.length ? {
      aantal: metControle.length,
      doorEenMens: handmatig.length,
      opgelost: metControle.filter((r) => r.controle.resolvet === true).length,
      nietOpgelost: metControle.filter((r) => r.controle.resolvet === false).length,
      opdrachtgevers,
      // Hoeveel rapporten staan op naam van iemand anders dan deze leverancier?
      opNaamVanDerde: derdePartij,
      veldverschillen,
      alleenSchrijfwijze,
      // De regels zelf, zodat het rapport ze kan tonen in plaats van alleen tellen.
      regels: metControle.slice(0, 60).map((r) => ({
        referentie: r.referentie, url: r.url, testsoort: r.testsoort,
        client: r.controle.client, manufacturer: r.controle.manufacturer,
        product: r.controle.product, batchnummer: r.controle.batchnummer,
        zuiverheidPct: r.controle.zuiverheidPct, vullingPct: r.controle.vullingPct,
        resolvet: r.controle.resolvet, klasse: r.controle.klasse,
        veldenAfwijkend: r.controle.veldenAfwijkend,
        veldvergelijking: r.controle.veldvergelijking,
        gecontroleerdDoor: r.controle.checkedBy, methode: r.controle.methode
      }))
    } : null;
    if (handmatigeControles) {
      await meldStap(caseId, handmatigeControles.aantal + ' eerdere handmatige labcontrole(s) teruggelezen' +
        (derdePartij ? (' - LET OP: ' + derdePartij + ' rapport(en) staan op naam van een derde partij') : ''));
    }
    const beloften = (phase.data && phase.data.kwaliteitsbeloften) || [];
    const beloftetoets = toetsZuiverheidsbelofte(beloften, records);

    // ---- Bewijskracht per rapport: telt het lab mee? ----
    //
    // Regel van Annemarie, 20 september: een COA die er plausibel uitziet is
    // NIET hetzelfde als een COA die onafhankelijk geverifieerd is. Is het lab
    // erachter onvoldoende te verifieren, dan blijven identity, purity en
    // quantity die uitsluitend op dat rapport rusten ONBEVESTIGD. Niet
    // weerlegd - onbevestigd.
    //
    // LET OP: dit vuurt alleen waar een MENS een oordeel heeft vastgelegd.
    // Een lab zonder oordeel laat het bewijs staan zoals het was. Anders zou
    // vandaag elke leverancier in een klap op nul komen, want er is nog geen
    // enkel lab beoordeeld. Hoeveel labs nog wachten staat in labsZonderOordeel;
    // of een onbeoordeeld lab ook al zou moeten blokkeren is A22.
    const labOordelenNu = await coaStore.labOordelen().catch(() => ({}));
    const labsZonderOordeel = new Set();
    records.forEach((r) => {
      if (!r) return;
      const naam = r.laboratorium ? coaStore.normaliseerLab(r.laboratorium).naam : null;
      const oordeel = naam ? (labOordelenNu[coaStore.labSleutel(naam)] || null) : null;
      const bk = coaStore.bewijskrachtVanLab(oordeel);
      r.bewijskracht = bk.telt === true ? 'onafhankelijk geverifieerd'
        : (bk.telt === false ? 'onbevestigd' : 'lab nog niet beoordeeld');
      r.bewijskrachtReden = bk.reden;
      r.labStatus = oordeel ? oordeel.status : null;
      if (naam && !oordeel) labsZonderOordeel.add(naam);
    });
    const onbevestigd = records.filter((r) => r && r.bewijskracht === 'onbevestigd').length;
    if (onbevestigd) {
      await meldStap(caseId, 'LET OP: ' + onbevestigd + ' rapport(en) rusten op een laboratorium dat niet als onafhankelijk geverifieerd geldt');
    }

    const intake = records.map((r, i) => {
      const fields = [];
      if (r.purityPercent != null) fields.push('purity');
      if (r.quantity && r.quantity.deviationPct != null) fields.push('quantity');
      // M7 / A8, hersteld 19 september. Hier stond:
      //   if (r.authenticiteitsklasse) fields.push('identity');
      // Dat is fout. De authenticiteitsklasse zegt of het RAPPORT echt is
      // (C01). Identity is de vraag of de juiste stof is aangetroffen (C02).
      // Door die koppeling kon de Evidence Gate op PASS komen zonder dat er
      // ooit een identiteitsbepaling was gelezen.
      if (heeftIdentiteitsbepaling(r)) fields.push('identity');
      if (r.sterility && r.sterility.tested) fields.push('sterility');
      if (r.endotoxin && r.endotoxin.tested) fields.push('endotoxin');
      // Zware metalen als eigen veld. Zaten in de verzamelbak 'other', waardoor
      // een shop die lood en kwik laat meten niet te onderscheiden was van een
      // shop die een willekeurige extra parameter rapporteert.
      if (r.zwareMetalen && (r.zwareMetalen.tested === true ||
          (r.zwareMetalen.resultaten && r.zwareMetalen.resultaten.length))) fields.push('heavyMetals');
      if (r.overigeContaminanten && r.overigeContaminanten.length) fields.push('other');
      return {
        intake_id: 'coa-' + i, found: true,
        access_status: r.accessStatus || (r.reportId || r.verificationKey ? 'readable' : 'unreadable'),
        parse_status: (r.product || r.purityPercent != null) ? 'valid' : 'partial',
        // Rust dit rapport op een lab dat niet als onafhankelijk geverifieerd
        // geldt? Dan zijn de analytische velden niet bruikbaar als bewijs. Ze
        // staan er wel, ze tellen alleen niet mee.
        analytical_fields_usable: r.bewijskracht === 'onbevestigd' ? [] : fields,
        analytical_fields_gelezen: fields,
        bewijskracht: r.bewijskracht || null,
        bewijskracht_reden: r.bewijskrachtReden || null
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
      verwijzingenVastgelegd: refOpslag.opgeslagen,
      verwijzingenOnleesbaar: refOpslag.onleesbaar,
      referentiesUitDocumenten: docRefOpslag.opgeslagen,
      referentiesZonderBekendeUrl: docRefOpslag.zonderUrl,
      nieuwTenOpzichteVanZoekstap: crawlRecords.length,
      maximaalOpgehaald: COA_AUTOFETCH_MAX,
      nietGeprobeerdWegensLimiet: nietGeprobeerd,
      lus: lusLog,
      archief: archiefTelling,
      beperkingen: (crawl && crawl.notes) || ['crawl niet uitgevoerd'],
      diagnose: (crawl && crawl.diagnose) || []
    };
    result = { key: 'coaDataset', title: 'COA-dataset en -authenticiteit', data: Object.assign({}, phase.data, { coaRecords: records, intake, archief: archiveNotes, crawl: crawlInfo, labverificatie: verificaties, kwaliteitsbeloften: beloften, beloftetoets, testdekking, handmatigeControles,
      labsZonderOordeel: [...labsZonderOordeel], rapportenOnbevestigd: onbevestigd }) };
  } else if (key === 'laboratorium') {
    // Begin bij wat de COA-stap al gezien heeft. Draait deze stap zonder
    // voorafgaande COA-stap, dan is waarneming gewoon leeg en valt stepOpts
    // terug op de oude zoekopdracht.
    const bestaand = await db.getCase(caseId).catch(() => null);
    const coaData = (bestaand && bestaand.phaseData && bestaand.phaseData.coaDataset && bestaand.phaseData.coaDataset.data) || null;
    const waarneming = labsUitCoaData(coaData);
    const fase = await runPhase(ctx, stepOpts('laboratorium', ctx, waarneming), caseId);
    const data = Object.assign({}, (fase && fase.data) || {});
    const gevonden = Array.isArray(data.bevindingen) ? data.bevindingen : [];
    // Waarnemingen eerst: die zijn geteld, de rest is onderzoek.
    data.bevindingen = labBevindingenUitWaarneming(waarneming).concat(gevonden);
    // Het menselijke oordeel erbij, zodat het modelmateriaal eronder kan
    // worden geplaatst in plaats van ernaast.
    const oordelenVoorLabs = await coaStore.labOordelen().catch(() => ({}));
    data.labs = koppelLabBeoordelingen(waarneming.labs, data.labBeoordelingen, oordelenVoorLabs);
    data.labWaarneming = { gelezenRapporten: waarneming.gelezenRapporten, rapportenZonderLabnaam: waarneming.zonderLabnaam };
    if (!data.laboratoriumNaam && waarneming.labs.length) data.laboratoriumNaam = waarneming.labs[0].naam;
    delete data.labBeoordelingen;
    result = { key: 'laboratorium', title: 'Laboratorium', data };
  } else if (key === 'identiteit') {
    result = await runPhase(ctx, stepOpts('identiteit', ctx), caseId);
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
    result = await runPhase(ctx, stepOpts(key, ctx), caseId);
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
  await meldStap(caseId, 'De ' + AANTAL_CATEGORIEEN + ' categorieen beoordelen op het verzamelde bewijs');
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
  // De drie blokken boven het rapport. Deterministisch, en bewust NA de
  // engine: productbewijs leest de Evidence Score, verificatie leest de
  // authenticiteitsklassen die de resolver of een mens heeft vastgelegd.
  const coaRecordsVoorBlokken = (c.phaseData && c.phaseData.coaDataset && c.phaseData.coaDataset.data
    && c.phaseData.coaDataset.data.coaRecords) || [];
  engineResult.blokken = bouwBlokken(engineResult, coaRecordsVoorBlokken, c.bedrijfsgegevens || null);
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
    stapLog.delete(caseId);
    await db.updateCase(caseId, { status: 'gratis_klaar', tier: 'gratis', currentStep: null });
  } catch (e) {
    if (!e || !e.stopped) {
      stapLog.delete(caseId);
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
    stapLog.delete(caseId);
    await db.updateCase(caseId, { status: 'klaar', tier: 'deep', currentStep: null });
  } catch (e) {
    if (!e || !e.stopped) {
      stapLog.delete(caseId);
      await db.updateCase(caseId, { status: 'fout', error: (e && e.message) || 'onbekende fout', currentStep: null });
    }
  }
}

module.exports = {
  runFreeTier, runDeepTier, runResearchStep, runCategorize, applyScoringEngine, runSynthesis,
  ensureNotStopped, stopAudit, RESEARCH_STEP_KEYS, FREE_STEP_KEYS, DEEP_STEP_KEYS, STEP_DEFS,
  extractCoaFromUpload, COA_EXTRACTOR_VERSION, resolveerLabReferenties, meldStap, herleesDocument,
  toetsZuiverheidsbelofte
};
