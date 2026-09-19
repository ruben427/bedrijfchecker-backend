// Meet of de verificatiediensten van laboratoria bereikbaar zijn vanaf de
// plek waar deze code draait.
//
// Waarom dit bestaat: verify.janoshik.com geeft vanaf Railway 403 met
// Cloudflare-headers, terwijl dezelfde URL vanaf een laptop gewoon werkt
// (gemeten 15 sep 2026). Een resolver die niet bij het lab kan, levert geen
// klasse en geen oordeel. Welke labs wel open staan bepaalt dus rechtstreeks
// welke adapter we als eerste bouwen.
//
// LET OP: meet vanaf Railway, niet lokaal. Lokaal draaien is alleen nuttig
// als vergelijking - verschilt de uitkomst, dan blokkeert het lab op IP.
//
// Geen gebruikersinvoer: de lijst hieronder is hardcoded, dus dit is geen
// SSRF-oppervlak. Wie een lab wil toevoegen, doet dat hier.

// 8 seconden, niet 15. Railway kapt een inkomend verzoek af voordat een
// trage meting klaar is, en dan krijg je een lege reactie in plaats van een
// uitkomst. Een lab dat na 8 seconden nog niets heeft gezegd, is voor ons
// doel net zo goed onbereikbaar.
const TIMEOUT_MS = Number(process.env.LAB_PROBE_TIMEOUT_MS) || 8000;

const LABS = [
  // Janoshik: de echte referentie uit de validatieset. Die test twee dingen
  // tegelijk - komen we erbij, en lost een geldig rapport nog steeds op.
  // Geldig blijft op /tests/<ref>; ongeldig stuurt door naar navigation.php.
  { lab: 'Janoshik', soort: 'verificatie', url: 'https://verify.janoshik.com/tests/164849-selank_10mg_E7US5H3NA1RL' },
  { lab: 'Janoshik', soort: 'homepage', url: 'https://janoshik.com/' },

  { lab: 'Uzorak', soort: 'verificatie', url: 'https://uzorak.com/verify' },
  { lab: 'Uzorak', soort: 'homepage', url: 'https://uzorak.com/' },

  { lab: 'Freedom Diagnostics', soort: 'homepage', url: 'https://freedomdiagnosticstesting.com/' },

  { lab: 'Vanguard', soort: 'verificatie', url: 'https://verifiedbyvanguard.com/search' },
  { lab: 'Vanguard', soort: 'homepage', url: 'https://vanguardlaboratory.com/' },

  { lab: 'Krause Analytical', soort: 'verificatie', url: 'https://www.krauselabs.com/coa-verification' },

  { lab: 'Chromate', soort: 'verificatie', url: 'https://chromate.org/verify' },
  { lab: 'Chromate', soort: 'homepage', url: 'https://chromate.org/' },

  { lab: 'BT Labs', soort: 'homepage', url: 'https://btlabtesting.com/' },
  { lab: 'Sterigenix', soort: 'homepage', url: 'https://sterigenixanalytical.com/' },
  { lab: 'Kovera', soort: 'homepage', url: 'https://koveralabs.com/' }
];

// Cloudflare en vergelijkbare diensten geven lang niet altijd een nette 403.
// Soms is het een 200 met een JS-uitdaging erin. Daarom kijken we ook naar de
// eerste stukjes van de body.
const UITDAGING = [
  'just a moment',
  'attention required',
  'cf-browser-verification',
  'challenge-platform',
  'enable javascript and cookies to continue',
  'checking your browser',
  'ddos protection by'
];

function lijktOpBotmuur(status, headers, body) {
  const server = String(headers.server || '').toLowerCase();
  const cfRay = !!headers['cf-ray'];
  const cfMit = !!headers['cf-mitigated'];
  const tekst = String(body || '').toLowerCase();
  const uitdaging = UITDAGING.some((m) => tekst.indexOf(m) !== -1);
  const cloudflare = cfRay || cfMit || server.indexOf('cloudflare') !== -1;
  if (uitdaging) return true;
  if ((status === 403 || status === 503 || status === 429) && cloudflare) return true;
  return false;
}

function klasseer(status, headers, body) {
  if (lijktOpBotmuur(status, headers, body)) return 'geblokkeerd';
  if (status === 404) return 'niet gevonden';
  if (status === 401 || status === 403) return 'geweigerd';
  if (status >= 500) return 'serverfout';
  if (status >= 200 && status < 400) return 'open';
  return 'onbekend';
}

async function probeOne(item) {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(item.url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        // Geen browser nadoen. We willen weten of het lab onze server
        // toelaat zoals hij is, niet of we er met een vermomming langs komen.
        'User-Agent': 'PepProof-LabProbe/1.0 (+https://checker.deannemethode.nl)',
        'Accept': 'text/html,application/xhtml+xml,*/*'
      }
    });
    const headers = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    let body = '';
    try { body = (await res.text()).slice(0, 4000); } catch (e) { body = ''; }
    clearTimeout(timer);
    const eindUrl = res.url && res.url !== item.url ? res.url : null;
    return {
      lab: item.lab,
      soort: item.soort,
      url: item.url,
      status: res.status,
      klasse: klasseer(res.status, headers, body),
      eindUrl,
      doorgestuurd: !!eindUrl,
      server: headers.server || null,
      cloudflare: !!(headers['cf-ray'] || headers['cf-mitigated'] || String(headers.server || '').toLowerCase().indexOf('cloudflare') !== -1),
      duurMs: Date.now() - start,
      fout: null
    };
  } catch (e) {
    clearTimeout(timer);
    const afgebroken = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return {
      lab: item.lab,
      soort: item.soort,
      url: item.url,
      status: null,
      klasse: afgebroken ? 'time-out' : 'onbereikbaar',
      eindUrl: null,
      doorgestuurd: false,
      server: null,
      cloudflare: false,
      duurMs: Date.now() - start,
      fout: afgebroken ? 'time-out na ' + TIMEOUT_MS + 'ms' : ((e && e.message) || 'onbekende fout')
    };
  }
}

// Vijf tegelijk: drie golven, dus ruim binnen de 30 seconden. We meten of iets open staat, niet hoe hard het
// kan. Een reeks snelle verzoeken vanaf hetzelfde IP is precies wat een
// botmuur wil zien.
async function probeAll(labs) {
  const lijst = labs || LABS;
  const uit = [];
  for (let i = 0; i < lijst.length; i += 5) {
    const groep = lijst.slice(i, i + 5);
    const res = await Promise.all(groep.map(probeOne));
    res.forEach((r) => uit.push(r));
  }
  const open = uit.filter((r) => r.klasse === 'open').length;
  const geblokkeerd = uit.filter((r) => r.klasse === 'geblokkeerd').length;
  return {
    gemetenOp: new Date().toISOString(),
    omgeving: process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || 'onbekend (lokaal?)',
    aantal: uit.length,
    open,
    geblokkeerd,
    resultaten: uit
  };
}

module.exports = { LABS, probeAll, probeOne };
