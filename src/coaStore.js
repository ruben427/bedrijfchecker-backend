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

module.exports = {
  initCoaSchema, supplierKeyFromUrl, sha256Of, checkUnchanged, recordObservation,
  reconcileSupplierIndex, saveExtraction, getExtraction, supplierHistory, getSource, getDocument
};
