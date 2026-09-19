// MCP-server voor handmatige COA-verificatie via chat (19 sep, naar aanleiding
// van "kunnen we dit ook in haar prive Claude doen"). Naast admin-coa.html:
// dezelfde drie bewerkingen (opzoeken, uploaden+uitlezen, verificatie
// vastleggen), nu als MCP-tools zodat een teamlid ze via een Claude-chat kan
// aanroepen (custom connector, remote MCP) in plaats van via de webpagina.
//
// BEWUST EEN APART TOKEN (COA_STAFF_TOKEN), NIET ADMIN_TOKEN:
// ADMIN_TOKEN geeft volledige toegang tot alle cases van alle leveranciers.
// Dit endpoint verwerkt door de gebruiker aangeleverde documenten en wordt
// aangeroepen door een AI-model — een kwaadaardig "COA"-bestand zou via
// prompt-injectie kunnen proberen extra acties te laten uitvoeren. Met een
// apart token kan zo'n poging hoogstens deze drie COA-tools misbruiken, nooit
// de rest van de API (case-data, andere leveranciers se persoonsgegevens, etc).
//
// De MCP SDK is ESM-only; deze backend draait als CommonJS (zie package.json
// "type": "commonjs"). Vandaar de dynamic import() hieronder, lazy en één
// keer gecached, in plaats van een top-level require().
const express = require('express');
const { z } = require('zod');
const coaStore = require('./coaStore');
const pipeline = require('./pipeline');
const { safeEqual } = require('./auth');

function requireStaffToken(req, res, next) {
  const configured = process.env.COA_STAFF_TOKEN;
  if (!configured) {
    return res.status(503).json({ error: 'niet_geconfigureerd', message: 'COA_STAFF_TOKEN is niet gezet op de server.' });
  }
  const header = req.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  const token = m ? m[1].trim() : null;
  if (!token || !safeEqual(token, configured)) {
    return res.status(401).json({ error: 'unauthorized', message: 'Ongeldig of ontbrekend token.' });
  }
  next();
}

function janoshikLinkFrom(task, sample, key) {
  if (!task || !key) return null;
  const ref = sample ? (task + '-' + sample + '_' + key) : (task + '_' + key);
  return 'https://verify.janoshik.com/tests/' + encodeURIComponent(ref);
}

async function buildServer() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'bedrijfchecker-coa-staff', version: '1.0.0' });

  server.registerTool(
    'zoek_leverancier_coas',
    {
      title: 'Zoek COA-documenten van een leverancier',
      description: 'Geeft alle bekende COA-documenten (automatisch gevonden via de site-crawl, en eerder handmatig geüpload) voor één leverancier, met hun huidige verificatiestatus. Gebruik dit eerst, voordat je iets nieuws uploadt, om te zien wat er al bekend of al geverifieerd is.',
      inputSchema: z.object({
        leverancierUrl: z.string().min(1).describe('Website of domein van de leverancier, bijv. peptidekoning.to')
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ leverancierUrl }) => {
      const supplierKey = coaStore.supplierKeyFromUrl(leverancierUrl);
      const docs = await coaStore.getDocumentsBySupplier(supplierKey);
      const summary = docs.length
        ? docs.map((d) => {
            const ext = (d.extraction && d.extraction.coaRecords && d.extraction.coaRecords[0]) || {};
            const bron = d.url && d.url.indexOf('admin-upload://') === 0 ? 'handmatig geüpload' : (d.url || 'onbekende bron');
            return '- ' + (ext.product || 'onbekend product') + ' — sha256 ' + d.sha256 + ' — ' + bron +
              (d.authenticity_class ? ' — klasse ' + d.authenticity_class : ' — nog niet geverifieerd') +
              (d.lab ? ' — lab: ' + d.lab : '') + (d.task_number ? ' — task ' + d.task_number : '');
          }).join('\n')
        : 'Nog geen documenten bekend voor deze leverancier.';
      return {
        content: [{ type: 'text', text: 'Leverancier-ID: ' + supplierKey + '\n\n' + summary }],
        structuredContent: { supplierKey, documents: docs }
      };
    }
  );

  server.registerTool(
    'upload_coa',
    {
      title: 'Upload en lees een COA uit',
      description: 'Slaat een door de gebruiker aangeleverd COA-document (PDF of afbeelding, als base64) op voor een leverancier en leest het uit met dezelfde AI-leesstap als de automatische controle. Geeft de gelezen velden terug (product, batchnummer, task/report-ID, verificatiesleutel, lab) als startpunt voor de handmatige labcontrole, plus het sha256 dat verifieer_coa nodig heeft. Kent zelf NOOIT een authenticiteitsklasse toe — die komt uitsluitend van de menselijke labcontrole via verifieer_coa.',
      inputSchema: z.object({
        leverancierUrl: z.string().min(1).describe('Website of domein van de leverancier'),
        naam: z.string().optional().describe('Naam van de leverancier voor in de leesprompt (optioneel, standaard het domein)'),
        bestandBase64: z.string().min(1).describe('De bytes van het document, base64-gecodeerd'),
        mediaType: z.string().min(1).describe('MIME-type, bijv. application/pdf of image/jpeg')
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ leverancierUrl, naam, bestandBase64, mediaType }) => {
      const supplierKey = coaStore.supplierKeyFromUrl(leverancierUrl);
      const buffer = Buffer.from(bestandBase64, 'base64');
      const sha256 = coaStore.sha256Of(buffer);
      const syntheticUrl = 'admin-upload://' + supplierKey + '/' + sha256;
      await coaStore.recordObservation({ url: syntheticUrl, supplierKey, buffer, mimetype: mediaType });
      let extraction = await coaStore.getExtraction(sha256, pipeline.COA_EXTRACTOR_VERSION);
      if (!extraction) {
        extraction = await pipeline.extractCoaFromUpload(naam || supplierKey, { data: bestandBase64, mediaType });
        const first = (extraction && extraction.coaRecords && extraction.coaRecords[0]) || {};
        await coaStore.saveExtraction(sha256, pipeline.COA_EXTRACTOR_VERSION, extraction || { coaRecords: [] }, {
          lab: first.laboratorium || null,
          taskNumber: first.reportId || null,
          keyHash: first.verificationKey ? coaStore.sha256Of(Buffer.from(String(first.verificationKey))) : null
        });
      }
      const first = (extraction && extraction.coaRecords && extraction.coaRecords[0]) || {};
      const janoshikLink = janoshikLinkFrom(first.reportId, null, first.verificationKey);
      return {
        content: [{ type: 'text', text: 'Uitgelezen. sha256: ' + sha256 +
          (janoshikLink ? ('\nMogelijke verificatielink (controleer task/sample/sleutel zelf, dit is een AI-lezing): ' + janoshikLink) : '\nGeen task-ID/sleutel herkend; vraag de gebruiker om deze uit het document zelf.') }],
        structuredContent: { supplierKey, sha256, extraction, janoshikLink }
      };
    }
  );

  server.registerTool(
    'verifieer_coa',
    {
      title: 'Leg een handmatige labverificatie vast',
      description: 'Bewaart de uitslag van een handmatige controle bij het lab (bijv. verify.janoshik.com) voor één specifiek document (sha256, uit zoek_leverancier_coas of upload_coa). Klasse D (referentie aanwezig maar resolvet niet) mag alleen worden vastgelegd na een echte, door een mens uitgevoerde controle in een browser — nooit als eigen inschatting van het model. Zodra dit is opgeslagen telt het automatisch mee in elk toekomstig rapport van deze leverancier.',
      inputSchema: z.object({
        sha256: z.string().min(32).describe('Het sha256 van het document'),
        klasse: z.enum(['A', 'B', 'C', 'D']).describe('A = resolvet + velden kloppen, B = resolvet + velden wijken af, C = geen bruikbare referentie, D = referentie aanwezig maar resolvet niet'),
        lab: z.string().optional(),
        task: z.string().optional(),
        sample: z.string().optional(),
        key: z.string().optional(),
        resolvedUrl: z.string().optional().describe('De uiteindelijke URL die geopend en gecontroleerd is'),
        notitie: z.string().optional().describe('Wat er op de verificatiepagina te zien was'),
        gecontroleerdDoor: z.string().min(1).describe('Naam van de persoon die de controle heeft uitgevoerd')
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ sha256, klasse, lab, task, sample, key, resolvedUrl, notitie, gecontroleerdDoor }) => {
      const verification = {
        class: klasse, method: 'janoshik', lab: lab || null, task: task || null, sample: sample || null,
        key: key || null, resolvedUrl: resolvedUrl || null, note: notitie || null,
        checkedBy: gecontroleerdDoor, checkedAt: Date.now()
      };
      await coaStore.saveVerification(sha256, verification);
      return {
        content: [{ type: 'text', text: 'Verificatie opgeslagen: klasse ' + klasse + ' door ' + gecontroleerdDoor + '. Telt vanaf nu mee in rapporten van deze leverancier.' }],
        structuredContent: { sha256, verification }
      };
    }
  );

  return server;
}

let serverPromise = null;
function getServer() {
  if (!serverPromise) serverPromise = buildServer();
  return serverPromise;
}

let transportClassPromise = null;
function getTransportClass() {
  if (!transportClassPromise) {
    transportClassPromise = import('@modelcontextprotocol/sdk/server/streamableHttp.js')
      .then((mod) => mod.StreamableHTTPServerTransport);
  }
  return transportClassPromise;
}

// Registreert POST /mcp. Wordt in server.js VOOR de globale
// express.json({limit:'2mb'}) gemount, met een eigen, ruimere limiet — een
// base64-gecodeerd PDF is al gauw een derde groter dan het bestand zelf.
function mount(app) {
  app.post('/mcp', requireStaffToken, express.json({ limit: '25mb' }), async (req, res) => {
    try {
      const [server, TransportClass] = await Promise.all([getServer(), getTransportClass()]);
      const transport = new TransportClass({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('mcpCoaServer:', (e && e.message) || e);
      if (!res.headersSent) res.status(500).json({ error: 'mcp_fout' });
    }
  });
}

module.exports = { mount };
