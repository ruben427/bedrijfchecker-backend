// Postgres-laag — vervangt de Artifact's `db`-capability (window.claude.use('db')).
// Eén tabel `cases` met JSONB-kolommen die de vorm van het oude case-document
// zo veel mogelijk volgen, plus `stats` voor de gemiddelde stapduur.

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      naam TEXT,
      website TEXT,
      land TEXT,
      kvk_nummer TEXT,
      notities TEXT,
      status TEXT NOT NULL DEFAULT 'bezig',
      error TEXT,
      current_step JSONB,
      progress JSONB NOT NULL DEFAULT '[]',
      phase_data JSONB NOT NULL DEFAULT '{}',
      category_assessments JSONB,
      adequacy JSONB,
      engine_result JSONB,
      report JSONB,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stats (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
  `);
  // Geüploade brondocumenten (bv. een KvK-uittreksel als PDF) blijven hier
  // persistent bewaard — voorheen werden uploads alleen transiet gebruikt
  // tijdens de audit-run en daarna nergens opgeslagen.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'overig',
      filename TEXT,
      mimetype TEXT,
      size_bytes INTEGER,
      data BYTEA NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS documents_case_id_idx ON documents (case_id);`);
}

function rowToCase(row) {
  if (!row) return null;
  return {
    id: row.id,
    naam: row.naam,
    website: row.website,
    land: row.land,
    kvkNummer: row.kvk_nummer,
    notities: row.notities,
    status: row.status,
    error: row.error,
    currentStep: row.current_step,
    progress: row.progress || [],
    phaseData: row.phase_data || {},
    categoryAssessments: row.category_assessments,
    adequacy: row.adequacy,
    engineResult: row.engine_result,
    report: row.report,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

async function createCase(id, fields) {
  const now = Date.now();
  await pool.query(
    `INSERT INTO cases (id, naam, website, land, kvk_nummer, notities, status, progress, phase_data, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'bezig','[]','{}',$7,$7)`,
    [id, fields.naam || fields.website, fields.website, fields.land || null, fields.kvkNummer || null, fields.notities || null, now]
  );
  return getCase(id);
}

async function getCase(id) {
  const { rows } = await pool.query('SELECT * FROM cases WHERE id = $1', [id]);
  return rowToCase(rows[0]);
}

async function listCases() {
  const { rows } = await pool.query('SELECT * FROM cases ORDER BY created_at DESC LIMIT 200');
  return rows.map(rowToCase);
}

// Generieke patch-update: alleen de meegegeven velden worden overschreven,
// net als de .update() van de Artifact's db-capability.
const FIELD_COLUMN = {
  naam: 'naam', website: 'website', land: 'land', kvkNummer: 'kvk_nummer', notities: 'notities',
  status: 'status', error: 'error', currentStep: 'current_step', progress: 'progress',
  categoryAssessments: 'category_assessments', adequacy: 'adequacy', engineResult: 'engine_result', report: 'report'
};
async function updateCase(id, patch) {
  const sets = ['updated_at = $1'];
  const values = [Date.now()];
  let i = 2;
  Object.keys(patch).forEach((key) => {
    if (key === 'updatedAt') return;
    const col = FIELD_COLUMN[key];
    if (!col) return;
    const jsonCols = ['current_step', 'progress', 'category_assessments', 'adequacy', 'engine_result', 'report'];
    sets.push(`${col} = $${i}`);
    values.push(jsonCols.includes(col) ? JSON.stringify(patch[key]) : patch[key]);
    i++;
  });
  values.push(id);
  await pool.query(`UPDATE cases SET ${sets.join(', ')} WHERE id = $${i}`, values);
  return getCase(id);
}

// phaseData is een JSONB-object; deze merget één key erin i.p.v. het geheel
// te vervangen (zoals de Artifact's caseRef(id).update({phaseData:{key:...}}) deed).
async function mergePhaseData(id, key, value) {
  await pool.query(
    `UPDATE cases SET phase_data = jsonb_set(COALESCE(phase_data, '{}'::jsonb), $2, $3::jsonb, true), updated_at = $4 WHERE id = $1`,
    [id, `{${key}}`, JSON.stringify(value), Date.now()]
  );
}

async function getStepStats() {
  const { rows } = await pool.query("SELECT value FROM stats WHERE key = 'stepDurations'");
  return (rows[0] && rows[0].value) || {};
}
async function updateStepStats(key, durationMs) {
  try {
    const all = await getStepStats();
    const cur = all[key] || { avgMs: durationMs, count: 0 };
    const count = cur.count + 1;
    const avgMs = Math.round((cur.avgMs * cur.count + durationMs) / count);
    all[key] = { avgMs, count };
    await pool.query(
      `INSERT INTO stats (key, value) VALUES ('stepDurations', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify(all)]
    );
  } catch (e) { /* stats zijn best-effort, zoals in de Artifact */ }
}

// Documenten: metadata + bytes apart ophaalbaar, zodat een lijstje tonen
// (GET .../documents) niet meteen alle bestandsbytes over de lijn hoeft te sturen.
async function addDocument(id, caseId, fields) {
  const now = Date.now();
  await pool.query(
    `INSERT INTO documents (id, case_id, kind, filename, mimetype, size_bytes, data, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, caseId, fields.kind || 'overig', fields.filename || null, fields.mimetype || null, fields.buffer ? fields.buffer.length : 0, fields.buffer, now]
  );
}
async function listDocuments(caseId) {
  const { rows } = await pool.query(
    'SELECT id, kind, filename, mimetype, size_bytes, created_at FROM documents WHERE case_id = $1 ORDER BY created_at ASC',
    [caseId]
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, filename: r.filename, mimetype: r.mimetype, sizeBytes: r.size_bytes, createdAt: Number(r.created_at) }));
}
async function getDocument(id) {
  const { rows } = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, caseId: r.case_id, kind: r.kind, filename: r.filename, mimetype: r.mimetype, sizeBytes: r.size_bytes, data: r.data, createdAt: Number(r.created_at) };
}
// Handig voor de pipeline: het meest recente document van een bepaalde soort
// (bv. 'kvk'), als base64 klaar om naar Claude te sturen.
async function getLatestDocumentByKind(caseId, kind) {
  const { rows } = await pool.query(
    'SELECT * FROM documents WHERE case_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 1',
    [caseId, kind]
  );
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, filename: r.filename, mimetype: r.mimetype, data: r.data.toString('base64') };
}

module.exports = {
  pool, initSchema, createCase, getCase, listCases, updateCase, mergePhaseData, getStepStats, updateStepStats,
  addDocument, listDocuments, getDocument, getLatestDocumentByKind
};
