require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const pipeline = require('./pipeline');
const { isValidWebUrl, normalizeUrl } = require('./validate');
const { checkPeptideSupplierRelevance } = require('./relevanceCheck');

const app = express();
// Twee velden: 'files' voor de bestaande generieke bijlagen (COA's, screenshots,
// max 10) en een los 'kvkDocument'-veld (max 1) voor het KvK-uittreksel. Geen
// mimetype-filter meer op multer-niveau — een PDF komt nu ook door; voorheen
// werd elk niet-image-bestand verderop in de route stilletjes weggegooid.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 11 } });
const uploadFields = upload.fields([{ name: 'files', maxCount: 10 }, { name: 'kvkDocument', maxCount: 1 }]);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
app.use(cors({ origin: allowedOrigins.includes('*') ? true : allowedOrigins }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Lijst eerder gedraaide audits (voor het dashboard/landingspagina-lijstje).
app.get('/api/audits', async (req, res) => {
  try {
    const cases = await db.listCases();
    res.json({ cases });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/audits/:id', async (req, res) => {
  try {
    const c = await db.getCase(req.params.id);
    if (!c) return res.status(404).json({ error: 'not_found' });
    res.json({ case: c });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start een nieuwe audit. multipart/form-data: velden website/naam/land/
// kvkNummer/notities + optioneel bestand(en) onder "files" (COA's, screenshots).
app.post('/api/audits', uploadFields, async (req, res) => {
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
  const created = await db.createCase(id, ctx);

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

  res.status(201).json({ case: created });
});

// Metadata van geüploade documenten bij een case (voor een bijlagenlijstje
// in de UI) — de bytes zelf komen pas via de download-route hieronder.
app.get('/api/audits/:id/documents', async (req, res) => {
  try {
    res.json({ documents: await db.listDocuments(req.params.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/audits/:id/documents/:docId', async (req, res) => {
  try {
    const doc = await db.getDocument(req.params.docId);
    if (!doc || doc.caseId !== req.params.id) return res.status(404).json({ error: 'not_found' });
    res.set('Content-Type', doc.mimetype || 'application/octet-stream');
    res.set('Content-Disposition', 'inline; filename="' + (doc.filename || doc.id) + '"');
    res.send(doc.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/audits/:id/stop', async (req, res) => {
  try {
    await pipeline.stopAudit(req.params.id);
    const c = await db.getCase(req.params.id);
    res.json({ case: c });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ga door naar de betaalde Deep Dive voor een case waarvan de gratis check
// klaar is. Nog GEEN betaalstraat hier (Ruben: "zonder betaalstraat nog, maar
// dus wel de knip") — dit is puur het vervolgtraject zelf, klaar om er later
// een betaalmoment vóór te zetten. Draait de resterende DEEP_STEP_KEYS boven
// op dezelfde case (zelfde fasegegevens blijven staan) en herberekent daarna
// categorize/engine/rapport in "deep"-stand.
app.post('/api/audits/:id/continue-deep', async (req, res) => {
  try {
    const c = await db.getCase(req.params.id);
    if (!c) return res.status(404).json({ error: 'not_found' });
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
    res.json({ case: await db.getCase(req.params.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Herstart één specifieke stap (bijv. na een fout), zonder de hele audit
// opnieuw te draaien. Zelfde cascade als de oude Artifact-client (runFromStep):
// een onderzoeksstap trekt altijd categorize + de engine + een volledige
// hersynthese achter zich aan, anders raken categorybeoordeling en rapport
// verouderd t.o.v. de net vernieuwde brondata.
app.post('/api/audits/:id/retry-step', async (req, res) => {
  const { key } = req.body || {};
  try {
    const c = await db.getCase(req.params.id);
    if (!c) return res.status(404).json({ error: 'not_found' });
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
    res.json({ case: await db.getCase(req.params.id) });
  } catch (e) {
    await db.updateCase(req.params.id, { status: 'fout', error: (e && e.message) || 'onbekende fout' }).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3000;

db.initSchema()
  .then(() => {
    app.listen(port, () => console.log('bedrijfchecker-backend luistert op poort ' + port));
  })
  .catch((e) => {
    console.error('Kon databaseschema niet initialiseren:', e);
    process.exit(1);
  });
