// Automatisch een kandidaat-COA-document (PDF of afbeelding) ophalen van een
// bronUrl die de coaDataset-stap zelf al aanwees, zodat we niet afhankelijk
// blijven van alleen de tekst-snippet die Tavily teruggaf. Zelfde
// AbortController-timeoutpatroon als tavilyClient.js — met één verschil:
// deze functie gooit ZELF NOOIT. Een falende, tragere of niet-PDF/afbeelding
// download mag de coaDataset-stap (en dus de hele audit) nooit blokkeren of
// laten mislukken; bij twijfel geven we gewoon null terug en blijft de
// AI-inschatting van die COA staan zoals hij al was.
//
// Dit lost bewust niet alles op: bot-beveiligde sites, interactieve
// lab-opzoekportalen (waar een batchnummer eerst ingevuld moet worden) en
// documenten die alleen achter een klantlogin staan blijven onbereikbaar.
// Voor alles daarbuiten — een direct linkbare PDF of afbeelding — voegt dit
// wel echte documentbytes toe in plaats van alleen een Tavily-snippet.

const { isPublicHttpUrl } = require('./urlGuard');

const TIMEOUT_MS = Number(process.env.DOC_FETCH_TIMEOUT_MS) || 20000;
const MAX_BYTES = Number(process.env.DOC_FETCH_MAX_BYTES) || 15 * 1024 * 1024;

function guessMediaType(url, contentType) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (ct === 'application/pdf' || ct.startsWith('image/')) return ct;
  const path = (String(url).split('?')[0] || '').toLowerCase();
  if (path.endsWith('.pdf')) return 'application/pdf';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  return null;
}

async function fetchRemoteDocument(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (!isPublicHttpUrl(url).ok) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Sommige sites weigeren verzoeken zonder User-Agent of met een
        // duidelijk bot-achtige header; een gewone browser-UA haalt het
        // meeste eerlijk-toegankelijke materiaal alsnog binnen.
        'User-Agent': 'Mozilla/5.0 (compatible; BedrijfcheckerBot/1.0; +https://checker.deannemethode.nl)',
        Accept: 'application/pdf,image/*,*/*'
      }
    });
    if (!res.ok) return null;
    // Na een doorstuur zegt de oorspronkelijke URL niets meer over het type:
    // Bridge Analytical stuurt /verify/?key=... door naar een PDF zonder
    // extensie in het eerste pad. Daarom eerst de eind-URL proberen.
    const eindUrl = res.url || url;
    const mediaType = guessMediaType(eindUrl, res.headers.get('content-type')) ||
                      guessMediaType(url, res.headers.get('content-type'));
    if (!mediaType) return null;
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength && contentLength > MAX_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    // buffer/etag/lastModified erbij voor het documentarchief (src/coaStore.js):
    // de hash bepaalt of dit bestand al geanalyseerd is, de headers of het
    // sinds de vorige keer veranderd is. data/mediaType blijven wat ze waren,
    // zodat bestaande aanroepers ongewijzigd blijven werken.
    return {
      data: buf.toString('base64'),
      mediaType,
      buffer: buf,
      etag: res.headers.get('etag') || null,
      lastModified: res.headers.get('last-modified') || null,
      // De URL waar we werkelijk uitkwamen. Bij een verificatielink is dat het
      // rapport zelf, en dat is wat je wil vastleggen als bron.
      finalUrl: eindUrl,
      doorgestuurd: eindUrl !== url
    };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchRemoteDocument };
