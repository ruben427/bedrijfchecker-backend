// ---------------------------------------------------------------------------
// Waar komt deze zin vandaan?
//
// Annemarie gaat de uitkomst redigeren: zij plakt de tekst zoals die er staat
// en schrijft eronder wat het moet zijn. Om daar iets mee te kunnen moet een
// geplakte zin te herleiden zijn - staat hij letterlijk in de code, of is hij
// door het model geschreven? Dat zijn twee heel verschillende correcties. Een
// vaste zin verander je door de string te veranderen; gegenereerde tekst
// verander je door een regel toe te voegen die ook op andere teksten werkt.
//
// Daarom leest dit bestand ONZE EIGEN BRONBESTANDEN en haalt er de letterlijke
// zinnen uit. Bewust geen handgeschreven lijst: die loopt binnen twee weken
// achter op de code, en dan wijst hij naar zinnen die niet meer bestaan.
//
// Het is alleen een aanwijzing. Er hangt geen besluit aan, dus een misser
// kost niets: dan staat er "herkomst onbekend" en zoek ik het zelf op.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

// De bestanden waar tekst in staat die de gebruiker te zien krijgt.
const BRONBESTANDEN = ['blokken.js', 'uitspraken.js', 'niveaus.js', 'dekking.js', 'scoringEngine.js'];

// Korter dan dit is geen zin maar een woord, en die leveren alleen ruis op.
//
// LET OP waarom dit zo laag staat. De eerste versie hield 28 aan en vond
// daardoor precies de zinnen NIET waar het om gaat. "Bij 7 van de 9 rapporten
// is de zuiverheid onafhankelijk bevestigd" bestaat in de code namelijk
// helemaal niet als zin: hij wordt aan elkaar geplakt uit 'Bij ', ' van de ',
// ' rapporten is de ' en ' onafhankelijk bevestigd.'. Stuk voor stuk te kort.
//
// Daarom zoeken we niet naar EEN zin die past, maar naar hoeveel van de
// geplakte tekst wordt gedekt door fragmenten uit hetzelfde bestand. Een zin
// die voor tachtig procent uit onze eigen stukjes bestaat, komt uit onze code.
const MIN_LENGTE = 14;

// Normaliseren voor de vergelijking. Getallen eruit: "Bij 3 van de 12
// rapporten" en "Bij 7 van de 9 rapporten" zijn dezelfde zin. Dat is precies
// waarom een letterlijke vergelijking hier niet werkt.
function kaal(t) {
  return String(t == null ? '' : t)
    .toLowerCase()
    .replace(/\d+([.,]\d+)?/g, ' ')
    .replace(/[^a-zà-ÿ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let registerCache = null;

// Alle letterlijke tekstfragmenten uit onze eigen bronbestanden, met bestand
// en regel. Eenmalig ingelezen; het proces draait toch met vaste bestanden.
function register() {
  if (registerCache) return registerCache;
  const uit = [];
  BRONBESTANDEN.forEach((bestand) => {
    let inhoud;
    try {
      inhoud = fs.readFileSync(path.join(__dirname, bestand), 'utf8');
    } catch (e) {
      return;
    }
    inhoud.split('\n').forEach((regel, i) => {
      // Commentaarregels overslaan: daar staat uitleg, geen uitvoer.
      if (/^\s*(\/\/|\*|\/\*)/.test(regel)) return;
      // LET OP - eerst stond hier /'([^'\\]{14,})'/ met de lengte-eis IN de
      // uitdrukking. Dat koppelt de verkeerde aanhalingstekens aan elkaar:
      // op de regel
      //   zin: 'Bij ' + t.geverifieerd + ' van de ' + ...
      // is 'Bij ' te kort, dus sloeg de uitdrukking het sluitteken over en
      // matchte " + t.geverifieerd + " als tekst. Zo kwam er code in het
      // register en verdwenen de echte fragmenten eruit.
      //
      // Dus: eerst ELK stukje tussen aanhalingstekens pakken, daarna pas op
      // lengte filteren.
      const treffers = (regel.match(/'[^']*'/g) || []).concat(regel.match(/"[^"]*"/g) || []);
      treffers.forEach((ruw) => {
        const zin = ruw.slice(1, -1);
        if (zin.length < MIN_LENGTE) return;
        if (/^[A-Z0-9_]+$/.test(zin)) return;
        if (/https?:\/\/|SELECT |INSERT |CREATE TABLE|ALTER TABLE/i.test(zin)) return;
        if (!/\s/.test(zin)) return;
        const k = kaal(zin);
        if (k.length < 10) return;
        uit.push({ bestand: 'src/' + bestand, regel: i + 1, fragment: zin, kaal: k });
      });
    });
  });
  registerCache = uit;
  return uit;
}

// Hoeveel van de geplakte tekst wordt gedekt door fragmenten uit de code?
// Per bestand geteld, zodat een toevallige treffer in een ander bestand de
// uitslag niet optilt.
function dekking(kaalTekst) {
  const perBestand = new Map();
  register().forEach((r) => {
    let van = kaalTekst.indexOf(r.kaal);
    if (van === -1) return;
    if (!perBestand.has(r.bestand)) perBestand.set(r.bestand, { bestand: r.bestand, stukken: [], regels: [] });
    const vak = perBestand.get(r.bestand);
    while (van !== -1) {
      vak.stukken.push([van, van + r.kaal.length]);
      van = kaalTekst.indexOf(r.kaal, van + 1);
    }
    vak.regels.push({ regel: r.regel, fragment: r.fragment });
  });

  const uit = [];
  perBestand.forEach((vak) => {
    // Overlappende stukken een keer tellen.
    const gesorteerd = vak.stukken.sort((a, b) => a[0] - b[0]);
    let gedekt = 0, tot = -1;
    gesorteerd.forEach(([van, eind]) => {
      const start = Math.max(van, tot);
      if (eind > start) { gedekt += eind - start; tot = eind; }
    });
    uit.push({
      bestand: vak.bestand,
      aandeel: kaalTekst.length ? Math.round((gedekt / kaalTekst.length) * 100) / 100 : 0,
      regels: vak.regels.sort((a, b) => a.regel - b.regel).slice(0, 6)
    });
  });
  return uit.sort((a, b) => b.aandeel - a.aandeel);
}

// De hoofdvraag: staat deze tekst in onze code, of komt hij uit het model?
//
// Drie uitkomsten, en het verschil doet ertoe:
//   vast         de zin is grotendeels uit onze eigen stukjes opgebouwd
//   gegenereerd  bijna niets komt terug; dan is het modeltekst
//   onzeker      ertussenin - waarschijnlijk modeltekst die een vaste zin
//                parafraseert, en dat is juist een interessant geval
function zoekHerkomst(tekst) {
  const t = String(tekst || '').trim();
  if (t.length < 12) return { soort: 'te kort', kandidaten: [] };

  const k = kaal(t);
  const gevonden = dekking(k);
  const beste = gevonden[0] || null;
  const aandeel = beste ? beste.aandeel : 0;

  if (aandeel >= 0.6) {
    return {
      soort: 'vast', bron: beste, aandeel, kandidaten: gevonden.slice(0, 3),
      uitleg: 'Deze zin komt uit ' + beste.bestand + ' (rond regel ' +
        beste.regels.map((r) => r.regel).join(', ') + '). Een correctie hierop is een wijziging van ' +
        'die zin in de code, en geldt meteen voor elk rapport.'
    };
  }
  if (aandeel >= 0.25) {
    return {
      soort: 'onzeker', bron: beste, aandeel, kandidaten: gevonden.slice(0, 3),
      uitleg: 'Een deel van deze tekst staat in ' + beste.bestand + ', de rest niet. Waarschijnlijk heeft ' +
        'het model een vaste zin omschreven of er iets aan toegevoegd. Dat is een interessant geval: ' +
        'dan lopen de vaste tekst en de gegenereerde tekst uit elkaar.'
    };
  }
  return {
    soort: 'gegenereerd', aandeel, kandidaten: gevonden.slice(0, 2),
    uitleg: 'Deze tekst staat niet in onze code. Hij is per run door het model geschreven, dus een ' +
      'correctie hierop hoort een schrijfregel te worden die ook op andere rapporten werkt.'
  };
}

module.exports = { zoekHerkomst, register, kaal, dekking, BRONBESTANDEN };
