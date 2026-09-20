// COA-documentarchief: analyseer elk uniek document precies één keer, ooit.
//
// Twee vragen die uit elkaar gehouden moeten worden:
//   WAT is het?   -> coa_documents, gesleuteld op de SHA-256 van de bytes
//   WAAR zagen we het? -> coa_sources, één rij per URL per leverancier
//
// De bytes zelf bewaren we NIET. Alleen de hash (32 bytes) en het
// analyseresultaat. Dat is genoeg om te weten of een bestand is veranderd,
// zonder een archief van andermans documenten aan te leggen.
//
// LET OP: cachen op alleen de URL is onveilig. Dan zie je nooit dat het
// bestand achter die URL is vervangen — precies het geval dat we willen
// vangen (leverancier zet stil een ander rapport op dezelfde plek). Daarom:
// URL is de opzoeksleutel, de hash is de geldigheidscontrole.
//
// Elke functie hier is defensief: een fout in het archief mag nooit een
// lopende audit laten mislukken. Bij twijfel loggen en null teruggeven.

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('./db');
const janoshik = require('./janoshik');

const HEAD_TIMEOUT_MS = Number(process.env.COA_HEAD_TIMEOUT_MS) || 10000;

async function initCoaSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coa_documents (
      sha256 TEXT PRIMARY KEY,
      mimetype TEXT,
      byte_size INTEGER,
      lab TEXT,
      task_number TEXT,
      sample_number TEXT,
      key_hash TEXT,
      extraction JSONB,
      extractor_version TEXT,
      verification JSONB,
      verification_checked_at BIGINT,
      authenticity_class TEXT,
      first_analyzed_at BIGINT,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coa_sources (
      id TEXT PRIMARY KEY,
      supplier_key TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      sha256 TEXT,
      http_etag TEXT,
      http_last_modified TEXT,
      content_length BIGINT,
      first_seen_at BIGINT NOT NULL,
      last_checked_at BIGINT NOT NULL,
      last_changed_at BIGINT,
      status TEXT NOT NULL DEFAULT 'active'
    );
  `);
  // De geschiedenis. Hier komen de signalen uit die geen enkele losse audit
  // kan vinden: een verdwenen COA, een stil vervangen rapport.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coa_source_events (
      id TEXT PRIMARY KEY,
      supplier_key TEXT NOT NULL,
      url TEXT NOT NULL,
      event TEXT NOT NULL,
      from_sha256 TEXT,
      to_sha256 TEXT,
      created_at BIGINT NOT NULL
    );
  `);
  // Verwijzingen naar de verificatiepagina van het lab. Bewust een eigen
  // tabel: coa_documents is content-addressed op de bytes van een bestand, en
  // een verwijzing heeft geen bestand. Toch is dit vaak het sterkere bewijs -
  // aan een zelf gehoste PDF valt te sleutelen, aan een referentie bij het lab
  // niet. Gemeten 19 sep: astralabs en pyroxlabs publiceren elk 80 van deze
  // verwijzingen en nul bruikbare bestanden; zonder deze tabel zien we van die
  // shops dus helemaal niets.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coa_references (
      id TEXT PRIMARY KEY,
      supplier_key TEXT NOT NULL,
      lab TEXT NOT NULL,
      referentie TEXT NOT NULL,
      task_number TEXT,
      sample TEXT,
      ref_key TEXT,
      url TEXT NOT NULL,
      context TEXT,
      gevonden_op TEXT,
      first_seen_at BIGINT NOT NULL,
      last_seen_at BIGINT NOT NULL,
      UNIQUE (supplier_key, url)
    );
  `);
  // De controle van een labreferentie hangt aan de REFERENTIE, niet aan de
  // leverancier. Of rapport 221439 bestaat en wie er als opdrachtgever op
  // staat, is een eigenschap van dat rapport - dat verandert niet per shop.
  // Een mens controleert het dus een keer, en elke shop die ernaar verwijst
  // profiteert ervan. Dat is dezelfde gedachte als het documentarchief.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coa_reference_checks (
      id TEXT PRIMARY KEY,
      lab TEXT NOT NULL,
      referentie TEXT NOT NULL,
      task_number TEXT,
      resolvet BOOLEAN,
      klasse TEXT,
      client TEXT,
      product TEXT,
      batchnummer TEXT,
      resolved_url TEXT,
      notitie TEXT,
      checked_by TEXT,
      methode TEXT NOT NULL DEFAULT 'handmatig',
      checked_at BIGINT NOT NULL,
      UNIQUE (lab, referentie)
    );
  `);
  await pool.query(`ALTER TABLE coa_reference_checks ADD COLUMN IF NOT EXISTS methode TEXT NOT NULL DEFAULT 'handmatig';`);
  // Het gestructureerde labrapport (uitslag per test, identiteit, zuiverheid,
  // verborgen tests). Tot nu belandde dat alleen in een Nederlandse notitie en
  // was het na de run weg - niet te filteren, niet te tonen in het rapport.
  await pool.query(`ALTER TABLE coa_reference_checks ADD COLUMN IF NOT EXISTS rapport JSONB;`);
  // Zuiverheid en vulling hadden geen eigen kolom, dus belandden ze bij een
  // handmatige controle in de notitie - waar ze niet te filteren of te
  // vergelijken zijn. De mens typt over wat er staat (tekst); het
  // percentage leiden we daar zelf uit af.
  await pool.query(`ALTER TABLE coa_reference_checks ADD COLUMN IF NOT EXISTS zuiverheid TEXT;`);
  await pool.query(`ALTER TABLE coa_reference_checks ADD COLUMN IF NOT EXISTS zuiverheid_pct NUMERIC;`);
  await pool.query(`ALTER TABLE coa_reference_checks ADD COLUMN IF NOT EXISTS vulling TEXT;`);
  await pool.query(`ALTER TABLE coa_reference_checks ADD COLUMN IF NOT EXISTS vulling_pct NUMERIC;`);
  // Wat er stond toen we er geen getal uit kregen. Zonder dit ziet een
  // mislukte afleiding er hetzelfde uit als een veld dat nooit is ingevuld,
  // en leest 'geen getal' als 'geen bezwaar'. Niet leeg = mensenoog nodig.
  await pool.query(`ALTER TABLE coa_reference_checks ADD COLUMN IF NOT EXISTS afleidingsnotitie TEXT;`);
  // Velden die tot nu in de notitie belandden of alleen in een JSON-blob
  // stonden. Eigen kolommen, want in proza kun je niet filteren.
  await pool.query(`ALTER TABLE coa_reference_checks ADD COLUMN IF NOT EXISTS manufacturer TEXT;`);
  await pool.query(`ALTER TABLE coa_reference_checks ADD COLUMN IF NOT EXISTS gemeten_mg NUMERIC;`);
  await pool.query(`ALTER TABLE coa_reference_checks ADD COLUMN IF NOT EXISTS etiket_mg NUMERIC;`);
  await pool.query(`ALTER TABLE coa_reference_checks ADD COLUMN IF NOT EXISTS datum_analyse DATE;`);
  // Waartegen de klasse is afgezet: de URL van de kopie op de site van de
  // shop, of het sha256 van het document. Zonder dit is later niet na te
  // gaan waar een A op rust.
  await pool.query(`ALTER TABLE coa_reference_checks ADD COLUMN IF NOT EXISTS vergeleken_met TEXT;`);
  // De veldvergelijking gestructureerd, niet in proza. Een regelset kan niets
  // met 'Client wijkt af' in een notitie; hiermee kan Annemarie haar besluit
  // (A15) straks over alles heen draaien in plaats van 200 notities lezen.
  await pool.query(`ALTER TABLE coa_reference_checks ADD COLUMN IF NOT EXISTS veldvergelijking JSONB;`);
  await pool.query(`ALTER TABLE coa_reference_checks ADD COLUMN IF NOT EXISTS velden_vergeleken INTEGER;`);
  await pool.query(`ALTER TABLE coa_reference_checks ADD COLUMN IF NOT EXISTS velden_afwijkend INTEGER;`);
  // Zelfde velden op documentniveau. Daar zat de hele verificatie in een
  // JSONB-blob en was alleen authenticity_class een echte kolom.
  for (const kolom of [
    'client TEXT', 'manufacturer TEXT', 'batchnummer TEXT', 'zuiverheid TEXT',
    'zuiverheid_pct NUMERIC', 'gemeten_mg NUMERIC', 'etiket_mg NUMERIC',
    'vulling_pct NUMERIC', 'datum_analyse DATE', 'vergeleken_met TEXT',
    'afleidingsnotitie TEXT', 'verification_method TEXT',
    'veldvergelijking JSONB', 'velden_vergeleken INTEGER', 'velden_afwijkend INTEGER'
  ]) {
    await pool.query('ALTER TABLE coa_documents ADD COLUMN IF NOT EXISTS ' + kolom + ';');
  }
  // Sommige shops splitsen per batch in losse rapporten: een voor zuiverheid,
  // een voor zware metalen, een voor endotoxinen. Gezien bij omegapeptides:
  // 74 certificaten voor een stuk of 25 batches. Zonder testsoort tellen we
  // die als 74 losse rapporten en zien we niet dat een batch volledig is -
  // of juist alleen op zuiverheid is getest.
  await pool.query(`ALTER TABLE coa_references ADD COLUMN IF NOT EXISTS testsoort TEXT;`);
  // Waarom staat deze leverancier bij deze referentie? Tot nu was dat altijd
  // 'toont hem op zijn site'. Sinds we opdrachtgevers kennen is er een tweede
  // soort: de partij op wiens naam het rapport staat. utherpeptide.com toont
  // niets - die is de opdrachtgever achter astralabs en pyroxlabs.
  // Ze scheiden is noodzakelijk: zonder dit zou Uther ineens 55 referenties
  // 'delen' met beide shops en klopt de kruisverbandtelling niet meer.
  await pool.query(`ALTER TABLE coa_references ADD COLUMN IF NOT EXISTS relatie TEXT NOT NULL DEFAULT 'toont';`);
  await pool.query(`CREATE INDEX IF NOT EXISTS coa_refs_supplier_idx ON coa_references (supplier_key);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS coa_refs_ref_idx ON coa_references (lab, referentie);`);
  await normaliseerBestaandeLabnamen();
  await pool.query(`CREATE INDEX IF NOT EXISTS coa_sources_supplier_idx ON coa_sources (supplier_key);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS coa_sources_sha_idx ON coa_sources (sha256);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS coa_events_supplier_idx ON coa_source_events (supplier_key, created_at DESC);`);
}

// Leverancierssleutel = genormaliseerde hostname. Bewust niet het case-id:
// twee gebruikers die dezelfde shop onderzoeken moeten op dezelfde sleutel
// uitkomen, anders werkt hergebruik niet.
function supplierKeyFromUrl(input) {
  try {
    const u = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch (e) {
    return String(input || '').trim().toLowerCase() || null;
  }
}

function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function logEvent(supplierKey, url, event, fromSha, toSha) {
  try {
    await pool.query(
      `INSERT INTO coa_source_events (id, supplier_key, url, event, from_sha256, to_sha256, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv4(), supplierKey, url, event, fromSha || null, toSha || null, Date.now()]
    );
  } catch (e) { /* geschiedenis is best-effort */ }
}

async function getSource(url) {
  const { rows } = await pool.query('SELECT * FROM coa_sources WHERE url = $1', [url]);
  return rows[0] || null;
}

// Een ophaalbare bron voor dit document. Het archief bewaart de bytes niet,
// alleen de hash - dus opnieuw lezen betekent opnieuw downloaden. Synthetische
// bronnen (admin-upload://, labref://) vallen af: daar valt niets te halen.
async function publiekeBronVoorDocument(sha256) {
  try {
    const { rows } = await pool.query(
      `SELECT url, supplier_key FROM coa_sources
       WHERE sha256 = $1 AND url LIKE 'http%'
       ORDER BY last_checked_at DESC NULLS LAST LIMIT 1`,
      [sha256]
    );
    return rows[0] || null;
  } catch (e) {
    console.error('coaStore.publiekeBronVoorDocument:', (e && e.message) || e);
    return null;
  }
}

async function getDocument(sha256) {
  const { rows } = await pool.query('SELECT * FROM coa_documents WHERE sha256 = $1', [sha256]);
  return rows[0] || null;
}

// Goedkope voorcontrole: is het bestand achter deze URL nog hetzelfde?
// Geen download, alleen headers. Geen ETag beschikbaar -> 'unknown', en dan
// downloaden we alsnog. Downloaden is goedkoop; analyseren niet.
async function checkUnchanged(url) {
  const known = await getSource(url).catch(() => null);
  if (!known || !known.sha256) return { known: false, unchanged: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    if (!res.ok) return { known: true, unchanged: false, reason: 'head_' + res.status };
    const etag = res.headers.get('etag');
    const lastMod = res.headers.get('last-modified');
    const len = Number(res.headers.get('content-length') || 0) || null;
    if (etag && known.http_etag && etag === known.http_etag) return { known: true, unchanged: true, reason: 'etag', sha256: known.sha256 };
    if (!etag && lastMod && known.http_last_modified && lastMod === known.http_last_modified &&
        (!len || !known.content_length || Number(known.content_length) === len)) {
      return { known: true, unchanged: true, reason: 'last-modified', sha256: known.sha256 };
    }
    return { known: true, unchanged: false, reason: 'fingerprint_changed' };
  } catch (e) {
    return { known: true, unchanged: false, reason: 'head_failed' };
  } finally {
    clearTimeout(timer);
  }
}

// Registreer wat we feitelijk hebben opgehaald. Geeft terug wat er met dit
// document gebeurd is, zodat de aanroeper weet of er geanalyseerd moet worden.
//
//   'new'       — deze URL kenden we nog niet
//   'unchanged' — zelfde bytes als vorige keer; analyse hergebruiken
//   'replaced'  — andere bytes op dezelfde URL; SIGNAAL
//   'moved'     — bytes die we al kenden van een andere URL/leverancier
async function recordObservation(opts) {
  const url = opts.url;
  const buffer = opts.buffer;
  if (!url || !buffer || !buffer.length) return null;
  const supplierKey = opts.supplierKey || supplierKeyFromUrl(url);
  const now = Date.now();
  const sha = sha256Of(buffer);

  try {
    const existingDoc = await getDocument(sha);
    if (!existingDoc) {
      await pool.query(
        `INSERT INTO coa_documents (sha256, mimetype, byte_size, created_at)
         VALUES ($1,$2,$3,$4) ON CONFLICT (sha256) DO NOTHING`,
        [sha, opts.mimetype || null, buffer.length, now]
      );
    }

    const prior = await getSource(url);
    let change;
    if (!prior) {
      // Kenden we deze bytes al van ergens anders? Dan is de analyse er al.
      const { rows } = await pool.query('SELECT url, supplier_key FROM coa_sources WHERE sha256 = $1 LIMIT 1', [sha]);
      change = rows[0] ? 'moved' : 'new';
      await pool.query(
        `INSERT INTO coa_sources (id, supplier_key, url, sha256, http_etag, http_last_modified, content_length, first_seen_at, last_checked_at, last_changed_at, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,'active')`,
        [uuidv4(), supplierKey, url, sha, opts.etag || null, opts.lastModified || null, buffer.length, now]
      );
      await logEvent(supplierKey, url, change, null, sha);
      return { sha256: sha, change, alsoSeenAt: rows[0] ? rows[0].url : null, documentKnown: !!existingDoc };
    }

    if (prior.sha256 === sha) {
      await pool.query(
        `UPDATE coa_sources SET http_etag = $2, http_last_modified = $3, content_length = $4, last_checked_at = $5, status = 'active' WHERE url = $1`,
        [url, opts.etag || null, opts.lastModified || null, buffer.length, now]
      );
      return { sha256: sha, change: 'unchanged', documentKnown: true };
    }

    // Andere bytes op dezelfde URL. Dit is het signaal waar het archief
    // voor bestaat — nooit stilzwijgend overschrijven zonder gebeurtenis.
    await pool.query(
      `UPDATE coa_sources SET sha256 = $2, http_etag = $3, http_last_modified = $4, content_length = $5, last_checked_at = $6, last_changed_at = $6, status = 'active' WHERE url = $1`,
      [url, sha, opts.etag || null, opts.lastModified || null, buffer.length, now]
    );
    await logEvent(supplierKey, url, 'replaced', prior.sha256, sha);
    return { sha256: sha, change: 'replaced', previousSha256: prior.sha256, documentKnown: !!existingDoc };
  } catch (e) {
    console.error('coaStore.recordObservation:', (e && e.message) || e);
    return null;
  }
}

// Vergelijk de nu gevonden COA-URLs met wat we eerder van deze leverancier
// zagen. URLs die weg zijn, worden 'gone' — niet verwijderd. Een leverancier
// die stil een rapport weghaalt is een bevinding, geen opruimactie.
async function reconcileSupplierIndex(supplierKey, currentUrls) {
  if (!supplierKey) return { gone: [], reappeared: [] };
  const now = Date.now();
  const gone = [];
  const reappeared = [];
  try {
    const { rows } = await pool.query('SELECT url, status FROM coa_sources WHERE supplier_key = $1', [supplierKey]);
    const current = new Set(currentUrls || []);
    for (const row of rows) {
      if (!current.has(row.url) && row.status === 'active') {
        await pool.query(`UPDATE coa_sources SET status = 'gone', last_checked_at = $2 WHERE url = $1`, [row.url, now]);
        await logEvent(supplierKey, row.url, 'gone', null, null);
        gone.push(row.url);
      } else if (current.has(row.url) && row.status === 'gone') {
        await pool.query(`UPDATE coa_sources SET status = 'active', last_checked_at = $2 WHERE url = $1`, [row.url, now]);
        await logEvent(supplierKey, row.url, 'reappeared', null, null);
        reappeared.push(row.url);
      }
    }
  } catch (e) {
    console.error('coaStore.reconcileSupplierIndex:', (e && e.message) || e);
  }
  return { gone, reappeared };
}

// Analyseresultaat opslaan. Gesleuteld op (sha256, extractor_version): bij een
// ongewijzigde extractorversie wordt dit nooit opnieuw berekend.
async function saveExtraction(sha256, extractorVersion, extraction, meta) {
  try {
    const m = meta || {};
    await pool.query(
      `UPDATE coa_documents SET extraction = $3, extractor_version = $2,
         lab = COALESCE($4, lab), task_number = COALESCE($5, task_number),
         sample_number = COALESCE($6, sample_number), key_hash = COALESCE($7, key_hash),
         first_analyzed_at = COALESCE(first_analyzed_at, $8)
       WHERE sha256 = $1`,
      [sha256, extractorVersion, JSON.stringify(extraction || null), m.lab || null, m.taskNumber || null,
       m.sampleNumber || null, m.keyHash || null, Date.now()]
    );
  } catch (e) {
    console.error('coaStore.saveExtraction:', (e && e.message) || e);
  }
}

// Bestaat er al een bruikbare analyse voor deze bytes? Zo ja, niet opnieuw doen.
async function getExtraction(sha256, extractorVersion) {
  try {
    const doc = await getDocument(sha256);
    if (!doc || !doc.extraction) return null;
    if (extractorVersion && doc.extractor_version !== extractorVersion) return null;
    return doc.extraction;
  } catch (e) {
    return null;
  }
}

// Menselijke verificatie-uitslag opslaan (Werkbord/admin-COA-pagina, 19 sep).
// Los van saveExtraction(): dat legt vast WAT het document zegt, dit legt vast
// OF een mens dat heeft nagetrokken bij het lab. verification/authenticity_class/
// verification_checked_at stonden al in het schema (Janoshik-adapter v1.0) maar
// werden nooit beschreven — de server kan verify.janoshik.com niet zelf bereiken
// (403, zie "COA Authenticiteitsverificatie - Janoshik v2.0" §5), dus die
// resolutie gebeurt nu bewust in de browser van een staflid, met deze functie
// als opslagpunt achteraf.
//
// verification-vorm: { class:'A'|'B'|'C'|'D', method, lab, task, sample, key,
//   resolvedUrl, note, checkedBy, checkedAt }.
async function saveVerification(sha256, verification) {
  const v = verification || {};
  // De blob blijft (daar staat alles in wat we ooit meekregen), maar de velden
  // waarop gefilterd en vergeleken wordt krijgen een echte kolom. In een
  // JSONB-blob kun je geen leverancier met een afwijkende vulling opzoeken.
  const vul = vullingUit(v);
  const dv = veldvergelijkingUit(v);
  try {
    await pool.query(
      `UPDATE coa_documents SET verification = $2, authenticity_class = $3, verification_checked_at = $4,
              client = COALESCE($5, client), manufacturer = COALESCE($6, manufacturer),
              batchnummer = COALESCE($7, batchnummer), zuiverheid = COALESCE($8, zuiverheid),
              zuiverheid_pct = COALESCE($9, zuiverheid_pct), gemeten_mg = COALESCE($10, gemeten_mg),
              etiket_mg = COALESCE($11, etiket_mg), vulling_pct = COALESCE($12, vulling_pct),
              datum_analyse = COALESCE($13, datum_analyse),
              vergeleken_met = COALESCE($14, vergeleken_met),
              afleidingsnotitie = COALESCE($15, afleidingsnotitie),
              verification_method = COALESCE($16, verification_method),
              veldvergelijking = COALESCE($17, veldvergelijking),
              velden_vergeleken = COALESCE($18, velden_vergeleken),
              velden_afwijkend = COALESCE($19, velden_afwijkend)
       WHERE sha256 = $1`,
      [sha256, JSON.stringify(v), v.class || null, v.checkedAt || Date.now(),
       v.client || null, v.manufacturer || null, v.batchnummer || null,
       v.zuiverheid || null, percentageUit(v.zuiverheid),
       vul.gemetenMg, vul.etiketMg, vul.pct,
       v.datumAnalyse || null,
       // Bij een document is de kopie van de shop het document zelf.
       v.vergelekenMet || sha256,
       afleidingsnotitieVoor(v, vul), v.method || null,
       dv.velden ? JSON.stringify(dv.velden) : null, dv.vergeleken, dv.afwijkend]
    );
  } catch (e) {
    console.error('coaStore.saveVerification:', (e && e.message) || e);
    throw e;
  }
}

// Alle bekende documenten van één leverancier, incl. bron (url/status) en
// eventuele verificatie — voor de admin-COA-pagina (overzicht + historie).
async function getDocumentsBySupplier(supplierKey) {
  if (!supplierKey) return [];
  try {
    const { rows } = await pool.query(
      `SELECT s.url, s.status, s.first_seen_at, s.last_checked_at,
              d.sha256, d.mimetype, d.byte_size, d.lab, d.task_number, d.sample_number,
              d.extraction, d.extractor_version, d.verification, d.authenticity_class,
              d.verification_checked_at, d.first_analyzed_at
       FROM coa_sources s JOIN coa_documents d ON d.sha256 = s.sha256
       WHERE s.supplier_key = $1
       ORDER BY s.first_seen_at DESC`,
      [supplierKey]
    );
    return rows;
  } catch (e) {
    console.error('coaStore.getDocumentsBySupplier:', (e && e.message) || e);
    return [];
  }
}

// Alleen de documenten die al menselijk geverifieerd zijn — dit is wat de
// pipeline (coaDataset-stap) meeneemt in een nieuwe/toekomstige audit van
// dezelfde leverancier, zodat het handwerk van een staflid daadwerkelijk een
// beter rapport oplevert i.p.v. passief in het archief te blijven liggen.
async function listVerifiedDocumentsForSupplier(supplierKey) {
  const rows = await getDocumentsBySupplier(supplierKey);
  return rows.filter((r) => r.authenticity_class);
}

// Overzicht per leverancier, voor de audit en later voor de UI.
async function supplierHistory(supplierKey, limit) {
  try {
    const { rows } = await pool.query(
      `SELECT event, url, from_sha256, to_sha256, created_at FROM coa_source_events
       WHERE supplier_key = $1 ORDER BY created_at DESC LIMIT $2`,
      [supplierKey, Number(limit) || 50]
    );
    return rows.map((r) => ({ event: r.event, url: r.url, from: r.from_sha256, to: r.to_sha256, at: Number(r.created_at) }));
  } catch (e) {
    return [];
  }
}


// Verwijzingen naar een labverificatiepagina vastleggen. De referentie wordt
// uit de URL geparsed (task, sample, sleutel) zodat twee shops die naar
// hetzelfde rapport wijzen met een tekstvergelijking te vinden zijn - daar is
// geen enkele call naar het lab voor nodig, wat maar goed is ook, want
// Janoshik laat onze server er niet in (zie de labmeting).
// Elke lab heeft zijn eigen vorm van referentie in de URL. Janoshik zet task,
// sample en sleutel in het pad; Bridge Analytical gebruikt ?key=; anderen een
// id in het laatste padsegment. Zonder deze splitsing zouden alleen
// Janoshik-verwijzingen te matchen zijn, en dat was precies de blinde vlek.
function referentieUitUrl(lab, url) {
  if (/janoshik/i.test(lab || '')) {
    const p = janoshik.parseReferentie(url);
    if (p) return { referentie: p.referentie, taskNumber: p.taskNumber, sample: p.sample || null, key: p.key };
  }
  try {
    const u = new URL(url);
    const uitQuery = u.searchParams.get('key') || u.searchParams.get('code') || u.searchParams.get('id');
    if (uitQuery) return { referentie: uitQuery.trim(), taskNumber: null, sample: null, key: uitQuery.trim() };
    const laatste = u.pathname.split('/').filter(Boolean).pop();
    if (laatste && laatste.length >= 6 && !/^(verify|verification|tests?|coa|report)$/i.test(laatste)) {
      const schoon = decodeURIComponent(laatste);
      return { referentie: schoon, taskNumber: null, sample: null, key: schoon };
    }
  } catch (e) { /* geen bruikbare URL */ }
  return null;
}

// Eenmalige opschoning. Referenties die zijn weggeschreven voordat de
// labnaam genormaliseerd werd dragen nog het hele briefhoofd als labnaam
// ("ILS Laboratories, 8222 Vickers St, ..."). Daardoor vindt een filter op
// "ILS Laboratories" ze niet, terwijl een telling ze wel meerekent - precies
// het soort verschil waar je uren naar zoekt. Loopt bij het opstarten, raakt
// alleen rijen die daadwerkelijk anders worden.
async function normaliseerBestaandeLabnamen() {
  try {
    const { rows } = await pool.query('SELECT DISTINCT lab FROM coa_references');
    for (const r of rows) {
      const net = normaliseerLab(r.lab).naam;
      if (!net || net === r.lab) continue;
      const slug = net.toLowerCase().replace(/[^a-z0-9]/g, '') || 'onbekend';
      // De synthetische labref-URL draagt de labslug, dus die moet mee -
      // anders verschijnt dezelfde referentie later een tweede keer.
      await pool.query(
        `UPDATE coa_references
         SET lab = $2,
             url = CASE WHEN url LIKE 'labref://%'
                        THEN 'labref://' || $3 || '/' || split_part(url, '/', 4)
                        ELSE url END
         WHERE lab = $1`,
        [r.lab, net, slug]
      );
      await pool.query('UPDATE coa_reference_checks SET lab = $2 WHERE lab = $1', [r.lab, net]).catch(() => {});
      console.log('coaStore: labnaam genormaliseerd van "' + String(r.lab).slice(0, 60) + '" naar "' + net + '"');
    }
  } catch (e) {
    console.error('coaStore.normaliseerBestaandeLabnamen:', (e && e.message) || e);
  }
}

// Welke test is dit? Afgeleid uit de rijtekst naast de verwijzing. Alleen als
// de shop het zelf benoemt - we raden niet. null betekent 'niet benoemd',
// niet 'niet getest'.
const TESTSOORTEN = [
  ['zware metalen', /\bmetals?\b|\bheavy[\s-]*metals?\b|metaaltest|zware\s*metalen|\bmetal\s*test\b/i],
  ['endotoxinen', /\bendotox/i],
  ['steriliteit', /\bsterilit|\bsterility\b|\bbioburden\b/i],
  ['identiteit', /\bidentity\b|\bidentiteit\b|\bid\s*test\b/i],
  ['zuiverheid', /\bpurity\b|\bzuiverheid\b|\bhplc\b/i]
];

function testsoortUit(tekst) {
  const t = String(tekst || '');
  if (!t.trim()) return null;
  for (const paar of TESTSOORTEN) {
    if (paar[1].test(t)) return paar[0];
  }
  return null;
}

// Het batchnummer NIET uit de rijtekst raden. Geprobeerd en verworpen op
// 20 september: de heuristiek pakte '500mg' en 'IGF1-LR3' als batchnummer.
// Een fout batchnummer groepeert de verkeerde rapporten bij elkaar, en dat
// is erger dan geen groepering. De batch komt uit het labrapport zelf, bij
// het oplossen van de referentie of bij een handmatige controle.

// Welke soorten tests heeft deze leverancier laten doen, en hoeveel van elk?
// Bij een shop die per batch in losse rapporten splitst zegt "74 certificaten"
// niets; "25 op zuiverheid, 24 op zware metalen, 23 op endotoxinen" wel.
// Referenties zonder benoemde soort tellen apart - niet benoemd is iets anders
// dan niet getest.
async function testsoortDekking(supplierKey) {
  if (!supplierKey) return null;
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(testsoort, '(niet benoemd)') AS soort, COUNT(*)::int AS aantal
       FROM coa_references WHERE supplier_key = $1 GROUP BY 1 ORDER BY 2 DESC`,
      [supplierKey]
    );
    const perSoort = {};
    let totaal = 0;
    rows.forEach((r) => { perSoort[r.soort] = r.aantal; totaal += r.aantal; });
    return {
      perSoort, totaal,
      zwareMetalen: perSoort['zware metalen'] || 0,
      endotoxinen: perSoort['endotoxinen'] || 0,
      steriliteit: perSoort['steriliteit'] || 0,
      zuiverheid: perSoort['zuiverheid'] || 0,
      nietBenoemd: perSoort['(niet benoemd)'] || 0
    };
  } catch (e) {
    console.error('coaStore.testsoortDekking:', (e && e.message) || e);
    return null;
  }
}

async function recordReferences(supplierKey, lijst) {
  const items = (lijst || []).filter((v) => v && v.url);
  if (!supplierKey || !items.length) return { opgeslagen: 0, onleesbaar: 0 };
  const now = Date.now();
  let opgeslagen = 0;
  let onleesbaar = 0;
  for (const v of items) {
    // Normaliseren bij het OPSLAAN, niet pas in het overzicht. Anders belandt
    // "ILS Laboratories, 8222 Vickers St, Suite 106, San Diego, CA 92111" als
    // eigen lab in de tabel en vindt een zoekopdracht op "ILS Laboratories"
    // niets - en de resolver haalt zijn werkvoorraad op dezelfde manier op.
    const lab = normaliseerLab(v.lab || 'Janoshik').naam;
    const p = referentieUitUrl(lab, v.url);
    if (!p) { onleesbaar++; continue; }
    try {
      await pool.query(
        `INSERT INTO coa_references (id, supplier_key, lab, referentie, task_number, sample, ref_key, url, context, gevonden_op, first_seen_at, last_seen_at, testsoort)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12)
         ON CONFLICT (supplier_key, url) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at,
           testsoort = COALESCE(EXCLUDED.testsoort, coa_references.testsoort),
           context = COALESCE(EXCLUDED.context, coa_references.context)`,
        [uuidv4(), supplierKey, lab, p.referentie, p.taskNumber, p.sample || null, p.key,
         v.url, (v.context || '').slice(0, 300) || null, v.gevondenOp || null, now,
         // De testsoort staat meestal in de rij; anders soms in de referentie
         // zelf ("...-NAD_500mg_METAL_...").
         testsoortUit(v.context) || testsoortUit(v.url)]
      );
      opgeslagen++;
    } catch (e) {
      console.error('coaStore.recordReferences:', (e && e.message) || e);
    }
  }
  return { opgeslagen, onleesbaar };
}

// Vastleggen wat een mens op de verificatiepagina van het lab heeft gezien.
// Het veld 'client' is hier het belangrijkste: staat daar de shop zelf, of een
// derde partij? Dat is precies wat wij niet kunnen zien en een mens in twee
// seconden wel.
//
// LET OP: alleen deze route mag klasse D zetten (referentie bestaat, maar
// lost niet op). Het model doet dat nooit zelf - zelfde regel als bij de
// documenten.
// Uit de letterlijke tekst die een mens overtypt het percentage halen. De
// tekst blijft altijd bewaard; lukt het afleiden niet, dan blijft het getal
// leeg. Nooit andersom - een geraden getal is erger dan geen getal.
function percentageUit(tekst) {
  if (!tekst) return null;
  const t = String(tekst);
  // Een expliciet percentage wint: "99.14%" of "(106%)".
  const pct = t.match(/(\d{1,3}(?:[.,]\d+)?)\s*%/);
  if (pct) {
    const n = Number(pct[1].replace(',', '.'));
    if (Number.isFinite(n) && n >= 0 && n <= 1000) return n;
  }
  // Anders een verhouding met dezelfde eenheid: "10.6 mg / 10 mg".
  const ratio = t.match(/(\d+(?:[.,]\d+)?)\s*([a-z]{1,4})?\s*\/\s*(\d+(?:[.,]\d+)?)\s*([a-z]{1,4})?/i);
  if (ratio) {
    const a = Number(ratio[1].replace(',', '.'));
    const b = Number(ratio[3].replace(',', '.'));
    const ea = (ratio[2] || '').toLowerCase();
    const eb = (ratio[4] || '').toLowerCase();
    if (ea && eb && ea !== eb) return null;   // appels en peren
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) {
      return Math.round((a / b) * 10000) / 100;
    }
  }
  return null;
}

// De kopie van de shop naast het labrapport, veld voor veld.
//
// Dezelfde velden en dezelfde normalisatie als de resolver (janoshik.js),
// zodat handmatig en automatisch werk in precies dezelfde vorm in de database
// komen. Een veld dat aan een kant ontbreekt is geen verschil - dat is
// 'niet vergeleken', en dat is iets anders dan 'komt overeen'.
function veldvergelijkingUit(c) {
  const shop = c.kopieShop || null;
  const lab = c.bijLab || null;
  if (!shop && !lab) return { velden: null, vergeleken: null, afwijkend: null };

  const velden = [];
  for (const paar of janoshik.TE_VERGELIJKEN) {
    const sleutel = paar[0], label = paar[1], soort = paar[2];
    const ruwA = shop ? shop[sleutel] : null;
    const ruwB = lab ? lab[sleutel] : null;
    // Per veld zijn eigen soort: een datum als datum, een percentage als
    // getal. Tekstvergelijking op die velden levert verschillen op die er
    // geen zijn.
    const a = janoshik.normaliseerVeld(ruwA, soort);
    const b = janoshik.normaliseerVeld(ruwB, soort);
    const ingevuld = (x) => x != null && x !== '';
    if (!ingevuld(ruwA) && !ingevuld(ruwB)) continue;
    const rij = {
      veld: label, sleutel, soort,
      opKopieLeverancier: ingevuld(ruwA) ? ruwA : null,
      bijHetLab: ingevuld(ruwB) ? ruwB : null,
      // null = niet te vergelijken. Dat is een kant die ontbreekt, maar ook
      // een datum die niet eenduidig te lezen is. Nooit false.
      gelijk: (a == null || b == null) ? null : (a === b)
    };
    // Waarom niet vergeleken, als er wel aan beide kanten iets stond.
    if (rij.gelijk === null && ingevuld(ruwA) && ingevuld(ruwB)) {
      rij.reden = 'niet eenduidig te lezen als ' + soort;
    }
    if (rij.gelijk === false && soort === 'naam') {
      const ka = janoshik.kaleNaam(ruwA), kb = janoshik.kaleNaam(ruwB);
      if (ka && kb && ka === kb) rij.bijnaGelijk = true;
    }
    if (rij.gelijk === false && soort === 'productnaam' && janoshik.naamLijktOp(ruwA, ruwB)) {
      rij.bijnaGelijk = true;
    }
    velden.push(rij);
  }
  if (!velden.length) return { velden: null, vergeleken: null, afwijkend: null };
  return {
    velden,
    vergeleken: velden.filter((v) => v.gelijk !== null).length,
    // Een verschil dat alleen een schrijfwijze is telt apart. Anders schreeuwt
    // de telling: vier van de zes vergelijkingen op 20 september sloegen aan op
    // "SS-31 50mg" tegenover "SS-31", en dat is geen bevinding.
    afwijkend: velden.filter((v) => v.gelijk === false && !v.bijnaGelijk).length,
    afwijkendAlleenSchrijfwijze: velden.filter((v) => v.gelijk === false && v.bijnaGelijk).length
  };
}

// Vulling: hoeveel wijkt de gemeten hoeveelheid af van wat het etiket claimt?
//
// LET OP - dit is een AFWIJKING, geen verhouding. 10,6 mg in een vial van
// 10 mg geeft +6, niet 106. De pijplijn gebruikt elders al deviationPct met
// diezelfde betekenis; twee betekenissen onder een naam is precies de fout
// die we bij de klassen A-D al hebben.
//
// Leeg bij iu-eenheden (HGH) en bij blends: daar staat een som van meerdere
// peptides tegenover een geclaimd totaal, en dat is iets anders dan vulling.
// De reden komt in de afleidingsnotitie, zodat leeg nooit stil is.
const GEWICHT = { mg: 1, mcg: 0.001, 'ug': 0.001, 'µg': 0.001, g: 1000 };

function vullingUit(c) {
  const tekst = c.vulling ? String(c.vulling) : '';
  const product = c.product ? String(c.product) : '';
  // Een losse plus maakt nog geen blend: NAD+ is een enkele stof. Alleen een
  // plus met een woord erachter telt, zoals 'CJC-1295 + Ipamorelin'.
  const lijktBlend = /\bblend\b/i.test(product) || /\+\s*[a-z]{2,}/i.test(product) || /\bblend\b/i.test(tekst);
  const lijktIu = /\biu\b/i.test(tekst) || /\biu\b/i.test(product);

  let gemeten = Number.isFinite(Number(c.gemetenMg)) && c.gemetenMg !== null && c.gemetenMg !== '' ? Number(c.gemetenMg) : null;
  let etiket = Number.isFinite(Number(c.etiketMg)) && c.etiketMg !== null && c.etiketMg !== '' ? Number(c.etiketMg) : null;

  if ((gemeten === null || etiket === null) && tekst) {
    const m = tekst.match(/(\d+(?:[.,]\d+)?)\s*(mg|mcg|ug|µg|g|iu)?\s*\/\s*(\d+(?:[.,]\d+)?)\s*(mg|mcg|ug|µg|g|iu)?/i);
    if (m) {
      const ea = (m[2] || 'mg').toLowerCase();
      const eb = (m[4] || ea).toLowerCase();
      if (ea in GEWICHT && eb in GEWICHT) {
        if (gemeten === null) gemeten = Number(m[1].replace(',', '.')) * GEWICHT[ea];
        if (etiket === null) etiket = Number(m[3].replace(',', '.')) * GEWICHT[eb];
      }
    }
  }

  if (lijktIu) return { gemetenMg: null, etiketMg: null, pct: null, reden: 'iu-eenheid: niet in mg uit te drukken' };
  if (lijktBlend) return { gemetenMg: gemeten, etiketMg: etiket, pct: null, reden: 'blend: som van meerdere peptides, geen vulling van een enkele stof' };
  if (gemeten === null || etiket === null) {
    return { gemetenMg: gemeten, etiketMg: etiket, pct: null, reden: tekst ? 'uit "' + tekst.slice(0, 80) + '" kwamen geen twee vergelijkbare gewichten' : null };
  }
  if (!(etiket > 0)) return { gemetenMg: gemeten, etiketMg: etiket, pct: null, reden: 'etiketwaarde is nul of negatief' };
  return { gemetenMg: gemeten, etiketMg: etiket, pct: Math.round(((gemeten - etiket) / etiket) * 10000) / 100, reden: null };
}

// Welke velden hadden wel tekst maar leverden geen getal op? Dat vastleggen
// in plaats van stil laten verdwijnen.
function afleidingsnotitieVoor(c, vul) {
  const regels = [];
  if (c.zuiverheid && percentageUit(c.zuiverheid) === null) {
    regels.push('zuiverheid: "' + String(c.zuiverheid).slice(0, 120) + '" - hier kwam geen percentage uit; tekst bewaard, getal leeg');
  }
  if (vul && vul.reden) regels.push('vulling: ' + vul.reden);
  return regels.length ? regels.join(' | ') : null;
}

async function saveReferenceCheck(lab, referentie, check) {
  if (!lab || !referentie || !check) return null;
  const c = check;
  const vul = vullingUit(c);
  const vv = veldvergelijkingUit(c);
  try {
    const { rows } = await pool.query(
      `INSERT INTO coa_reference_checks
         (id, lab, referentie, task_number, resolvet, klasse, client, product, batchnummer, resolved_url, notitie, checked_by, methode, checked_at, rapport, zuiverheid, zuiverheid_pct, vulling, vulling_pct, afleidingsnotitie,
          manufacturer, gemeten_mg, etiket_mg, datum_analyse, vergeleken_met,
          veldvergelijking, velden_vergeleken, velden_afwijkend)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       ON CONFLICT (lab, referentie) DO UPDATE SET
         resolvet = EXCLUDED.resolvet, client = EXCLUDED.client,
         product = EXCLUDED.product, batchnummer = EXCLUDED.batchnummer,
         resolved_url = EXCLUDED.resolved_url, notitie = EXCLUDED.notitie,
         checked_by = EXCLUDED.checked_by, checked_at = EXCLUDED.checked_at,
         methode = EXCLUDED.methode,
         -- Een menselijke controle heeft geen labrapport bij zich. Die mag het
         -- rapport dat de resolver eerder ophaalde niet wissen.
         rapport = COALESCE(EXCLUDED.rapport, coa_reference_checks.rapport),
         zuiverheid = COALESCE(EXCLUDED.zuiverheid, coa_reference_checks.zuiverheid),
         zuiverheid_pct = COALESCE(EXCLUDED.zuiverheid_pct, coa_reference_checks.zuiverheid_pct),
         vulling = COALESCE(EXCLUDED.vulling, coa_reference_checks.vulling),
         vulling_pct = COALESCE(EXCLUDED.vulling_pct, coa_reference_checks.vulling_pct),
         afleidingsnotitie = COALESCE(EXCLUDED.afleidingsnotitie, coa_reference_checks.afleidingsnotitie),
         manufacturer = COALESCE(EXCLUDED.manufacturer, coa_reference_checks.manufacturer),
         gemeten_mg = COALESCE(EXCLUDED.gemeten_mg, coa_reference_checks.gemeten_mg),
         etiket_mg = COALESCE(EXCLUDED.etiket_mg, coa_reference_checks.etiket_mg),
         datum_analyse = COALESCE(EXCLUDED.datum_analyse, coa_reference_checks.datum_analyse),
         vergeleken_met = COALESCE(EXCLUDED.vergeleken_met, coa_reference_checks.vergeleken_met),
         veldvergelijking = COALESCE(EXCLUDED.veldvergelijking, coa_reference_checks.veldvergelijking),
         velden_vergeleken = COALESCE(EXCLUDED.velden_vergeleken, coa_reference_checks.velden_vergeleken),
         velden_afwijkend = COALESCE(EXCLUDED.velden_afwijkend, coa_reference_checks.velden_afwijkend),
         -- Een resolverrun mag een door een mens gezette klasse nooit wissen.
         klasse = CASE WHEN EXCLUDED.methode = 'resolver'
                       THEN coa_reference_checks.klasse
                       ELSE EXCLUDED.klasse END
       RETURNING *`,
      [uuidv4(), lab, referentie, c.taskNumber || null,
       typeof c.resolvet === 'boolean' ? c.resolvet : null,
       c.klasse || null, c.client || null, c.product || null, c.batchnummer || null,
       c.resolvedUrl || null, c.notitie || null, c.checkedBy || null, c.methode || 'handmatig', Date.now(),
       c.rapport ? JSON.stringify(c.rapport) : null,
       c.zuiverheid || null, percentageUit(c.zuiverheid),
       c.vulling || null, vul.pct, afleidingsnotitieVoor(c, vul),
       c.manufacturer || null, vul.gemetenMg, vul.etiketMg,
       c.datumAnalyse || null, c.vergelekenMet || null,
       vv.velden ? JSON.stringify(vv.velden) : null, vv.vergeleken, vv.afwijkend]
    );
    // Is de opdrachtgever een partij die we nog niet kennen? Dan krijgt die
    // zijn eigen plek, zodat hij later op te vragen is als elke leverancier.
    if (c.client) await legOpdrachtgeverVast(lab, referentie, c.client);
    return rows[0] || null;
  } catch (e) {
    console.error('coaStore.saveReferenceCheck:', (e && e.message) || e);
    return null;
  }
}

// Welke referenties van dit lab zijn nog niet opgelost? Dit is de werkvoorraad
// van de resolver.
async function openstaandeReferenties(lab, max, opties) {
  try {
    // Met opnieuw=true draaien ook al opgeloste referenties mee. Een door een
    // mens gecontroleerde referentie blijft er altijd buiten: die uitspraak is
    // het eindoordeel en wordt niet door een machine overgedaan.
    const opnieuw = !!(opties && opties.opnieuw);
    const filter = opnieuw
      ? `(c.id IS NULL OR c.methode = 'resolver')`
      : `c.id IS NULL`;
    const { rows } = await pool.query(
      `SELECT DISTINCT r.lab, r.referentie, r.url
       FROM coa_references r
       LEFT JOIN coa_reference_checks c ON c.lab = r.lab AND c.referentie = r.referentie
       WHERE r.lab = $1 AND ${filter}
       ORDER BY r.referentie
       LIMIT $2`,
      [lab, Math.max(1, Math.min(Number(max) || 10, 100))]
    );
    return rows;
  } catch (e) {
    console.error('coaStore.openstaandeReferenties:', (e && e.message) || e);
    return [];
  }
}

async function listReferenceChecks() {
  try {
    const { rows } = await pool.query('SELECT * FROM coa_reference_checks');
    return rows;
  } catch (e) {
    console.error('coaStore.listReferenceChecks:', (e && e.message) || e);
    return [];
  }
}

// Referenties die op het DOCUMENT gedrukt staan, niet als link gepubliceerd.
// Tot 20 september kwamen alleen gelinkte verwijzingen in het archief, en dat
// is precies andersom dan hoe de meeste shops het doen: ILS-rapporten worden
// zelf gehost met een toegangscode in de kop, Janoshik-rapporten dragen task
// en sleutel op het vel. Zonder deze stap heeft een labadapter alleen de
// referenties die een shop toevallig aanklikbaar maakte.
//
// De URL is hier vaak onbekend, want niet elk lab heeft een URL-vorm die wij
// kennen. In dat geval een synthetische sleutel 'labref://<lab>/<referentie>',
// net als bij admin-uploads: alleen om de UNIQUE-constraint te bedienen, en
// herkenbaar als "referentie zonder bekende verificatie-URL".
async function recordReferencesUitDocumenten(supplierKey, items) {
  const lijst = (items || []).filter((v) => v && v.lab && v.referentie);
  if (!supplierKey || !lijst.length) return { opgeslagen: 0, zonderUrl: 0 };
  const now = Date.now();
  let opgeslagen = 0;
  let zonderUrl = 0;
  for (const v of lijst) {
    const lab = normaliseerLab(v.lab).naam;
    const labSlug = lab.toLowerCase().replace(/[^a-z0-9]/g, '') || 'onbekend';
    const url = v.url || ('labref://' + labSlug + '/' + encodeURIComponent(v.referentie));
    if (!v.url) zonderUrl++;
    try {
      await pool.query(
        `INSERT INTO coa_references (id, supplier_key, lab, referentie, task_number, sample, ref_key, url, context, gevonden_op, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
         ON CONFLICT (supplier_key, url) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
        [uuidv4(), supplierKey, lab, v.referentie, v.taskNumber || null, v.sample || null,
         v.key || null, url, (v.context || 'gelezen van het document zelf').slice(0, 300),
         v.gevondenOp || null, now]
      );
      opgeslagen++;
    } catch (e) {
      console.error('coaStore.recordReferencesUitDocumenten:', (e && e.message) || e);
    }
  }
  return { opgeslagen, zonderUrl };
}

async function listReferences() {
  try {
    const { rows } = await pool.query(
      'SELECT supplier_key, lab, referentie, task_number, sample, ref_key, url, first_seen_at FROM coa_references'
    );
    return rows;
  } catch (e) {
    console.error('coaStore.listReferences:', (e && e.message) || e);
    return [];
  }
}

// Echte aantallen, los van de paginalimiet. referentiesMetControle geeft
// maximaal 100 (cap 500) rijen terug, gesorteerd op checked_at DESC. Een
// telling over die pagina is dus niet alleen onvolledig maar ook scheef: de
// gecontroleerde referenties staan vooraan, dus het lijkt alsof er veel meer
// af is dan werkelijk. Deze query telt de hele tabel.
async function referentieTotalen(lab) {
  try {
    const params = [];
    const waar = lab ? 'WHERE r.lab = $1' : '';
    if (lab) params.push(lab);
    const { rows } = await pool.query(
      `SELECT r.lab,
              COUNT(DISTINCT r.referentie) AS totaal,
              COUNT(DISTINCT CASE WHEN c.id IS NOT NULL THEN r.referentie END) AS gecontroleerd,
              COUNT(DISTINCT CASE WHEN c.resolvet = true THEN r.referentie END) AS opgelost,
              COUNT(DISTINCT CASE WHEN c.methode = 'handmatig' THEN r.referentie END) AS handmatig
       FROM coa_references r
       LEFT JOIN coa_reference_checks c ON c.lab = r.lab AND c.referentie = r.referentie
       ${waar}
       GROUP BY r.lab`,
      params
    );
    // Labnamen samenvoegen op hun nette vorm, anders telt hetzelfde lab
    // onder twee schrijfwijzen als twee labs.
    const perLab = {};
    let totaal = 0, gecontroleerd = 0, opgelost = 0, handmatig = 0;
    rows.forEach((r) => {
      const k = normaliseerLab(r.lab).naam || 'onbekend';
      const b = perLab[k] || (perLab[k] = { totaal: 0, gecontroleerd: 0, opgelost: 0, handmatig: 0, openstaand: 0 });
      b.totaal += Number(r.totaal) || 0;
      b.gecontroleerd += Number(r.gecontroleerd) || 0;
      b.opgelost += Number(r.opgelost) || 0;
      b.handmatig += Number(r.handmatig) || 0;
      b.openstaand = b.totaal - b.gecontroleerd;
    });
    Object.values(perLab).forEach((b) => {
      totaal += b.totaal; gecontroleerd += b.gecontroleerd;
      opgelost += b.opgelost; handmatig += b.handmatig;
    });
    return { perLab, totaal, gecontroleerd, opgelost, handmatig, openstaand: totaal - gecontroleerd };
  } catch (e) {
    console.error('coaStore.referentieTotalen:', (e && e.message) || e);
    return { perLab: {}, totaal: 0, gecontroleerd: 0, opgelost: 0, handmatig: 0, openstaand: 0 };
  }
}

// Labreferenties van EEN leverancier, met hun controle. Nodig omdat de
// chatroute wel kon schrijven maar niet teruglezen: zonder dit weet niemand
// of een referentie al gecontroleerd is, en wordt hetzelfde rapport twee keer
// met de hand geopend.
// Van wie is deze test eigenlijk?
//
// Zodra twee shops hetzelfde labrapport tonen, is het rapport niet van allebei.
// Er zijn drie uitkomsten, en de derde is de interessantste:
//
//   eigen        - de opdrachtgever op het rapport is deze shop zelf
//   andere shop  - de opdrachtgever is een van de andere shops op dit rapport
//   derde partij - de opdrachtgever is niemand van de shops die het tonen
//
// Die laatste zagen we bij astralabs en pyroxlabs: Client en Manufacturer
// allebei utherpeptide.com, een partij die geen van beide noemt. Waarschijnlijk
// hun gezamenlijke fabrikant. Dat is iets anders dan 'een van de twee liegt' -
// maar de claim 'onafhankelijk getest' hoort dan bij de fabrikant, niet bij de
// winkel.
//
// Vergelijken met kaleNaam uit janoshik.js: die haalt domeinvorm en
// rechtsvorm weg, zodat 'Astra Labs' en 'astralabs.co.uk' matchen. Geen match
// is geen oordeel over eerlijkheid - alleen een waarneming.
function clientOordeel(client, leveranciers) {
  const kaal = janoshik.kaleNaam(client);
  if (!kaal) return null;
  const lijst = (leveranciers || []).filter(Boolean);
  if (!lijst.length) return null;

  const eigen = [];
  for (const key of lijst) {
    const k = janoshik.kaleNaam(key);
    if (k && (k === kaal || k.includes(kaal) || kaal.includes(k))) eigen.push(key);
  }
  return {
    client,
    hoort_bij: eigen,
    // true als geen van de shops die dit rapport tonen de opdrachtgever is
    derdePartij: eigen.length === 0,
    // true als meerdere shops het tonen maar maar een ervan de opdrachtgever is
    gedeeldMaarVanEen: lijst.length > 1 && eigen.length === 1,
    aantalLeveranciers: lijst.length
  };
}

// Een opdrachtgever die zelf geen shop in ons archief is, krijgt zijn eigen
// plek. Daarna is utherpeptide.com op te vragen als elke andere leverancier:
// welke rapporten staan op hun naam, en welke shops tonen die.
//
// Alleen als de clientnaam een domein is. "OmegaPeptides" is geen sleutel; die
// shop kennen we al via zijn eigen site. Een naam zonder punt laten we staan -
// liever geen entiteit dan een verzonnen entiteit.
function lijktOpDomein(naam) {
  const t = String(naam || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(t) && /\.[a-z]{2,}$/.test(t) ? t : null;
}

async function legOpdrachtgeverVast(lab, referentie, client) {
  const sleutel = lijktOpDomein(client);
  if (!sleutel || !lab || !referentie) return null;
  try {
    // Toont deze partij de referentie zelf al? Dan is het een shop, geen
    // losse opdrachtgever, en verandert er niets.
    const bestaand = await pool.query(
      `SELECT relatie FROM coa_references WHERE supplier_key = $1 AND lab = $2 AND referentie = $3 LIMIT 1`,
      [sleutel, lab, referentie]
    );
    if (bestaand.rows.length && bestaand.rows[0].relatie === 'toont') return null;

    const bron = await pool.query(
      `SELECT url, task_number, sample, ref_key, testsoort FROM coa_references
       WHERE lab = $1 AND referentie = $2 ORDER BY first_seen_at LIMIT 1`,
      [lab, referentie]
    );
    if (!bron.rows.length) return null;
    const b = bron.rows[0];
    const now = Date.now();
    await pool.query(
      `INSERT INTO coa_references (id, supplier_key, lab, referentie, task_number, sample, ref_key, url, context, gevonden_op, first_seen_at, last_seen_at, testsoort, relatie)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,'opdrachtgever')
       ON CONFLICT (supplier_key, url) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
      [uuidv4(), sleutel, lab, referentie, b.task_number, b.sample, b.ref_key, b.url,
       'opdrachtgever volgens het labrapport', null, now, b.testsoort]
    );
    return sleutel;
  } catch (e) {
    console.error('coaStore.legOpdrachtgeverVast:', (e && e.message) || e);
    return null;
  }
}

// Overzicht van alle leveranciers die we kennen, met wat we per stuk hebben.
// Bedoeld voor de stafpagina: een regel per leverancier, en de kolommen die er
// toe doen staan vooraan - niet "hoeveel rapporten" maar "hoeveel daarvan zijn
// gecontroleerd, en wat kwam daaruit".
async function leveranciersOverzicht() {
  try {
    const { rows: refRijen } = await pool.query(
      `SELECT r.supplier_key, r.lab, r.relatie, r.testsoort,
              c.id IS NOT NULL AS gecontroleerd, c.resolvet, c.client,
              c.velden_afwijkend, c.checked_at
       FROM coa_references r
       LEFT JOIN coa_reference_checks c ON c.lab = r.lab AND c.referentie = r.referentie`
    );
    const { rows: docRijen } = await pool.query(
      `SELECT s.supplier_key, COUNT(DISTINCT d.sha256)::int AS documenten,
              COUNT(DISTINCT d.sha256) FILTER (WHERE d.authenticity_class IS NOT NULL)::int AS metKlasse,
              MAX(s.last_checked_at) AS laatstGezien
       FROM coa_sources s JOIN coa_documents d ON d.sha256 = s.sha256
       GROUP BY s.supplier_key`
    );

    const perKey = {};
    const zorg = (k) => (perKey[k] = perKey[k] || {
      supplierKey: k, labs: {}, testsoorten: {},
      referenties: 0, alsOpdrachtgever: 0, gecontroleerd: 0, opgelost: 0,
      nietOpgelost: 0, opNaamVanDerde: 0, metVeldverschil: 0,
      documenten: 0, documentenMetKlasse: 0, laatstGecontroleerd: null, laatstGezien: null
    });

    refRijen.forEach((r) => {
      const b = zorg(r.supplier_key);
      if (r.relatie === 'opdrachtgever') { b.alsOpdrachtgever++; }
      else {
        b.referenties++;
        const lab = normaliseerLab(r.lab).naam;
        b.labs[lab] = (b.labs[lab] || 0) + 1;
        const ts = r.testsoort || '(niet benoemd)';
        b.testsoorten[ts] = (b.testsoorten[ts] || 0) + 1;
      }
      if (!r.gecontroleerd) return;
      b.gecontroleerd++;
      if (r.resolvet === true) b.opgelost++;
      if (r.resolvet === false) b.nietOpgelost++;
      if (Number(r.velden_afwijkend) > 0) b.metVeldverschil++;
      if (r.client) {
        const oordeel = clientOordeel(r.client, [r.supplier_key]);
        if (oordeel && oordeel.derdePartij) b.opNaamVanDerde++;
      }
      if (r.checked_at && (!b.laatstGecontroleerd || r.checked_at > b.laatstGecontroleerd)) {
        b.laatstGecontroleerd = Number(r.checked_at);
      }
    });

    docRijen.forEach((r) => {
      const b = zorg(r.supplier_key);
      b.documenten = r.documenten;
      b.documentenMetKlasse = r.metklasse;
      b.laatstGezien = r.laatstgezien ? Number(r.laatstgezien) : null;
    });

    // lab:-sleutels zijn geen leveranciers maar een bijproduct van de resolver.
    return Object.values(perKey)
      .filter((b) => !/^lab:/i.test(b.supplierKey))
      .sort((a, b) => (b.referenties + b.documenten) - (a.referenties + a.documenten));
  } catch (e) {
    console.error('coaStore.leveranciersOverzicht:', (e && e.message) || e);
    return [];
  }
}

async function referentiesVanLeverancier(supplierKey, max) {
  if (!supplierKey) return [];
  try {
    const { rows } = await pool.query(
      `SELECT r.lab, r.referentie, r.url, r.testsoort, r.context, r.relatie,
              c.resolvet, c.klasse, c.client, c.manufacturer, c.product, c.batchnummer,
              c.zuiverheid, c.zuiverheid_pct, c.vulling_pct, c.datum_analyse,
              c.veldvergelijking, c.velden_vergeleken, c.velden_afwijkend,
              c.vergeleken_met, c.afleidingsnotitie, c.notitie,
              c.checked_by, c.methode, c.checked_at
       FROM coa_references r
       LEFT JOIN coa_reference_checks c ON c.lab = r.lab AND c.referentie = r.referentie
       WHERE r.supplier_key = $1
       ORDER BY c.checked_at DESC NULLS LAST, r.referentie
       LIMIT $2`,
      [supplierKey, Math.max(1, Math.min(Number(max) || 200, 500))]
    );
    return rows.map((r) => ({
      lab: normaliseerLab(r.lab).naam, referentie: r.referentie, url: r.url,
      testsoort: r.testsoort, context: r.context, relatie: r.relatie || 'toont',
      controle: r.checked_at ? {
        resolvet: r.resolvet, klasse: r.klasse, client: r.client, manufacturer: r.manufacturer,
        product: r.product, batchnummer: r.batchnummer,
        zuiverheid: r.zuiverheid, zuiverheidPct: r.zuiverheid_pct, vullingPct: r.vulling_pct,
        datumAnalyse: r.datum_analyse, veldvergelijking: r.veldvergelijking,
        veldenVergeleken: r.velden_vergeleken, veldenAfwijkend: r.velden_afwijkend,
        vergelekenMet: r.vergeleken_met, afleidingsnotitie: r.afleidingsnotitie,
        notitie: r.notitie, checkedBy: r.checked_by, methode: r.methode, checkedAt: r.checked_at
      } : null
    }));
  } catch (e) {
    console.error('coaStore.referentiesVanLeverancier:', (e && e.message) || e);
    return [];
  }
}

async function referentiesMetControle(lab, max) {
  try {
    const params = [Math.max(1, Math.min(Number(max) || 100, 500))];
    const waar = lab ? 'WHERE r.lab = $2' : '';  // na de opschoning is de ruwe naam al de nette
    if (lab) params.push(lab);
    const { rows } = await pool.query(
      `SELECT r.lab, r.referentie, r.url, r.testsoort,
              array_agg(DISTINCT r.supplier_key) FILTER (WHERE r.relatie = 'toont') AS leveranciers,
              array_agg(DISTINCT r.supplier_key) FILTER (WHERE r.relatie = 'opdrachtgever') AS opdrachtgevers,
              c.resolvet, c.klasse, c.client, c.product, c.batchnummer,
              c.notitie, c.checked_by, c.methode, c.checked_at,
              c.zuiverheid, c.zuiverheid_pct, c.vulling, c.vulling_pct, c.afleidingsnotitie,
              c.manufacturer, c.gemeten_mg, c.etiket_mg, c.datum_analyse, c.vergeleken_met,
              c.veldvergelijking, c.velden_vergeleken, c.velden_afwijkend
       FROM coa_references r
       LEFT JOIN coa_reference_checks c ON c.lab = r.lab AND c.referentie = r.referentie
       ${waar}
       GROUP BY r.lab, r.referentie, r.url, r.testsoort, c.resolvet, c.klasse, c.client, c.product,
                c.batchnummer, c.notitie, c.checked_by, c.methode, c.checked_at,
                c.zuiverheid, c.zuiverheid_pct, c.vulling, c.vulling_pct, c.afleidingsnotitie,
              c.manufacturer, c.gemeten_mg, c.etiket_mg, c.datum_analyse, c.vergeleken_met,
              c.veldvergelijking, c.velden_vergeleken, c.velden_afwijkend
       ORDER BY c.checked_at DESC NULLS LAST, r.referentie
       LIMIT $1`,
      params
    );
    return rows.map((r) => ({
      lab: r.lab, labNet: normaliseerLab(r.lab).naam,
      referentie: r.referentie, url: r.url, testsoort: r.testsoort || null,
      // LET OP: leveranciers zijn de shops die het rapport TONEN. De partij op
      // wiens naam het staat zit in opdrachtgevers. Ze door elkaar halen maakt
      // de kruisverbandtelling onzin: Uther zou dan 55 referenties 'delen'.
      leveranciers: r.leveranciers || [],
      opdrachtgevers: r.opdrachtgevers || [],
      controle: r.checked_at ? {
        resolvet: r.resolvet, klasse: r.klasse, client: r.client, product: r.product,
        batchnummer: r.batchnummer, notitie: r.notitie, checkedBy: r.checked_by,
        methode: r.methode, checkedAt: r.checked_at,
        zuiverheid: r.zuiverheid, zuiverheidPct: r.zuiverheid_pct,
        vulling: r.vulling, vullingPct: r.vulling_pct,
        afleidingsnotitie: r.afleidingsnotitie,
        manufacturer: r.manufacturer, gemetenMg: r.gemeten_mg, etiketMg: r.etiket_mg,
        datumAnalyse: r.datum_analyse, vergelekenMet: r.vergeleken_met,
        veldvergelijking: r.veldvergelijking,
        veldenVergeleken: r.velden_vergeleken, veldenAfwijkend: r.velden_afwijkend
      } : null
    }));
  } catch (e) {
    console.error('coaStore.referentiesMetControle:', (e && e.message) || e);
    return [];
  }
}

// --- Kruisverband tussen leveranciers ------------------------------------
// Het archief is content-addressed: publiceren twee shops hetzelfde bestand,
// dan levert dat hetzelfde sha256 op. Dat signaal zat al in de data, maar was
// nergens op te vragen - getDocumentsBySupplier stelt de vraag per
// leverancier. Hieronder staat de vraag andersom: bij hoeveel leveranciers
// komt dit document voor, en welke shops wijzen naar hetzelfde lab?
//
// LET OP: het veld "lijst" hieronder is een werklijst, GEEN methodiek-
// uitspraak. Het stuurt geen enkele score aan en verschijnt alleen in het
// interne overzicht, zodat zichtbaar is wanneer meerdere shops naar een lab
// wijzen waar twijfel over bestaat. De beoordeling van een lab zelf hoort in
// categorie L01 en komt niet uit deze tabel.
const BEKENDE_LABS = [
  { naam: 'Janoshik', lijst: 'betrouwbaar', patronen: ['janoshik'] },
  { naam: 'Uzorak', lijst: 'betrouwbaar', patronen: ['uzorak'] },
  { naam: 'BT Lab Testing', lijst: 'betrouwbaar', patronen: ['btlabtesting', 'btlab'] },
  { naam: 'Sterigenix Analytical', lijst: 'betrouwbaar', patronen: ['sterigenix'] },
  { naam: 'Freedom Diagnostics', lijst: 'betrouwbaar', patronen: ['freedomdiagnostics', 'freedomdiagnostic'] },
  { naam: 'Vanguard Laboratory', lijst: 'betrouwbaar', patronen: ['vanguardlab', 'vanguardlaboratory'] },
  { naam: 'Chromate', lijst: 'betrouwbaar', patronen: ['chromate'] },
  { naam: 'Krause Labs', lijst: 'betrouwbaar', patronen: ['krause'] },
  { naam: 'Kovera Labs', lijst: 'nieuw', patronen: ['kovera'] },
  { naam: 'Brown Institute of Biomolecular Research', lijst: 'twijfel', patronen: ['browninstitute', 'brownbiomolecular'] },
  { naam: 'ILS Laboratories', lijst: 'twijfel', patronen: ['ilslab', 'ilslaboratories', 'ilslaboratory'] },
  { naam: 'Axiom Analytics', lijst: 'twijfel', patronen: ['axiomanalytics', 'axiom'] },
  { naam: 'Finnrick', lijst: 'twijfel', patronen: ['finnrick'] }
];

// De uitleesstap zet in het labveld alles wat er op het briefhoofd staat:
// "MZ Biolabs", "MZ Biolabs, 2102 N Country Club Rd, Tucson, AZ 85716" en
// een variant met e-mailadres en een markdown-link kwamen alle drie voorbij
// als aparte laboratoria. Daarom eerst terug naar de kale naam: markdown-
// links uitpakken en alles vanaf de eerste komma (adres, contactgegevens)
// weglaten.
function korteLabnaam(ruw) {
  let t = String(ruw || '');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.split(/[,;|\n]/)[0];
  t = t.replace(/\s+/g, ' ').trim().replace(/[.\-\u2013\u2014]+$/, '').trim();
  return t;
}

// Geeft naast de weergavenaam een groepeersleutel terug. Zonder die sleutel
// telt elke schrijfwijze als een eigen lab en klopt "bij hoeveel shops komt
// dit lab voor" simpelweg niet.
function normaliseerLab(ruw) {
  const kort = korteLabnaam(ruw);
  const plat = kort.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!plat) return { naam: 'onbekend', lijst: 'geen labnaam gelezen', sleutel: '' };
  for (const l of BEKENDE_LABS) {
    if (l.patronen.some((p) => plat.indexOf(p) !== -1)) {
      return { naam: l.naam, lijst: l.lijst, sleutel: l.naam.toLowerCase().replace(/[^a-z0-9]/g, '') };
    }
  }
  return { naam: kort, lijst: 'niet op de werklijst', sleutel: plat };
}

function klasseVan(rij) {
  const v = rij.verification;
  return (v && v.class) || rij.authenticity_class || null;
}

// Alle documenten met hun bronnen in een keer; de aantallen blijven klein
// (honderden), dus het groeperen gebeurt hier in JS. Dat houdt de
// labnormalisatie op een plek in plaats van in SQL.
async function crossSupplierOverview() {
  try {
    const { rows } = await pool.query(
      `SELECT d.sha256, d.lab, d.task_number, d.sample_number, d.authenticity_class,
              d.verification, d.first_analyzed_at,
              d.extraction->'coaRecords'->0->>'product'          AS product,
              d.extraction->'coaRecords'->0->>'batchnummer'      AS batchnummer,
              d.extraction->'coaRecords'->0->>'verificationKey'  AS sleutel,
              s.supplier_key, s.url, s.status
       FROM coa_documents d JOIN coa_sources s ON s.sha256 = d.sha256
       ORDER BY d.first_analyzed_at DESC NULLS LAST`
    );

    const docs = new Map();
    rows.forEach((r) => {
      let d = docs.get(r.sha256);
      if (!d) {
        const lab = normaliseerLab(r.lab);
        d = {
          sha256: r.sha256, product: r.product || null, batchnummer: r.batchnummer || null,
          lab: lab.naam, labRuw: r.lab || null, labLijst: lab.lijst, labSleutel: lab.sleutel,
          taskNumber: r.task_number || null, sampleNumber: r.sample_number || null,
          sleutel: r.sleutel || null, klasse: klasseVan(r), bronnen: []
        };
        docs.set(r.sha256, d);
      }
      if (!/^lab:/i.test(r.supplier_key || '')) d.bronnen.push({ supplierKey: r.supplier_key, url: r.url, status: r.status });
    });

    // Verwijzingen staan los van de documenten, maar horen in hetzelfde
    // overzicht: een shop die alleen doorlinkt naar het lab hoort onder dat
    // lab te staan, niet te ontbreken.
    const refRijen = await listReferences();
    const checkRijen = await listReferenceChecks();
    const checkOp = new Map();
    checkRijen.forEach((c) => {
      checkOp.set(normaliseerLab(c.lab).sleutel + '|' + String(c.referentie).toLowerCase(), {
        klasse: c.klasse, resolvet: c.resolvet, client: c.client, product: c.product,
        batchnummer: c.batchnummer, notitie: c.notitie, checkedBy: c.checked_by, checkedAt: c.checked_at,
        methode: c.methode || 'handmatig'
      });
    });
    const refs = refRijen.map((r) => {
      const lab = normaliseerLab(r.lab);
      return {
        leverancier: r.supplier_key, lab: lab.naam, labLijst: lab.lijst, labSleutel: lab.sleutel,
        referentie: r.referentie, taskNumber: r.task_number, sample: r.sample, sleutel: r.ref_key, url: r.url
      };
    });

    const alle = Array.from(docs.values());
    alle.forEach((d) => {
      d.leveranciers = Array.from(new Set(d.bronnen.map((b) => b.supplierKey))).sort();
    });

    // 1. Exact hetzelfde bestand bij meer dan een shop. Sterkste signaal:
    //    byte-voor-byte identiek, dus doorverkocht of gekopieerd bewijs.
    const gedeeldeDocumenten = alle
      .filter((d) => d.leveranciers.length > 1)
      .sort((a, b) => b.leveranciers.length - a.leveranciers.length);

    // 2. Zelfde task-/rapportnummer bij meer dan een shop, maar andere
    //    bestanden. Dat kan hergebruik zijn, maar ook een bewerkt document -
    //    dit hoort altijd met de hand bij het lab nagetrokken te worden.
    const perTask = new Map();
    alle.forEach((d) => {
      if (!d.taskNumber) return;
      const sleutel = d.labSleutel + '|' + String(d.taskNumber).trim().toLowerCase();
      if (!perTask.has(sleutel)) perTask.set(sleutel, { lab: d.lab, taskNumber: d.taskNumber, documenten: [] });
      perTask.get(sleutel).documenten.push(d);
    });
    const gedeeldeTasknummers = [];
    perTask.forEach((t) => {
      const leveranciers = Array.from(new Set(t.documenten.reduce((a, d) => a.concat(d.leveranciers), []))).sort();
      if (leveranciers.length < 2) return;
      gedeeldeTasknummers.push({
        lab: t.lab, taskNumber: t.taskNumber, leveranciers,
        bestanden: t.documenten.map((d) => ({ sha256: d.sha256, product: d.product, batchnummer: d.batchnummer })),
        identiek: t.documenten.length === 1
      });
    });
    gedeeldeTasknummers.sort((a, b) => b.leveranciers.length - a.leveranciers.length);

    // 2b. Zelfde labreferentie bij meer dan een shop. Dit is het sterkste
    //     signaal dat we zonder het lab zelf kunnen vaststellen: twee shops
    //     die publiekelijk naar exact hetzelfde labrapport wijzen.
    const perRef = new Map();
    refs.forEach((r) => {
      const k = r.labSleutel + '|' + r.referentie.toLowerCase();
      if (!perRef.has(k)) perRef.set(k, { lab: r.lab, labSleutel: r.labSleutel, referentie: r.referentie, taskNumber: r.taskNumber, sample: r.sample, leveranciers: new Set(), url: r.url });
      perRef.get(k).leveranciers.add(r.leverancier);
    });
    const gedeeldeReferenties = [];
    perRef.forEach((r) => {
      if (r.leveranciers.size < 2) return;
      gedeeldeReferenties.push({
        lab: r.lab, referentie: r.referentie, taskNumber: r.taskNumber, sample: r.sample,
        url: r.url, leveranciers: Array.from(r.leveranciers).sort(),
        controle: checkOp.get(r.labSleutel + '|' + r.referentie.toLowerCase()) || null
      });
    });
    gedeeldeReferenties.sort((a, b) => b.leveranciers.length - a.leveranciers.length);

    // 3. Per lab: welke shops wijzen ernaar, hoeveel documenten, hoeveel
    //    daarvan al met de hand geverifieerd. Dit is de lijst waarop je ziet
    //    waar een handmatige controle het meeste oplevert.
    const perLab = new Map();
    alle.forEach((d) => {
      if (!perLab.has(d.labSleutel)) perLab.set(d.labSleutel, { lab: d.lab, lijst: d.labLijst, leveranciers: new Set(), documenten: 0, geverifieerd: 0, labnamenRuw: new Set() });
      const l = perLab.get(d.labSleutel);
      d.leveranciers.forEach((s) => l.leveranciers.add(s));
      if (d.labRuw) l.labnamenRuw.add(d.labRuw);
      l.documenten += 1;
      if (d.klasse) l.geverifieerd += 1;
    });
    // Een shop die alleen doorlinkt heeft nul documenten bij dit lab, maar
    // hoort er wel bij te staan - anders verdwijnt juist de shop die het
    // netjes doet uit het overzicht.
    refs.forEach((r) => {
      if (!perLab.has(r.labSleutel)) perLab.set(r.labSleutel, { lab: r.lab, lijst: r.labLijst, leveranciers: new Set(), documenten: 0, geverifieerd: 0, labnamenRuw: new Set(), verwijzingen: 0 });
      const l = perLab.get(r.labSleutel);
      l.leveranciers.add(r.leverancier);
      l.verwijzingen = (l.verwijzingen || 0) + 1;
    });
    const labs = Array.from(perLab.values()).map((l) => ({
      lab: l.lab, lijst: l.lijst, labnamenRuw: Array.from(l.labnamenRuw),
      leveranciers: Array.from(l.leveranciers).sort(),
      aantalLeveranciers: l.leveranciers.size, documenten: l.documenten,
      verwijzingen: l.verwijzingen || 0, geverifieerd: l.geverifieerd
    })).sort((a, b) => b.aantalLeveranciers - a.aantalLeveranciers || b.documenten - a.documenten);

    const alleLeveranciers = new Set();
    alle.forEach((d) => d.leveranciers.forEach((s) => alleLeveranciers.add(s)));
    refs.forEach((r) => alleLeveranciers.add(r.leverancier));

    return {
      totalen: {
        leveranciers: alleLeveranciers.size,
        documenten: alle.length,
        geverifieerd: alle.filter((d) => d.klasse).length,
        gedeeldeDocumenten: gedeeldeDocumenten.length,
        gedeeldeTasknummers: gedeeldeTasknummers.length,
        verwijzingen: refs.length,
        gedeeldeReferenties: gedeeldeReferenties.length,
        referentiesGecontroleerd: checkRijen.length,
        // Diagnose: hoeveel documenten hebben uberhaupt de velden waarop het
        // kruisverband draait? Zonder deze cijfers is "0 gedeelde
        // task-nummers" niet te onderscheiden van "de uitleesstap leest geen
        // task-nummers" - het verschil tussen een bevinding en een meetfout.
        metLabnaam: alle.filter((d) => d.labRuw).length,
        metTasknummer: alle.filter((d) => d.taskNumber).length,
        metSleutel: alle.filter((d) => d.sleutel).length,
        metProduct: alle.filter((d) => d.product).length
      },
      // Per leverancier dezelfde diagnose, zodat zichtbaar is of het uitlezen
      // bij een bepaalde shop faalt of over de hele linie.
      perLeverancier: Array.from(alleLeveranciers).sort().map((sk) => {
        const mijne = alle.filter((d) => d.leveranciers.indexOf(sk) !== -1);
        return {
          leverancier: sk, documenten: mijne.length,
          metLabnaam: mijne.filter((d) => d.labRuw).length,
          metTasknummer: mijne.filter((d) => d.taskNumber).length,
          metSleutel: mijne.filter((d) => d.sleutel).length,
          verwijzingen: refs.filter((r) => r.leverancier === sk).length
        };
      }),
      labs, gedeeldeDocumenten, gedeeldeTasknummers, gedeeldeReferenties
    };
  } catch (e) {
    console.error('coaStore.crossSupplierOverview:', (e && e.message) || e);
    return { totalen: { leveranciers: 0, documenten: 0, geverifieerd: 0, gedeeldeDocumenten: 0, gedeeldeTasknummers: 0, metLabnaam: 0, metTasknummer: 0, metSleutel: 0, metProduct: 0, verwijzingen: 0, gedeeldeReferenties: 0, referentiesGecontroleerd: 0 }, perLeverancier: [], labs: [], gedeeldeDocumenten: [], gedeeldeTasknummers: [], gedeeldeReferenties: [] };
  }
}

// Bij welke andere leveranciers staat dit document nog meer? Bewust een losse
// functie: getDocumentsBySupplier draait ook in de pipeline en mag geen extra
// query per audit krijgen.
async function andereLeveranciersVoor(shaList) {
  const lijst = (shaList || []).filter(Boolean);
  if (!lijst.length) return {};
  try {
    const { rows } = await pool.query(
      'SELECT sha256, supplier_key FROM coa_sources WHERE sha256 = ANY($1::text[])', [lijst]
    );
    const uit = {};
    rows.forEach((r) => {
      if (!uit[r.sha256]) uit[r.sha256] = new Set();
      uit[r.sha256].add(r.supplier_key);
    });
    Object.keys(uit).forEach((k) => { uit[k] = Array.from(uit[k]).sort(); });
    return uit;
  } catch (e) {
    console.error('coaStore.andereLeveranciersVoor:', (e && e.message) || e);
    return {};
  }
}

module.exports = {
  leveranciersOverzicht,
  legOpdrachtgeverVast, lijktOpDomein,
  clientOordeel,
  referentiesVanLeverancier,
  testsoortDekking,
  referentieTotalen,
  initCoaSchema, supplierKeyFromUrl, sha256Of, checkUnchanged, recordObservation, publiekeBronVoorDocument,
  reconcileSupplierIndex, saveExtraction, getExtraction, supplierHistory, getSource, getDocument,
  saveVerification, getDocumentsBySupplier, listVerifiedDocumentsForSupplier,
  crossSupplierOverview, andereLeveranciersVoor, normaliseerLab,
  recordReferences, recordReferencesUitDocumenten, listReferences, saveReferenceCheck, listReferenceChecks, openstaandeReferenties,
  referentiesMetControle,
  referentieUitUrl
};
