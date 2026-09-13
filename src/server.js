require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const pipeline = require('./pipeline');
const { isValidWebUrl, normalizeUrl } = require('./validate');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 10 } });

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
app.post('/api/audits', upload.array('files', 10), async (req, res) => {
  const website = normalizeUrl(req.body.website || '');
  if (!isValidWebUrl(website)) {
    return res.status(400).json({ error: 'invalid_url', message: 'Vul een geldige web URL in.' });
  }
  const naam = (req.body.naam || '').trim() || website;
  const ctx = {
    naam,
    website,
    land: req.body.land || null,
    kvkNummer: req.body.kvkNummer || null,
    notities: req.body.notities || null,
    images: (req.files || [])
      .filter((f) => f.mimetype && f.mimetype.startsWith('image/'))
      .map((f) => ({ data: f.buffer.toString('base64'), mediaType: f.mimetype }))
  };

  const id = uuidv4();
  const created = await db.createCase(id, ctx);

  // Fire-and-forget: de audit draait op de achtergrond, de client volgt
  // voortgang via GET /api/audits/:id (polling), net als in de Artifact.
  pipeline.runAudit(id, ctx).catch(() => {});

  res.status(201).json({ case: created });
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
    const ctx = { naam: c.naam, website: c.website, land: c.land, kvkNummer: c.kvkNummer, notities: c.notities, images: [] };
    await db.updateCase(req.params.id, { status: 'bezig', error: null });
    if (key !== 'reportA' && key !== 'reportB') {
      if (key === 'categorize') {
        await pipeline.runCategorize(req.params.id, ctx);
      } else if (pipeline.RESEARCH_STEP_KEYS.includes(key)) {
        await pipeline.runResearchStep(req.params.id, ctx, key);
        await pipeline.runCategorize(req.params.id, ctx);
      }
    }
    await pipeline.applyScoringEngine(req.params.id);
    await pipeline.runSynthesis(req.params.id, ctx);
    await db.updateCase(req.params.id, { status: 'klaar' });
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
