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
const teksten = require('./teksten');
const db = require('./db');
const pipeline = require('./pipeline');
const { safeEqual } = require('./auth');

// --- twee rollen, twee tokens ----------------------------------------------
//
// Tot 22 september was er een token en kon iedereen alles: ook COA's uploaden
// en resolverruns starten. Aan de HTTP-kant bestaat dat onderscheid al wel -
// daar is een apart leestoken, juist om de beoordelaar niet alles te geven -
// maar aan deze kant niet.
//
// REDACTIE is de rol van de beoordelaar: kijken, oordelen over labs en
// naamkoppelingen, en teksten redigeren. Dat zijn allemaal uitspraken, en
// uitspraken horen bij haar. Wat er NIET in zit is het binnenhalen en
// verifieren van bewijs: uploaden, resolveren, signalen afvinken. Dat is
// beheer van de pijplijn, en dat is een andere verantwoordelijkheid.
//
// De rol bepaalt ook de TOOLLIJST, niet alleen of een aanroep lukt. Een tool
// tonen die je vervolgens niet mag gebruiken is een uitnodiging tot een
// foutmelding.
const REDACTIE_TOOLS = [
  'zoek_leverancier_coas', 'zoek_labreferenties', 'nieuwe_signalen',
  'toon_laboratoria', 'toon_leveranciers', 'toon_naamkoppelingen', 'toon_rapport',
  'beoordeel_laboratorium', 'beoordeel_naamkoppeling',
  'geef_tekstfeedback', 'verklaar_tekst', 'open_tekstoordelen', 'schrijfregels'
];

function rolVanToken(req) {
  const staf = process.env.COA_STAFF_TOKEN;
  const redactie = process.env.COA_REDACTIE_TOKEN;
  const header = req.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  const token = m ? m[1].trim() : null;
  if (!token) return null;
  if (staf && safeEqual(token, staf)) return 'staf';
  if (redactie && safeEqual(token, redactie)) return 'redactie';
  return null;
}

function requireStaffToken(req, res, next) {
  if (!process.env.COA_STAFF_TOKEN) {
    return res.status(503).json({ error: 'niet_geconfigureerd', message: 'COA_STAFF_TOKEN is niet gezet op de server.' });
  }
  const rol = rolVanToken(req);
  if (!rol) {
    return res.status(401).json({ error: 'unauthorized', message: 'Ongeldig of ontbrekend token.' });
  }
  req.mcpRol = rol;
  next();
}

function janoshikLinkFrom(task, sample, key) {
  if (!task || !key) return null;
  const ref = sample ? (task + '-' + sample + '_' + key) : (task + '_' + key);
  return 'https://verify.janoshik.com/tests/' + encodeURIComponent(ref);
}

async function buildServer(rol) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'bedrijfchecker-coa-' + (rol || 'staf'), version: '1.1.0' });

  // De rolfilter zit op registerTool zelf, niet bij elke tool apart. Dertien
  // keer dezelfde controle overschrijven is dertien plekken om er een te
  // vergeten, en vergeten betekent hier dat iemand meer mag dan de bedoeling.
  if (rol === 'redactie') {
    const origineel = server.registerTool.bind(server);
    server.registerTool = function (naam) {
      if (REDACTIE_TOOLS.indexOf(naam) === -1) return null;
      return origineel.apply(server, arguments);
    };
  }

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
        klasse: z.enum(['A', 'B', 'C', 'D']).describe('HERZIEN 22 SEPTEMBER, BESLUIT A15b. De klasse gaat over de authenticiteit van het OORSPRONKELIJKE LABRAPPORT, niet over de kopie die de shop toont. A = de referentie lost rechtstreeks bij het lab op en geeft een geldig rapport terug. Dat blijft A, ook als velden op de kopie van de shop afwijken. B = authentiek met sterke verificatie, maar niet rechtstreeks bij het lab bevestigd. B is NIET meer de stand voor afwijkende velden. C = geen bruikbare referentie. D = referentie aanwezig maar lost niet op. Wijkt de kopie van de shop af, zet dat dan in kopieShop en bijLab: de server bepaalt zelf of dat schrijfwijze, een afwijkend meetresultaat of een koppelingsprobleem is.'),
        lab: z.string().optional(),
        task: z.string().optional(),
        sample: z.string().optional(),
        key: z.string().optional(),
        resolvedUrl: z.string().optional().describe('De uiteindelijke URL die geopend en gecontroleerd is'),
        client: z.string().optional().describe('De opdrachtgever zoals het labrapport die letterlijk noemt'),
        manufacturer: z.string().optional().describe('De fabrikant zoals het labrapport die letterlijk noemt. Kan afwijken van client - juist dat verschil is een waarneming.'),
        batchnummer: z.string().optional().describe('Het batch- of lotnummer zoals het lab het noemt. Eigen kolom: niet in de notitie.'),
        zuiverheid: z.string().optional().describe('De zuiverheid letterlijk zoals hij op de pagina staat, bijvoorbeeld "99.14%".'),
        vulling: z.string().optional().describe('Gemeten tegenover geclaimd, letterlijk, bijvoorbeeld "10.6 mg / 10 mg".'),
        gemetenMg: z.number().optional(),
        etiketMg: z.number().optional(),
        datumAnalyse: z.string().optional().describe('Analysedatum als JJJJ-MM-DD'),
        kopieShop: z.object({
          client: z.string().optional(), manufacturer: z.string().optional(),
          batchnummer: z.string().optional(), product: z.string().optional(),
          purityPercent: z.number().optional(), orderDate: z.string().optional(),
          receivedDate: z.string().optional(), analysisDate: z.string().optional()
        }).optional().describe('Wat er op de KOPIE bij de shop staat. Alleen de velden invullen die je daar echt hebt gezien; een veld dat je niet hebt gecontroleerd laat je weg.'),
        bijLab: z.object({
          client: z.string().optional(), manufacturer: z.string().optional(),
          batchnummer: z.string().optional(), product: z.string().optional(),
          purityPercent: z.number().optional(), orderDate: z.string().optional(),
          receivedDate: z.string().optional(), analysisDate: z.string().optional()
        }).optional().describe('Wat er op de pagina van het LAB staat, dezelfde velden. Het vergelijken doet de server: een veld dat aan een kant ontbreekt telt als niet-vergeleken, nooit als verschil. Zet verschillen dus HIER neer, niet in woorden in de notitie - uit proza kan later geen classificatie worden afgeleid.'),
        notitie: z.string().optional().describe('Wat er VERDER op de verificatiepagina te zien was. Batch, zuiverheid, vulling, client en fabrikant horen hier niet in - die hebben een eigen veld.'),
        gecontroleerdDoor: z.string().min(1).describe('Naam van de persoon die de controle heeft uitgevoerd')
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (a) => {
      const { sha256, klasse, lab, task, sample, key, resolvedUrl, notitie, gecontroleerdDoor } = a;
      const verification = {
        class: klasse, method: 'janoshik', lab: lab || null, task: task || null, sample: sample || null,
        key: key || null, resolvedUrl: resolvedUrl || null, note: notitie || null,
        client: a.client || null, manufacturer: a.manufacturer || null, batchnummer: a.batchnummer || null,
        zuiverheid: a.zuiverheid || null, vulling: a.vulling || null,
        gemetenMg: a.gemetenMg, etiketMg: a.etiketMg, datumAnalyse: a.datumAnalyse || null,
        kopieShop: a.kopieShop || null, bijLab: a.bijLab || null,
        checkedBy: gecontroleerdDoor, checkedAt: Date.now()
      };
      await coaStore.saveVerification(sha256, verification);
      return {
        content: [{ type: 'text', text: 'Verificatie opgeslagen: klasse ' + klasse + ' door ' + gecontroleerdDoor + '. Telt vanaf nu mee in rapporten van deze leverancier.' }],
        structuredContent: { sha256, verification }
      };
    }
  );

  // Vierde tool, 19 sep. Aanleiding: astralabs en pyroxlabs bleken 55
  // identieke Janoshik-referenties te publiceren. Die referenties hebben geen
  // bestand, dus verifieer_coa (dat op sha256 werkt) kon er niets mee.
  server.registerTool(
    'verifieer_labreferentie',
    {
      title: 'Leg vast wat je op de verificatiepagina van het lab zag',
      description: 'Bewaart het resultaat van een handmatige controle van een labreferentie (een link als https://verify.janoshik.com/tests/221439-reta20_RE200804_P3C3N2UBW4YL). Gebruik dit nadat je die pagina ZELF in een browser hebt geopend. Het belangrijkste veld is client: de opdrachtgever zoals het lab die noemt - staat daar de shop zelf of een derde partij? De controle hangt aan de referentie, niet aan een shop, en telt dus meteen voor elke shop die naar hetzelfde rapport verwijst. Vul nooit iets in wat je niet met eigen ogen op die pagina hebt gezien; klasse D (referentie bestaat maar lost niet op) mag alleen na een echte controle.',
      inputSchema: z.object({
        referentie: z.string().min(3).describe('De referentie of de volledige verificatie-URL'),
        lab: z.string().optional().describe('Standaard Janoshik'),
        resolvet: z.boolean().describe('Gaf de pagina een echt rapport terug? true of false'),
        klasse: z.enum(['A', 'B', 'C', 'D']).optional().describe('ALLEEN invullen als er een kopie van de shop naast het labrapport ligt en je vergelekenMet meegeeft - een klasse op een kale referentie zegt niets. BESLIST OP 22 SEPTEMBER (A15b): de klasse gaat over de authenticiteit van het OORSPRONKELIJKE LABRAPPORT, niet over wat de shop eromheen publiceert. A = de referentie lost rechtstreeks bij het lab op en geeft een geldig rapport terug - ook als de kopie van de shop afwijkt. B = authentiek met sterke verificatie, maar niet rechtstreeks bij het lab bevestigd. C = geen bruikbare referentie. D = referentie aanwezig maar lost niet op. Een afwijking tussen shopkopie en labrapport hoort NIET in deze letter: vul kopieShop en bijLab in, dan bepaalt de server of het schrijfwijze is (geen gevolg), een afwijkend meetresultaat (de labwaarde is leidend) of een verschil in batch, lot of product (de koppeling gaat omlaag).'),
        client: z.string().optional().describe('De opdrachtgever zoals letterlijk op het rapport vermeld'),
        product: z.string().optional(),
        testnaam: z.string().optional().describe('Hoe het LAB de test noemt, letterlijk overgetypt van de verificatiepagina - bijvoorbeeld "Sterility testing (TAMC+TYMC)" of "Assessment of a peptide vial or vials". Overtypen, niet samenvatten. Dit staat los van wat de shop de test noemt in zijn linktekst; juist het verschil daartussen is een waarneming, dus het een overschrijft het ander niet.'),
        testsoorten: z.array(z.enum(['zware metalen', 'endotoxinen', 'steriliteit', 'identiteit', 'oplosmiddelresten', 'watergehalte', 'tfa', 'ph', 'gehalte', 'zuiverheid']))
          .optional().describe('Wat er in dit rapport daadwerkelijk is gemeten, uit de vaste lijst. Meerdere mag: een rapport meet vaak meer dan een ding. Leeg laten kan - dan wordt het uit testnaam afgeleid. LET OP: een steriliteitstest is GEEN zuiverheidstest. Als hier steriliteit staat en geen zuiverheid, horen zuiverheid en vulling leeg te blijven; die zijn dan niet gemeten, niet slecht.'),
        batchnummer: z.string().optional().describe('Het batch- of lotnummer zoals het lab het noemt. Heeft een eigen kolom: niet in de notitie zetten.'),
        zuiverheid: z.string().optional().describe('De zuiverheid letterlijk zoals hij op de pagina staat, bijvoorbeeld "99.14%". Overtypen wat er staat; het percentage wordt er zelf uit afgeleid.'),
        vulling: z.string().optional().describe('De gemeten hoeveelheid tegenover de geclaimde, letterlijk zoals het er staat, bijvoorbeeld "10.6 mg / 10 mg". Gemeten en etiket worden hieruit afgeleid als je ze niet los meegeeft.'),
        gemetenMg: z.number().optional().describe('De gemeten hoeveelheid in mg. Alleen invullen als je het cijfer zelf hebt gezien.'),
        vialen: z.array(z.object({
          gemetenMg: z.number().optional(),
          purityPercent: z.number().optional()
        })).optional().describe('Alleen als het rapport HETZELFDE product in meerdere vialen meet, bijvoorbeeld "25.29 mg; 25.19 mg; 25.41 mg" met "99.829%; 99.810%; 99.795%". Elke viaal apart. Niet verwarren met componenten: dat zijn verschillende stoffen in een vial, dit is een stof in meerdere vialen. Middel niet zelf - de spreiding tussen vialen is zelf een waarneming, en de server rekent het gemiddelde en het bereik uit.'),
        componenten: z.array(z.object({
          stof: z.string().describe('De stofnaam zoals het rapport hem noemt'),
          gemetenMg: z.number().optional(),
          geclaimdMg: z.number().optional().describe('Alleen als het rapport of de shop per stof een claim noemt. Meestal leeg: bij "Glow 70mg" staat nergens wat die 70 per stof claimt.'),
          metaalcomplex: z.object({
            metaal: z.string().optional(), totaalMg: z.number().optional(),
            peptideMg: z.number().optional(), metaalMg: z.number().optional()
          }).optional()
        })).optional().describe('Alleen bij blends: een vial met meer dan een stof, zoals GLOW of KLOW. Neem elke regel van het rapport over als eigen component. Is een component zelf een metaalcomplex, zet het complex dan BIJ DIE COMPONENT. Niet optellen tot een totaal - dat gebeurt verderop, en alleen als duidelijk is wat het etiket claimt.'),
        metaalcomplex: z.object({
          metaal: z.string().optional().describe('Bijvoorbeeld koper'),
          totaalMg: z.number().optional().describe('Het totaal van het complex, bijvoorbeeld 61.77'),
          peptideMg: z.number().optional().describe('Het peptidegehalte, bijvoorbeeld 51.71'),
          metaalMg: z.number().optional().describe('Het metaalgehalte, bijvoorbeeld 10.06')
        }).optional().describe('Alleen bij peptiden die als metaalcomplex worden geleverd, zoals GHK-Cu. Het rapport toont dan drie getallen: totaal (peptidegehalte) [metaalgehalte]. Neem ze alle drie over. Er wordt dan GEEN vulling berekend - welke van de twee getallen het etiket claimt staat er zelden bij, en het verschil is groot.'),
        etiketMg: z.number().optional().describe('De hoeveelheid die het etiket claimt, in mg.'),
        manufacturer: z.string().optional().describe('De fabrikant zoals het labrapport die letterlijk noemt. Staat los van client: die twee kunnen verschillen en juist dat verschil is een waarneming.'),
        datumAnalyse: z.string().optional().describe('De analysedatum van het rapport, als JJJJ-MM-DD.'),
        kopieShop: z.object({
          client: z.string().optional(), manufacturer: z.string().optional(),
          batchnummer: z.string().optional(), product: z.string().optional(),
          purityPercent: z.number().optional(), orderDate: z.string().optional(),
          receivedDate: z.string().optional(), analysisDate: z.string().optional()
        }).optional().describe('Wat er op de KOPIE bij de shop staat. Alleen de velden invullen die je daar echt hebt gezien; een veld dat je niet hebt gecontroleerd laat je weg.'),
        bijLab: z.object({
          client: z.string().optional(), manufacturer: z.string().optional(),
          batchnummer: z.string().optional(), product: z.string().optional(),
          purityPercent: z.number().optional(), orderDate: z.string().optional(),
          receivedDate: z.string().optional(), analysisDate: z.string().optional()
        }).optional().describe('Wat er op de pagina van het LAB staat, dezelfde velden. Het vergelijken doet de server: een veld dat aan een kant ontbreekt telt als niet-vergeleken, nooit als verschil. Zet verschillen dus HIER neer, niet in woorden in de notitie - uit proza kan later geen classificatie worden afgeleid.'),
        vergelekenMet: z.string().optional().describe('VERPLICHT zodra je een klasse geeft: waartegen is het labrapport afgezet? De URL van de kopie op de site van de shop, of het sha256 van het document. Zonder dit is later niet na te gaan waar een A op rust.'),
        notitie: z.string().optional().describe('Wat er VERDER op de pagina te zien was. Batch, zuiverheid en vulling horen hier niet in - die hebben een eigen veld.'),
        gecontroleerdDoor: z.string().min(1).describe('Naam van de persoon die de controle heeft uitgevoerd')
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (a) => {
      const { referentie, lab, resolvet, klasse, client, product, batchnummer, zuiverheid, vulling, notitie, gecontroleerdDoor } = a;
      if (klasse && !a.vergelekenMet) {
        return { content: [{ type: 'text', text: 'Geen klasse vastgelegd: bij een klasse hoort vergelekenMet (de URL van de kopie bij de shop, of het sha256 van het document). Zonder die verwijzing rust de klasse nergens op. Leg de waarnemingen vast zonder klasse, of vul vergelekenMet aan.' }], isError: true };
      }
      const p = require('./janoshik').parseReferentie(referentie);
      const ref = p ? p.referentie : String(referentie).trim();
      const opgeslagen = await coaStore.saveReferenceCheck(lab || 'Janoshik', ref, {
        taskNumber: p ? p.taskNumber : null,
        resolvet, klasse: klasse || null, client: client || null,
        product: product || null, batchnummer: batchnummer || null,
        testnaam: a.testnaam || null, testsoorten: a.testsoorten || null,
        zuiverheid: zuiverheid || null, vulling: vulling || null,
        gemetenMg: a.gemetenMg, etiketMg: a.etiketMg, metaalcomplex: a.metaalcomplex || null,
        componenten: a.componenten || null, vialen: a.vialen || null,
        manufacturer: a.manufacturer || null, datumAnalyse: a.datumAnalyse || null,
        vergelekenMet: a.vergelekenMet || null,
        kopieShop: a.kopieShop || null, bijLab: a.bijLab || null,
        resolvedUrl: /^https?:\/\//i.test(String(referentie)) ? String(referentie) : janoshikLinkFrom(p && p.taskNumber, p && p.sample, p && p.key),
        notitie: notitie || null, checkedBy: gecontroleerdDoor
      });
      return {
        content: [{ type: 'text', text: opgeslagen
          ? ('Vastgelegd voor ' + ref + (client ? (' - opdrachtgever: ' + client) : '') + '. Dit telt voor elke shop die naar dit rapport verwijst.')
          : 'Opslaan mislukt.' }],
        structuredContent: { referentie: ref, opgeslagen: !!opgeslagen }
      };
    }
  );

  // Vijfde tool, 20 september. Aanleiding: de chatroute kon labreferenties wel
  // vastleggen maar niet teruglezen. Zonder leestool weet niemand of een
  // referentie al gecontroleerd is, en wordt hetzelfde rapport twee keer met
  // de hand geopend.
  server.registerTool(
    'zoek_labreferenties',
    {
      title: 'Bekijk de labreferenties van een leverancier',
      description: 'Geeft alle labverwijzingen (links naar verify.janoshik.com en vergelijkbare labpaginas) die bij een leverancier bekend zijn, met per stuk of er al een controle op zit en wat daaruit kwam. Werkt ook voor een partij die zelf geen webshop is maar wel als opdrachtgever op rapporten staat, zoals een fabrikant achter meerdere shops: het veld relatie zegt of deze partij het rapport TOONT of er de OPDRACHTGEVER van is. Gebruik dit VOORDAT je iets handmatig gaat controleren: dan weet je welke nog open staan en werk je niets dubbel. Let op het veld testsoort - sommige shops splitsen per batch in losse rapporten voor zuiverheid, zware metalen en endotoxinen.',
      inputSchema: z.object({
        leverancierUrl: z.string().min(1).describe('Website of domein van de leverancier, bijv. omegapeptides.eu'),
        alleenOpenstaand: z.boolean().optional().describe('Alleen de referenties zonder controle teruggeven'),
        max: z.number().optional().describe('Maximum aantal (standaard 200)')
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ leverancierUrl, alleenOpenstaand, max }) => {
      const supplierKey = coaStore.supplierKeyFromUrl(leverancierUrl);
      const alle = await coaStore.referentiesVanLeverancier(supplierKey, max);
      const rijen = alleenOpenstaand ? alle.filter((r) => !r.controle) : alle;
      const perSoort = {};
      alle.forEach((r) => { const k = r.testsoort || '(niet benoemd)'; perSoort[k] = (perSoort[k] || 0) + 1; });
      const gecontroleerd = alle.filter((r) => r.controle).length;
      const kop = 'Leverancier-ID: ' + supplierKey + '\n' +
        alle.length + ' labverwijzingen, ' + gecontroleerd + ' gecontroleerd, ' +
        (alle.length - gecontroleerd) + ' open.\n' +
        'Per testsoort: ' + (Object.keys(perSoort).length
          ? Object.keys(perSoort).map((k) => k + ' ' + perSoort[k]).join(', ')
          : 'geen') + '\n';
      const lijst = rijen.length
        ? rijen.slice(0, 60).map((r) => {
            const c = r.controle;
            const oordeel = (c && c.client) ? coaStore.wieBesteldeDeTest(c.client, [supplierKey]) : null;
            return '- ' + r.referentie + (r.testsoort ? ' [' + r.testsoort + ']' : '') +
              (r.relatie === 'opdrachtgever' ? ' (op naam van deze partij, zij tonen hem niet zelf)' : '') +
              (c
                ? (' — gecontroleerd door ' + (c.checkedBy || '?') +
                   (c.client ? ', opdrachtgever: ' + c.client +
                     (oordeel ? (oordeel.derdePartij ? ' (DERDE PARTIJ - niet deze shop)' : ' (de shop zelf)') : '') : '') +
                   (c.klasse ? ', klasse ' + c.klasse : ', geen klasse') +
                   (c.veldenAfwijkend ? ', ' + c.veldenAfwijkend + ' veld(en) wijken af' : ''))
                : ' — nog niet gecontroleerd') +
              '\n  ' + r.url;
          }).join('\n')
        : 'Geen verwijzingen die aan het filter voldoen.';
      return {
        content: [{ type: 'text', text: kop + '\n' + lijst }],
        structuredContent: { supplierKey, totaal: alle.length, gecontroleerd, perSoort, referenties: rijen }
      };
    }
  );

  // Zesde tool, 20 september. Aanleiding: peptidekliniek.nl verwijst naar
  // "RC Testing" met een referentienummer, maar dat laboratorium bestaat niet.
  // Nagetrokken bij de KvK en elders - onderzoekswerk dat geen enkele
  // heuristiek kan doen.
  server.registerTool(
    'beoordeel_laboratorium',
    {
      title: 'Leg vast wat je over een laboratorium hebt vastgesteld',
      description: 'Bewaart een MENSELIJK oordeel over een laboratorium: bestaat het, is het onafhankelijk van de leverancier, of weten we het niet. Gebruik dit alleen na echt onderzoek - kamer van koophandel, domeinregistratie, adres, wie de site beheert - en zet je bronnen erbij. Zodra dit is vastgelegd erft ELKE leverancier die naar dit lab verwijst de bevinding, dus een oordeel "bestaat niet" is zwaar: het maakt elk certificaat dat ernaar wijst waardeloos, hoe echt het er ook uitziet. Vermoeden is geen vaststelling: gebruik dan status onbekend en schrijf in de onderbouwing wat je wel en niet hebt kunnen nagaan.',
      inputSchema: z.object({
        lab: z.string().min(2).describe('De naam van het laboratorium zoals hij op de certificaten staat, bijvoorbeeld "RC Testing"'),
        status: z.enum(coaStore.LAB_STATUSSEN).describe('erkend = bestaand, onafhankelijk lab; bewijs telt mee. niet bereikbaar voor ons = het lab is aantoonbaar echt maar laat onze server niet toe (zoals Janoshik met Cloudflare); dat zegt NIETS over het lab of de leverancier, alleen dat wij de rapporten niet zelf kunnen ophalen - een mens die de referentie natrekt tilt hem alsnog naar geverifieerd. onvoldoende verifieerbaar = je hebt gezocht en gevraagd maar kon het lab niet onafhankelijk bevestigen - dit is de stand voor het gewone geval, en hij zegt NIET dat het lab vals is. niet onafhankelijk = bestaat wel maar hoort bij de leverancier of een verbonden partij. bestaat niet = je hebt VASTGESTELD dat het niet bestaat, met bronnen; gebruik dit alleen als je dat echt kunt onderbouwen. geen lab - databron/testplatform = dit is helemaal geen analytisch laboratorium maar een databank of platform dat monsters door externe labs laat testen, zoals Finnrick. Dat is geen oordeel over de kwaliteit: de bewijswaarde komt dan van het lab dat de analyse echt heeft uitgevoerd, en is dat niet te achterhalen, dan levert het rapport geen labbewijs op. LET OP: een COA die er plausibel uitziet is niet hetzelfde als een COA die onafhankelijk geverifieerd is. Bij alles behalve erkend blijven identity, purity en quantity die uitsluitend op dat rapport rusten ONBEVESTIGD - niet weerlegd, wel onbevestigd.'),
        onderbouwing: z.string().min(10).describe('Wat je hebt nagegaan en wat je vond. Schrijf wat je hebt gezien, niet wat je vermoedt.'),
        bronnen: z.array(z.string()).optional().describe('URLs of vindplaatsen: KvK-uittreksel, whois, archiefpagina, adrescontrole'),
        informatieOpgevraagd: z.boolean().optional().describe('Heb je de leverancier om de bedrijfsgegevens van het lab gevraagd?'),
        informatieReactie: z.string().optional().describe('Wat kwam daarop terug. Weigeren bewijst niets, maar het is wel het punt waarop de verificatieketen ophoudt - en dat hoort vastgelegd.'),
        vastgelegdDoor: z.string().min(1).describe('Naam van de persoon die dit heeft vastgesteld')
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (a) => {
      const { lab, status, onderbouwing, bronnen, vastgelegdDoor } = a;
      const opgeslagen = await coaStore.saveLabOordeel(lab, {
        status, onderbouwing, bronnen: bronnen || [], vastgelegdDoor,
        informatieOpgevraagd: a.informatieOpgevraagd, informatieReactie: a.informatieReactie
      });
      return {
        content: [{ type: 'text', text: opgeslagen
          ? ('Vastgelegd: ' + lab + ' - ' + status + '. Telt vanaf nu mee bij elke leverancier die naar dit lab verwijst.' +
             (status !== 'erkend' && status !== 'nog niet beoordeeld'
               ? ' Identity, purity en quantity die uitsluitend op rapporten van dit lab rusten gelden daarmee als ONBEVESTIGD.' : ''))
          : 'Opslaan mislukt. Controleer of de status een van de vier toegestane waarden is.' }],
        structuredContent: { lab, status, opgeslagen: !!opgeslagen }
      };
    }
  );

  // A16 - BESLUIT ANNEMARIE, 21 SEPTEMBER. Een afwijkende productnaam is een
  // controletrigger geworden. Zonder een plek om de uitkomst vast te leggen
  // blijft zo een rapport voor altijd wachten, en telt het bewijs nooit mee.
  server.registerTool(
    'beoordeel_naamkoppeling',
    {
      title: 'Legt vast of een afwijkende productnaam een handelsnaam is',
      description: 'Voor het geval dat het labrapport de identiteit toetste tegen een ANDERE stof dan de productnaam op het etiket. Gezien bij NextGen: een vial verkocht als "GLP-3" waarvan ILS de identiteit toetste tegen retatrutide. Het rapport liegt niet en het etiket hoeft ook niet fout te zijn - GLP-3 kan een handelsnaam zijn - maar tot iemand dat heeft nagekeken is niet vastgesteld dat dit rapport over dit product gaat. Twee uitkomsten, en alleen bij de eerste telt het bewijs van dat rapport normaal mee. Dit is uitdrukkelijk GEEN oordeel over de leverancier: "koppeling onvoldoende aangetoond" betekent dat wij het verband niet konden aantonen, niet dat er bedrog is.',
      inputSchema: z.object({
        leverancier: z.string().min(2).describe('De leverancierssleutel, meestal de hostname van de shop, bijvoorbeeld "nextgenpeptides.com"'),
        product: z.string().min(1).describe('De productnaam zoals die op het etiket of in het rapport staat, bijvoorbeeld "GLP-3"'),
        getoetsteStof: z.string().min(1).describe('De stof waartegen het lab de identiteit toetste, bijvoorbeeld "Retatrutide"'),
        status: z.enum(['wacht op beoordeling', 'handmatig bevestigd als handelsnaam/alias', 'koppeling onvoldoende aangetoond']).describe('handmatig bevestigd als handelsnaam/alias = je hebt vastgesteld dat de productnaam een handelsnaam of alias is voor die stof; het bewijs van dat rapport telt daarna normaal mee. koppeling onvoldoende aangetoond = je hebt gekeken en kon het verband niet aantonen; het bewijs telt niet mee, zonder dat wij daarmee iets over de leverancier zeggen. wacht op beoordeling = terugzetten naar onbeoordeeld.'),
        onderbouwing: z.string().min(10).describe('Waar je dit op baseert. Bij een handelsnaam: waar je die naam als alias hebt teruggevonden.'),
        vastgelegdDoor: z.string().min(1).describe('Naam van de persoon die dit heeft vastgesteld')
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (a) => {
      const opgeslagen = await coaStore.saveNaamOordeel(a.leverancier, a.product, a.getoetsteStof, {
        status: a.status, onderbouwing: a.onderbouwing, vastgelegdDoor: a.vastgelegdDoor
      });
      return {
        content: [{ type: 'text', text: opgeslagen
          ? ('Vastgelegd: ' + a.product + ' tegenover ' + a.getoetsteStof + ' bij ' + a.leverancier + ' - ' + a.status + '.' +
             (a.status === 'handmatig bevestigd als handelsnaam/alias'
               ? ' Het bewijs van dat rapport telt vanaf nu normaal mee.'
               : ' Het bewijs van dat rapport telt voorlopig niet mee.'))
          : 'Opslaan mislukt. Controleer leverancier, product, stof en status.' }],
        structuredContent: { leverancier: a.leverancier, product: a.product, status: a.status, opgeslagen: !!opgeslagen }
      };
    }
  );

  // --- rondkijken ----------------------------------------------------------
  //
  // Tot nu kon je alleen per leverancier zoeken. Dat werkt als je al weet welke
  // shop je zoekt, en niet als de vraag "welke labs wachten nog op mij" is.
  // Die gegevens zaten wel in het systeem, maar alleen achter de stafpagina's.
  server.registerTool(
    'toon_laboratoria',
    {
      title: 'Alle laboratoria met hun stand',
      description: 'Geeft elk laboratorium dat wij zijn tegengekomen, met de stand die een beoordelaar eraan heeft gegeven en de onderbouwing daarbij. Labs zonder stand staan er ook in: dat is de werkvoorraad. Twee signalen komen er automatisch bij: komt dit lab maar bij een leverancier voor, en is er ook maar een verwijzing die een buitenstaander zelf kan nalopen. Gebruik dit om te zien wat er nog open staat en wat er eerder over een lab is vastgelegd.',
      inputSchema: z.object({
        alleenZonderOordeel: z.boolean().optional().describe('Alleen de labs waar nog geen stand op zit')
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (a) => {
      const labs = await coaStore.labSignalen();
      const lijst = a.alleenZonderOordeel ? labs.filter((l) => !l.oordeel) : labs;
      const tekst = lijst.length
        ? lijst.map((l) => '- ' + l.lab + ': ' + (l.oordeel ? l.oordeel.status : 'NOG GEEN STAND') +
            (l.oordeel && l.oordeel.onderbouwing ? '\n    ' + String(l.oordeel.onderbouwing).slice(0, 300) : '')).join('\n')
        : 'Geen laboratoria gevonden.';
      return {
        content: [{ type: 'text', text: tekst }],
        structuredContent: { aantal: lijst.length, statussen: coaStore.LAB_STATUSSEN, labs: lijst }
      };
    }
  );

  server.registerTool(
    'toon_leveranciers',
    {
      title: 'Overzicht van alle leveranciers',
      description: 'Een regel per leverancier die wij kennen, met hoeveel labverwijzingen er bekend zijn, hoeveel daarvan handmatig zijn gecontroleerd en hoeveel er op naam van een derde partij staan. Gebruik dit om te zien waar het werk zit, of om een leverancierssleutel op te zoeken die je bij de andere tools nodig hebt.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      const rijen = await coaStore.leveranciersOverzicht();
      const tekst = rijen.length
        ? rijen.map((r) => '- ' + (r.supplierKey || '?') + ': ' + (r.referenties || 0) +
            ' verwijzing(en), ' + (r.gecontroleerd || 0) + ' gecontroleerd' +
            (r.opNaamVanDerde ? ', ' + r.opNaamVanDerde + ' op naam van een derde' : '')).join('\n')
        : 'Nog geen leveranciers in het archief.';
      return { content: [{ type: 'text', text: tekst }], structuredContent: { aantal: rijen.length, leveranciers: rijen } };
    }
  );

  server.registerTool(
    'toon_naamkoppelingen',
    {
      title: 'Producten waarvan de naam afwijkt van de geteste stof',
      description: 'Geeft de gevallen waarin het labrapport de identiteit toetste tegen een ANDERE stof dan de productnaam op het etiket, met de stand die eraan is gegeven. Zolang die op "wacht op beoordeling" staat telt het bewijs van dat rapport niet mee - niet omdat er iets mis is, maar omdat niet is vastgesteld dat het rapport over dat product gaat. Dit is dus een werkvoorraad, geen lijst met bevindingen.',
      inputSchema: z.object({
        leverancier: z.string().optional().describe('Beperk tot een leverancier, bijvoorbeeld nextgenpeptides.com')
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (a) => {
      const oordelen = await coaStore.naamOordelen(a.leverancier || null);
      const lijst = Object.values(oordelen);
      const tekst = lijst.length
        ? lijst.map((o) => '- ' + o.supplierKey + ': "' + o.product + '" getoetst tegen "' + o.getoetsteStof +
            '" -> ' + o.status + (o.onderbouwing ? '\n    ' + o.onderbouwing : '')).join('\n')
        : 'Geen vastgelegde naamkoppelingen.';
      return {
        content: [{ type: 'text', text: tekst }],
        structuredContent: { aantal: lijst.length, statussen: coaStore.NAAM_STATUSSEN, koppelingen: lijst }
      };
    }
  );

  server.registerTool(
    'toon_rapport',
    {
      title: 'De uitkomst van een controle, zoals de gebruiker hem ziet',
      description: 'Haalt het rapport van een uitgevoerde controle op: de uitkomst van de Evidence Gate, de vier blokken met hun zinnen, en de narratieve tekst. Gebruik dit om een tekst in zijn CONTEXT te zien voordat je hem beoordeelt - een losse zin redigeren zonder te zien waar hij staat en wat eromheen staat levert meestal de verkeerde correctie op. Geef een caseId, of een leverancier: dan komt de laatste controle van die shop terug.',
      inputSchema: z.object({
        caseId: z.string().optional().describe('Het id van de controle'),
        leverancier: z.string().optional().describe('Of de shop, bijvoorbeeld omegapeptides.eu - dan de laatst afgeronde controle')
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (a) => {
      let c = null;
      if (a.caseId) {
        c = await db.getCase(a.caseId).catch(() => null);
      } else if (a.leverancier) {
        const kaal = String(a.leverancier).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
        const alle = await db.listCases().catch(() => []);
        const passend = alle.filter((x) => String(x.website || '').toLowerCase().includes(kaal));
        c = passend.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0))[0] || null;
        if (c) c = await db.getCase(c.id).catch(() => null);
      }
      if (!c) {
        return { content: [{ type: 'text', text: 'Geen controle gevonden. Geef een caseId of een leverancier die al een keer is gecontroleerd.' }] };
      }
      const er = c.engineResult || {};
      const blokken = er.blokken || {};
      const zinnen = [];
      ['openheid', 'verificatie', 'productbewijs', 'waarden'].forEach((k) => {
        const b = blokken[k];
        if (!b) return;
        if (b.werkregel) zinnen.push(k + ': ' + b.werkregel);
        (b.regels || []).forEach((r) => { if (r && r.zin) zinnen.push(k + ': ' + r.zin); });
      });
      const rap = c.report || {};
      const tekst = [
        'Controle van ' + (c.naam || c.website || c.id),
        'Evidence Gate: ' + ((er.gate && er.gate.status) || 'onbekend') + (er.gate && er.gate.code ? ' (' + er.gate.code + ')' : ''),
        '',
        'Zinnen uit de blokken:',
        zinnen.length ? zinnen.map((z) => '- ' + z).join('\n') : '- (geen)',
        '',
        'Narratieve tekst:',
        String(rap.executiveSummary || '(geen samenvatting)')
      ].join('\n');
      return {
        content: [{ type: 'text', text: tekst }],
        structuredContent: {
          caseId: c.id, website: c.website, gate: er.gate || null,
          blokzinnen: zinnen, executiveSummary: rap.executiveSummary || null,
          aandachtspunten: rap.belangrijksteAandachtspunten || [],
          positief: rap.sterkstePositieveBevindingen || []
        }
      };
    }
  );

  // Wat betekent deze zin, en waarom staat hij er zo?
  //
  // Zonder deze tool vult een chat het zelf in met algemene kennis, en dat
  // klinkt overtuigend terwijl het er volledig naast kan zitten. Het antwoord
  // stond er al: in deze code staat de reden boven de regel, meestal met het
  // besluitnummer erbij.
  server.registerTool(
    'verklaar_tekst',
    {
      title: 'Wat betekent deze tekst, en waarom staat hij er zo',
      description: 'Plak een zin uit een rapport en krijg terug waar hij vandaan komt en waarom hij zo luidt. Bij een VASTE zin komt de uitleg uit de code zelf - daar staat de reden boven de regel, vaak met het besluitnummer erbij (A13, A24, L01), zodat je kunt zien op welk besluit een formulering rust. Bij GEGENEREERDE tekst is er geen vaste betekenis: die is voor dat ene rapport geschreven. Gebruik dit voordat je een tekst afkeurt: soms staat er iets met opzet zo, en dan is de vraag of dat besluit nog klopt en niet of de zin mooier kan.',
      inputSchema: z.object({
        tekst: z.string().min(12).describe('De zin zoals hij in het rapport staat')
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (a) => {
      const v = teksten.verklaarTekst(a.tekst);
      return {
        content: [{ type: 'text', text: v.antwoord || v.uitleg || 'Geen herkomst gevonden.' }],
        structuredContent: {
          soort: v.soort, aandeel: v.aandeel || 0, bron: v.bron || null,
          besluiten: v.besluiten || [], verklaring: v.verklaring || null
        }
      };
    }
  );

  // --- de redactielus, 22 september ---------------------------------------
  //
  // Annemarie beoordeelt niet alleen shops en labs, maar ook de teksten die
  // eruit komen. Afgesproken werkwijze: zij kopieert wat er staat en schrijft
  // eronder wat het moet zijn. Deze tool vangt dat paar op EN vertelt haar
  // meteen waar die tekst vandaan komt, want dat bepaalt wat er kan gebeuren.
  server.registerTool(
    'geef_tekstfeedback',
    {
      title: 'Zeg wat een tekst zou moeten zijn',
      description: 'Voor het redigeren van de teksten die PepProof naar buiten brengt. Plak de tekst zoals hij er staat in origineel, en schrijf in gewenst hoe hij zou moeten luiden. De server zoekt zelf uit waar die tekst vandaan komt en zegt dat terug, want dat maakt uit: een VASTE zin staat letterlijk in de code en verandert in elk rapport tegelijk zodra iemand hem aanpast, terwijl GEGENEREERDE tekst per run door het model wordt geschreven en alleen via een schrijfregel te sturen is. Geef de leverancier mee als je de tekst in een concreet rapport zag - zonder die context is een zin later moeilijk terug te vinden. Dit legt alleen vast; de verwerking gebeurt daarna met de hand.',
      inputSchema: z.object({
        origineel: z.string().min(12).describe('De tekst precies zoals hij er staat. Liever een hele zin dan een half stuk: aan losse woorden is de herkomst niet te zien.'),
        gewenst: z.string().min(3).describe('Hoe de tekst zou moeten luiden. Mag ook een aanwijzing zijn in plaats van een voltooide zin, bijvoorbeeld "korter, en niet suggereren dat wij het zelf hebben gemeten".'),
        toelichting: z.string().optional().describe('Waarom. Dit is het belangrijkste veld voor het leren: uit de reden valt een regel af te leiden die ook op andere teksten werkt, uit alleen de nieuwe zin niet.'),
        leverancier: z.string().optional().describe('De shop waar je deze tekst zag, bijvoorbeeld omegapeptides.eu'),
        caseId: z.string().optional().describe('Het id van de controle, als je dat bij de hand hebt'),
        door: z.string().min(1).describe('Je naam')
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (a) => {
      const opgeslagen = await coaStore.saveTekstoordeel(a);
      if (!opgeslagen) {
        return { content: [{ type: 'text', text: 'Opslaan mislukt. Controleer origineel, gewenst en door.' }] };
      }
      const h = opgeslagen.herkomst || {};
      const regels = [];
      regels.push('Vastgelegd.');
      regels.push('');
      regels.push('Herkomst: ' + (h.soort || 'onbekend') + '. ' + (h.uitleg || ''));
      if (h.soort === 'gegenereerd') {
        regels.push('');
        regels.push('Let op: een correctie op deze tekst verandert niets zolang er geen schrijfregel van gemaakt is. ' +
          'De reden die je meegaf is daarvoor het belangrijkste - daaruit komt de regel.');
      }
      return {
        content: [{ type: 'text', text: regels.join('\n') }],
        structuredContent: { id: opgeslagen.id, soort: h.soort || null, bron: h.bron || null }
      };
    }
  );

  server.registerTool(
    'open_tekstoordelen',
    {
      title: 'Welke tekstcorrecties wachten nog',
      description: 'Geeft de aangeleverde tekstcorrecties terug die nog niet zijn verwerkt, met de herkomst die de server erbij heeft gezocht. Bedoeld voor wie ze doorvoert: lees dit, pas de tekst of de prompt aan, en sluit ze daarna af met verwerk_tekstoordeel.',
      inputSchema: z.object({
        status: z.enum(['open', 'verwerkt', 'afgewezen']).optional().describe('Standaard open'),
        max: z.number().optional().describe('Standaard 50')
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (a) => {
      const lijst = await coaStore.tekstoordelen({ status: a.status || 'open', max: a.max });
      const tekst = lijst.length
        ? lijst.map((t) => '- [' + t.soort + '] ' + (t.leverancier ? '(' + t.leverancier + ') ' : '') +
            '"' + String(t.origineel).slice(0, 120) + '" -> "' + String(t.gewenst).slice(0, 120) + '"' +
            (t.toelichting ? ' | reden: ' + t.toelichting : '') + ' | id ' + t.id).join('\n')
        : 'Geen openstaande tekstcorrecties.';
      return { content: [{ type: 'text', text: tekst }], structuredContent: { aantal: lijst.length, oordelen: lijst } };
    }
  );

  server.registerTool(
    'verwerk_tekstoordeel',
    {
      title: 'Sluit een tekstcorrectie af en leg de regel vast',
      description: 'Markeert een tekstcorrectie als verwerkt en legt er optioneel een SCHRIJFREGEL bij vast. Die regel is het punt van de hele lus: een correctie die alleen die ene zin verbetert leert niets, een regel geldt voor alle tekst die daarna wordt geschreven. Formuleer de regel dus algemeen en zet het oorspronkelijke paar erbij als voorbeeld. LET OP de grens: een schrijfregel gaat over formulering - woordkeus, lengte, toon, wat je wel en niet mag beweren. Nooit over de uitkomst. Een regel die een leverancier gunstiger of ongunstiger laat klinken dan het bewijs toestaat verandert de methodiek via de achterdeur en hoort hier niet.',
      inputSchema: z.object({
        id: z.string().min(8).describe('Het id uit open_tekstoordelen'),
        status: z.enum(['verwerkt', 'afgewezen']).optional().describe('Standaard verwerkt. Afgewezen als de correctie niet is doorgevoerd - zet dan in notitie waarom.'),
        notitie: z.string().optional().describe('Wat er is gedaan, of waarom niet'),
        regel: z.string().optional().describe('De algemene regel die hieruit volgt, bijvoorbeeld "schrijf nooit dat wij iets hebben gemeten; wij lezen wat er in het document staat"'),
        voorbeeldVoor: z.string().optional().describe('De oude formulering, als voorbeeld bij de regel'),
        voorbeeldNa: z.string().optional().describe('De gewenste formulering'),
        geldtVoor: z.enum(['alles', 'rapport', 'blokken']).optional().describe('alles = elke tekst. rapport = alleen de gegenereerde rapporttekst. blokken = alleen de vaste zinnen in de blokken.'),
        door: z.string().min(1).describe('Je naam')
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (a) => {
      const bij = await coaStore.verwerkTekstoordeel(a.id, { status: a.status, notitie: a.notitie });
      let regel = null;
      if (a.regel) {
        regel = await coaStore.saveSchrijfregel({
          regel: a.regel, voorbeeldVoor: a.voorbeeldVoor, voorbeeldNa: a.voorbeeldNa,
          uitTekstoordeel: a.id, geldtVoor: a.geldtVoor, door: a.door
        });
      }
      return {
        content: [{ type: 'text', text: (bij ? 'Afgesloten als ' + (a.status || 'verwerkt') + '.' : 'Niet gevonden.') +
          (regel ? ' Schrijfregel vastgelegd; hij gaat mee in elke volgende rapporttekst.' : '') }],
        structuredContent: { afgesloten: !!bij, regelVastgelegd: !!regel }
      };
    }
  );

  server.registerTool(
    'schrijfregels',
    {
      title: 'De regels die uit eerdere correcties zijn afgeleid',
      description: 'Geeft de actieve schrijfregels terug. Lees dit VOORDAT je nieuwe tekst voor PepProof schrijft - vaste zinnen in de code net zo goed als prompts. Dat is de enige manier waarop een eerdere correctie ook op andere teksten doorwerkt; anders wordt dezelfde opmerking over een half jaar opnieuw gemaakt.',
      inputSchema: z.object({
        geldtVoor: z.enum(['alles', 'rapport', 'blokken']).optional()
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (a) => {
      const lijst = await coaStore.schrijfregels({ geldtVoor: a.geldtVoor });
      const tekst = lijst.length
        ? lijst.map((r, i) => (i + 1) + '. ' + r.regel +
            (r.voorbeeldVoor ? '\n   niet: ' + r.voorbeeldVoor : '') +
            (r.voorbeeldNa ? '\n   wel:  ' + r.voorbeeldNa : '')).join('\n')
        : 'Nog geen schrijfregels vastgelegd.';
      return { content: [{ type: 'text', text: tekst }], structuredContent: { aantal: lijst.length, regels: lijst } };
    }
  );

  // Zevende en achtste tool, 21 september. Aanleiding: de pijplijn legde alles
  // vast en wees niemand ergens op. Iemand voert een onbekende shop in, de
  // FREE loopt door, het lab erachter kent niemand - en dat blijft stil tot
  // iemand toevallig de stafpagina opent. Voor een testversie waarin vreemden
  // shops invoeren is dat het gat.
  server.registerTool(
    'nieuwe_signalen',
    {
      title: 'Wat is er nieuw en nog niet gemeld',
      description: 'Geeft de leveranciers en laboratoria die sinds de vorige melding voor het eerst zijn opgedoken en waar nog niemand op is gewezen. Bedoeld voor een terugkerende controle: lees dit, maak er taken van, en markeer ze daarna met markeer_gesignaleerd zodat ze niet opnieuw langskomen. Een lab dat al een stand van een beoordelaar heeft komt hier nooit in voor - die stand IS het bewijs dat er naar gekeken is. Let op het veld uitCasesZonderReferentie: dat lab werd op een rapport genoemd zonder verificatiecode, en is dus juist het minst controleerbare soort.',
      inputSchema: z.object({
        max: z.number().optional().describe('Maximum per soort (standaard 50)')
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ max }) => {
      const uit = await coaStore.nieuweSignalen({ max });
      if (!uit) {
        return { content: [{ type: 'text', text: 'Kon de signalen niet ophalen.' }], structuredContent: { fout: true } };
      }
      const datum = (v) => (v ? new Date(Number(v)).toISOString().slice(0, 10) : 'onbekend');
      const regels = [];
      regels.push(uit.leveranciers.length + ' nieuwe leverancier(s), ' + uit.labs.length + ' nieuw lab/labs.');
      if (uit.leveranciers.length) {
        regels.push('', 'LEVERANCIERS:');
        uit.leveranciers.forEach((l) => {
          regels.push('- ' + l.sleutel + (l.naam ? (' (' + l.naam + ')') : '') +
            ' - eerst gezien ' + datum(l.eersteKeerGezien) +
            ', ' + l.runs + ' run(s), ' + l.verwijzingen + ' labverwijzing(en), ' + l.labs + ' lab(s)' +
            (l.verwijzingen === 0 ? ' - LET OP: geen enkel labrapport gevonden' : ''));
        });
      }
      if (uit.labs.length) {
        regels.push('', 'LABORATORIA ZONDER STAND:');
        uit.labs.forEach((l) => {
          regels.push('- ' + l.sleutel + ' - eerst gezien ' + datum(l.eersteKeerGezien) +
            ', ' + l.verwijzingen + ' verwijzing(en) bij ' + l.shops + ' shop(s)' +
            (l.uitCasesZonderReferentie ? ' - LET OP: genoemd op een rapport zonder verificatiecode' : ''));
        });
      }
      if (!uit.leveranciers.length && !uit.labs.length) regels.push('Niets nieuws.');
      return { content: [{ type: 'text', text: regels.join('\n') }], structuredContent: uit };
    }
  );

  server.registerTool(
    'markeer_gesignaleerd',
    {
      title: 'Markeer signalen als gemeld',
      description: 'Legt vast dat er op deze leveranciers en laboratoria is gewezen, zodat nieuwe_signalen ze niet opnieuw teruggeeft. Roep dit pas aan NADAT de taak of melding daadwerkelijk is aangemaakt - anders verdwijnt het signaal zonder dat iemand het heeft gezien. Gemeld is niet hetzelfde als afgehandeld: of er iets mee gedaan is staat in de taak zelf, en bij een lab in zijn stand.',
      inputSchema: z.object({
        items: z.array(z.object({
          soort: z.enum(['leverancier', 'lab']),
          sleutel: z.string().min(1).describe('De supplier_key of de labnaam, precies zoals nieuwe_signalen hem teruggaf'),
          eersteKeerGezien: z.number().optional(),
          notitie: z.string().optional().describe('Waar het signaal heen ging, bijv. een taaknaam')
        })).min(1).max(200),
        door: z.string().optional().describe('Wie of wat de melding deed')
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ items, door }) => {
      const uit = await coaStore.markeerGesignaleerd(items, door);
      return {
        content: [{ type: 'text', text: uit.gemarkeerd + ' van ' + (uit.aangeboden || 0) +
          ' vastgelegd als gemeld' + (uit.gemarkeerd < (uit.aangeboden || 0) ? ' (de rest stond er al in)' : '') + '.' }],
        structuredContent: uit
      };
    }
  );

  return server;
}

// De namen van de tools die DEZE versie registreert. Zo kun je via /api/health
// zien welke tools de draaiende code kent, zonder afhankelijk te zijn van een
// MCP-verbinding die een oud schema vasthoudt.
const TOOL_NAMEN = [
  'zoek_leverancier_coas', 'upload_coa', 'verifieer_coa',
  'verifieer_labreferentie', 'zoek_labreferenties', 'beoordeel_laboratorium',
  'nieuwe_signalen', 'markeer_gesignaleerd', 'beoordeel_naamkoppeling',
  'geef_tekstfeedback', 'open_tekstoordelen', 'verwerk_tekstoordeel', 'schrijfregels',
  'toon_laboratoria', 'toon_leveranciers', 'toon_naamkoppelingen', 'toon_rapport', 'verklaar_tekst'
];
function toolNamen(rol) {
  if (rol === 'redactie') return TOOL_NAMEN.filter((n) => REDACTIE_TOOLS.indexOf(n) !== -1);
  return TOOL_NAMEN;
}

const serverPerRol = new Map();
function getServer(rol) {
  const sleutel = rol === 'redactie' ? 'redactie' : 'staf';
  if (!serverPerRol.has(sleutel)) serverPerRol.set(sleutel, buildServer(sleutel));
  return serverPerRol.get(sleutel);
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
// Waarom meer dan een pad? De client onthoudt de toollijst bij de URL waarop
// een connector is aangemaakt, en ververst die niet bij opnieuw verbinden: op
// 20 september toonden twee onafhankelijke sessies nog de lijst van 19
// september (vier tools, verifieer_labreferentie met negen velden), terwijl de
// server er zes met eenentwintig velden had. Vier keer los- en vastkoppelen
// veranderde niets. Een pad dat de client nog nooit heeft gezien dwingt wel een
// verse lijst af. /mcp blijft werken voor wie al gekoppeld is.
//
// 22 SEPTEMBER, TWEEDE KEER. Na het toevoegen van beoordeel_naamkoppeling gaf
// de connector op /mcp/v2 nog steeds acht tools terug, ook na opnieuw
// aanzetten en na een expliciete verversing. Op de server stond de negende
// wel; dat is nagegaan via /api/admin/naamkoppelingen, dat alleen in de
// nieuwe code bestaat en netjes om een token vroeg.
//
// Er komt dus elke keer een pad bij, en elke keer is dat een codewijziging
// plus een deploy voordat iemand een connector kan maken. Daarom nu een
// parameter in plaats van een lijst: /mcp/v3, /mcp/v4 en verder werken
// meteen, zonder hier iets te veranderen. Wat er achter zit is elke keer
// dezelfde server met dezelfde toollijst - het pad is alleen een manier om
// de cache van de client te omzeilen.
//
// /mcp en /mcp/v2 blijven apart staan zodat bestaande connectoren blijven
// werken; het patroon eronder vangt de rest.
const MCP_PADEN = ['/mcp', '/mcp/v2', '/mcp/:versie'];

// Wat er in de statusuitvoer en de documentatie moet staan: de paden die
// iemand echt kan intypen, niet het patroon.
const MCP_VOORBEELDPADEN = ['/mcp', '/mcp/v2', '/mcp/v3'];

function mount(app) {
  app.post(MCP_PADEN, requireStaffToken, express.json({ limit: '25mb' }), async (req, res) => {
    try {
      const [server, TransportClass] = await Promise.all([getServer(req.mcpRol), getTransportClass()]);
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

module.exports = { mount, toolNamen, MCP_PADEN, MCP_VOORBEELDPADEN, REDACTIE_TOOLS };
