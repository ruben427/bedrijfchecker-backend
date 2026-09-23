// Toegangscontrole voor de publieke API.
//
// Ontwerpkeuze: geen accounts, geen login — dat was expliciet de bedoeling van
// Path B (bezoekers hoeven nergens voor in te loggen). In plaats daarvan houdt
// elke browser één willekeurig "owner token" in localStorage. De backend
// bewaart alleen de SHA-256 daarvan bij de case. Daarmee geldt:
//
//   - een case is alleen leesbaar voor de browser die hem heeft aangemaakt;
//   - /api/audits geeft alleen de cases van die ene browser terug;
//   - een onraadbaar case-id is nooit meer de enige bescherming.
//
// ADMIN_TOKEN (env) geeft volledige toegang, inclusief de audit trace.

const crypto = require('crypto');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Constant-time vergelijking die niet lekt via de lengte.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readToken(req) {
  const header = req.get('X-Owner-Token');
  if (header && header.trim()) return header.trim();
  const auth = req.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : null;
}

// Minimale eisen aan een client-gegenereerd token: lang en willekeurig genoeg
// dat raden zinloos is. Te korte tokens weigeren we, anders kan een client
// zichzelf met "1" als eigenaar van niets-in-het-bijzonder opvoeren en later
// per ongeluk met een ander botsen.
function isPlausibleToken(token) {
  return typeof token === 'string' && token.length >= 32 && token.length <= 512 && /^[A-Za-z0-9_-]+$/.test(token);
}

// Leestoken (VIEWER_TOKEN): alleen kijken, niets veranderen.
//
// Waarom apart van ADMIN_TOKEN: wie meekijkt hoeft niet te kunnen uploaden,
// verifieren of resolvers starten. En als een leestoken uitlekt hoeft alleen
// dat ene token vervangen te worden, niet de sleutel waar alles aan hangt.
//
// Het mag een wachtwoordzin zijn in plaats van een willekeurige sleutel - het
// is hetzelfde mechanisme, een gedeeld geheim. Maar korter dan 16 tekens
// weigert de server, anders is "leestoken" een mooi woord voor een zwak
// wachtwoord. Vier willekeurige woorden achter elkaar is prima en typt beter
// dan een sleutel.
const MIN_LEESTOKEN = 16;

function tokenGeldig(naam) {
  const t = process.env[naam];
  if (!t) return null;
  if (String(t).length < MIN_LEESTOKEN) {
    console.warn('[auth] ' + naam + ' is korter dan ' + MIN_LEESTOKEN + ' tekens en wordt genegeerd.');
    return null;
  }
  if (process.env.ADMIN_TOKEN && String(t) === String(process.env.ADMIN_TOKEN)) {
    console.warn('[auth] ' + naam + ' is gelijk aan ADMIN_TOKEN en wordt genegeerd.');
    return null;
  }
  return String(t);
}

function leestokenGeldig() {
  return tokenGeldig('VIEWER_TOKEN');
}

// DRIE ROLLEN, 22 september. Er zijn drie sleutels en ze doen alle drie iets
// anders:
//
//   ADMIN_TOKEN          beheerder    alles, inclusief uploaden, resolverruns
//                                     en de audit trace
//   COA_REDACTIE_TOKEN   beoordelaar  kijken en oordelen: labstanden,
//                                     naamkoppelingen, teksten
//   VIEWER_TOKEN         lezer        alleen kijken, niets aanpassen
//
// Tot vandaag mocht het leestoken wel degelijk iets veranderen - het
// labooordeel - en dat was een bewuste uitzondering met een reden: het
// labooordeel is Annemarie's werk en zij had geen eigen sleutel. Die reden is
// er niet meer, want die sleutel bestaat nu. De uitzondering is daarmee weg en
// 'alleen lezen' betekent weer wat het zegt.
//
// Twee sleutels voor dezelfde rol, 22 september.
//
// De beoordelaar werkt op twee plekken: op de stafpagina's (deze HTTP-kant) en
// via de connector (de MCP-kant, COA_REDACTIE_TOKEN). Dat waren twee losse
// geheimen voor een en dezelfde persoon met een en dezelfde rol, en dan wordt
// er een van de twee ergens opgeschreven.
//
// Daarom telt COA_REDACTIE_TOKEN hier ook als leestoken. VIEWER_TOKEN blijft
// werken, zodat bestaande koppelingen niet omvallen.
//
// LET OP de grens die blijft staan: dit geeft de REDACTIEROL op de HTTP-kant,
// niet de beheerdersrol. Uploaden, resolverruns en de audit trace hangen aan
// ADMIN_TOKEN en dat verandert hier niet.
function pastBij(req, naam) {
  const token = readToken(req);
  if (!token) return false;
  const sleutel = tokenGeldig(naam);
  if (!sleutel) return false;
  return safeEqual(token, sleutel);
}

// De beoordelaar: kijken en oordelen.
function isBeoordelaar(req) {
  return pastBij(req, 'COA_REDACTIE_TOKEN');
}

// De lezer: alleen kijken.
function isLezer(req) {
  return pastBij(req, 'VIEWER_TOKEN');
}

// Blijft bestaan en betekent nog steeds "geen beheerder, wel binnen". Wordt
// gebruikt waar het alleen om toegang tot LEZEN gaat.
function isViewer(req) {
  return isBeoordelaar(req) || isLezer(req);
}

function isAdmin(req) {
  const admin = process.env.ADMIN_TOKEN;
  if (!admin) return false;
  const token = readToken(req);
  if (!token) return false;
  return safeEqual(token, admin);
}

// Vereist een geldig owner token. Zet req.ownerTokenHash / req.isAdmin.
function requireOwnerToken(req, res, next) {
  req.isAdmin = isAdmin(req);
  req.isBeoordelaar = !req.isAdmin && isBeoordelaar(req);
  req.isLezer = !req.isAdmin && !req.isBeoordelaar && isLezer(req);
  req.isViewer = req.isBeoordelaar || req.isLezer;
  req.rol = req.isAdmin ? 'beheerder' : (req.isBeoordelaar ? 'beoordelaar' : (req.isLezer ? 'lezer' : null));
  // Een BEHEERDER hoeft geen eigenaarshash: requireCaseAccess laat hem bij elke
  // case en listCases() geeft hem alles.
  if (req.isAdmin) {
    req.ownerTokenHash = null;
    return next();
  }
  // Een BEOORDELAAR of LEZER wel. Hier stond isViewer bij de regel hierboven,
  // en dat maakte een stille val, 23 september gemeten op de live backend:
  //
  //   POST /api/audits met een rolsleutel  -> 201, case aangemaakt
  //   GET  /api/audits/:id met diezelfde   -> 404
  //   GET  /api/audits (de lijst)          -> 0
  //
  // De case kreeg owner_token_hash NULL, en daarop geeft requireCaseAccess
  // bewust 404 ("bestaat niet" en "niet van jou" zijn dezelfde melding). De
  // run draaide gewoon door op de server; alleen kon niemand hem meer opvragen.
  // De checker vertaalde die 404 naar null zonder fout, dus het zag eruit als
  // vastlopen.
  //
  // LET OP waarom de plausibiliteitstest hier NIET geldt: een leestoken mag
  // een wachtwoordzin zijn (spaties, korter dan 32). Die eis stellen zou een
  // lezer op alles een 401 geven. Voor de hash maakt de vorm niet uit.
  if (req.isViewer) {
    req.ownerTokenHash = hashToken(readToken(req));
    return next();
  }
  const token = readToken(req);
  if (!isPlausibleToken(token)) {
    return res.status(401).json({ error: 'missing_owner_token', message: 'Deze aanvraag heeft een geldig owner token nodig.' });
  }
  req.ownerTokenHash = hashToken(token);
  next();
}

// Vereist dat de aanvrager eigenaar (of admin) is van de case in :id.
// Laadt de case en hangt hem aan req.case, zodat de route hem niet nog een
// keer hoeft op te halen.
// TWEE SMAKEN, en het verschil is lezen tegenover doen.
//
// requireCaseAccess(db) is de strenge: alleen de eigenaar van de case en de
// beheerder komen erdoor. Die hangt onder alles wat iets DOET - stoppen,
// hervatten, opnieuw draaien, doorzetten naar de deep dive.
//
// requireCaseAccess(db, { staf: true }) laat er ook een beoordelaar en een
// lezer bij. BESLUIT RUBEN 23 september: de staf mag elk gedraaid rapport
// lezen, anders ziet Annemarie in de admin een lijst met checks waar ze niet
// in kan kijken. Die hangt alleen onder de GET-routes.
//
// LET OP dat dit bewust NIET in een regel is samengevat. Een lezer die overal
// bij mag lezen is een keuze; een lezer die overal een run kan stoppen of
// opnieuw kan starten is een ongeluk.
function requireCaseAccess(db, opties) {
  const stafMagLezen = !!(opties && opties.staf);
  return async function (req, res, next) {
    try {
      const c = await db.getCase(req.params.id);
      // Bewust dezelfde 404 voor "bestaat niet" en "niet van jou": anders is
      // het statusverschil zelf een manier om te ontdekken welke case-ids
      // bestaan.
      if (!c) return res.status(404).json({ error: 'not_found' });
      if (req.isAdmin) { req.case = c; return next(); }
      if (stafMagLezen && req.isViewer) { req.case = c; return next(); }
      if (!c.ownerTokenHash || c.ownerTokenHash !== req.ownerTokenHash) {
        return res.status(404).json({ error: 'not_found' });
      }
      req.case = c;
      next();
    } catch (e) {
      next(e);
    }
  };
}

module.exports = { hashToken, readToken, isAdmin, isViewer, isBeoordelaar, isLezer, isPlausibleToken, requireOwnerToken, requireCaseAccess, safeEqual, MIN_LEESTOKEN, tokenGeldig };
