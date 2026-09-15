// Korte voorcheck (STAP 0, vóór de volledige 11-stappen-pipeline start):
// is deze website überhaupt een leverancier/verkoper van peptiden of
// research chemicals? Zo niet, dan heeft het geen zin om de rest van de
// (kostbare: 8 onderzoeksstappen + categorisatie + rapport) audit te
// draaien. Idee van Ruben: URL geldig? -> relevantiecheck -> ja/nee -> pas
// dan de volledige pipeline starten.
//
// Bewust GEEN onderdeel van STEP_DEFS/progress in pipeline.js — dit is een
// losse, goedkope gate vóór er een case wordt aangemaakt, niet een van de
// genummerde onderzoeksstappen. En bewust fail-open bij een TECHNISCHE fout
// (site niet op te halen, timeout, kapotte JSON) — dan is er geen paginatekst
// om te beoordelen, en een legitieme leverancier blokkeren omdat de voorcheck
// zelf haperde is erger dan een enkele onnodige volledige audit.
//
// 15 sep: bol.com (en vergelijkbare brede webshops) kwam er nog doorheen —
// niet door de fail-open hierboven, maar doordat het model bij twijfel al
// snel "onbekend" antwoordde (en "onbekend" telde ook als relevant=true).
// Twee aanpassingen: extract_depth 'advanced' i.p.v. 'basic' voor deze ene
// URL (goedkoper te verantwoorden dan bij de volledige multi-URL-audit,
// levert bruikbaardere paginatekst), en een explicietere prompt die "nee"
// voorschrijft zodra de pagina duidelijk een brede webshop/marktplaats is —
// ook als peptiden daar niet met zoveel woorden worden uitgesloten.
// "onbekend" is nu voorbehouden aan pagina's zonder bruikbare tekst
// (cookiemelding/laadscherm/foutmelding), niet meer aan "ambigu qua topic".

const { tavilyExtract } = require('./tavilyClient');
const { sampleJsonSafe } = require('./anthropicClient');

async function checkPeptideSupplierRelevance(ctx) {
  try {
    const extract = await tavilyExtract([ctx.website], { depth: 'advanced' });
    const pageText = (extract.ok[0] && extract.ok[0].content) || '';
    if (!pageText) {
      return { relevant: true, verdict: 'onbekend', reasoning: 'De pagina kon niet opgehaald worden voor de voorcheck.' };
    }
    const prompt = 'Je beoordeelt UITSLUITEND op basis van onderstaande paginatekst of dit een website is van een leverancier/verkoper van peptiden en/of research chemicals (bedoeld voor onderzoek, lichaamskracht/bodybuilding of vergelijkbaar gebruik) — dus geen nieuwsartikel, blogpost, algemeen platform, brede webshop/marktplaats die van alles verkoopt, of overduidelijk onrelateerde website.\n\n' +
      'Website: ' + ctx.website + '\nPaginatekst (eerste deel):\n' + pageText.slice(0, 3000) + '\n\n' +
      'Antwoord met compacte JSON, exact dit schema: {"beoordeling":"ja|nee|onbekend","onderbouwing":string}. Kies "nee" zodra duidelijk is dat dit een brede webshop, marktplaats of algemene retailer is met allerlei ongerelateerde productcategorieën (elektronica, huishouden, boodschappen, mode, etc.) — ook als peptiden of research chemicals daar nergens expliciet worden uitgesloten; een brede winkel als deze is per definitie geen gespecialiseerde peptide-/research-chemicals-leverancier. Kies "onbekend" alleen wanneer de paginatekst zelf niets bruikbaars bevat om op te beoordelen (bv. enkel een cookiemelding, laadscherm of foutmelding) — niet zomaar omdat het onderwerp niet met zoveel woorden genoemd wordt. Houd onderbouwing tot 1-2 zinnen.';
    const data = await sampleJsonSafe(prompt, { label: 'relevantieCheck', maxTokens: 512 });
    const verdict = (data && data.beoordeling) || 'onbekend';
    return { relevant: verdict !== 'nee', verdict, reasoning: (data && data.onderbouwing) || '' };
  } catch (e) {
    return { relevant: true, verdict: 'onbekend', reasoning: 'Voorcheck kon niet worden uitgevoerd: ' + e.message };
  }
}

module.exports = { checkPeptideSupplierRelevance };
