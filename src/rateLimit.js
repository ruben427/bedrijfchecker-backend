// Rate limiting zonder externe dependency.
//
// Belangrijk detail voor dit product: POST /api/audits start een relevantie-
// check (betaalde AI-call) VOORDAT er een case bestaat. Een geweigerde aanvraag
// kost dus al geld. De strenge limiter hoort daarom vóór die route te staan,
// niet erin.
//
// In-memory sliding window. Eén Railway-instantie = één venster; bij meerdere
// instanties telt elke instantie apart. Dat is voor deze schaal voldoende;
// vervang de store door Redis/Postgres zodra er horizontaal geschaald wordt.

const WINDOWS = new Map();

function prune(hits, since) {
  let i = 0;
  while (i < hits.length && hits[i] < since) i++;
  return i > 0 ? hits.slice(i) : hits;
}

// Voorkomt onbeperkte geheugengroei door verlaten sleutels.
let lastSweep = Date.now();
function sweep(now, maxWindowMs) {
  if (now - lastSweep < 60000) return;
  lastSweep = now;
  for (const [key, hits] of WINDOWS) {
    if (!hits.length || hits[hits.length - 1] < now - maxWindowMs) WINDOWS.delete(key);
  }
}

function rateLimit(options) {
  const name = options.name;
  const windowMs = options.windowMs;
  const max = options.max;
  const message = options.message || 'Te veel aanvragen. Probeer het over een moment opnieuw.';

  return function (req, res, next) {
    const now = Date.now();
    sweep(now, windowMs);

    // Sleutel op owner token als dat er is, anders op IP. Zo raakt één
    // gedeeld kantoor-IP niet meteen iedereen kwijt, en blijft een client
    // die telkens een nieuw token verzint alsnog op zijn IP begrensd.
    const token = req.get('X-Owner-Token');
    const key = name + '|' + (token ? 't:' + token.slice(0, 24) : 'ip:' + req.ip);

    const hits = prune(WINDOWS.get(key) || [], now - windowMs);
    if (hits.length >= max) {
      const retryAfter = Math.ceil((hits[0] + windowMs - now) / 1000);
      res.set('Retry-After', String(Math.max(1, retryAfter)));
      return res.status(429).json({ error: 'rate_limited', message, retryAfterSeconds: Math.max(1, retryAfter) });
    }
    hits.push(now);
    WINDOWS.set(key, hits);
    next();
  };
}

// Startlimiet bewust laag: een audit kost meerdere AI-calls en loopt minuten.
const startAudit = rateLimit({
  name: 'start',
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUDITS_PER_HOUR || 10),
  message: 'Je kunt maximaal een beperkt aantal audits per uur starten.'
});

// Acties op een bestaande case (stop, retry-step, continue-deep) zijn goedkoper
// dan een nieuwe audit, maar retry-step draait wel opnieuw AI-stappen.
const caseAction = rateLimit({
  name: 'action',
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_ACTIONS_PER_10MIN || 30)
});

// Lezen mag ruim: de frontend pollt elke 4 seconden tijdens een lopende audit.
const read = rateLimit({
  name: 'read',
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_READS_PER_MIN || 120)
});

module.exports = { rateLimit, startAudit, caseAction, read };
