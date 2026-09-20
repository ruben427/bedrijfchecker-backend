// ILS Laboratories — labadapter.
//
// Gevonden 20 september 2026 door het verificatieformulier op ils-lab.com een
// keer met de hand in te vullen en het bijbehorende JavaScript te lezen. De
// keten is:
//
//   GET portal.ils-lab.com/api/coa/verify/<TOEGANGSCODE>  -> { qrCodeId, coaNumber }
//   GET portal.ils-lab.com/api/trpc/publicCoa.getByQrCode?...qrCodeId...  -> het hele rapport als JSON
//
// Een code van 12 tekens of langer IS al een qrCodeId; dan vervalt de eerste
// stap. Dat verklaart de code die pandapeptides publiceert
// (rMDSiG-2VEcGSOWV): geen toegangscode maar een qrCodeId.
//
// WAAROM DIT ANDERS IS DAN JANOSHIK: hier komt gestructureerde data terug, geen
// afbeelding. Geen vision-call, dus geen kosten per rapport, en de velden
// hoeven niet uit een plaatje geraden te worden.
//
// LET OP: elk testresultaat draagt een veld hiddenOnCertificate. Het lab kan
// dus een uitgevoerde test van het gedrukte certificaat weglaten. Dat is via
// deze API zichtbaar en op de PDF niet. Wat dat methodisch betekent is een
// vraag voor de methodiek, niet voor deze adapter - hier wordt het alleen
// vastgelegd.

const { isPublicHttpUrl } = require('./urlGuard');

const TIMEOUT_MS = Number(process.env.LAB_VERIFY_TIMEOUT_MS) || 15000;
const PORTAAL = 'https://portal.ils-lab.com';

// Harde allowlist, zelfde gedachte als bij Janoshik: een rapport dat naar een
// lookalike-domein verwijst is een rode vlag, geen technische storing.
const OFFICIELE_HOSTS = new Set(['portal.ils-lab.com', 'ils-lab.com', 'www.ils-lab.com', 'files.ils-lab.com']);

function isOfficieleHost(url) {
  try { return OFFICIELE_HOSTS.has(new URL(url).hostname.toLowerCase()); } catch (e) { return false; }
}

async function haalJson(url) {
  if (!isPublicHttpUrl(url).ok || !isOfficieleHost(url)) return { fout: 'niet-officieel domein' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'PepProof/1.0 (+https://checker.deannemethode.nl)' }
    });
    if (res.status === 404) return { fout: 'niet gevonden', status: 404 };
    if (!res.ok) return { fout: 'status ' + res.status, status: res.status };
    return { data: await res.json() };
  } catch (e) {
    const naam = (e && e.name) || 'Error';
    return { fout: naam === 'AbortError' ? 'timeout' : 'netwerkfout' };
  } finally {
    clearTimeout(timer);
  }
}

// Een referentie kan een toegangscode zijn (7-8 tekens van het COA) of al een
// qrCodeId (12+). Alleen de eerste vorm vraagt een opzoekstap.
function lijktOpQrCodeId(ref) {
  return String(ref || '').trim().length >= 12;
}

function verifyUrl(qrCodeId) {
  return PORTAAL + '/verify/' + encodeURIComponent(qrCodeId);
}

async function resolveer(referentie) {
  const ref = String(referentie || '').trim();
  if (!ref) return { resolved: false, status: 'geen referentie' };

  let qrCodeId = null;
  let coaNumber = null;

  if (lijktOpQrCodeId(ref)) {
    qrCodeId = ref;
  } else {
    const op = await haalJson(PORTAAL + '/api/coa/verify/' + encodeURIComponent(ref));
    if (op.fout) {
      // 404 betekent hier iets anders dan een storing: de code bestaat niet
      // bij het lab. Dat is een uitkomst, geen technisch probleem.
      return op.status === 404
        ? { resolved: false, status: 'toegangscode bestaat niet bij ILS', code: ref }
        : { resolved: null, status: 'verificatie niet uitvoerbaar: ' + op.fout, code: ref };
    }
    qrCodeId = op.data && op.data.qrCodeId;
    coaNumber = (op.data && op.data.coaNumber) || null;
    if (!qrCodeId) return { resolved: false, status: 'geen qrCodeId teruggegeven', code: ref };
  }

  const invoer = encodeURIComponent(JSON.stringify({ '0': { json: { qrCodeId } } }));
  const rapport = await haalJson(PORTAAL + '/api/trpc/publicCoa.getByQrCode?batch=1&input=' + invoer);
  if (rapport.fout) {
    return { resolved: null, status: 'rapport niet op te halen: ' + rapport.fout, qrCodeId, url: verifyUrl(qrCodeId) };
  }

  const blok = Array.isArray(rapport.data) ? rapport.data[0] : rapport.data;
  const d = blok && blok.result && blok.result.data && blok.result.data.json;
  if (!d) return { resolved: false, status: 'leeg antwoord van het lab', qrCodeId, url: verifyUrl(qrCodeId) };

  const tests = Array.isArray(d.testResults) ? d.testResults : [];
  const verborgen = tests.filter((t) => t && Number(t.hiddenOnCertificate) === 1);
  const identiteit = tests.find((t) => t && /identity/i.test(t.analyte || ''));
  const zuiverheid = tests.find((t) => t && /purity/i.test(t.analyte || ''));
  const gehalte = tests.find((t) => t && /net peptide content|content/i.test(t.analyte || ''));

  return {
    resolved: true,
    status: 'rapport gevonden bij ILS',
    qrCodeId, url: verifyUrl(qrCodeId),
    coaNumber: d.coaNumber || coaNumber || null,
    toegangscode: d.accessCode || (lijktOpQrCodeId(ref) ? null : ref),
    client: d.clientName || null,
    clientWebsite: d.clientWebsite || null,
    product: d.product || null,
    concentratie: d.concentration || null,
    batchnummer: d.lotNumber || null,
    testType: d.testTypeName || null,
    monsterOntvangen: d.sampleReceived || null,
    analyseBevestigd: d.analysisConfirmed || null,
    ondertekenaar: d.signatory ? (d.signatory + (d.signatoryTitle ? (', ' + d.signatoryTitle) : '')) : null,
    pdfUrl: d.pdfUrl || null,
    chromatogramUrl: d.chromatogramUrl || null,
    // Identiteit is hier een echte bepaling: het lab noemt de stof waarop is
    // getoetst (limit) en of die is aangetroffen (result).
    identiteit: identiteit ? {
      verwachteStof: identiteit.limit || null,
      resultaat: identiteit.result || null,
      status: identiteit.status || null
    } : null,
    zuiverheid: zuiverheid ? { resultaat: zuiverheid.result || null, norm: zuiverheid.limit || null, status: zuiverheid.status || null } : null,
    gehalte: gehalte ? { resultaat: gehalte.result || null, eenheid: gehalte.unit || null } : null,
    tests: tests.map((t) => ({
      analyte: t.analyte || null, limiet: t.limit || null, resultaat: t.result || null,
      eenheid: t.unit || null, status: t.status || null,
      verborgenOpCertificaat: Number(t.hiddenOnCertificate) === 1
    })),
    // Het aantal tests dat wel is uitgevoerd maar niet op het gedrukte
    // certificaat staat. Nul is de normale waarde; alles daarboven hoort
    // opgemerkt te worden.
    verborgenOpCertificaat: verborgen.length,
    blend: d.blendComposition || null
  };
}

module.exports = { resolveer, verifyUrl, lijktOpQrCodeId, isOfficieleHost, OFFICIELE_HOSTS };
