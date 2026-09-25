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
// 25 sep: die fail-open is gesplitst. Zie het blok A12/M30 hieronder — hij
// geldt nog wel voor technisch falen, niet meer voor een onopgeloste
// leverancier.
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

// ---------------------------------------------------------------------------
// A12 — DE VOORCHECK GESPLITST (BESLUIT ANNEMARIE, M30, 19 september 2026)
//
// Tot nu toe eindigden twee heel verschillende gevallen op dezelfde uitkomst:
// verdict "onbekend" met relevant: true. De run ging in beide gevallen door.
//
// Haar besluit op M30, letterlijk:
//
//   "Niet fail-open, niet fail-closed, maar gesplitst. Bij SOURCE_UNAVAILABLE
//    of tooluitval mag de run doorgaan met een expliciete beperking, mits de
//    entiteit via andere invoer voldoende is vastgesteld. Bij UNRESOLVED of
//    een ambigue leverancier niet doorgaan tot de URL of identiteit voldoende
//    is opgelost. Technisch falen is geen negatief bewijs; onduidelijke
//    identiteit blokkeert wel correct onderzoek."
//
// Waar die twee in dit bestand zitten:
//
//  * SOURCE_UNAVAILABLE — wij kregen geen paginatekst: de extract gaf niets
//    terug, of er viel onderweg iets om. Er is dan niets beoordeeld. Dat is
//    onze storing, niet iets wat de leverancier heeft gedaan, dus de run mag
//    door. Wel wordt de beperking vastgelegd (server.js schrijft hem bij de
//    case weg), zodat later terug te zien is dat deze run zonder voorcheck
//    is begonnen.
//
//  * UNRESOLVED — er was wel paginatekst, maar daaruit viel niet op te maken
//    wat voor site dit is. De identiteit is dan onopgelost en daarmee blokkeert
//    hij correct onderzoek: niet starten, en vragen om een onderscheidender
//    adres (bijvoorbeeld de winkel- of productpagina in plaats van een
//    landingspagina).
//
// LET OP — wat hier bewust NIET in zit: haar voorwaarde "mits de entiteit via
// andere invoer voldoende is vastgesteld". Wanneer een entiteit langs naam,
// KvK-nummer of een geupload document "voldoende vastgesteld" heet, is een
// methodische drempel die niemand heeft vastgelegd. Die zou deze tak strenger
// maken dan hij nu is; tot die drempel er is loopt SOURCE_UNAVAILABLE door
// zoals hij altijd liep, nu met de beperking erbij. Geen gok in de code.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DOORGELINKTE SHOPS (BESLUIT RUBEN, 23 september 2026, taak "Nieuwe
// leverancier bekeken: raccoonpeptides.com")
//
// raccoonpeptides.com bleek geen eigen winkel: wie het adres intikt, komt uit
// bij peptidesupermarket.co.uk. Wij zouden dan een rapport maken over een
// domein dat zelf niets verkoopt, en dat rapport zou gaan over de bewijzen
// van een ANDERE shop.
//
// Zijn woorden: "kunnen we dit toevoegen aan het gedeelte waar we checken of
// het een peptide website is. Dat als het wordt doorgelinkt. Dat we zeggen
// dat je deze niet kan checken en dat we de URL die doorgelinkt is invuld in
// het veld die je wel kan checken."
//
// Dus: dit is geen oordeel over de shop en geen uitsluiting. Het is de
// vaststelling dat er op dit adres niets te controleren valt, plus het adres
// waar dat wel kan. Wie het wil weten, drukt nog een keer op start.
//
// LET OP - twee grenzen die hier bewust in zitten:
//  * Alleen een sprong naar een ANDERE site telt. http->https, www erbij of
//    eraf, een taalpad en een subdomein zijn dezelfde winkel.
//  * Bij een technische hobbel gebeurt er niets: dan loopt de voorcheck
//    gewoon door zoals hij altijd liep. Dezelfde fail-open als hierboven -
//    een echte leverancier tegenhouden omdat onze eigen meting haperde is
//    erger dan een audit die achteraf onnodig bleek.
// ---------------------------------------------------------------------------

const { isPublicHttpUrl } = require('./urlGuard');

const DOORLINK_TIMEOUT_MS = Number(process.env.DOORLINK_TIMEOUT_MS) || 8000;

// Twee hostnamen horen bij dezelfde winkel als ze na het weghalen van "www."
// gelijk zijn, of als de een een subdomein van de ander is.
function zelfdeSite(a, b) {
  if (!a || !b) return true;
  const x = String(a).toLowerCase().replace(/^www\./, '');
  const y = String(b).toLowerCase().replace(/^www\./, '');
  if (x === y) return true;
  return x.endsWith('.' + y) || y.endsWith('.' + x);
}

// Volgt de omleidingen en geeft het eindadres terug als dat op een andere
// site uitkomt. Geeft null terug bij gelijk gebleven adres en bij elke fout.
async function volgDoorlink(website) {
  const start = isPublicHttpUrl(website);
  if (!start.ok) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOORLINK_TIMEOUT_MS);
  try {
    const res = await fetch(start.url, { redirect: 'follow', signal: controller.signal });
    if (res.body && typeof res.body.cancel === 'function') {
      try { await res.body.cancel(); } catch (e) { /* niets aan te doen */ }
    }
    const eind = String(res.url || '');
    if (!eind) return null;
    // Het eindadres is een nieuwe bestemming en dus opnieuw invoer van buiten:
    // dezelfde SSRF-controle als op het beginadres.
    const veilig = isPublicHttpUrl(eind);
    if (!veilig.ok) return null;
    const vanHost = new URL(start.url).hostname;
    const naarHost = new URL(veilig.url).hostname;
    if (zelfdeSite(vanHost, naarHost)) return null;
    return { url: veilig.url, van: vanHost, naar: naarHost };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const { tavilyExtract } = require('./tavilyClient');
const { sampleJsonSafe } = require('./anthropicClient');

async function checkPeptideSupplierRelevance(ctx) {
  try {
    // Eerst kijken of dit adres wel bij zichzelf uitkomt. Zo niet, dan heeft
    // beoordelen geen zin: de paginatekst is dan van een andere winkel.
    const doorlink = await volgDoorlink(ctx.website);
    if (doorlink) {
      return {
        relevant: false,
        verdict: 'doorgelinkt',
        doorgelinktNaar: doorlink.url,
        reasoning: doorlink.van + ' stuurt je door naar ' + doorlink.naar + '. Deze winkel is daardoor niet te controleren: alles wat er te zien is, hoort bij ' + doorlink.naar + '.'
      };
    }
    const extract = await tavilyExtract([ctx.website], { depth: 'advanced' });
    const pageText = (extract.ok[0] && extract.ok[0].content) || '';
    if (!pageText) {
      // SOURCE_UNAVAILABLE (M30): geen paginatekst, dus niets beoordeeld.
      // Doorlopen mag, met de beperking expliciet erbij.
      return {
        relevant: true,
        verdict: 'bron_onbereikbaar',
        beperking: 'SOURCE_UNAVAILABLE',
        reasoning: 'De pagina kon niet opgehaald worden voor de voorcheck.'
      };
    }
    const prompt = 'Je beoordeelt UITSLUITEND op basis van onderstaande paginatekst of dit een website is van een leverancier/verkoper van peptiden en/of research chemicals (bedoeld voor onderzoek, lichaamskracht/bodybuilding of vergelijkbaar gebruik) — dus geen nieuwsartikel, blogpost, algemeen platform, brede webshop/marktplaats die van alles verkoopt, of overduidelijk onrelateerde website.\n\n' +
      'Website: ' + ctx.website + '\nPaginatekst (eerste deel):\n' + pageText.slice(0, 3000) + '\n\n' +
      'Antwoord met compacte JSON, exact dit schema: {"beoordeling":"ja|nee|onbekend","onderbouwing":string}. Kies "nee" zodra duidelijk is dat dit een brede webshop, marktplaats of algemene retailer is met allerlei ongerelateerde productcategorieën (elektronica, huishouden, boodschappen, mode, etc.) — ook als peptiden of research chemicals daar nergens expliciet worden uitgesloten; een brede winkel als deze is per definitie geen gespecialiseerde peptide-/research-chemicals-leverancier. Kies "onbekend" alleen wanneer de paginatekst zelf niets bruikbaars bevat om op te beoordelen (bv. enkel een cookiemelding, laadscherm of foutmelding) — niet zomaar omdat het onderwerp niet met zoveel woorden genoemd wordt. Houd onderbouwing tot 1-2 zinnen.';
    const data = await sampleJsonSafe(prompt, { label: 'relevantieCheck', maxTokens: 512 });
    const beoordeling = (data && data.beoordeling) || 'onbekend';
    const onderbouwing = (data && data.onderbouwing) || '';
    // UNRESOLVED (M30): er was paginatekst, maar wat voor site dit is bleef
    // onopgelost. Onduidelijke identiteit blokkeert correct onderzoek, dus
    // hier stopt het tot er een onderscheidender adres ligt.
    if (beoordeling === 'onbekend') {
      return {
        relevant: false,
        verdict: 'onopgelost',
        beperking: 'UNRESOLVED',
        reasoning: onderbouwing
      };
    }
    return { relevant: beoordeling !== 'nee', verdict: beoordeling, reasoning: onderbouwing };
  } catch (e) {
    // Tooluitval (M30, SOURCE_UNAVAILABLE): technisch falen is geen negatief
    // bewijs. Doorlopen, met de beperking erbij.
    return {
      relevant: true,
      verdict: 'bron_onbereikbaar',
      beperking: 'SOURCE_UNAVAILABLE',
      reasoning: 'Voorcheck kon niet worden uitgevoerd: ' + e.message
    };
  }
}

module.exports = { checkPeptideSupplierRelevance, volgDoorlink, zelfdeSite };
