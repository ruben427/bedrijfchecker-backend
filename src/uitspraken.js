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
// LET OP: absolute waarde. Overvulling is geen bonus. Dat is een besluit, geen
// implementatiedetail - de engine kende al signalGt10, maar niets gebruikte
// het en niemand had gezegd dat +20% net zo goed telt als -20%.
const VULLING_DREMPEL_PCT = 10;

function vullingOordeel(pct) {
  if (pct == null || Number.isNaN(Number(pct))) {
    return { bevinding: false, tonen: false, reden: 'geen vergelijkbare meting' };
  }
  const p = Number(pct);
  const afwijking = Math.abs(p);
  if (afwijking >= VULLING_DREMPEL_PCT) {
    return {
      bevinding: true, tonen: true, pct: p, richting: p > 0 ? 'boven' : 'onder',
      zin: 'De gemeten hoeveelheid ligt ' + Math.abs(Math.round(p * 10) / 10) + '% ' +
        (p > 0 ? 'boven' : 'onder') + ' wat het etiket claimt.'
    };
  }
  // Onder de drempel: wel laten zien, geen aandachtspunt van maken.
  return {
    bevinding: false, tonen: true, pct: p, richting: p > 0 ? 'boven' : 'onder',
    zin: null, reden: 'afwijking onder ' + VULLING_DREMPEL_PCT + '%'
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
// LET OP: Annemarie vinkte "akkoord, met wijziging" aan en liet de toelichting
// leeg. De tekst hieronder is dus het CONCEPT waar zij iets aan wil veranderen;
// wat precies is nog niet teruggekoppeld. Daarom definitief: false. De bijvraag
// is wel beantwoord: de naam van het lab wordt genoemd.
const LAB_NAAM_NOEMEN = true;

function labNietVerifieerbaar(labnaam, oordeel) {
  if (!oordeel || oordeel.status === 'erkend') return null;
  const naam = LAB_NAAM_NOEMEN && labnaam ? labnaam : 'het laboratorium dat deze aanbieder gebruikt';
  return {
    definitief: false,
    wachtOp: 'A-1: wijziging door Annemarie nog niet doorgegeven',
    regels: [
      'De laboratoriumrapporten van deze aanbieder komen van ' + naam +
        '. Wij hebben dit laboratorium niet onafhankelijk kunnen bevestigen, en de aanbieder heeft de bedrijfsgegevens van het laboratorium op verzoek niet verstrekt.',
      'Daarmee zijn identiteit, zuiverheid en hoeveelheid die uitsluitend op deze rapporten rusten onbevestigd. Niet weerlegd - onbevestigd.',
      'Dit zegt niet dat het laboratorium niet bestaat, en niet dat de rapporten onjuist zijn.'
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
// ook duidelijk worden benoemd. Wel alleen voor de onderdelen die
// daadwerkelijk zijn gecontroleerd, zonder daar meteen een algemeen oordeel
// over de leverancier van te maken."
//
// LET OP - hier zit een open vraag onder (terug te koppelen). "In orde" over
// een rapport van een lab dat nog NIET is beoordeeld zegt niets: we weten dan
// niet of het lab deugt. Vandaag heeft alleen RC Testing een oordeel; Janoshik,
// Bridge Analytical en ILS staan op "nog niet beoordeeld". Tot Annemarie dat
// beslist is de veilige stand: geen "in orde" zonder labooordeel, met de reden
// erbij. Anders zou de eerste groene uitspraak van het product rusten op een
// lab waar niemand naar heeft gekeken.
function inOrde(onderdeel, gecontroleerd, labBeoordeeld) {
  if (!gecontroleerd) return null;
  if (!labBeoordeeld) {
    return {
      status: 'niet vast te stellen',
      reden: 'het laboratorium achter deze rapporten is nog niet beoordeeld; ' +
        'zonder dat oordeel kunnen wij niet zeggen dat dit onderdeel in orde is'
    };
  }
  return {
    status: 'gecontroleerd, geen afwijking gevonden',
    onderdeel,
    // Nooit doortrekken naar de leverancier als geheel.
    reikwijdte: 'Dit geldt voor ' + onderdeel + ', niet voor de aanbieder als geheel.'
  };
}

module.exports = {
  VASTGESTELD_OP, VASTGESTELD_DOOR,
  VULLING_DREMPEL_PCT, vullingOordeel,
  dekking,
  LAB_NAAM_NOEMEN, labNietVerifieerbaar,
  opdrachtgeverRegels,
  beloftetoets, openheidNaastBevinding,
  inOrde
};
