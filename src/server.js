require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const coaStore = require('./coaStore');
const vestiging = require('./vestiging');
const coaCrawler = require('./coaCrawler');
const siteShot = require('./siteShot');
const pipeline = require('./pipeline');
const auth = require('./auth');
const anthropicClient = require('./anthropicClient');
const rl = require('./rateLimit');
const { caseSummary, ownerCase, publicCase, sanitizeError } = require('./serialize');
const { isValidWebUrl, normalizeUrl } = require('./validate');
const { checkPeptideSupplierRelevance } = require('./relevanceCheck');
const labProbe = require('./labProbe');
const mcpCoaServer = require('./mcpCoaServer');

const app = express();

// Verraadt anders gratis welke stack eronder zit.
app.disable('x-powered-by');

// Railway zet een proxy voor de app; zonder dit is req.ip het IP van de proxy
// en begrenst de rate limiter effectief iedereen als één bezoeker.
app.set('trust proxy', 1);

// Twee velden: 'files' voor de bestaande generieke bijlagen (COA's, screenshots,
// max 10) en een los 'kvkDocument'-veld (max 1) voor het KvK-uittreksel. Geen
// mimetype-filter meer op multer-niveau — een PDF komt nu ook door; voorheen
// werd elk niet-image-bestand verderop in de route stilletjes weggegooid.
// LET OP: 'files' hieronder is het TOTAAL over alle velden samen. Staat dat
// lager dan de som van de maxCounts, dan weigert multer een combinatie die
// volgens de velden wel mag - met een melding die daar niet naar wijst.
// 10 + 1 + 5 = 16.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 16 } });
// 'eigenCoa' is nieuw (22 september, testvariant): het certificaat dat de
// KOPER zelf bij zijn bestelling kreeg. Dat is iets anders dan wat de shop
// publiceert - het gaat over zijn eigen batch - en het wordt daarom apart
// gehouden, niet op een hoop met 'files'.
const uploadFields = upload.fields([
  { name: 'files', maxCount: 10 },
  { name: 'kvkDocument', maxCount: 1 },
  // Vijf, niet drie: het paneel dat tijdens de check verschijnt als we niets
  // op de site vonden belooft er letterlijk vijf (Figma 1686-8812). De tekst
  // en deze grens horen gelijk te blijven; zie TUSSEN_COA_MAX in de frontend.
  { name: 'eigenCoa', maxCount: 5 }
]);

// CORS is hier geen autorisatiegrens (dat is het owner token), maar beperkt wel
// welke pagina's namens een bezoeker mogen aanroepen. Zet ALLOWED_ORIGINS zodra
// de frontend een vaste origin heeft.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Owner-Token'],
  exposedHeaders: ['Retry-After']
}));
// Voór de globale JSON-parser hieronder: deze route heeft zijn eigen, ruimere
// bodylimiet nodig (base64-COA's) en zijn eigen auth (COA_STAFF_TOKEN, niet
// het owner-token-systeem) — zie src/mcpCoaServer.js.
mcpCoaServer.mount(app);

app.use(express.json({ limit: '2mb' }));

const START_TIJD = Date.now();

// Welke code draait hier eigenlijk?
//
// Dit ontbrak, en dat heeft vandaag drie keer tijd gekost: we probeerden te
// raden of een deploy live was door te kijken of een nieuw endpoint bestond.
// Dat bewijst alleen dat DIE commit er is, niet de laatste - en de toollijst
// van een MCP-verbinding is helemaal onbetrouwbaar, want die is gecachet.
//
// Railway zet de commit-sha in de omgeving. Eén regel, en elke twijfel over
// welke versie draait is voorbij. Publiek: een commit-sha verraadt niets wat
// een aanvaller niet ook uit de repo haalt, en de prijs van raden is hoger.
app.get('/api/health', (req, res) => res.json({
  ok: true,
  commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || null,
  commitKort: (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT || '').slice(0, 7) || null,
  tak: process.env.RAILWAY_GIT_BRANCH || null,
  gestartOp: START_TIJD,
  draaitAl: Math.round((Date.now() - START_TIJD) / 1000) + 's',
  // Zodat je zonder de connector kunt zien welke MCP-tools deze versie kent.
  mcpTools: mcpCoaServer.toolNamen ? mcpCoaServer.toolNamen() : null,
  // Op welke paden het MCP-eindpunt luistert. Een connector die een oude
  // toollijst blijft tonen kan op een van deze paden opnieuw worden
  // aangemaakt; een pad dat de client nog niet kent haalt wel een verse lijst.
  mcpPaden: mcpCoaServer.MCP_VOORBEELDPADEN || mcpCoaServer.MCP_PADEN || ['/mcp']
}));

// --- publieke check: open of dicht -----------------------------------------
//
// Besluit Ruben, 23 september 2026. Omschakelen naar onderhoud is een
// omgevingsvariabele in Railway, geen uitrol: PUBLIEKE_CHECK=uit.
//
// LET OP waarom dit in de SERVER zit en niet in de pagina. Een pagina
// verbergen is geen afsluiten: de HTML en de JS worden door iedereen
// gedownload, en het startverzoek is met de hand na te bootsen. Alleen een
// weigering hier sluit de deur echt.
//
// Het token van de bezoeker telt hier niet: dat maakt elke browser zelf aan.
// Alleen een stafrol (ADMIN_TOKEN, COA_REDACTIE_TOKEN, VIEWER_TOKEN) komt er
// tijdens onderhoud nog langs, zodat wij kunnen blijven werken.
// De stand staat in de database, zodat hij vanaf de stafpagina om te zetten is
// zonder uitrol. PUBLIEKE_CHECK in de omgeving is alleen de beginstand, voor
// het geval er nog nooit iets is gezet.
const PUBLIEKE_CHECK_STANDAARD = String(process.env.PUBLIEKE_CHECK || 'aan').toLowerCase() !== 'uit';
const ONDERHOUD_STANDAARD = process.env.ONDERHOUD_BERICHT ||
  'We zijn even bezig met onderhoud. De check is zo weer beschikbaar.';

async function publiekeStand() {
  let rij = null;
  try { rij = await db.getInstelling('publiekeCheck'); } catch (e) { /* db plat: val terug op de omgeving */ }
  const w = rij && rij.waarde ? rij.waarde : null;
  return {
    open: w && typeof w.open === 'boolean' ? w.open : PUBLIEKE_CHECK_STANDAARD,
    bericht: (w && w.bericht) || ONDERHOUD_STANDAARD,
    door: rij ? rij.gezet_door : null,
    op: rij ? rij.gezet_op : null
  };
}

// Publiek: de pagina mag weten of de check openstaat, zonder token. Zonder dit
// zou de pagina het pas merken als iemand op Start klikt.
app.get('/api/stand', rl.read, async (req, res) => {
  const stand = await publiekeStand();
  res.json({
    publiekeCheck: stand.open,
    // Alleen meesturen als hij ook echt geldt; anders leest een open site al
    // een onderhoudstekst mee die nergens voor staat.
    bericht: stand.open ? null : stand.bericht
  });
});

// Omzetten mag alleen de BEHEERDER. Een beoordelaar mag oordelen vastleggen,
// niet de deur voor de buitenwereld dichtdoen.
app.post('/api/admin/stand', rl.caseAction, auth.requireOwnerToken, async (req, res) => {
  if (!auth.isAdmin(req)) return res.status(403).json({ error: 'geen_beheerder' });
  const open = req.body && typeof req.body.open === 'boolean' ? req.body.open : null;
  if (open === null) return res.status(400).json({ error: 'open_ontbreekt', message: 'Geef open: true of false mee.' });
  const bericht = (req.body && typeof req.body.bericht === 'string' && req.body.bericht.trim())
    ? req.body.bericht.trim() : ONDERHOUD_STANDAARD;
  const door = (req.body && req.body.door) ? String(req.body.door).slice(0, 80) : null;
  await db.setInstelling('publiekeCheck', { open: open, bericht: bericht }, door);
  const stand = await publiekeStand();
  console.log('[stand] publieke check ' + (stand.open ? 'OPEN' : 'DICHT') + (door ? ' door ' + door : ''));
  res.json({ publiekeCheck: stand.open, bericht: stand.bericht, door: stand.door, op: stand.op });
});

const caseAccess = auth.requireCaseAccess(db);

// Lijst eerder gedraaide audits — uitsluitend die van de aanvragende browser.
// Voorheen gaf deze route iedereen de cases van iedereen terug.
app.get('/api/audits', rl.read, auth.requireOwnerToken, async (req, res) => {
  try {
    const cases = req.isAdmin ? await db.listCases() : await db.listCasesByOwner(req.ownerTokenHash);
    res.json({ cases: cases.map(caseSummary) });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

app.get('/api/audits/:id', rl.read, auth.requireOwnerToken, caseAccess, (req, res) => {
  res.json({ case: ownerCase(req.case) });
});

// Uitslag zonder methode — bedoeld voor een gedeelde weergave. Bewust dezelfde
// eigenaarscontrole als hierboven; pas als er echte deellinks komen, krijgt
// deze route een eigen, per-case deeltoken.
app.get('/api/audits/:id/public', rl.read, auth.requireOwnerToken, caseAccess, (req, res) => {
  res.json({ case: publicCase(req.case) });
});

// Alleen de crawlstap tegen een lijst leverancierssites, zonder AI, zonder
// case en zonder kosten. Bedoeld om te meten hoe vaak een shop een
// server-side fetch blokkeert - dat bepaalt of de browserextensie nodig is.
//
// Geeft bewust geen pagina-inhoud terug, alleen of het lukte en waarom niet.
// De SSRF-guard in src/urlGuard.js weigert interne adressen.
app.post('/api/diagnostics/crawl', rl.caseAction, auth.requireOwnerToken, async (req, res) => {
  try {
    const sites = Array.isArray(req.body && req.body.websites) ? req.body.websites.slice(0, 15) : [];
    if (!sites.length) return res.status(400).json({ error: 'geen_websites', message: 'Geef een lijst websites mee (max 15).' });
    const resultaten = [];
    for (const site of sites) {
      const t0 = Date.now();
      const r = await coaCrawler.crawlCoaIndex(String(site)).catch((e) => ({ documents: [], indexPages: [], notes: ['crawl mislukte: ' + ((e && e.message) || 'onbekend')], diagnose: [] }));
      const redenen = {};
      (r.diagnose || []).forEach((d) => { redenen[d.resultaat] = (redenen[d.resultaat] || 0) + 1; });
      resultaten.push({
        site: String(site),
        documenten: (r.documents || []).length,
        indexPaginas: r.indexPages || [],
        redenen,
        notities: r.notes || [],
        duurMs: Date.now() - t0
      });
    }
    res.json({ resultaten });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Start een nieuwe audit. multipart/form-data: velden website/naam/land/
// kvkNummer/notities + optioneel bestand(en) onder "files" (COA's, screenshots).
//
// Volgorde van de middleware is hier niet vrijblijvend: de relevantiecheck
// hieronder is een betaalde AI-call die draait VOORDAT er een case bestaat.
// Rate limiting en tokencontrole moeten daar dus vóór staan, niet erin.
// Labmeting: welke verificatiediensten van laboratoria laten deze server
// binnen? Alleen opvraagbaar met het ADMIN_TOKEN. Geen invoer van buiten -
// de lijst zit in labProbe.js - dus dit is geen SSRF-oppervlak.
app.get('/api/diagnostics/labs', rl.caseAction, auth.requireOwnerToken, async (req, res) => {
  // Alleen met het ADMIN_TOKEN. Strenger dan een omgevingsvariabele, en er
  // valt niets te vergeten bij het uitrollen. De URL-lijst staat vast in
  // labProbe.js, dus een bezoeker kan hier niets anders mee laten ophalen.
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'admin_only', message: 'Deze meting is alleen met het admin-token op te vragen.' });
  }
  try {
    const r = await labProbe.probeAll();
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: 'probe_failed', message: (e && e.message) || 'onbekende fout' });
  }
});

app.post('/api/audits', rl.startAudit, auth.requireOwnerToken, uploadFields, async (req, res) => {
  try {
    // Onderhoud: dicht voor bezoekers, open voor de staf.
    const stand = await publiekeStand();
    if (!stand.open && !(auth.isAdmin(req) || auth.isViewer(req))) {
      return res.status(503).json({ error: 'gesloten', message: stand.bericht });
    }
    const website = normalizeUrl(req.body.website || '');
    if (!isValidWebUrl(website)) {
      return res.status(400).json({ error: 'invalid_url', message: 'Vul een geldige web URL in.' });
    }
    const naam = (req.body.naam || '').trim() || website;

    // Voorcheck: is dit überhaupt een peptide-/research-chemicals-leverancier?
    // Zo niet, dan slaan we het aanmaken van een case en de volledige (dure)
    // pipeline over — precies het idee van Ruben: URL geldig? -> relevant? ->
    // pas dan starten. Fail-open (zie relevanceCheck.js): bij twijfel of een
    // technische hobbel gaat de audit gewoon door.
    const relevance = await checkPeptideSupplierRelevance({ naam, website });
    // BESLUIT RUBEN 23 september 2026 (taak raccoonpeptides.com): een adres dat
    // doorlinkt naar een andere winkel is niet te controleren, en dan geven we
    // het adres terug waar het wel kan - "we zeggen dat je deze niet kan
    // checken en we de URL die doorgelinkt is invulden in het veld die je wel
    // kan checken". Eigen foutcode, want dit is geen oordeel over de shop
    // zoals not_peptide_supplier dat wel is; er valt hier simpelweg niets te
    // meten.
    if (!relevance.relevant && relevance.doorgelinktNaar) {
      return res.status(422).json({
        error: 'doorgelinkt',
        doorgelinktNaar: relevance.doorgelinktNaar,
        message: 'Deze website is niet te controleren: hij stuurt je door naar een andere winkel.' + (relevance.reasoning ? ' ' + relevance.reasoning : '') + ' Het adres hiernaast is ingevuld - druk nog een keer op start om die te controleren.'
      });
    }
    if (!relevance.relevant) {
      return res.status(422).json({
        error: 'not_peptide_supplier',
        message: 'Deze website lijkt geen leverancier van peptiden of research chemicals te zijn, dus we starten geen audit.' + (relevance.reasoning ? ' ' + relevance.reasoning : '')
      });
    }

    const genericFiles = (req.files && req.files.files) || [];
    const kvkFile = (req.files && req.files.kvkDocument && req.files.kvkDocument[0]) || null;

    // Het eigen certificaat van de koper: bestand(en) en/of een link.
    // Een link wordt hier alleen op vorm gecontroleerd; het echte ophalen
    // gebeurt in de pijplijn via docFetcher, die zijn eigen SSRF-guard heeft.
    const eigenCoaFiles = (req.files && req.files.eigenCoa) || [];
    const eigenCoaUrlRuw = String((req.body && req.body.eigenCoaUrl) || '').trim();
    let eigenCoaUrl = null;
    if (eigenCoaUrlRuw) {
      const genormaliseerd = normalizeUrl(eigenCoaUrlRuw);
      if (!isValidWebUrl(genormaliseerd)) {
        return res.status(400).json({
          error: 'invalid_coa_url',
          message: 'De link naar je eigen certificaat is geen geldige web-URL.'
        });
      }
      eigenCoaUrl = genormaliseerd;
    }

    const ctx = {
      naam,
      website,
      land: req.body.land || null,
      kvkNummer: req.body.kvkNummer || null,
      notities: req.body.notities || null,
      images: genericFiles
        .filter((f) => f.mimetype && f.mimetype.startsWith('image/'))
        .map((f) => ({ data: f.buffer.toString('base64'), mediaType: f.mimetype })),
      kvkDocument: kvkFile ? { data: kvkFile.buffer.toString('base64'), mediaType: kvkFile.mimetype } : null,
      eigenCoaUrl,
      eigenCoaBestanden: eigenCoaFiles.map((f) => ({
        data: f.buffer.toString('base64'), mediaType: f.mimetype, bestandsnaam: f.originalname || null
      }))
    };

    const id = uuidv4();
    const created = await db.createCase(id, Object.assign({}, ctx, { ownerTokenHash: req.ownerTokenHash }));

    // Geüploade bestanden persistent bewaren (niet alleen transiet gebruiken
    // tijdens deze run) zodat ze later terug te vinden zijn en, bij een
    // toekomstige KvK-koppeling, hetzelfde opslagpad hergebruikt kan worden.
    await Promise.all([
      ...genericFiles.map((f) => db.addDocument(uuidv4(), id, { kind: 'overig', filename: f.originalname, mimetype: f.mimetype, buffer: f.buffer })),
      ...(kvkFile ? [db.addDocument(uuidv4(), id, { kind: 'kvk', filename: kvkFile.originalname, mimetype: kvkFile.mimetype, buffer: kvkFile.buffer })] : []),
      ...eigenCoaFiles.map((f) => db.addDocument(uuidv4(), id, { kind: 'eigen-coa', filename: f.originalname, mimetype: f.mimetype, buffer: f.buffer }))
    ]).catch(() => {});

    // Fire-and-forget: de audit draait op de achtergrond, de client volgt
    // voortgang via GET /api/audits/:id (polling), net als in de Artifact.
    // Draait alleen de gratis stappen (laboratorium + coaDataset) — de knip
    // tussen gratis en betaald, zie POST /api/audits/:id/continue-deep hieronder.
    pipeline.runFreeTier(id, ctx).catch(() => {});

    res.status(201).json({ case: ownerCase(created) });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Schermafdruk van de website van een leverancier. Bewust publiek en op
// hostnaam: het is een foto van een openbare homepage, er zit geen enkel
// casegegeven in, en een <img>-tag kan geen Authorization-header meesturen.
// Bestaat er geen afdruk, dan geeft dit 404 en toont de frontend de lege plek.
app.get('/api/sites/:host/screenshot', rl.read, async (req, res) => {
  try {
    const shot = await siteShot.getShot(siteShot.sleutelVanUrl(req.params.host));
    if (!shot) return res.status(404).json({ error: 'not_found' });
    res.set('Content-Type', shot.mimetype || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(shot.bytes);
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Metadata van geüploade documenten bij een case (voor een bijlagenlijstje
// in de UI) — de bytes zelf komen pas via de download-route hieronder.
app.get('/api/audits/:id/documents', rl.read, auth.requireOwnerToken, caseAccess, async (req, res) => {
  try {
    res.json({ documents: await db.listDocuments(req.params.id) });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Deze route geeft de ruwe bytes van een geüpload bestand terug — bijvoorbeeld
// een KvK-uittreksel met persoonsgegevens. Voorheen volstond het kennen van
// case-id + doc-id; nu moet je ook eigenaar van de case zijn.
app.get('/api/audits/:id/documents/:docId', rl.read, auth.requireOwnerToken, caseAccess, async (req, res) => {
  try {
    const doc = await db.getDocument(req.params.docId);
    if (!doc || doc.caseId !== req.params.id) return res.status(404).json({ error: 'not_found' });
    res.set('Content-Type', doc.mimetype || 'application/octet-stream');
    res.set('Content-Disposition', 'inline; filename="' + (doc.filename || doc.id) + '"');
    res.send(doc.data);
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

app.post('/api/audits/:id/stop', rl.caseAction, auth.requireOwnerToken, caseAccess, async (req, res) => {
  try {
    await pipeline.stopAudit(req.params.id);
    res.json({ case: ownerCase(await db.getCase(req.params.id)) });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Ga door naar de betaalde Deep Dive voor een case waarvan de gratis check
// klaar is. Nog GEEN betaalstraat hier (Ruben: "zonder betaalstraat nog, maar
// dus wel de knip") — dit is puur het vervolgtraject zelf, klaar om er later
// een betaalmoment vóór te zetten. Draait de resterende DEEP_STEP_KEYS boven
// op dezelfde case (zelfde fasegegevens blijven staan) en herberekent daarna
// categorize/engine/rapport in "deep"-stand.
// Hervatten nadat er met de hand een testrapport is toegevoegd, 24 september.
//
// De gratis controle stopt met 'wacht_op_coa' als er geen enkel rapport is
// gevonden. Dit is de weg terug. Bewust GEEN admin-route: dit is de gewone
// gebruiker die zijn eigen check weer op gang brengt, dus caseAccess volstaat
// - precies zoals bij continue-deep.
app.post('/api/audits/:id/hervat', rl.caseAction, auth.requireOwnerToken, caseAccess, async (req, res) => {
  try {
    const c = req.case;
    if (c.status !== 'wacht_op_coa') {
      return res.status(409).json({
        error: 'invalid_state',
        message: 'Deze controle wacht niet op een rapport.'
      });
    }
    // Een link naar een certificaat mag hier mee. Die loopt in de COA-stap
    // door precies dezelfde ophaal- en uitleesroute als elk ander gevonden
    // document - geen apart pad, dus ook geen apart vertrouwen.
    const ruw = String((req.body && req.body.eigenCoaUrl) || '').trim();
    let eigenCoaUrl = null;
    if (ruw) {
      const genormaliseerd = normalizeUrl(ruw);
      if (!isValidWebUrl(genormaliseerd)) {
        return res.status(400).json({
          error: 'invalid_coa_url',
          message: 'De link naar het certificaat is geen geldige web-URL.'
        });
      }
      eigenCoaUrl = genormaliseerd;
    }
    const ctx = {
      naam: c.naam, website: c.website, land: c.land,
      kvkNummer: c.kvkNummer, notities: c.notities, images: [],
      eigenCoaUrl
    };
    pipeline.hervatNaWachten(req.params.id, ctx).catch(() => {});
    res.json({ case: ownerCase(await db.getCase(req.params.id)) });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

app.post('/api/audits/:id/continue-deep', rl.caseAction, auth.requireOwnerToken, caseAccess, async (req, res) => {
  try {
    const c = req.case;
    if (c.status !== 'gratis_klaar') {
      return res.status(409).json({ error: 'invalid_state', message: 'Deze audit staat niet klaar om verdiept te worden.' });
    }
    const storedKvk = await db.getLatestDocumentByKind(req.params.id, 'kvk').catch(() => null);
    const ctx = {
      naam: c.naam, website: c.website, land: c.land, kvkNummer: c.kvkNummer, notities: c.notities,
      images: [], kvkDocument: storedKvk ? { data: storedKvk.data, mediaType: storedKvk.mimetype } : null
    };
    await db.updateCase(req.params.id, { status: 'bezig', tier: 'deep', error: null });
    pipeline.runDeepTier(req.params.id, ctx).catch(() => {});
    res.json({ case: ownerCase(await db.getCase(req.params.id)) });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Dezelfde case volledig opnieuw draaien. Tot nu toe startte "opnieuw
// analyseren" een nieuwe case, waardoor je bij elke herhaling een dubbele in
// je lijst kreeg en de vorige uitkomst kwijt was als vergelijkingsmateriaal.
// Deze route zet de bestaande case terug op nul en draait de gratis tier
// opnieuw: zelfde id, zelfde link, zelfde geüploade documenten.
app.post('/api/audits/:id/rerun', rl.caseAction, auth.requireOwnerToken, caseAccess, async (req, res) => {
  try {
    const c = req.case;
    if (c.status === 'bezig') {
      return res.status(409).json({ error: 'invalid_state', message: 'Deze audit draait al.' });
    }
    const storedKvk = await db.getLatestDocumentByKind(req.params.id, 'kvk').catch(() => null);
    const ctx = {
      naam: c.naam, website: c.website, land: c.land, kvkNummer: c.kvkNummer, notities: c.notities,
      images: [], kvkDocument: storedKvk ? { data: storedKvk.data, mediaType: storedKvk.mimetype } : null
    };
    await db.resetCase(req.params.id);
    pipeline.runFreeTier(req.params.id, ctx).catch(() => {});
    res.json({ case: ownerCase(await db.getCase(req.params.id)) });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Herstart één specifieke stap (bijv. na een fout), zonder de hele audit
// opnieuw te draaien. Zelfde cascade als de oude Artifact-client (runFromStep):
// een onderzoeksstap trekt altijd categorize + de engine + een volledige
// hersynthese achter zich aan, anders raken categorybeoordeling en rapport
// verouderd t.o.v. de net vernieuwde brondata.
app.post('/api/audits/:id/retry-step', rl.caseAction, auth.requireOwnerToken, caseAccess, async (req, res) => {
  const { key } = req.body || {};
  try {
    const c = req.case;
    // Bij een retry van de identiteitsstap willen we een eerder geüpload
    // KvK-document opnieuw laten meewegen, ook al wordt er nu niets nieuws
    // geüpload — vandaar de opzoek in de persistente documents-tabel.
    const storedKvk = await db.getLatestDocumentByKind(req.params.id, 'kvk').catch(() => null);
    const ctx = {
      naam: c.naam, website: c.website, land: c.land, kvkNummer: c.kvkNummer, notities: c.notities,
      images: [], kvkDocument: storedKvk ? { data: storedKvk.data, mediaType: storedKvk.mimetype } : null
    };
    // Welke tier deze case al bereikt heeft bepaalt welke categorize/rapport-
    // prompt hoort te draaien (gratis blijft "buiten scope"-taal gebruiken
    // voor B02 e.d., deep beoordeelt alles volledig) en welke status hierna
    // weer moet gelden — nooit zomaar 'klaar', anders lijkt een gratis case
    // ineens de Deep Dive gehad te hebben.
    const tier = c.tier === 'deep' ? 'deep' : 'gratis';
    const doneStatus = tier === 'deep' ? 'klaar' : 'gratis_klaar';
    await db.updateCase(req.params.id, { status: 'bezig', error: null });
    if (key !== 'reportA' && key !== 'reportB') {
      if (key === 'categorize') {
        await pipeline.runCategorize(req.params.id, ctx, tier);
      } else if (pipeline.RESEARCH_STEP_KEYS.includes(key)) {
        await pipeline.runResearchStep(req.params.id, ctx, key);
        await pipeline.runCategorize(req.params.id, ctx, tier);
      }
    }
    await pipeline.applyScoringEngine(req.params.id);
    await pipeline.runSynthesis(req.params.id, ctx, tier);
    await db.updateCase(req.params.id, { status: doneStatus });
    res.json({ case: ownerCase(await db.getCase(req.params.id)) });
  } catch (e) {
    await db.updateCase(req.params.id, { status: 'fout', error: 'Er ging iets mis tijdens deze stap.' }).catch(() => {});
    res.status(500).json(sanitizeError(e, req));
  }
});

// Los kanaal naast de geautomatiseerde coaDataset-stap: de server kan
// verify.janoshik.com zelf niet bereiken (403, zie projectdoc "COA
// Authenticiteitsverificatie - Janoshik v2.0" §5), dus hier kan een staflid
// een COA uploaden, zelf bij het lab natrekken en het resultaat vastleggen —
// dat telt daarna automatisch mee in elk rapport van diezelfde leverancier
// (coaStore.listVerifiedDocumentsForSupplier, gebruikt in pipeline.js).
const uploadCoa = upload.single('coaFile');

function requireAdmin(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden', message: 'Alleen toegankelijk voor beheerders.' });
  next();
}

// Alleen lezen. Beheerders mogen alles, houders van VIEWER_TOKEN mogen kijken.
// Uitsluitend op routes die niets veranderen - een leestoken hoort nooit een
// upload, een verificatie of een resolver te kunnen starten.
function requireLezer(req, res, next) {
  if (req.isAdmin || req.isViewer) return next();
  return res.status(403).json({ error: 'forbidden', message: 'Alleen toegankelijk voor beheerders of met een leestoken.' });
}

// Wie mag een laboratorium beoordelen? Beheerders en beoordelaars.
//
// HERZIEN 22 SEPTEMBER. Hier stond dat het LEESTOKEN dit ook mocht, als
// bewuste uitzondering: het labooordeel is Annemarie's werk, zij werkt in een
// browser en niet in een chat, en haar het beheerderstoken geven zou haar ook
// uploads en resolverruns geven.
//
// Die reden is vervallen: zij heeft nu een eigen sleutel met precies die rol
// (COA_REDACTIE_TOKEN). Daarmee kan het leestoken terug naar wat de naam
// belooft - alleen kijken. Een token dat "alleen lezen" heet en toch iets kan
// vastleggen is een verrassing die je op het verkeerde moment ontdekt.
//
// De oude uitleg, voor de volledigheid:
//
// LET OP - dit is de ENIGE route waar het leestoken iets mag veranderen, en
// dat is een bewuste uitzondering. Het token heette "alleen lezen" en dat
// klopt nu niet meer helemaal. De reden: het labooordeel is Annemarie's werk,
// zij werkt in een browser en niet in een chat, en haar het beheerderstoken
// geven zou haar ook uploads, resolverruns en verificaties geven. Dit is de
// smalle deur in plaats van de brede.
//
// Wat het leestoken hier NIET mag: een oordeel wissen. Alleen vastleggen en
// bijwerken, en elk oordeel draagt de naam van wie het vastlegde.
function requireBeoordelaar(req, res, next) {
  if (req.isAdmin || req.isBeoordelaar) return next();
  return res.status(403).json({
    error: 'forbidden',
    message: req.isLezer
      ? 'Je kijkt mee met een leestoken. Daarmee kun je niets vastleggen.'
      : 'Alleen toegankelijk voor beheerders en beoordelaars.'
  });
}

// Wie mag een TESTRESULTAAT vastleggen?
//
// 23 september. Dit stond op requireAdmin en dat was precies verkeerd om:
// Ruben kon accepteren, Annemarie niet — terwijl zij de enige is die het
// oordeel mag geven. Zij deed het hele voorwerk (rapport ophalen, uitlezen,
// velden nalopen) en kreeg bij de laatste klik een 403.
//
// Waarom een EIGEN functie en niet gewoon requireBeoordelaar, dat vandaag
// hetzelfde teruggeeft: het zijn twee verschillende handelingen. Een
// redacteur verandert hoe iets leest; wie een test accepteert zet een stempel
// die naar buiten gaat. Voorlopig gedekt door dezelfde sleutel — maar als
// aparte functie, zodat het later te splitsen is zonder de routes opnieuw aan
// te raken. De grens staat dan in de code en niet alleen in een afspraak.
//
// LET OP wat hier NIET bij zit, bewust: upload, herlees en resolve. Dat is
// zwaarder werk en blijft aan de beheerder hangen.
function magTestenAccepteren(req) {
  return !!(req.isAdmin || req.isBeoordelaar);
}

function requireTestbeoordelaar(req, res, next) {
  if (magTestenAccepteren(req)) return next();
  return res.status(403).json({
    error: 'forbidden',
    message: req.isLezer
      ? 'Je kijkt mee met een leestoken. Daarmee kun je geen test accepteren.'
      : 'Alleen toegankelijk voor beheerders en beoordelaars.'
  });
}

// Alle laboratoria die we tegenkomen, met wat we erover weten en twee
// signalen die geen mens hoeft te bedenken: komt dit lab maar bij een
// leverancier voor, en is er ook maar een verwijzing die een buitenstaander
// zelf kan nalopen.
app.get('/api/admin/laboratoria', rl.read, auth.requireOwnerToken, requireLezer, async (req, res) => {
  try {
    const labs = await coaStore.labSignalen();
    res.json({
      aantal: labs.length,
      bestaatNiet: labs.filter((l) => l.oordeel && l.oordeel.status === 'bestaat niet').map((l) => l.lab),
      zonderOordeel: labs.filter((l) => !l.oordeel).map((l) => l.lab),
      teControleren: labs.filter((l) => !l.oordeel && (l.maarEenLeverancier || l.nooitOnafhankelijkTeControleren)).map((l) => l.lab),
      // De lijst waaruit de beoordelaar kiest, zodat de pagina hem niet apart
      // hoeft te kennen en een nieuwe stand vanzelf meekomt.
      statussen: coaStore.LAB_STATUSSEN,
      labs
    });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Een laboratorium beoordelen. Schrijft in lab_oordelen - de tabel van de
// MENS. Het model schrijft in labBeoordelingen en komt hier nooit; wat naar
// buiten gaat is altijd dit oordeel.
app.post('/api/admin/laboratoria/beoordeling', rl.caseAction, auth.requireOwnerToken, requireBeoordelaar, async (req, res) => {
  try {
    const b = req.body || {};
    const lab = String(b.lab || '').trim();
    if (!lab) return res.status(400).json({ error: 'geen_lab', message: 'Geef de naam van het laboratorium mee.' });
    if (coaStore.LAB_STATUSSEN.indexOf(b.status) === -1) {
      return res.status(400).json({ error: 'ongeldige_status', message: 'status moet een van: ' + coaStore.LAB_STATUSSEN.join(', ') });
    }
    const vastgelegdDoor = String(b.vastgelegdDoor || '').trim();
    if (!vastgelegdDoor) return res.status(400).json({ error: 'geen_naam', message: 'Vul in wie dit heeft vastgesteld.' });
    // Een onderbouwing is verplicht bij alles behalve "nog niet beoordeeld".
    // Een status zonder reden is over een half jaar niet meer na te gaan, en
    // erft wel door naar elke shop die naar dit lab verwijst.
    const onderbouwing = String(b.onderbouwing || '').trim();
    if (b.status !== 'nog niet beoordeeld' && onderbouwing.length < 10) {
      return res.status(400).json({ error: 'geen_onderbouwing', message: 'Schrijf op wat je hebt nagegaan en wat je vond.' });
    }
    // "bestaat niet" is de zwaarste uitspraak in het systeem: hij maakt elk
    // certificaat dat naar dit lab wijst waardeloos. Die mag niet zonder bron.
    const bronnen = Array.isArray(b.bronnen) ? b.bronnen.filter((x) => String(x || '').trim()) : [];
    if (b.status === 'bestaat niet' && !bronnen.length) {
      return res.status(400).json({ error: 'geen_bronnen', message: 'Voor "bestaat niet" zijn bronnen verplicht: waar heb je dat vastgesteld?' });
    }
    const opgeslagen = await coaStore.saveLabOordeel(lab, {
      status: b.status, onderbouwing: onderbouwing || null,
      bronnen: bronnen.length ? bronnen : null,
      vastgelegdDoor,
      informatieOpgevraagd: typeof b.informatieOpgevraagd === 'boolean' ? b.informatieOpgevraagd : null,
      informatieReactie: b.informatieReactie || null
    });
    if (!opgeslagen) return res.status(500).json({ error: 'opslaan_mislukt', message: 'Het oordeel kon niet worden opgeslagen.' });
    res.json({ ok: true, oordeel: opgeslagen });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Wie ben ik? Er zijn geen accounts - dat was een ontwerpkeuze, zie auth.js -
// maar er zijn wel twee tokens, en die zeggen genoeg: ADMIN_TOKEN is de
// beheerder, VIEWER_TOKEN is de beoordelaar. De stafpagina kan daarmee tonen
// wie er kijkt zonder dat er een inlogsysteem bij hoeft.
//
// LET OP wat dit NIET is: het token zegt welke ROL je hebt, niet wie je bent.
// De naam die bij een oordeel komt te staan typt de beoordelaar zelf in. Twee
// mensen die hetzelfde token gebruiken zijn voor de server dezelfde.
app.get('/api/admin/wie-ben-ik', rl.read, auth.requireOwnerToken, requireLezer, async (req, res) => {
  res.json({
    rol: req.rol || 'lezer',
    magBeoordelen: !!(req.isAdmin || req.isBeoordelaar),
    magTestenAccepteren: magTestenAccepteren(req),
    magUploaden: !!req.isAdmin,
    // Zodat de pagina niet zelf hoeft te weten wat er bestaat.
    labStatussen: coaStore.LAB_STATUSSEN,
    naamStatussen: coaStore.NAAM_STATUSSEN
  });
});

// De redactielus, ook over HTTP - zodat een stafpagina de openstaande
// tekstcorrecties kan tonen zonder een MCP-verbinding. Lezen mag een lezer;
// vastleggen ook, want dit IS het werk van de redactie en het raakt geen
// bewijs.
app.get('/api/admin/tekstoordelen', rl.read, auth.requireOwnerToken, requireLezer, async (req, res) => {
  try {
    const status = String(req.query.status || 'open');
    const oordelen = await coaStore.tekstoordelen({ status, max: Number(req.query.max) || 50 });
    const regels = await coaStore.schrijfregels({});
    res.json({ status, aantal: oordelen.length, oordelen, schrijfregels: regels });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

app.post('/api/admin/tekstoordelen', rl.caseAction, auth.requireOwnerToken, requireBeoordelaar, async (req, res) => {
  try {
    const b = req.body || {};
    if (!String(b.origineel || '').trim() || !String(b.gewenst || '').trim()) {
      return res.status(400).json({ error: 'onvolledig', message: 'Geef origineel en gewenst mee.' });
    }
    if (!String(b.door || '').trim()) {
      return res.status(400).json({ error: 'geen_naam', message: 'Vul in wie dit heeft aangeleverd.' });
    }
    const opgeslagen = await coaStore.saveTekstoordeel(b);
    if (!opgeslagen) return res.status(500).json({ error: 'opslaan_mislukt' });
    res.json({ ok: true, id: opgeslagen.id, herkomst: opgeslagen.herkomst });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Het portret van een leverancier vastleggen: het geschreven stuk over wie
// deze partij is. Lezen mag een lezer, schrijven vraagt een beoordelaar -
// dit is redactiewerk en dat is Annemarie's werk, niet dat van het systeem.
//
// HIER ZITTEN GEEN GETALLEN IN. Geen tellingen, geen percentages, geen
// zuiverheid, geen score. Die komen uit de database en veranderen per run;
// een tekst die ze noemt is binnen een week onwaar zonder dat iemand het
// merkt. Het systeem weigert een portret daar niet om - dat zou een
// jaartal of een postcode ook treffen - maar de admin waarschuwt erop.
app.post('/api/admin/leveranciers/portret', rl.caseAction, auth.requireOwnerToken, requireBeoordelaar, async (req, res) => {
  try {
    const b = req.body || {};
    const key = coaStore.supplierKeyFromUrl(String(b.supplierKey || '').trim());
    if (!key) return res.status(400).json({ error: 'geen_leverancier', message: 'Geef mee om welke leverancier het gaat.' });
    const tekst = String(b.tekst || '').trim();
    if (tekst.length < 40) {
      return res.status(400).json({ error: 'geen_tekst', message: 'Schrijf een portret van minstens een paar zinnen.' });
    }
    const vastgelegdDoor = String(b.vastgelegdDoor || '').trim();
    if (!vastgelegdDoor) return res.status(400).json({ error: 'geen_schrijver', message: 'Vul in wie dit heeft geschreven.' });
    const bronnen = Array.isArray(b.bronnen) ? b.bronnen.filter((x) => String(x || '').trim()) : [];

    const opgeslagen = await coaStore.savePortret(key, { tekst, bronnen, vastgelegdDoor });
    if (!opgeslagen) return res.status(500).json({ error: 'niet_opgeslagen', message: 'Opslaan is niet gelukt.' });
    res.json({ ok: true, portret: opgeslagen });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Vestigingsland vastleggen, voor een lab of een leverancier. BESLUIT RUBEN
// 22 september: "EU" gaat over de juridische vestiging, niet het verzendland.
//
// Zelfde opzet als de labstand: lezen mag een lezer, vastleggen vraagt een
// beoordelaar, en zonder naam en onderbouwing gaat er niets in. Het systeem
// leidt zelf een land af uit briefhoofd, rechtsvorm en landdomein, maar dat
// blijft een voorstel - wat hier binnenkomt gaat daar altijd boven.
app.post('/api/admin/vestiging', rl.caseAction, auth.requireOwnerToken, requireBeoordelaar, async (req, res) => {
  try {
    const b = req.body || {};
    const soort = String(b.soort || '').trim();
    if (soort !== 'lab' && soort !== 'leverancier') {
      return res.status(400).json({ error: 'ongeldige_soort', message: 'soort moet "lab" of "leverancier" zijn.' });
    }
    const naam = String(b.naam || '').trim();
    if (!naam) return res.status(400).json({ error: 'geen_naam', message: 'Geef de naam van het lab of de leverancier mee.' });
    const vastgelegdDoor = String(b.vastgelegdDoor || '').trim();
    if (!vastgelegdDoor) return res.status(400).json({ error: 'geen_beoordelaar', message: 'Vul in wie dit heeft vastgesteld.' });

    // Het land mag als code ("nl") of als naam ("Nederland") binnenkomen.
    const herkend = vestiging.normaliseerLand(b.land);
    if (!herkend.land) {
      return res.status(400).json({ error: 'geen_land', message: 'Vul een land in, als landcode (nl) of als naam (Nederland).' });
    }
    // Een land zonder onderbouwing is over een half jaar niet na te gaan, en
    // het bepaalt straks of iemand een betaalde verdieping krijgt aangeboden.
    const onderbouwing = String(b.onderbouwing || '').trim();
    if (onderbouwing.length < 10) {
      return res.status(400).json({ error: 'geen_onderbouwing', message: 'Schrijf op waar je dit hebt vastgesteld.' });
    }
    const bronnen = Array.isArray(b.bronnen) ? b.bronnen.filter((x) => String(x || '').trim()) : [];

    const sleutel = soort === 'lab'
      ? coaStore.labSleutel(coaStore.normaliseerLab(naam).naam)
      : coaStore.supplierKeyFromUrl(naam);
    if (!sleutel) return res.status(400).json({ error: 'geen_sleutel', message: 'Kon geen sleutel maken van deze naam.' });

    const opgeslagen = await coaStore.saveVestiging(soort, sleutel, {
      naam,
      land: herkend.land,
      landcode: herkend.landcode,
      // eu blijft null bij een land dat we niet op de lijst hebben. Dan staat
      // er wel een land, maar doen we geen EU-uitspraak.
      eu: herkend.eu,
      onderbouwing,
      bronnen: bronnen.length ? bronnen : null,
      vastgelegdDoor
    });
    if (!opgeslagen) return res.status(500).json({ error: 'opslaan_mislukt', message: 'De vestiging kon niet worden opgeslagen.' });
    res.json({ ok: true, vestiging: opgeslagen });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// A16 - de handmatige naambeoordeling. Een productnaam die afwijkt van de
// stof waartegen het lab de identiteit toetste is een controletrigger, geen
// afkeuring: twee uitkomsten, en alleen bij "handmatig bevestigd als
// handelsnaam/alias" telt het bewijs van dat rapport normaal mee.
//
// Zelfde opzet als bij de laboratoria: lezen mag een lezer, vastleggen vraagt
// een beoordelaar, en een uitkomst zonder onderbouwing wordt geweigerd. Wat
// hier wordt vastgelegd houdt een rapport binnen of buiten het bewijs; dat
// moet over een half jaar nog na te gaan zijn.
app.get('/api/admin/naamkoppelingen', rl.read, auth.requireOwnerToken, requireLezer, async (req, res) => {
  try {
    const leverancier = String(req.query.leverancier || '').trim() || null;
    const oordelen = await coaStore.naamOordelen(leverancier);
    res.json({
      statussen: coaStore.NAAM_STATUSSEN,
      aantal: Object.keys(oordelen).length,
      oordelen: Object.values(oordelen)
    });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

app.post('/api/admin/naamkoppelingen/beoordeling', rl.caseAction, auth.requireOwnerToken, requireBeoordelaar, async (req, res) => {
  try {
    const b = req.body || {};
    const leverancier = String(b.leverancier || '').trim();
    const product = String(b.product || '').trim();
    const stof = String(b.getoetsteStof || '').trim();
    if (!leverancier || !product || !stof) {
      return res.status(400).json({ error: 'onvolledig', message: 'Geef leverancier, product en getoetsteStof mee.' });
    }
    if (coaStore.NAAM_STATUSSEN.indexOf(b.status) === -1) {
      return res.status(400).json({ error: 'ongeldige_status', message: 'status moet een van: ' + coaStore.NAAM_STATUSSEN.join(', ') });
    }
    const vastgelegdDoor = String(b.vastgelegdDoor || '').trim();
    if (!vastgelegdDoor) return res.status(400).json({ error: 'geen_naam', message: 'Vul in wie dit heeft vastgesteld.' });
    const onderbouwing = String(b.onderbouwing || '').trim();
    if (b.status !== 'wacht op beoordeling' && onderbouwing.length < 10) {
      return res.status(400).json({ error: 'geen_onderbouwing', message: 'Schrijf op waar je dit op baseert: is dit een bekende handelsnaam, of is de koppeling niet aangetoond?' });
    }
    const opgeslagen = await coaStore.saveNaamOordeel(leverancier, product, stof, {
      status: b.status, onderbouwing: onderbouwing || null, vastgelegdDoor
    });
    if (!opgeslagen) return res.status(500).json({ error: 'opslaan_mislukt', message: 'Het oordeel kon niet worden opgeslagen.' });
    res.json({ ok: true, oordeel: opgeslagen });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Stafoverzicht: een regel per leverancier, en per leverancier alles wat we
// hebben. Bestond nog niet - alles zat in de database maar er was geen plek
// waar je het zag.
app.get('/api/admin/leveranciers', rl.read, auth.requireOwnerToken, requireLezer, async (req, res) => {
  try {
    const rijen = await coaStore.leveranciersOverzicht();
    res.json({
      aantal: rijen.length,
      totalen: {
        referenties: rijen.reduce((n, r) => n + r.referenties, 0),
        gecontroleerd: rijen.reduce((n, r) => n + r.gecontroleerd, 0),
        opNaamVanDerde: rijen.reduce((n, r) => n + r.opNaamVanDerde, 0),
        metVeldverschil: rijen.reduce((n, r) => n + r.metVeldverschil, 0),
        documenten: rijen.reduce((n, r) => n + r.documenten, 0)
      },
      leveranciers: rijen
    });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Detail van een leverancier: alle labverwijzingen met hun controle, en alle
// documenten. Dit is wat Annemarie openklapt om te zien wat er werkelijk ligt.
app.get('/api/admin/leveranciers/:supplierKey', rl.read, auth.requireOwnerToken, requireLezer, async (req, res) => {
  try {
    const key = coaStore.supplierKeyFromUrl(req.params.supplierKey);
    const [referenties, documenten, laboordeel, portret] = await Promise.all([
      coaStore.referentiesVanLeverancier(key, 500),
      coaStore.getDocumentsBySupplier(key),
      coaStore.laboordeelVoorLeverancier(key),
      coaStore.portret(key)
    ]);
    referenties.forEach((r) => {
      r.wieBesteldeDeTest = (r.controle && r.controle.client)
        ? coaStore.wieBesteldeDeTest(r.controle.client, [key])
        : null;
    });
    res.json({
      supplierKey: key,
      // Het geschreven stuk over deze leverancier. Null betekent: nog niet
      // geschreven. Het staat hier los van alles wat geteld wordt, want het
      // verandert niet mee met een run.
      portret,
      // Zwaarste bevinding die we kennen: verwijst deze leverancier naar een
      // laboratorium waarvan een mens heeft vastgesteld dat het niet bestaat?
      laboordeel,
      referenties,
      documenten: documenten.map((d) => ({
        sha256: d.sha256, url: d.url, status: d.status, lab: d.lab,
        taskNumber: d.task_number, klasse: d.authenticity_class,
        mimetype: d.mimetype, byteSize: d.byte_size,
        // TWEE IDENTIFICATOREN PER RAPPORT. Bij Janoshik is de labreferentie
        // het taaknummer, en dan is task_number genoeg. RC Testing geeft er
        // twee: een rapportnummer (RC749587, dat komt hier binnen als
        // task_number) en een losse verificatiesleutel (84590223). De
        // labreferentie hangt aan de SLEUTEL. Zonder dit veld kon de admin het
        // document niet bij de referentie vinden en stond er "Nog geen
        // rapport" terwijl de PDF gewoon in het archief zat - 23 september zo
        // gevonden bij alle dertig documenten van peptidekliniek.
        verificatieSleutels: (d.extraction && Array.isArray(d.extraction.coaRecords)
          ? d.extraction.coaRecords.map((c) => c && c.verificationKey).filter(Boolean).map(String)
          : []),
        product: (d.extraction && d.extraction.coaRecords && d.extraction.coaRecords[0] && d.extraction.coaRecords[0].product) || null,
        zuiverheid: (d.extraction && d.extraction.coaRecords && d.extraction.coaRecords[0] && d.extraction.coaRecords[0].purityPercent) || null,
        eersteAnalyse: d.first_analyzed_at
      }))
    });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Kruisverband over alle leveranciers heen: hetzelfde bestand of hetzelfde
// task-nummer bij meer dan een shop, en per lab welke shops ernaar wijzen.
// LET OP: deze route MOET boven /api/admin/coa/:supplierKey blijven staan,
// anders vangt die parameter-route het pad "kruisverband" op.
app.get('/api/admin/coa/kruisverband', rl.read, auth.requireOwnerToken, requireLezer, async (req, res) => {
  try {
    res.json(await coaStore.crossSupplierOverview());
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Vastleggen wat een mens op de verificatiepagina van het lab heeft gezien.
// Hangt aan de referentie, niet aan een leverancier: of rapport 221439
// bestaat en wie de opdrachtgever is, verandert niet per shop. Een controle
// telt dus meteen voor elke shop die naar datzelfde rapport verwijst.
// Staat bewust boven /api/admin/coa/:supplierKey.
app.post('/api/admin/coa/references/verify', rl.caseAction, auth.requireOwnerToken, requireTestbeoordelaar, async (req, res) => {
  try {
    const b = req.body || {};
    const lab = (b.lab || 'Janoshik').trim();
    const referentie = (b.referentie || '').trim();
    if (!referentie) return res.status(400).json({ error: 'geen_referentie', message: 'Geef de referentie mee (bijv. 221439-reta20_RE200804_P3C3N2UBW4YL).' });
    if (b.klasse && !['A', 'B', 'C', 'D'].includes(b.klasse)) {
      return res.status(400).json({ error: 'ongeldige_klasse', message: 'klasse moet A, B, C of D zijn.' });
    }
    // gecontroleerdDoor is de naam die de MCP-tool gebruikt. Beide worden
    // geaccepteerd, zodat dezelfde json langs beide routes werkt.
    const checkedBy = b.checkedBy || b.gecontroleerdDoor || null;
    if (!checkedBy) return res.status(400).json({ error: 'geen_naam', message: 'Vul in wie de controle heeft uitgevoerd (checkedBy of gecontroleerdDoor).' });
    // Dezelfde eis als in de MCP-tool: een klasse zonder verwijzing naar
    // waartegen is vergeleken rust nergens op.
    if (b.klasse && !b.vergelekenMet) {
      return res.status(400).json({ error: 'geen_vergelijking', message: 'Bij een klasse hoort vergelekenMet: de URL van de kopie bij de shop, of het sha256 van het document.' });
    }
    // Task, sample en sleutel zitten al in de referentie; die hoeft de
    // aanroeper niet los mee te sturen. Wat wel wordt meegegeven wint.
    const ontleed = coaStore.referentieUitUrl(lab, referentie) || {};
    // Deze route gaf eerder maar zeven velden door terwijl saveReferenceCheck
    // er veel meer kent. Wie via curl schreef verloor stilzwijgend zuiverheid,
    // vulling, vialen, componenten en de veldvergelijking. Nu dezelfde velden
    // als de MCP-tool, zodat de schrijfroute niet uitmaakt voor wat er staat.
    const opgeslagen = await coaStore.saveReferenceCheck(lab, referentie, {
      taskNumber: b.taskNumber || ontleed.taskNumber || null,
      resolvet: typeof b.resolvet === 'boolean' ? b.resolvet : null,
      klasse: b.klasse || null,
      client: b.client || null,
      product: b.product || null,
      batchnummer: b.batchnummer || null,
      testnaam: b.testnaam || null,
      testsoorten: Array.isArray(b.testsoorten) ? b.testsoorten : null,
      zuiverheid: b.zuiverheid || null,
      vulling: b.vulling || null,
      gemetenMg: typeof b.gemetenMg === 'number' ? b.gemetenMg : undefined,
      etiketMg: typeof b.etiketMg === 'number' ? b.etiketMg : undefined,
      vialen: Array.isArray(b.vialen) ? b.vialen : null,
      componenten: Array.isArray(b.componenten) ? b.componenten : null,
      metaalcomplex: b.metaalcomplex || null,
      manufacturer: b.manufacturer || null,
      datumAnalyse: b.datumAnalyse || null,
      vergelekenMet: b.vergelekenMet || null,
      kopieShop: b.kopieShop || null,
      bijLab: b.bijLab || null,
      resolvedUrl: b.resolvedUrl || (/^https?:\/\//i.test(referentie) ? referentie : null) ||
        (/janoshik/i.test(lab) && ontleed.referentie ? 'https://verify.janoshik.com/tests/' + encodeURIComponent(ontleed.referentie) : null),
      notitie: b.notitie || null,
      checkedBy
    });
    if (!opgeslagen) return res.status(500).json({ error: 'opslaan_mislukt', message: 'De controle kon niet worden opgeslagen.' });
    res.json({ ok: true, controle: opgeslagen });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Het adres van de rapportafbeelding bij het lab vastleggen.
//
// Waarom een mens dit moet plakken: de verificatiepagina van Janoshik zit
// achter Cloudflare. Onze server komt er niet in, en de adminpagina mag hem
// niet ophalen (CORS). De AFBEELDING laadt wel gewoon; alleen haar adres is
// niet te vinden zonder die pagina. Een mens die hem toch opent kopieert het
// adres. Daarna staat het rapport er voor iedereen bij.
//
// Dit is geen controle en het zet geen klasse. Het legt alleen vast waar het
// papier te zien is.
app.post('/api/admin/coa/references/rapport', rl.caseAction, auth.requireOwnerToken, requireBeoordelaar, async (req, res) => {
  try {
    const b = req.body || {};
    const referentie = (b.referentie || '').trim();
    const url = (b.url || '').trim();
    const door = b.door || b.toegevoegdDoor || null;
    if (!referentie) return res.status(400).json({ error: 'geen_referentie', message: 'Geef de referentie mee.' });
    if (!/^https:\/\//i.test(url)) {
      return res.status(400).json({ error: 'geen_https', message: 'Het adres moet met https:// beginnen.' });
    }
    const bekend = await coaStore.referentieMetRapport(null, referentie);
    if (!bekend) return res.status(404).json({ error: 'onbekende_referentie', message: 'Deze referentie kennen wij niet.' });

    // Het adres moet van het lab komen. Zou de kopie van de shop hier mogen
    // staan, dan poetst dit precies het verschil weg dat de controle meet.
    const domein = (h) => String(h || '').toLowerCase().split('.').slice(-2).join('.');
    let labHost = '', plakHost = '';
    try { labHost = new URL(bekend.url || '').hostname; } catch (e) {}
    try { plakHost = new URL(url).hostname; } catch (e) {}
    if (!plakHost) return res.status(400).json({ error: 'geen_adres', message: 'Dat is geen geldig webadres.' });
    if (labHost && domein(labHost) !== domein(plakHost)) {
      return res.status(400).json({
        error: 'ander_domein',
        message: 'Dit adres komt van ' + plakHost + ', en de referentie hoort bij ' + labHost +
          '. Alleen het rapport bij het lab hoort hier; de kopie van de shop staat al elders.'
      });
    }
    const opgeslagen = await coaStore.saveReferenceRapport(bekend.lab, bekend.referentie, url, door);
    if (!opgeslagen) return res.status(500).json({ error: 'opslaan_mislukt', message: 'Het adres kon niet worden opgeslagen.' });
    res.json({ ok: true, rapport: opgeslagen });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// De afbeelding zelf, geplakt uit het klembord. Komt binnen als data-URL.
// Eigen bodyparser met meer ruimte: de standaard staat op 2 MB en dat is
// voor een rapportscan aan de krappe kant. De browser schaalt al terug.
app.post('/api/admin/coa/references/rapport/afbeelding',
  rl.caseAction, auth.requireOwnerToken, requireBeoordelaar, express.json({ limit: '8mb' }),
  async (req, res) => {
    try {
      const b = req.body || {};
      const referentie = (b.referentie || '').trim();
      const dataUrl = String(b.dataUrl || '');
      const door = b.door || b.toegevoegdDoor || null;
      if (!referentie) return res.status(400).json({ error: 'geen_referentie', message: 'Geef de referentie mee.' });
      const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
      if (!m) return res.status(400).json({ error: 'geen_afbeelding', message: 'Plak een afbeelding (png, jpeg of webp).' });
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length) return res.status(400).json({ error: 'leeg', message: 'De afbeelding is leeg.' });
      if (buf.length > 6 * 1024 * 1024) {
        return res.status(413).json({ error: 'te_groot', message: 'De afbeelding is groter dan 6 MB.' });
      }
      const bekend = await coaStore.referentieMetRapport(null, referentie);
      if (!bekend) return res.status(404).json({ error: 'onbekende_referentie', message: 'Deze referentie kennen wij niet.' });
      const opgeslagen = await coaStore.saveReferenceRapportBestand(bekend.lab, bekend.referentie, m[1], buf, door);
      if (!opgeslagen) return res.status(500).json({ error: 'opslaan_mislukt', message: 'De afbeelding kon niet worden opgeslagen.' });
      res.json({ ok: true, rapport: opgeslagen });
    } catch (e) {
      res.status(500).json(sanitizeError(e, req));
    }
  });

// De geplakte afbeelding teruggeven. Met het token in de header, niet in de
// URL: een adres belandt in logs en in de geschiedenis van de browser.
// De pagina haalt hem daarom op met fetch en maakt er zelf een blob van.
app.get('/api/admin/coa/references/rapport/afbeelding', rl.read, auth.requireOwnerToken, requireLezer, async (req, res) => {
  try {
    const referentie = (req.query.referentie || '').trim();
    if (!referentie) return res.status(400).json({ error: 'geen_referentie', message: 'Geef de referentie mee.' });
    const bestand = await coaStore.referenceRapportBestand(referentie);
    if (!bestand) return res.status(404).json({ error: 'geen_afbeelding', message: 'Voor deze referentie is geen afbeelding bewaard.' });
    res.set('Content-Type', bestand.mimetype);
    res.set('Cache-Control', 'private, max-age=600');
    res.send(bestand.bytes);
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Het rapport machinaal laten lezen.
//
// LET OP wat dit WEL en NIET is. Dit is een LEZING, geen vaststelling. Een
// model leest de scan en zegt wat het denkt te zien; dat kan misgaan, en een
// verkeerd gelezen zuiverheid die stilzwijgend als labwaarde wordt vastgelegd
// is erger dan helemaal geen lezing. Daarom slaat deze route NIETS op. Wat
// eruit komt gaat in de admin in een eigen kolom naast wat de shop zegt, en
// pas als een mens per veld aanvinkt dat het klopt, belandt het in de
// administratie via de gewone verify-route. Zie A14 en bewijs-boven-vermoeden.
app.post('/api/admin/coa/references/rapport/uitlezen', rl.caseAction, auth.requireOwnerToken, requireBeoordelaar, async (req, res) => {
  try {
    const referentie = ((req.body && req.body.referentie) || '').trim();
    if (!referentie) return res.status(400).json({ error: 'geen_referentie', message: 'Geef de referentie mee.' });
    const bestand = await coaStore.referenceRapportBestand(referentie);
    if (!bestand) {
      return res.status(404).json({
        error: 'geen_afbeelding',
        message: 'Er is voor deze referentie geen afbeelding bewaard. Plak eerst het rapport erbij; ' +
                 'een adres alleen kunnen wij niet ophalen, want het lab laat onze server er niet in.'
      });
    }
    const prompt = [
      'Hieronder staat een scan van een labrapport. Schrijf over wat er letterlijk staat.',
      '',
      'Regels:',
      '- Neem waarden LETTERLIJK over, inclusief eenheid en schrijfwijze. Niet afronden, niet herschrijven.',
      '- Staat een veld er niet, of kun je het niet met zekerheid lezen, dan null. Niet gokken.',
      '- Reken niets uit en leid niets af. Geen percentages berekenen, geen namen aanvullen,',
      '  geen datum omzetten die er niet staat.',
      '- Twijfel je over een teken (een 3 of een 8, een punt of een komma), zet het veld in',
      '  onzeker en laat de waarde staan zoals je hem het meest waarschijnlijk leest.',
      '',
      'Geef ALLEEN dit JSON-object terug, zonder tekst eromheen:',
      '{',
      '  "client": string|null,           // Client / opdrachtgever',
      '  "manufacturer": string|null,     // Manufacturer / fabrikant',
      '  "product": string|null,          // Sample, zoals het er staat',
      '  "batchnummer": string|null,      // Batch',
      '  "taskNumber": string|null,       // Task Number, zonder het hekje',
      '  "sleutel": string|null,          // de unique key onderaan',
      '  "testnaam": string|null,         // Tests requested, letterlijk',
      '  "zuiverheid": string|null,       // Purity zoals het er staat, bv "99.849%"',
      '  "gemetenMg": number|null,        // het gemeten aantal mg, alleen het getal',
      '  "datumAnalyse": string|null,     // Analysis conducted, als JJJJ-MM-DD',
      '  "resultaatregels": [ { "wat": string, "waarde": string } ],  // de tabel onder Results, letterlijk',
      '  "opmerkingen": string|null,      // Comments, letterlijk; leeg vak is null',
      '  "onzeker": [string]              // namen van de velden hierboven waar je niet zeker van bent',
      '}'
    ].join('\n');
    const gelezen = await anthropicClient.sampleJson(prompt, {
      images: [{ data: Buffer.from(bestand.bytes).toString('base64'), mediaType: bestand.mimetype }],
      maxTokens: 2048,
      label: 'rapport-uitlezen'
    });
    // Hoort dit rapport wel bij deze referentie? Een Janoshik-referentie
    // begint met het taaknummer (102064-Tirzepatide_60mg_YYPMGG45D735), dus
    // dat is na te rekenen. Wijkt het af, dan is er een ander rapport
    // ingeplakt en mogen deze waarden hier niet terechtkomen - dat is precies
    // de fout die je later nooit meer terugvindt.
    //
    // Alleen toetsen als de referentie ook echt met cijfers begint: bij een
    // lab met een ander formaat valt er niets te vergelijken en zou een
    // weigering onterecht zijn.
    const taakInRef = /^(\d{3,})/.exec(referentie);
    const taakOpRapport = String(gelezen && gelezen.taskNumber || '').replace(/[^0-9]/g, '');
    if (taakInRef && taakOpRapport && taakInRef[1] !== taakOpRapport) {
      return res.status(409).json({
        error: 'ander_rapport',
        message: 'Op dit rapport staat taaknummer ' + taakOpRapport + ', maar deze referentie hoort bij ' +
          taakInRef[1] + '. Er is een ander rapport ingeplakt; er is niets uitgelezen.'
      });
    }
    // De unieke sleutel is een zachtere toets: niet elk labformaat zet hem in
    // de referentie, dus dit is een waarschuwing en geen weigering.
    const waarschuwingen = [];
    const sleutel = String(gelezen && gelezen.sleutel || '').trim();
    if (sleutel && sleutel.length >= 6 && referentie.toLowerCase().indexOf(sleutel.toLowerCase()) === -1) {
      waarschuwingen.push('De unieke sleutel op het rapport (' + sleutel + ') komt niet voor in de referentie.');
    }

    res.json({ ok: true, gelezen, waarschuwingen, gelezenOp: Date.now() });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Weghalen wat erbij gezet is. Het rapport is geen oordeel, dus weggooien
// raakt geen controle: alleen het papier verdwijnt uit beeld.
app.delete('/api/admin/coa/references/rapport', rl.caseAction, auth.requireOwnerToken, requireBeoordelaar, async (req, res) => {
  try {
    const referentie = (req.query.referentie || (req.body && req.body.referentie) || '').trim();
    if (!referentie) return res.status(400).json({ error: 'geen_referentie', message: 'Geef de referentie mee.' });
    const ok = await coaStore.wisReferenceRapport(referentie);
    if (!ok) return res.status(500).json({ error: 'wissen_mislukt', message: 'Het rapport kon niet worden weggehaald.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Meten of onze server die afbeelding zelf kan ophalen. Alleen een meting:
// hij slaat niets op en geeft de afbeelding niet door. Nodig om te weten of
// we het rapport ooit machinaal kunnen uitlezen, of dat dat alleen in de
// browser kan.
//
// Het adres komt NIET uit de vraag maar uit wat wij al hebben opgeslagen.
// Anders is dit een open deur om onze server willekeurige adressen te laten
// ophalen - ook interne.
app.get('/api/admin/coa/references/rapport/proef', rl.read, auth.requireOwnerToken, requireBeoordelaar, async (req, res) => {
  try {
    const referentie = (req.query.referentie || '').trim();
    if (!referentie) return res.status(400).json({ error: 'geen_referentie', message: 'Geef de referentie mee.' });
    const bekend = await coaStore.referentieMetRapport(null, referentie);
    if (!bekend || !bekend.afbeeldingUrl) {
      return res.status(404).json({ error: 'geen_rapport', message: 'Voor deze referentie is nog geen rapportadres vastgelegd.' });
    }
    const begin = Date.now();
    const af = new AbortController();
    const klok = setTimeout(() => af.abort(), 15000);
    try {
      const r = await fetch(bekend.afbeeldingUrl, { redirect: 'follow', signal: af.signal });
      const buf = Buffer.from(await r.arrayBuffer());
      clearTimeout(klok);
      res.json({
        ok: r.ok, status: r.status,
        contentType: r.headers.get('content-type') || null,
        bytes: buf.length,
        ms: Date.now() - begin,
        // De eerste bytes verraden of het echt een plaatje is of een
        // Cloudflare-pagina met de status 200 erop.
        begintMet: buf.slice(0, 8).toString('hex')
      });
    } catch (e) {
      clearTimeout(klok);
      res.json({ ok: false, fout: (e && e.message) || String(e), ms: Date.now() - begin });
    }
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Alle referenties van een lab met hun controle. Nodig omdat het kruisverband
// alleen GEDEELDE referenties toont, en een lab met een enkele shop die per
// definitie niet heeft - de 45 opgeloste Bridge-rapporten waren daardoor
// nergens terug te zien.
app.get('/api/admin/coa/references', rl.read, auth.requireOwnerToken, requireLezer, async (req, res) => {
  try {
    const rijen = await coaStore.referentiesMetControle(req.query.lab || null, req.query.max);
    // LET OP: rijen is een PAGINA (standaard 100, cap 500), gesorteerd op
    // laatst gecontroleerd. Tellen over die pagina geeft een te rooskleurig
    // beeld, want het gecontroleerde werk staat vooraan. De echte aantallen
    // komen uit een aparte telling over de hele tabel.
    const totalen = await coaStore.referentieTotalen(req.query.lab || null);
    const metControle = rijen.filter((r) => r.controle);
    const perLab = {};
    rijen.forEach((r) => { const k = r.labNet || r.lab || 'onbekend'; perLab[k] = (perLab[k] || 0) + 1; });
    const clients = {};
    metControle.forEach((r) => {
      const c = (r.controle.client || 'onbekend').toLowerCase();
      clients[c] = (clients[c] || 0) + 1;
    });
    // Van wie is deze test? Zodra twee shops hetzelfde rapport tonen is het
    // niet van allebei. Deze afgeleide zegt per referentie of de opdrachtgever
    // een van de tonende shops is, of een derde partij.
    rijen.forEach((r) => {
      r.wieBesteldeDeTest = (r.controle && r.controle.client)
        ? coaStore.wieBesteldeDeTest(r.controle.client, r.leveranciers)
        : null;
    });
    const derdePartij = rijen.filter((r) => r.wieBesteldeDeTest && r.wieBesteldeDeTest.derdePartij);
    const gedeeldMaarVanEen = rijen.filter((r) => r.wieBesteldeDeTest && r.wieBesteldeDeTest.gedeeldMaarVanEen);
    res.json({
      lab: req.query.lab || 'alle',
      // Wat er werkelijk in het archief staat.
      totaal: totalen.totaal,
      gecontroleerd: totalen.gecontroleerd,
      opgelost: totalen.opgelost,
      handmatigGecontroleerd: totalen.handmatig,
      openstaand: totalen.openstaand,
      perLab: totalen.perLab,
      // Wat deze pagina laat zien. Eerder heette dit 'totaal' en telde het
      // alleen de opgehaalde pagina - dat leek een totaal maar was het niet.
      getoond: rijen.length,
      getoondPerLab: perLab,
      afgekapt: rijen.length < totalen.totaal,
      perOpdrachtgever: clients,
      // Hoeveel gecontroleerde rapporten staan op naam van iemand anders dan
      // de shop(s) die ze tonen, en hoeveel gedeelde rapporten horen bij
      // precies een van de tonende shops.
      opNaamVanDerde: derdePartij.length,
      gedeeldMaarVanEenShop: gedeeldMaarVanEen.length,
      derdePartijen: [...new Set(derdePartij.map((r) => r.wieBesteldeDeTest.client))],
      nietOpgelost: metControle.filter((r) => r.controle.resolvet === false).length,
      referenties: rijen
    });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Eén document opnieuw laten lezen, cache overgeslagen. Gereedschap om aan de
// leesprompt te kunnen sleutelen: pas hem aan, draai dit op het document dat
// niet goed gelezen werd, en zie meteen of het hielp. Zonder dit zou je de
// extractorversie moeten ophogen en alles opnieuw laten lezen.
//
// ?kijken=1 leest wel, maar schrijft niets naar het archief.
app.post('/api/admin/coa/documents/:sha256/herlees', rl.caseAction, auth.requireOwnerToken, requireAdmin, async (req, res) => {
  try {
    const r = await pipeline.herleesDocument(req.params.sha256, {
      naam: (req.body && req.body.naam) || null,
      alleenKijken: req.query.kijken === '1' || !!(req.body && req.body.alleenKijken)
    });
    if (r && r.fout) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Labreferenties automatisch oplossen bij het laboratorium. Alleen zinvol bij
// labs die onze server binnenlaten; Janoshik doet dat niet (403, Cloudflare).
// Bewust met een expliciete aanroep en een maximum per keer: elk opgehaald
// rapport gaat door de dure leesstap, dus dit is geen achtergrondproces dat
// ongemerkt kosten maakt.
app.post('/api/admin/coa/references/resolve', rl.caseAction, auth.requireOwnerToken, requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const lab = (b.lab || 'Bridge Analytical').trim();
    const max = Number(b.max) || 5;
    // opnieuw=true laat ook al door de resolver opgeloste referenties mee
    // draaien; menselijke controles blijven er altijd buiten.
    const r = await pipeline.resolveerLabReferenties(lab, max, { opnieuw: b.opnieuw === true });
    res.json(r);
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Alle rode bevindingen op een rij, over alle cases heen.
//
// Rood is het zwaarste wat de check kan vaststellen en het enige wat een
// leverancier echt raakt. Voor het publiek wordt, hoort een mens ernaar te
// kijken (M17: primaire bron erbij, momentopname, correctieroute). Deze route
// is die werklijst: waar staat rood, waarop rust het, en wie heeft dat
// vastgesteld - de resolver of een mens.
//
// Twee soorten rood, bewust apart:
//   klasseD      een rapportreferentie lost niet op of wijkt af van de kopie
//   categorieRood een COA-categorie is beoordeeld als aangetoond probleem
// Wat is er nieuw en nog niet gemeld? Zelfde gegevens als de MCP-tool
// nieuwe_signalen, zodat een stafpagina het ook kan tonen zonder een
// MCP-verbinding. Lezen mag een lezer; markeren vraagt om een beoordelaar,
// want wie markeert laat het signaal verdwijnen.
app.get('/api/admin/signalen', rl.read, auth.requireOwnerToken, requireLezer, async (req, res) => {
  try {
    const uit = await coaStore.nieuweSignalen({ max: Number(req.query.max) || 50 });
    if (!uit) return res.status(500).json({ error: 'kon de signalen niet ophalen' });
    res.json(uit);
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'onbekende fout' });
  }
});

app.post('/api/admin/signalen/gemeld', rl.caseAction, auth.requireOwnerToken, requireBeoordelaar, async (req, res) => {
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
    if (!items || !items.length) return res.status(400).json({ error: 'items ontbreekt' });
    const uit = await coaStore.markeerGesignaleerd(items, (req.body && req.body.door) || null);
    res.json(uit);
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'onbekende fout' });
  }
});

app.get('/api/admin/bevindingen/rood', rl.read, auth.requireOwnerToken, requireLezer, async (req, res) => {
  try {
    const cases = await db.listCases();
    const uit = [];
    for (const c of cases) {
      const recs = (c.phaseData && c.phaseData.coaDataset && c.phaseData.coaDataset.data
        && c.phaseData.coaDataset.data.coaRecords) || [];
      const klasseD = recs.filter((r) => r && r.authenticiteitsklasse === 'D').map((r) => ({
        product: r.product || null,
        laboratorium: r.laboratorium || null,
        batchnummer: r.batchnummer || null,
        reportId: r.reportId || null,
        verificationKey: r.verificationKey || null,
        verificationUrl: r.verificationUrl || null,
        // Wie kende de klasse toe: de resolver of een mens? Zonder dat is een
        // rode bevinding niet na te lopen.
        klasseBron: r.klasseBron || null,
        klasseReden: r.klasseReden || null,
        onderbouwing: r.authenticiteitsonderbouwing || null
      }));
      const a = (c.engineResult && c.engineResult.assessments) || {};
      const categorieRood = Object.keys(a)
        .filter((id) => /^C0[1-9]$/.test(id) && a[id] && a[id].color === 'red')
        .map((id) => ({ id, rationale: (a[id].rationale || '').slice(0, 400) }));
      const rodeVlaggen = ((c.report && c.report.rodeVlaggen) || []).map((f) => ({
        omschrijving: (f && (f.omschrijving || f.titel)) || String(f), bron: (f && f.bron) || null
      }));
      if (!klasseD.length && !categorieRood.length && !rodeVlaggen.length) continue;
      uit.push({
        caseId: c.id, website: c.website, status: c.status,
        gemaakt: c.createdAt, aantalRapporten: recs.length,
        klasseD, categorieRood, rodeVlaggen
      });
    }
    res.json({ cases: uit.length, bevindingen: uit });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Herberekenen zonder opnieuw te onderzoeken.
//
// De drie blokken en de Evidence Score worden tijdens de run uitgerekend en
// bij de case bewaard. Verandert een telregel - zoals op 21 september, toen
// een verificatielink ook als verificatiecode ging tellen - dan blijven alle
// bestaande cases het oude cijfer tonen. Opnieuw draaien lost dat op, maar
// dat kost modelaanroepen en geld voor onderzoek dat al gedaan is.
//
// Deze route rekent alleen opnieuw met wat er al ligt: dezelfde opgeslagen
// brondata, de nieuwe regels. Geen model, geen crawl, geen kosten.
//
// LET OP: dit raakt nooit de brondata zelf. Wat er is gevonden en gelezen
// blijft staan; alleen de afleiding eruit wordt ververst. Cases die nog
// draaien of nooit een beoordeling kregen worden overgeslagen.
app.post('/api/admin/cases/herbereken', rl.caseAction, auth.requireOwnerToken, requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const max = Math.min(Number(b.max) || 50, 200);
    const lijst = b.caseId ? [await db.getCase(b.caseId)] : await db.listCases();
    const gedaan = [];
    const overgeslagen = [];
    for (const c of lijst) {
      if (gedaan.length >= max) break;
      if (!c) { overgeslagen.push({ id: b.caseId || null, reden: 'niet gevonden' }); continue; }

      // Opschonen gebeurt voor ELKE case, ook een gestopte of een zonder
      // categoriebeoordeling. Een onterechte klasse D of een onterechte rode
      // vlag hoort nergens te blijven staan, en het opschonen heeft die
      // beoordeling niet nodig: het is alleen herlezen van wat er ligt.
      let klassenGewist = 0;
      let vlaggenAf = 0;
      try {
        const recs = (c.phaseData && c.phaseData.coaDataset && c.phaseData.coaDataset.data
          && c.phaseData.coaDataset.data.coaRecords) || null;
        if (recs && recs.length) {
          const schoon = pipeline.schoonKlasse(recs);
          klassenGewist = schoon.filter((r, i) => recs[i] && recs[i].authenticiteitsklasse && !r.authenticiteitsklasse).length;
          if (klassenGewist) {
            // Via mergePhaseData: updateCase kent phaseData niet als kolom.
            const coaDataset = Object.assign({}, c.phaseData.coaDataset);
            coaDataset.data = Object.assign({}, coaDataset.data, { coaRecords: schoon });
            await db.mergePhaseData(c.id, 'coaDataset', coaDataset);
          }
        }
        // De rode vlaggen uit de rapporttekst zijn door het model geschreven
        // en gingen niet door filterRood(). Geen modelaanroep, puur herlezen.
        if (c.report && Array.isArray(c.report.rodeVlaggen)) {
          const voor = c.report.rodeVlaggen.length;
          const report = pipeline.filterRodeVlaggen(Object.assign({}, c.report));
          vlaggenAf = voor - report.rodeVlaggen.length;
          if (vlaggenAf) await db.updateCase(c.id, { report });
        }
      } catch (e) {
        overgeslagen.push({ id: c.id, reden: 'opschonen mislukt' });
        continue;
      }

      // De engine opnieuw draaien kan alleen met een categoriebeoordeling.
      // Zonder die beoordeling is de case wel opgeschoond, maar krijgt hij
      // geen nieuwe blokken.
      if (!c.categoryAssessments || !Object.keys(c.categoryAssessments).length) {
        overgeslagen.push({ id: c.id, reden: 'geen categoriebeoordeling', klassenGewist, rodeVlaggenAfgekeurd: vlaggenAf });
        continue;
      }
      try {
        const engineResult = await pipeline.applyScoringEngine(c.id);
        const bl = engineResult && engineResult.blokken;
        gedaan.push({
          id: c.id, website: c.website,
          blokkenVersie: bl ? bl.versie : null,
          openheid: bl ? (bl.openheid.aanwezig + '/' + bl.openheid.noemer) : null,
          verificatie: bl ? bl.verificatie.woord : null,
          rodeVlaggenAfgekeurd: vlaggenAf,
          klassenGewist
        });
      } catch (e) {
        overgeslagen.push({ id: c.id, reden: 'herberekening mislukt' });
      }
    }
    const tel = (lijst, veld) => lijst.reduce((a, x) => a + (Number(x[veld]) || 0), 0);
    res.json({
      herberekend: gedaan.length,
      overgeslagen: overgeslagen.length,
      klassenGewist: tel(gedaan, 'klassenGewist') + tel(overgeslagen, 'klassenGewist'),
      rodeVlaggenAfgekeurd: tel(gedaan, 'rodeVlaggenAfgekeurd') + tel(overgeslagen, 'rodeVlaggenAfgekeurd'),
      gedaan, overgeslagen
    });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Overzicht van alle bekende documenten (crawl/auto-fetch/handmatig) en hun
// eventuele verificatiestatus voor één leverancier. De leverancier-ID is de
// genormaliseerde hostnaam, zie coaStore.supplierKeyFromUrl.
app.get('/api/admin/coa/:supplierKey', rl.read, auth.requireOwnerToken, requireLezer, async (req, res) => {
  try {
    const documents = await coaStore.getDocumentsBySupplier(req.params.supplierKey);
    // Bij welke andere shops staat hetzelfde bestand nog meer? Dat is precies
    // het signaal waarvoor het archief content-addressed is.
    const spreiding = await coaStore.andereLeveranciersVoor(documents.map((d) => d.sha256));
    const verrijkt = documents.map((d) => Object.assign({}, d, {
      andere_leveranciers: (spreiding[d.sha256] || []).filter((k) => k !== req.params.supplierKey)
    }));

    // Wat konden we NIET lezen? Dat is de werklijst om de leesstap mee te
    // verbeteren, en zonder filter verdrinkt hij in de rest. Bewust smal
    // teruggegeven: sha256, lab en wat er wel gelezen is - genoeg om een
    // document te kiezen en er /herlees op los te laten.
    const eersteRec = (d) => ((d.extraction && d.extraction.coaRecords) || [{}])[0] || {};
    if (req.query.zonderSleutel === '1') {
      const zonder = verrijkt.filter((d) => !eersteRec(d).verificationKey);
      return res.json({
        supplierKey: req.params.supplierKey,
        totaal: verrijkt.length,
        zonderSleutel: zonder.length,
        documents: zonder.map((d) => ({
          sha256: d.sha256,
          lab: eersteRec(d).laboratorium || d.lab || null,
          reportId: eersteRec(d).reportId || d.task_number || null,
          product: eersteRec(d).product || null,
          status: d.status,
          url: d.url
        }))
      });
    }
    res.json({ supplierKey: req.params.supplierKey, documents: verrijkt });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Eén COA handmatig uploaden voor een leverancier: de bytes gaan in hetzelfde
// archief als de automatische crawl (met een niet-http bronsleutel, zodat die
// nooit als kapotte link in het Bronnenregister belandt — zie pipeline.js) en
// worden meteen door dezelfde uitleesstap gehaald als de automatische route.
app.post('/api/admin/coa/:supplierKey/upload', rl.caseAction, auth.requireOwnerToken, requireAdmin, uploadCoa, async (req, res) => {
  try {
    const supplierKey = req.params.supplierKey;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'geen_bestand', message: 'Voeg een COA-bestand toe (veld coaFile).' });
    const naam = (req.body && req.body.naam) || supplierKey;
    const sha256 = coaStore.sha256Of(file.buffer);
    // Synthetische, niet-http bron-URL: alleen nodig om aan de UNIQUE-
    // constraint van coa_sources.url te voldoen.
    const syntheticUrl = 'admin-upload://' + supplierKey + '/' + sha256;
    const observation = await coaStore.recordObservation({
      url: syntheticUrl, supplierKey, buffer: file.buffer, mimetype: file.mimetype
    });
    let extraction = await coaStore.getExtraction(sha256, pipeline.COA_EXTRACTOR_VERSION);
    if (!extraction) {
      extraction = await pipeline.extractCoaFromUpload(naam, { data: file.buffer.toString('base64'), mediaType: file.mimetype });
      const first = (extraction && extraction.coaRecords && extraction.coaRecords[0]) || {};
      await coaStore.saveExtraction(sha256, pipeline.COA_EXTRACTOR_VERSION, extraction || { coaRecords: [] }, {
        lab: first.laboratorium || null,
        taskNumber: first.reportId || null,
        keyHash: first.verificationKey ? coaStore.sha256Of(Buffer.from(String(first.verificationKey))) : null
      });
    }
    res.status(201).json({ sha256, change: observation && observation.change, extraction });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Resultaat van de handmatige labverificatie vastleggen. Alleen een mens (deze
// route) mag klasse D zetten (referentie aanwezig, resolvet niet) — het
// AI-model in extractCoaFromUpload zet zelf nooit een authenticiteitsklasse.
app.post('/api/admin/coa/:supplierKey/documents/:sha256/verify', rl.caseAction, auth.requireOwnerToken, requireTestbeoordelaar, async (req, res) => {
  try {
    const { class: klasse, method, lab, task, sample, key, resolvedUrl, note, checkedBy } = req.body || {};
    if (!['A', 'B', 'C', 'D'].includes(klasse)) {
      return res.status(400).json({ error: 'ongeldige_klasse', message: 'class moet A, B, C of D zijn.' });
    }
    const verification = {
      class: klasse, method: method || 'janoshik', lab: lab || null, task: task || null,
      sample: sample || null, key: key || null, resolvedUrl: resolvedUrl || null,
      note: note || null, checkedBy: checkedBy || null, checkedAt: Date.now()
    };
    await coaStore.saveVerification(req.params.sha256, verification);
    res.json({ ok: true, verification });
  } catch (e) {
    res.status(500).json(sanitizeError(e, req));
  }
});

// Vangnet: elke fout die nog los komt (bijv. multer-limieten) gaat via dezelfde
// sanitizer, zodat er nooit een stacktrace of pad in een response belandt.
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file_too_large', message: 'Een bestand is groter dan 15 MB.' });
  }
  res.status(500).json(sanitizeError(err, req));
});

const port = process.env.PORT || 3000;

db.initSchema()
  // Het COA-archief mag de server niet kunnen tegenhouden. Elke coaStore-
  // functie vangt zijn eigen fouten af, dus zonder deze tabellen draait de
  // audit gewoon door - alleen zonder hergebruik en zonder geschiedenis.
  .then(() => coaStore.initCoaSchema().catch((e) => {
    console.error('LET OP: COA-archieftabellen konden niet worden aangemaakt; archief staat uit. Reden:', (e && e.message) || e);
  }))
  .then(() => siteShot.initShotSchema().catch((e) => {
    console.error('LET OP: tabel voor schermafdrukken kon niet worden aangemaakt; het rapport toont dan de lege plek. Reden:', (e && e.message) || e);
  }))
  .then(() => {
    if (!process.env.ADMIN_TOKEN) console.warn('LET OP: ADMIN_TOKEN is niet gezet — bestaande cases van vóór de eigenaarsmigratie zijn niet meer opvraagbaar.');
    // Meteen bij het opstarten: elke case die nog op 'bezig' staat is van een
    // vorig proces en draait dus niet meer. Bij een deploy is dat precies de
    // situatie. Daarna elke vijf minuten, voor een run die binnen dit proces
    // sneuvelt zonder zijn fout te kunnen wegschrijven.
    pipeline.maakGestrandeRunsLos({ grensMs: 60 * 1000 }).catch(() => {});
    const wachtdienst = setInterval(
      () => { pipeline.maakGestrandeRunsLos().catch(() => {}); },
      5 * 60 * 1000
    );
    wachtdienst.unref();
    app.listen(port, () => console.log('bedrijfchecker-backend luistert op poort ' + port));
  })
  .catch((e) => {
    console.error('Kon databaseschema niet initialiseren:', e);
    process.exit(1);
  });
