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
function isViewer(req) {
  const token = readToken(req);
  if (!token) return false;
  const sleutels = [leestokenGeldig(), tokenGeldig('COA_REDACTIE_TOKEN')].filter(Boolean);
  return sleutels.some((s) => safeEqual(token, s));
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
  req.isViewer = !req.isAdmin && isViewer(req);
  if (req.isAdmin || req.isViewer) {
    req.ownerTokenHash = null;
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
function requireCaseAccess(db) {
  return async function (req, res, next) {
    try {
      const c = await db.getCase(req.params.id);
      // Bewust dezelfde 404 voor "bestaat niet" en "niet van jou": anders is
      // het statusverschil zelf een manier om te ontdekken welke case-ids
      // bestaan.
      if (!c) return res.status(404).json({ error: 'not_found' });
      if (req.isAdmin) { req.case = c; return next(); }
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

module.exports = { hashToken, readToken, isAdmin, isViewer, isPlausibleToken, requireOwnerToken, requireCaseAccess, safeEqual, MIN_LEESTOKEN, tokenGeldig };
