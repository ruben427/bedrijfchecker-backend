// Korte voorcheck (STAP 0, vóór de volledige 11-stappen-pipeline start):
// is deze website überhaupt een leverancier/verkoper van peptiden of
// research chemicals? Zo niet, dan heeft het geen zin om de rest van de
// (kostbare: 8 onderzoeksstappen + categorisatie + rapport) audit te
// draaien. Idee van Ruben: URL geldig? -> relevantiecheck -> ja/nee -> pas
// dan de volledige pipeline starten.
//
// Bewust GEEN onderdeel van STEP_DEFS/progress in pipeline.js — dit is een
// losse, goedkope gate vóór er een case wordt aangemaakt, niet een van de
// genummerde onderzoeksstappen. En bewust fail-open: bij twijfel ("onbekend")
// of een technische fout (site niet op te halen, timeout, kapotte JSON) laten
// we gewoon door — een legitieme leverancier blokkeren omdat de voorcheck zelf
// haperde is erger dan een enkele onnodige volledige audit.

const { tavilyExtract } = require('./tavilyClient');
const { sampleJsonSafe } = require('./anthropicClient');

async function checkPeptideSupplierRelevance(ctx) {
  try {
    const extract = await tavilyExtract([ctx.website]);
    const pageText = (extract.ok[0] && extract.ok[0].content) || '';
    if (!pageText) {
      return { relevant: true, verdict: 'onbekend', reasoning: 'De pagina kon niet opgehaald worden voor de voorcheck.' };
    }
    const prompt = 'Je beoordeelt UITSLUITEND op basis van onderstaande paginatekst of dit een website is van een leverancier/verkoper van peptiden en/of research chemicals (bedoeld voor onderzoek, lichaamskracht/bodybuilding of vergelijkbaar gebruik) — dus geen nieuwsartikel, blogpost, algemeen platform, marktplaats voor heel andere producten, of overduidelijk onrelateerde website.\n\n' +
      'Website: ' + ctx.website + '\nPaginatekst (eerste deel):\n' + pageText.slice(0, 3000) + '\n\n' +
      'Antwoord met compacte JSON, exact dit schema: {"beoordeling":"ja|nee|onbekend","onderbouwing":string}. Kies "onbekend" als de tekst geen duidelijk antwoord geeft (bv. alleen een cookiemelding of laadscherm); kies pas "nee" als overduidelijk is dat dit geen peptide- of research-chemicals-leverancier is. Houd onderbouwing tot 1-2 zinnen.';
    const data = await sampleJsonSafe(prompt, { label: 'relevantieCheck', maxTokens: 512 });
    const verdict = (data && data.beoordeling) || 'onbekend';
    return { relevant: verdict !== 'nee', verdict, reasoning: (data && data.onderbouwing) || '' };
  } catch (e) {
    return { relevant: true, verdict: 'onbekend', reasoning: 'Voorcheck kon niet worden uitgevoerd: ' + e.message };
  }
}

module.exports = { checkPeptideSupplierRelevance };
