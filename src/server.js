require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const coaStore = require('./coaStore');
const coaCrawler = require('./coaCrawler');
const siteShot = require('./siteShot');
const pipeline = require('./pipeline');
const auth = require('./auth');
const rl = require('./rateLimit');
const { caseSummary, ownerCase, publicCase, sanitizeError } = require('./serialize');
const { isValidWebUrl, normalizeUrl } = require('./validate');
const { checkPeptideSupplierRelevance } = require('./relevanceCheck');
const labProbe = require('./labProbe');

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
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 11 } });
const uploadFields = upload.fields([{ name: 'files', maxCount: 10 }, { name: 'kvkDocument', maxCount: 1 }]);

// CORS is hier geen autorisatiegrens (dat is het owner token), maar beperkt wel
// welke pagina's namens een bezoeker mogen aanroepen. Zet ALLOWED_ORIGINS zodra
// de frontend een vaste origin heeft.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
app.use(cors({
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Owner-Token'],
  exposedHeaders: ['Retry-After']
}));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

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
// binnen? Zet LAB_PROBE=on om dit endpoint aan te zetten; standaard uit,
// zodat het niet per ongeluk blijft staan. Geen invoer van buiten - de
// lijst zit in labProbe.js - dus dit is geen SSRF-oppervlak.
app.get('/api/diagnostics/labs', rl.caseAction, auth.requireOwnerToken, async (req, res) => {
  if (process.env.LAB_PROBE !== 'on') {
    return res.status(404).json({ error: 'not_enabled', message: 'Zet LAB_PROBE=on om deze meting aan te zetten.' });
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
    if (!relevance.relevant) {
      return res.status(422).json({
        error: 'not_peptide_supplier',
        message: 'Deze website lijkt geen leverancier van peptiden of research chemicals te zijn, dus we starten geen audit.' + (relevance.reasoning ? ' ' + relevance.reasoning : '')
      });
    }

    const genericFiles = (req.files && req.files.files) || [];
    const kvkFile = (req.files && req.files.kvkDocument && req.files.kvkDocument[0]) || null;

    const ctx = {
      naam,
      website,
      land: req.body.land || null,
      kvkNummer: req.body.kvkNummer || null,
      notities: req.body.notities || null,
      images: genericFiles
        .filter((f) => f.mimetype && f.mimetype.startsWith('image/'))
        .map((f) => ({ data: f.buffer.toString('base64'), mediaType: f.mimetype })),
      kvkDocument: kvkFile ? { data: kvkFile.buffer.toString('base64'), mediaType: kvkFile.mimetype } : null
    };

    const id = uuidv4();
    const created = await db.createCase(id, Object.assign({}, ctx, { ownerTokenHash: req.ownerTokenHash }));

    // Geüploade bestanden persistent bewaren (niet alleen transiet gebruiken
    // tijdens deze run) zodat ze later terug te vinden zijn en, bij een
    // toekomstige KvK-koppeling, hetzelfde opslagpad hergebruikt kan worden.
    await Promise.all([
      ...genericFiles.map((f) => db.addDocument(uuidv4(), id, { kind: 'overig', filename: f.originalname, mimetype: f.mimetype, buffer: f.buffer })),
      ...(kvkFile ? [db.addDocument(uuidv4(), id, { kind: 'kvk', filename: kvkFile.originalname, mimetype: kvkFile.mimetype, buffer: kvkFile.buffer })] : [])
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
    app.listen(port, () => console.log('bedrijfchecker-backend luistert op poort ' + port));
  })
  .catch((e) => {
    console.error('Kon databaseschema niet initialiseren:', e);
    process.exit(1);
  });
