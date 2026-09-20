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
        klasse: z.enum(['A', 'B', 'C', 'D']).optional().describe('ALLEEN invullen als er een kopie van de shop naast het labrapport ligt en je vergelekenMet meegeeft - een klasse op een kale referentie zegt niets. LET OP: welke definitie voor A-D geldt is nog niet besloten (A15, ligt bij Annemarie). Tot dat besluit: laat dit leeg en leg alleen de waarnemingen vast. Wat je nu als letter wegschrijft moet je na het besluit herzien; waarnemingen niet.'),
        client: z.string().optional().describe('De opdrachtgever zoals letterlijk op het rapport vermeld'),
        product: z.string().optional(),
        batchnummer: z.string().optional().describe('Het batch- of lotnummer zoals het lab het noemt. Heeft een eigen kolom: niet in de notitie zetten.'),
        zuiverheid: z.string().optional().describe('De zuiverheid letterlijk zoals hij op de pagina staat, bijvoorbeeld "99.14%". Overtypen wat er staat; het percentage wordt er zelf uit afgeleid.'),
        vulling: z.string().optional().describe('De gemeten hoeveelheid tegenover de geclaimde, letterlijk zoals het er staat, bijvoorbeeld "10.6 mg / 10 mg". Gemeten en etiket worden hieruit afgeleid als je ze niet los meegeeft.'),
        gemetenMg: z.number().optional().describe('De gemeten hoeveelheid in mg. Alleen invullen als je het cijfer zelf hebt gezien.'),
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
        zuiverheid: zuiverheid || null, vulling: vulling || null,
        gemetenMg: a.gemetenMg, etiketMg: a.etiketMg, metaalcomplex: a.metaalcomplex || null,
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
            const oordeel = (c && c.client) ? coaStore.clientOordeel(c.client, [supplierKey]) : null;
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
        status: z.enum(['erkend', 'nog niet beoordeeld', 'onvoldoende verifieerbaar', 'niet onafhankelijk', 'bestaat niet']).describe('erkend = bestaand, onafhankelijk lab; bewijs telt mee. onvoldoende verifieerbaar = je hebt gezocht en gevraagd maar kon het lab niet onafhankelijk bevestigen - dit is de stand voor het gewone geval, en hij zegt NIET dat het lab vals is. niet onafhankelijk = bestaat wel maar hoort bij de leverancier of een verbonden partij. bestaat niet = je hebt VASTGESTELD dat het niet bestaat, met bronnen; gebruik dit alleen als je dat echt kunt onderbouwen. LET OP: een COA die er plausibel uitziet is niet hetzelfde als een COA die onafhankelijk geverifieerd is. Bij alles behalve erkend blijven identity, purity en quantity die uitsluitend op dat rapport rusten ONBEVESTIGD - niet weerlegd, wel onbevestigd.'),
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
