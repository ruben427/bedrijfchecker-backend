// Schermafdruk van de website van de leverancier.
//
// Waarom een eigen module: dit is het enige stuk van de backend dat een echte
// browser nodig heeft. Als die browser er op de server niet is, mag dat de
// audit niet breken — dan komt er gewoon geen plaatje en toont de frontend de
// lege plek. Vandaar dat alles hier "mislukken is prima" is.
//
// Formaat komt uit het design: 1200 breed, verhouding 4:3, dus 1200x900.
// Bewaartermijn een maand; daarna maakt de eerstvolgende run een nieuwe.

const { pool } = require('./db');
const urlGuard = require('./urlGuard');

const BREEDTE = 1200;
const HOOGTE = 900;                       // 4:3
const GELDIG_MS = 30 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = Number(process.env.SHOT_TIMEOUT_MS) || 20000;
// Bewust uit tenzij expliciet aangezet: chromium naast Node vraagt honderden
// MB's, en als de container daardoor omvalt sneuvelt de lopende audit mee.
// Zet SITE_SHOT=on in Railway om hem aan te zetten.
const AAN = String(process.env.SITE_SHOT || '').toLowerCase() === 'on';
// Harde bovengrens over het hele maakproces heen, zodat een browser die
// blijft hangen nooit iets openhoudt.
const TOTAAL_MS = Number(process.env.SHOT_TOTAL_MS) || 45000;

function metTijdslimiet(belofte, ms) {
  return new Promise((resolve) => {
    let klaar = false;
    const t = setTimeout(() => { if (!klaar) { klaar = true; resolve(null); } }, ms);
    belofte.then((v) => { if (!klaar) { klaar = true; clearTimeout(t); resolve(v); } })
      .catch(() => { if (!klaar) { klaar = true; clearTimeout(t); resolve(null); } });
  });
}

async function initShotSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_shots (
      supplier_key TEXT PRIMARY KEY,
      url TEXT,
      mimetype TEXT NOT NULL,
      bytes BYTEA NOT NULL,
      width INT,
      height INT,
      captured_at BIGINT NOT NULL
    );
  `);
}

function sleutelVanUrl(input) {
  try {
    const u = new URL(String(input).startsWith('http') ? input : 'https://' + input);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch (e) {
    return String(input || '').trim().toLowerCase();
  }
}

async function getShot(supplierKey) {
  const { rows } = await pool.query(
    'SELECT supplier_key, url, mimetype, bytes, width, height, captured_at FROM site_shots WHERE supplier_key = $1',
    [supplierKey]
  );
  return rows[0] || null;
}

async function saveShot(supplierKey, url, buffer, mimetype) {
  await pool.query(
    `INSERT INTO site_shots (supplier_key, url, mimetype, bytes, width, height, captured_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (supplier_key) DO UPDATE SET
       url = EXCLUDED.url, mimetype = EXCLUDED.mimetype, bytes = EXCLUDED.bytes,
       width = EXCLUDED.width, height = EXCLUDED.height, captured_at = EXCLUDED.captured_at`,
    [supplierKey, url, mimetype, buffer, BREEDTE, HOOGTE, Date.now()]
  );
}

// playwright staat bewust niet in de dependencies: draait de server op een
// image zonder browser, dan blijft dit gewoon null en slaan we de stap over.
function laadChromium() {
  for (const naam of ['playwright', 'playwright-core']) {
    try {
      const mod = require(naam);
      if (mod && mod.chromium) return mod.chromium;
    } catch (e) { /* niet geinstalleerd */ }
  }
  return null;
}

// playwright levert zijn eigen browser mee, maar op een image waar chromium
// via het systeem is geinstalleerd staat die ergens anders. Deze zoekt de
// bekende plekken af; vindt hij niets, dan probeert playwright zijn eigen pad.
function zoekChromium() {
  const fs = require('fs');
  const kandidaten = [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', '/root/.nix-profile/bin/chromium',
    '/nix/var/nix/profiles/default/bin/chromium'
  ];
  for (const k of kandidaten) {
    try { if (fs.existsSync(k)) return k; } catch (e) { /* volgende */ }
  }
  return null;
}

async function maakShot(url) {
  const chromium = laadChromium();
  if (!chromium) return null;
  const opties = { args: [
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--single-process', '--no-zygote', '--disable-extensions',
    '--blink-settings=imagesEnabled=true'
  ] };
  const pad = process.env.CHROMIUM_PATH || zoekChromium();
  if (pad) opties.executablePath = pad;

  let browser = null;
  try {
    browser = await chromium.launch(opties);
    const context = await browser.newContext({
      viewport: { width: BREEDTE, height: HOOGTE },
      deviceScaleFactor: 1,
      // Een gewone desktop-UA: we doen ons niet voor als iets anders dan een
      // browser, maar een kale headless-UA wordt door veel shops geweigerd.
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    // Even laten bezinken: lettertypen, hero-afbeeldingen, cookiebanners.
    await page.waitForTimeout(1500);
    const buffer = await page.screenshot({
      type: 'jpeg', quality: 72,
      clip: { x: 0, y: 0, width: BREEDTE, height: HOOGTE }
    });
    return buffer;
  } catch (e) {
    return null;
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* laat maar */ } }
  }
}

// Zorgt dat er een recente schermafdruk is. Geeft terug wat er gebeurde, zodat
// de pipeline het in de crawl-notities kan zetten.
async function ensureShot(website) {
  if (!AAN) return { status: 'uit (SITE_SHOT staat niet op on)' };
  const supplierKey = sleutelVanUrl(website);
  if (!supplierKey) return { status: 'geen sleutel' };
  const bestaand = await getShot(supplierKey).catch(() => null);
  if (bestaand && (Date.now() - Number(bestaand.captured_at)) < GELDIG_MS) {
    return { status: 'nog geldig', capturedAt: Number(bestaand.captured_at) };
  }
  const url = String(website).startsWith('http') ? website : 'https://' + website;
  // Zelfde poortwachter als de rest van de fetch-laag: geen localhost, geen
  // interne adressen, geen cloud-metadata.
  if (!urlGuard.isPublicHttpUrl(url)) return { status: 'adres niet toegestaan' };
  const buffer = await metTijdslimiet(maakShot(url), TOTAAL_MS);
  if (!buffer) return { status: bestaand ? 'verlopen, nieuwe poging mislukt' : 'geen schermafdruk gemaakt' };
  await saveShot(supplierKey, url, buffer, 'image/jpeg').catch(() => null);
  return { status: 'nieuw gemaakt' };
}

module.exports = { initShotSchema, ensureShot, getShot, sleutelVanUrl, GELDIG_MS };
