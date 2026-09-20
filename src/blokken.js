// ---------------------------------------------------------------------------
// De drie blokken boven het rapport: Openheid, Externe verificatie,
// Productbewijs. Puur deterministisch, geen model-call: dit telt alleen op
// wat elders al is vastgesteld.
//
// Volgorde is bewust openheid -> verificatie -> productbewijs. Verificatie
// bepaalt of productbewijs een percentage mag tonen, dus het hoort ervoor.
//
// HARDE GRENS: hier wordt geen authenticiteit bepaald. Een rapport geldt
// alleen als geverifieerd wanneer de resolver of een mens dat eerder heeft
// vastgelegd (authenticiteitsklasse). Dit bestand leest die uitkomst, het
// velt geen eigen oordeel.
// ---------------------------------------------------------------------------

// --- helpers ---------------------------------------------------------------

function heeftWaarde(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  return true;
}
function publiekeUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u);
}
// Meerderheidsregel: een veld telt als "de shop toont dit" wanneer het op
// meer dan de helft van de gevonden rapporten staat. Een enkel rapport met
// een labnaam maakt een shop niet open.
function opMeerderheid(records, fn) {
  if (!records.length) return false;
  const n = records.filter((r) => r && fn(r)).length;
  return n * 2 > records.length;
}

// --- per rapport: wat is de verificatiestand? ------------------------------
//
// geverifieerd      klasse A of B: bij het lab opgehaald en het bestaat
// weerlegd          klasse D: lost niet op, of wijkt af van de kopie
// niet_verifieerbaar klasse C: referentie aanwezig, lab biedt geen controle
// wachtrij          code aanwezig, nog niet nagetrokken (bv. Janoshik)
// code_weggehaald   het rapport noemt verificatie, de code zelf ontbreekt
// geen_code         nergens een verwijzing om mee te controleren
function standVanRapport(r) {
  if (!r) return 'geen_code';
  const klasse = r.authenticiteitsklasse || null;
  if (klasse === 'A' || klasse === 'B') return 'geverifieerd';
  if (klasse === 'D') return 'weerlegd';
  if (klasse === 'C') return 'niet_verifieerbaar';
  const heeftCode = heeftWaarde(r.verificationKey) || heeftWaarde(r.reportId) || heeftWaarde(r.verificationUrl);
  if (heeftCode) return 'wachtrij';
  // Het rapport verwijst wel naar een verificatiedienst, maar de code waarmee
  // je die zou gebruiken staat er niet. Dat is iets anders dan een rapport dat
  // nooit over verificatie sprak, en het hoort zichtbaar te blijven.
  if (heeftWaarde(r.verificatieDomein) || heeftWaarde(r.verificatieInstructie)) return 'code_weggehaald';
  return 'geen_code';
}

// --- blok 2: externe verificatie -------------------------------------------
//
// Altijd tellen tegen ALLE gevonden rapporten, niet tegen de rapporten die we
// toevallig konden controleren. Anders leest een op acht als "geverifieerd".
function verificatieBlok(recordsIn) {
  const records = (recordsIn || []).filter(Boolean);
  const stippen = records.map((r, i) => ({
    index: i,
    stand: standVanRapport(r),
    laboratorium: r.laboratorium || null,
    product: r.product || null,
    batchnummer: r.batchnummer || null,
    bronUrl: publiekeUrl(r.bronUrl) ? r.bronUrl : null,
    // Waar een mens of de resolver het heeft nagetrokken: meesturen, zodat de
    // herkomst zichtbaar blijft (M34).
    uit: r.uit || null,
    verifiedBy: r.verified_by || null,
    verifiedAt: r.verified_at || null,
    officieleBron: r.officieleBron || null
  }));
  const tel = (s) => stippen.filter((p) => p.stand === s).length;
  const totaal = stippen.length;
  const geverifieerd = tel('geverifieerd');
  const weerlegd = tel('weerlegd');
  const wachtrij = tel('wachtrij');
  const nietVerifieerbaar = tel('niet_verifieerbaar');
  const weggehaald = tel('code_weggehaald');
  const geenCode = tel('geen_code');

  // Kleur. Rood gaat voor alles, maar alleen op een vastgelegde uitkomst.
  // Een blokkade of storing is geen bewijs: dat blijft "nog niet gecontroleerd".
  let kleur;
  let woord;
  if (!totaal) { kleur = 'grey'; woord = 'Niets te controleren'; }
  else if (weerlegd > 0) { kleur = 'red'; woord = 'Wijkt af van het laboratorium'; }
  else if (geverifieerd === totaal) { kleur = 'green'; woord = 'Extern geverifieerd'; }
  else if (geverifieerd > 0) { kleur = 'orange'; woord = 'Deels extern geverifieerd'; }
  else if (wachtrij > 0) { kleur = 'orange'; woord = 'Nog niet gecontroleerd'; }
  else { kleur = 'grey'; woord = 'Niet mogelijk'; }

  return {
    kleur, woord, totaal,
    telling: { geverifieerd, weerlegd, wachtrij, nietVerifieerbaar, codeWeggehaald: weggehaald, geenCode },
    werkregel: totaal ? (geverifieerd + ' van ' + totaal + ' rapporten opgelost bij het lab') : null,
    stippen
  };
}

// --- blok 1: openheid ------------------------------------------------------
//
// Een vaste lijst, voor elke shop dezelfde noemer. Wat er niet staat telt als
// niet gevonden; er is geen "niet van toepassing", want dan is de ene shop
// niet meer met de andere te vergelijken.
//
// De vijf bedrijfspunten komen uit een waarneming van de site zelf. Draait die
// stap niet mee (de gratis check doet vandaag alleen coaDataset en
// laboratorium), dan blijven ze null: niet beoordeeld, en ze tellen niet als
// "niet gevonden". Het blok meldt dat dan zelf via volledig:false.
const OPENHEID_PUNTEN = [
  { id: 'O01', groep: 'bedrijf', label: 'Juridische bedrijfsnaam vermeld' },
  { id: 'O02', groep: 'bedrijf', label: 'Vestigingsadres vermeld' },
  { id: 'O03', groep: 'bedrijf', label: 'Registratienummer vermeld' },
  { id: 'O04', groep: 'bedrijf', label: 'Direct contact buiten een formulier' },
  { id: 'O05', groep: 'bedrijf', label: 'Algemene voorwaarden aanwezig' },
  { id: 'O06', groep: 'rapporten', label: 'Testrapporten openbaar op de site' },
  { id: 'O07', groep: 'rapporten', label: 'Laboratorium genoemd op de rapporten' },
  { id: 'O08', groep: 'rapporten', label: 'Batchnummer op de rapporten' },
  { id: 'O09', groep: 'rapporten', label: 'Verificatiecode intact' },
  { id: 'O10', groep: 'rapporten', label: 'Opdrachtgever zichtbaar op de rapporten' }
];

function openheidBlok(recordsIn, bedrijfIn) {
  const records = (recordsIn || []).filter(Boolean);
  const bedrijf = bedrijfIn || {};
  const verificatie = verificatieBlok(records);
  const weggehaald = verificatie.telling.codeWeggehaald > 0;

  const waarden = {
    O01: bedrijf.juridischeNaam,
    O02: bedrijf.vestigingsadres,
    O03: bedrijf.registratienummer,
    O04: bedrijf.directContact,
    O05: bedrijf.voorwaarden,
    O06: records.some((r) => publiekeUrl(r.bronUrl)),
    O07: opMeerderheid(records, (r) => heeftWaarde(r.laboratorium)),
    O08: opMeerderheid(records, (r) => heeftWaarde(r.batchnummer)),
    // Intact betekent: er is een code, en nergens is er een weggehaald.
    O09: !weggehaald && records.some((r) => heeftWaarde(r.verificationKey) || heeftWaarde(r.reportId)),
    O10: opMeerderheid(records, (r) => heeftWaarde(r.client) || heeftWaarde(r.opdrachtgever))
  };

  const punten = OPENHEID_PUNTEN.map((p) => {
    const v = waarden[p.id];
    let stand;
    if (v === true) stand = 'aanwezig';
    else if (v === false) stand = 'ontbreekt';
    else stand = 'niet_beoordeeld';
    if (p.id === 'O09' && weggehaald) stand = 'weggehaald';
    return { id: p.id, groep: p.groep, label: p.label, stand };
  });

  const beoordeeld = punten.filter((p) => p.stand !== 'niet_beoordeeld');
  const aanwezig = punten.filter((p) => p.stand === 'aanwezig').length;
  const noemer = beoordeeld.length;
  const volledig = noemer === OPENHEID_PUNTEN.length;

  // Groen bij 8 of meer van 10, en nooit met een weggehaalde verificatiecode.
  // Die drempel is een startpunt en moet nog tegen de validatieset gehouden
  // worden; hij staat daarom op een plek waar hij te verzetten is.
  const DREMPEL = 8;
  let kleur;
  if (!volledig) kleur = 'orange';
  else if (weggehaald) kleur = 'orange';
  else kleur = aanwezig >= DREMPEL ? 'green' : 'orange';

  return {
    kleur, aanwezig, noemer, maximum: OPENHEID_PUNTEN.length, volledig,
    drempel: DREMPEL,
    codeWeggehaald: weggehaald,
    // Zonder de bedrijfswaarneming is "4 van 10" misleidend: dan is het
    // 4 van 5 beoordeelde punten. De frontend leest dit veld, niet de noemer.
    toelichting: volledig ? null : 'Alleen de rapportpunten zijn beoordeeld; de bedrijfsgegevens draaien in deze check niet mee.',
    punten
  };
}

// Staat er een concreet aantoonbaar probleem in de COA-categorieen? De
// engine levert assessments soms als object (per id) en soms als lijst;
// beide vormen worden hier gelezen.
function coaCategorieRood(engineResult) {
  const a = (engineResult && engineResult.assessments) || null;
  if (!a) return null;
  const lijst = Array.isArray(a) ? a : Object.keys(a).map((id) => Object.assign({ id }, a[id]));
  const rood = lijst.find((c) => c && c.color === 'red' && /^C0[1-9]$/.test(c.id || ''));
  return rood ? (rood.id + ' is beoordeeld als aangetoond probleem') : null;
}

// --- blok 3: productbewijs -------------------------------------------------
//
// Een telling tot blok 2 bevestigt, dan pas een percentage. Leeg rendert nooit
// als 0%: geen bewijs is geen slecht bewijs.
function productbewijsBlok(engineResult, recordsIn) {
  const records = (recordsIn || []).filter(Boolean);
  const er = engineResult || {};
  const score = er.evidenceScore || {};
  const gate = er.gate || {};
  const verificatie = verificatieBlok(records);

  if (!records.length) {
    return { kleur: 'grey', vorm: 'woord', waarde: 'Niets gevonden', percentage: null, aantal: 0,
      reden: gate.code || 'NO_COA_FOUND' };
  }
  // Rood komt hier NIET uit de verificatiestand. Dat een referentie niet
  // oplost is een vraag over het document (blok 2); of de inhoud de
  // productclaim tegenspreekt is een vraag over het product, en die staat
  // vast in de categoriebeoordeling. Bij MyPept is het rapport echt en klopt
  // de zuiverheid; alleen de stof klopt niet. Dat is C02, niet klasse D.
  const rodeCategorie = coaCategorieRood(er);
  if (rodeCategorie) {
    return { kleur: 'red', vorm: 'woord', waarde: 'Tegengesproken', percentage: null, aantal: records.length,
      reden: rodeCategorie };
  }
  if (score.published && score.value != null) {
    return { kleur: 'green', vorm: 'percentage', waarde: score.value, percentage: score.value,
      aantal: records.length, coverage: score.coverage == null ? null : score.coverage, reden: null };
  }
  return { kleur: 'orange', vorm: 'telling', waarde: records.length, percentage: null, aantal: records.length,
    reden: score.reason || gate.code || null };
}

// Alles bij elkaar, in leesvolgorde.
function bouwBlokken(engineResult, records, bedrijf) {
  return {
    versie: '1.0',
    openheid: openheidBlok(records, bedrijf),
    verificatie: verificatieBlok(records),
    productbewijs: productbewijsBlok(engineResult, records)
  };
}

module.exports = {
  OPENHEID_PUNTEN, standVanRapport, openheidBlok, verificatieBlok, productbewijsBlok, bouwBlokken
};
