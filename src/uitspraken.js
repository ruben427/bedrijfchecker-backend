// ---------------------------------------------------------------------------
// Wat de FREE mag zeggen, en waar de grenzen liggen.
//
// Vastgesteld door Annemarie op 20 september 2026, in het Regelblad onder
// Methodiek werking. Alles hier is haar besluit; de code leidt het alleen af.
//
// WAAROM OP EEN PLEK. Een uitspraak die per rapport opnieuw wordt
// geformuleerd gaat schuiven. Vandaag is het "niet ingestuurd door deze
// aanbieder", morgen "waarschijnlijk niet van deze aanbieder", en niemand
// heeft dat besloten. Door de tekst hier vast te leggen is een wijziging een
// besluit in plaats van een verschrijving.
//
// HARDE GRENS: dit bestand stelt niets vast. Het zet vast wat er gezegd mag
// worden zodra iets elders is vastgesteld.
// ---------------------------------------------------------------------------

const VASTGESTELD_OP = '2026-09-20';
const VASTGESTELD_DOOR = 'Annemarie';

// --- B-1 -------------------------------------------------------------------
// "Vanaf 10% afwijking benoemen we dit als duidelijke bevinding. Zowel
// ondervulling als overvulling telt mee. Meer is namelijk niet automatisch
// beter. Als een vial 10 mg claimt en er wordt 12 mg gemeten, is dat gewoon
// 20% meer dan wat er op het label staat. Zeker wanneer iemand doseert op
// basis van dat label vind ik dat relevante informatie."
//
// WAARTEGEN (comment Annemarie, 20 sep 19:39): "De 10% meten we altijd tegen
// de hoeveelheid die de leverancier voor dat specifieke product claimt."
//
// PER VIAAL, NIET TEGEN HET GEMIDDELDE: "Als meerdere vials uit dezelfde
// test/batch zijn gemeten, wil ik niet alleen het gemiddelde gebruiken. Iedere
// gemeten vial telt afzonderlijk. Anders kan een afwijkende vial verdwijnen in
// een mooi gemiddelde." Het gemiddelde mag er als extra informatie bij staan.
//
// Dat is een wijziging op wat de server deed: vullingUit() rekende het
// percentage uit het GEMIDDELDE van de vialen. Bij Uther #214044 maakt dat
// niets uit - alle drie zitten ruim boven de drempel - maar bij een reeks
// waarin er een uitschiet, verdween die in het gemiddelde.
//
// "Als vials uiteenlopen, wil ik dat juist kunnen zien. Bijvoorbeeld: 3 vials
// getest, waarvan 1 meer dan 10% afwijkt. Dan is dat de bevinding, niet
// automatisch dat de hele batch meer dan 10% afwijkt."
const VULLING_DREMPEL_PCT = 10;

// Hoe betrouwbaar is de waarde waar we iets over zeggen? (comment Annemarie,
// 20 sep 19:41): "Een waarde die alleen door de AI-leesstap uit een COA is
// gehaald en niet is gecontroleerd, wil ik niet als harde 'gemeten afwijking'
// aan de gebruiker tonen. De AI mag deze waarden wel uitlezen en intern
// gebruiken als signaal (...) Dus ook onder de 10% geldt: alleen tonen als
// feit wanneer de onderliggende waarde voldoende is geverifieerd."
//
// Drie herkomsten, oplopend in gewicht. Alleen de bovenste twee mogen als
// feit naar buiten.
const HERKOMST = {
  handmatig: { feit: true,  label: 'door een mens gecontroleerd' },
  resolver:  { feit: true,  label: 'bij het laboratorium opgehaald' },
  gelezen:   { feit: false, label: 'uit het document gelezen, niet geverifieerd' }
};
function magAlsFeit(herkomst) {
  const h = HERKOMST[herkomst];
  return !!(h && h.feit);
}

// Een enkele meting tegen de claim van dat product.
function vullingVanEen(gemetenMg, geclaimdMg, herkomst) {
  const g = Number(gemetenMg), c = Number(geclaimdMg);
  if (!Number.isFinite(g) || !Number.isFinite(c) || c <= 0) {
    return { toetsbaar: false, reden: 'geen geclaimde hoeveelheid om tegen te meten' };
  }
  const pct = ((g - c) / c) * 100;
  const buiten = Math.abs(pct) >= VULLING_DREMPEL_PCT;
  return {
    toetsbaar: true, gemetenMg: g, geclaimdMg: c,
    pct: Math.round(pct * 100) / 100,
    buitenDrempel: buiten,
    richting: pct > 0 ? 'boven' : (pct < 0 ? 'onder' : 'gelijk'),
    // Mag dit getal als feit op het scherm? Zie HERKOMST.
    alsFeit: magAlsFeit(herkomst),
    herkomst: herkomst || null
  };
}

// Een rapport kan een vial meten of meerdere. Iedere vial telt afzonderlijk.
// metingen: [{gemetenMg}] of een enkel getal; geclaimdMg is wat de leverancier
// voor DIT product zegt dat erin zit.
function vullingOordeel(metingen, geclaimdMg, herkomst) {
  const lijst = Array.isArray(metingen) ? metingen : [{ gemetenMg: metingen }];
  const per = lijst.map((m) => vullingVanEen(m && m.gemetenMg != null ? m.gemetenMg : m, geclaimdMg, herkomst));
  const toetsbaar = per.filter((x) => x.toetsbaar);
  if (!toetsbaar.length) {
    return { bevinding: false, tonen: false, perViaal: per, reden: per[0] ? per[0].reden : 'niets te toetsen' };
  }
  const buiten = toetsbaar.filter((x) => x.buitenDrempel);
  const alsFeit = magAlsFeit(herkomst);

  // Het gemiddelde mag erbij als EXTRA informatie - nooit als de toets zelf.
  const gemiddeld = Math.round((toetsbaar.reduce((a, b) => a + b.gemetenMg, 0) / toetsbaar.length) * 1000) / 1000;
  const gemiddeldPct = Math.round((((gemiddeld - toetsbaar[0].geclaimdMg) / toetsbaar[0].geclaimdMg) * 100) * 100) / 100;

  let zin = null;
  if (buiten.length && alsFeit) {
    if (toetsbaar.length === 1) {
      const x = buiten[0];
      zin = 'De gemeten hoeveelheid ligt ' + Math.abs(Math.round(x.pct * 10) / 10) + '% ' + x.richting +
        ' wat de aanbieder voor dit product claimt (' + x.gemetenMg + ' mg tegen ' + x.geclaimdMg + ' mg).';
    } else if (buiten.length === toetsbaar.length) {
      zin = 'Alle ' + toetsbaar.length + ' gemeten vials wijken meer dan ' + VULLING_DREMPEL_PCT +
        '% af van wat de aanbieder voor dit product claimt (' + toetsbaar[0].geclaimdMg + ' mg): ' +
        toetsbaar.map((x) => x.gemetenMg + ' mg').join(', ') + '.';
    } else {
      // Precies het geval dat zij wilde kunnen zien.
      zin = 'Van de ' + toetsbaar.length + ' gemeten vials wijk' + (buiten.length === 1 ? 't er 1' : 'en er ' + buiten.length) +
        ' meer dan ' + VULLING_DREMPEL_PCT + '% af van de geclaimde ' + toetsbaar[0].geclaimdMg + ' mg: ' +
        buiten.map((x) => x.gemetenMg + ' mg (' + (x.pct > 0 ? '+' : '') + x.pct + '%)').join(', ') +
        '. De overige ' + (toetsbaar.length - buiten.length) + ' liggen binnen de ' + VULLING_DREMPEL_PCT + '%.';
    }
  }
  return {
    bevinding: buiten.length > 0 && alsFeit,
    // Niet als feit tonen wanneer de waarde alleen gelezen is. Intern blijft
    // alles staan - perViaal is er altijd - maar naar buiten niets.
    tonen: alsFeit,
    internSignaal: buiten.length > 0 && !alsFeit,
    aantalGemeten: toetsbaar.length,
    aantalBuitenDrempel: buiten.length,
    perViaal: per,
    gemiddelde: toetsbaar.length > 1 ? { mg: gemiddeld, pct: gemiddeldPct, rol: 'extra informatie, niet de toets' } : null,
    herkomst: herkomst || null,
    zin,
    reden: alsFeit ? null : 'waarde is ' + ((HERKOMST[herkomst] || {}).label || 'van onbekende herkomst') +
      '; nog niet als feit te tonen'
  };
}

// Blends. (comment Annemarie): "Bij blends zoals GLOW moeten we nog een aparte
// regel maken. Als alleen '70 mg totaal' wordt geclaimd en nergens staat
// hoeveel van iedere afzonderlijke stof erin hoort te zitten, kunnen we de
// afzonderlijke componenten niet eerlijk tegen een geclaimde hoeveelheid
// toetsen. Dan kunnen we alleen toetsen wat daadwerkelijk wordt geclaimd."
//
// Dus: is er een claim per stof, dan toetst elke stof apart. Is die er niet,
// dan is de som tegen de totaalclaim het enige dat eerlijk te toetsen is - en
// de componenten blijven waarneming.
function vullingBlend(componenten, totaalGeclaimdMg, herkomst, lijstIsCompleet) {
  const comps = (componenten || []).filter(Boolean);
  if (!comps.length) return null;
  const metClaim = comps.filter((c) => Number(c.geclaimdMg) > 0);
  if (metClaim.length === comps.length) {
    return {
      wijze: 'per stof',
      perStof: comps.map((c) => Object.assign({ stof: c.stof }, vullingVanEen(c.gemetenMg, c.geclaimdMg, herkomst)))
    };
  }
  const som = comps.reduce((a, c) => a + (Number(c.gemetenMg) || 0), 0);
  const ontbreekt = comps.filter((c) => !(Number(c.gemetenMg) > 0));
  // LET OP: een som is alleen eerlijk als we ALLE stoffen hebben. Leest de
  // leesstap er twee van de vijf, dan telt de som op tot een fractie van het
  // etiket en ziet een blend eruit als zwaar ondervuld - terwijl er niets aan
  // de hand hoeft te zijn. Dat is precies de conclusie die groter is dan het
  // bewijs. Dus: geen totaaltoets zonder de zekerheid dat de lijst compleet is.
  // Die zekerheid moet de aanroeper geven (volledigeComponentenlijst), omdat
  // alleen daar bekend is of het rapport is uitgelezen of overgetypt.
  // Expliciet bevestigen, niet afleiden. Eerst stond hier een check die op
  // 'niet false' testte, en undefined is niet false - dus een lijst waarvan
  // niemand iets had gezegd gold als compleet. Precies de stille aanname die
  // we hier niet willen: de aanroeper moet ZEGGEN dat hij alles heeft.
  const volledig = lijstIsCompleet === true && !ontbreekt.length;
  let totaal;
  if (!(Number(totaalGeclaimdMg) > 0)) {
    totaal = { toetsbaar: false, reden: 'geen totaalclaim gevonden' };
  } else if (!volledig) {
    totaal = {
      toetsbaar: false, somMg: Math.round(som * 1000) / 1000,
      reden: ontbreekt.length
        ? 'van ' + ontbreekt.length + ' van de ' + comps.length + ' stoffen is geen hoeveelheid gelezen; ' +
          'de som zegt dan niets over de vulling'
        : 'niet vastgesteld dat alle stoffen van deze blend zijn gelezen; ' +
          'een onvolledige som leest als ondervulling die er niet hoeft te zijn'
    };
  } else {
    totaal = Object.assign({ somMg: Math.round(som * 1000) / 1000 }, vullingVanEen(som, totaalGeclaimdMg, herkomst));
  }
  return {
    wijze: 'alleen het totaal',
    reden: 'de aanbieder claimt geen hoeveelheid per stof, alleen een totaal; ' +
      'de stoffen afzonderlijk zijn daarom niet tegen een claim te toetsen',
    perStofWaarneming: comps.map((c) => ({ stof: c.stof, gemetenMg: c.gemetenMg })),
    totaal
  };
}

// --- B-3 en B-4, en de bijvraag bij A-2 ------------------------------------
// Drie keer hetzelfde besluit, dus een mechanisme.
//
// "Ik wil hier geen willekeurig minimum aan hangen. Ook een gecontroleerd
// rapport kan relevante informatie geven, zolang we maar heel duidelijk zijn
// over hoeveel rapporten daadwerkelijk zijn gecontroleerd. De conclusie mag
// nooit groter worden gemaakt dan het bewijs dat we hebben."
//
// Er is dus GEEN ondergrens. Wat er wel is: elke uitspraak draagt zijn eigen
// noemer mee. Een uitspraak zonder telling hoort niet naar buiten te kunnen,
// en daarom geeft deze functie null terug in plaats van een lege string - dan
// valt het op in plaats van weg.
function dekking(gecontroleerd, getoond) {
  const g = Number(gecontroleerd);
  const t = Number(getoond);
  if (!Number.isFinite(g) || g <= 0) return null;
  if (!Number.isFinite(t) || t < g) {
    return { gecontroleerd: g, getoond: null, zin: 'Gebaseerd op ' + g + ' gecontroleerd' + (g === 1 ? ' rapport' : 'e rapporten') + '.' };
  }
  return {
    gecontroleerd: g, getoond: t, volledig: g === t,
    zin: g === t
      ? 'Alle ' + t + ' getoonde rapporten zijn gecontroleerd.'
      : 'Gebaseerd op ' + g + ' van de ' + t + ' getoonde rapporten. Over de overige ' +
        (t - g) + ' doen wij geen uitspraak.'
  };
}

// --- A-1 -------------------------------------------------------------------
// Door Annemarie herschreven en vastgesteld. Drie dingen veranderden ten
// opzichte van mijn concept, en ze zijn geen van drieen cosmetisch:
//
//  1. Haar naam staat in de tekst. "Anne heeft dit laboratorium uitgebreid
//     onderzocht" - de lezer hoort te weten dat hier een mens naar heeft
//     gekeken, niet een regel.
//  2. Scherper wat er niet kon: niet "het lab niet bevestigd" maar "niet
//     kunnen verifieren dat het daadwerkelijk als laboratorium opereert".
//     Het bedrijf kan bestaan; de vraag is of het een lab is.
//  3. Een slotzin die mijn versie miste: "Wel stopt hier de onafhankelijke
//     verificatie." Zonder die zin leest de disclaimer als een vrijspraak.
const LAB_NAAM_NOEMEN = true;

function labNietVerifieerbaar(labnaam, oordeel) {
  if (!oordeel || oordeel.status === 'erkend') return null;
  const naam = LAB_NAAM_NOEMEN && labnaam ? labnaam : 'het laboratorium dat deze aanbieder gebruikt';
  return {
    definitief: true, vastgesteldOp: VASTGESTELD_OP, vastgesteldDoor: VASTGESTELD_DOOR,
    regels: [
      'De laboratoriumrapporten van deze aanbieder komen van ' + naam +
        '. Anne heeft dit laboratorium uitgebreid onderzocht, maar kon niet onafhankelijk verifieren dat het daadwerkelijk als laboratorium opereert. ' +
        'Ook na meerdere verzoeken heeft de aanbieder geen aanvullende bedrijfsgegevens van het lab verstrekt.',
      'Daarmee blijven identiteit, zuiverheid en hoeveelheid die uitsluitend op deze rapporten rusten onbevestigd. Niet weerlegd, maar ook niet onafhankelijk bevestigd.',
      'Dit betekent niet dat het laboratorium niet bestaat of dat de rapporten onjuist zijn. Wel stopt hier de onafhankelijke verificatie.'
    ]
  };
}

// --- A-2 -------------------------------------------------------------------
// Drie regels die apart blijven. Zodra ze in een zin staan ontstaat een
// vaststelling met een ontsnapping erin, en zo'n zin kun je zo vaak herhalen
// dat hij niets meer zegt.
//
// REGEL 2 IS AANGEPAST DOOR ANNEMARIE. Er stond: "Wie de test bestelt, bepaalt
// welk monster naar het laboratorium gaat. Dat monster is niet door deze
// aanbieder ingestuurd." Dat beweert iets over een handeling die wij nooit
// hebben gezien. Haar versie beweert iets over de koppeling, en dat is wat we
// wel kunnen vaststellen: "We weten wie als opdrachtgever op de rapporten
// staat, maar niet wie het monster daadwerkelijk heeft ingestuurd."
function opdrachtgeverRegels(beeld, shopnaam, dekkingszin) {
  if (!beeld || !beeld.metOpdrachtgever) return null;
  const naam = shopnaam || 'deze aanbieder';
  const grootste = beeld.anderen && beeld.anderen.length
    ? beeld.anderen.slice().sort((a, b) => b.aantal - a.aantal)[0]
    : null;

  let feit;
  if (beeld.geenEnkeleOpEigenNaam && grootste && beeld.anderen.length === 1) {
    feit = 'Van de ' + beeld.metOpdrachtgever + ' labrapporten waarvan wij konden nagaan wie ze bestelde, ' +
      'staat er geen enkele op naam van ' + naam + '. Alle ' + grootste.aantal +
      ' zijn besteld door ' + grootste.opdrachtgever + '.';
  } else if (beeld.geenEnkeleOpEigenNaam) {
    feit = 'Van de ' + beeld.metOpdrachtgever + ' labrapporten waarvan wij konden nagaan wie ze bestelde, ' +
      'staat er geen enkele op naam van ' + naam + '. Ze zijn besteld door ' +
      beeld.anderen.map((a) => a.opdrachtgever + ' (' + a.aantal + ')').join(', ') + '.';
  } else if (beeld.opNaamVanAnder) {
    feit = 'Van de ' + beeld.metOpdrachtgever + ' labrapporten waarvan wij konden nagaan wie ze bestelde, ' +
      'staan er ' + beeld.opNaamVanAnder + ' op naam van een andere partij: ' +
      beeld.anderen.map((a) => a.opdrachtgever + ' (' + a.aantal + ')').join(', ') + '.';
  } else {
    return null;  // alles op eigen naam: hier valt niets te melden
  }

  return {
    definitief: true, vastgesteldOp: VASTGESTELD_OP, vastgesteldDoor: VASTGESTELD_DOOR,
    regels: [
      feit,
      'Daardoor kunnen we deze labrapporten niet rechtstreeks koppelen aan deze aanbieder. ' +
        'We weten wie als opdrachtgever op de rapporten staat, maar niet wie het monster daadwerkelijk heeft ingestuurd.',
      'Dit zegt niet dat de rapporten onjuist zijn, en niet dat het product afwijkt van wat er staat.'
    ],
    dekking: dekkingszin || null
  };
}

// --- A-3 -------------------------------------------------------------------
// Bij meerdere beloofde drempels toetsen we tegen de SOEPELSTE. Belooft een
// shop op dezelfde pagina >=99% en >=98%, dan is 98% de lat. Wie zichzelf
// tegenspreekt krijgt het voordeel van de twijfel; hij faalt dan nog steeds
// tegen zijn eigen soepelste woord.
function beloftetoets(drempels, onderDrempel, laagste) {
  const geldig = (drempels || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!geldig.length || !onderDrempel || !onderDrempel.length) return null;
  const lat = Math.min.apply(null, geldig);
  const laagsteRegel = laagste && laagste.product
    ? ' het laagste is ' + laagste.product + ' met ' + laagste.pct + '%.'
    : '';
  return {
    definitief: true, vastgesteldOp: VASTGESTELD_OP, vastgesteldDoor: VASTGESTELD_DOOR,
    lat, meerdereDrempels: geldig.length > 1,
    regels: [
      'Deze aanbieder stelt zelf een zuiverheidsdrempel van >=' + lat + '%. Op de eigen productpagina\'s staan ' +
        onderDrempel.length + ' product' + (onderDrempel.length === 1 ? '' : 'en') + ' die daaronder liggen;' +
        (laagsteRegel || ' de cijfers komen van de aanbieder zelf.')
    ]
  };
}

// Openheid apart benoemen. "Dat verandert de bevinding niet, maar geeft wel
// een eerlijker en completer beeld." Dus: een eigen regel, naast de bevinding,
// nooit erin verwerkt - anders verzacht het de bevinding in plaats van hem aan
// te vullen.
function openheidNaastBevinding(publiceertZelf) {
  if (!publiceertZelf) return null;
  return 'Deze aanbieder publiceert zelf de cijfers die zijn eigen belofte tegenspreken.';
}

// --- C-2 -------------------------------------------------------------------
// "PepProof moet niet alleen laten zien wat er niet klopt. Als Anne iets
// grondig heeft onderzocht en daarbij geen afwijkingen vindt, mag dat juist
// ook duidelijk worden benoemd."
//
// En op mijn vraag of dat ook mag bij een lab zonder oordeel (comment
// Annemarie, 20 sep 19:44): "Nee. 'Gecontroleerd en in orde' mag alleen worden
// gezegd over een onderdeel dat daadwerkelijk is beoordeeld. 'Nog niet
// beoordeeld' is dus niet hetzelfde als 'in orde'. C2 hoeft niet te wachten
// tot alle labs zijn beoordeeld. Als er nog niets voldoende is beoordeeld om
// positief te benoemen, dan doet C2 simpelweg nog niets."
//
// Daarom null en geen status. Mijn eerste versie gaf "niet vast te stellen"
// terug met een reden erbij, en dat is alsnog een uitspraak die ergens op het
// scherm kan belanden. Zij vroeg om zwijgen, niet om een nette lege doos.
//
// De vorm van de positieve zin is de hare: "Anne controleerde de beschikbare
// rapporten en kon deze rechtstreeks bij het genoemde laboratorium
// verifieren." Concreet benoemen wat er is geverifieerd, geen algemeen oordeel.
function inOrde(onderdeel, gecontroleerd, labBeoordeeld) {
  // "nog niet beoordeeld" mag nooit automatisch tot een positieve conclusie
  // leiden. Beide voorwaarden zijn hard.
  if (!gecontroleerd || !labBeoordeeld) return null;
  return {
    definitief: true, vastgesteldOp: VASTGESTELD_OP, vastgesteldDoor: VASTGESTELD_DOOR,
    onderdeel,
    zin: 'Anne controleerde ' + onderdeel + ' en kon dit rechtstreeks bij het genoemde laboratorium verifieren.',
    reikwijdte: 'Dit geldt voor ' + onderdeel + ', niet voor de aanbieder als geheel.'
  };
}

module.exports = {
  VASTGESTELD_OP, VASTGESTELD_DOOR,
  VULLING_DREMPEL_PCT, vullingOordeel, vullingVanEen, vullingBlend,
  HERKOMST, magAlsFeit,
  dekking,
  LAB_NAAM_NOEMEN, labNietVerifieerbaar,
  opdrachtgeverRegels,
  beloftetoets, openheidNaastBevinding,
  inOrde
};
