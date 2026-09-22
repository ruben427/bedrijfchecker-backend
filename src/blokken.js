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

const niveaus = require('./niveaus');

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
  if (!records.length) return null;
  const n = records.filter((r) => r && fn(r)).length;
  return n * 2 > records.length;
}
// Is dit rapport door ons daadwerkelijk gelezen? Een crawl-treffer die nog
// niet is opgehaald staat als 'pending' in de lijst: een lege huls zonder
// labnaam of batchnummer. Die mag niet meetellen als "de shop noemt geen
// laboratorium" - dat zou onze eigen onafgemaakte leesronde als verwijt aan
// de leverancier presenteren. Zelfde regel als bij rood: iets wat wij niet
// hebben vastgesteld is geen bevinding.
function isGelezen(r) {
  if (!r) return false;
  const st = r.accessStatus;
  if (!st) return true;  // ouder record zonder veld: wel uitgelezen
  return st === 'readable';
}

// --- per rapport: wat is de verificatiestand? ------------------------------
//
// geverifieerd      klasse A of B: bij het lab opgehaald en het bestaat
//                   LET OP - sinds A15b levert de resolver geen B meer. Een
//                   veldverschil maakt het rapport niet minder echt; dat staat
//                   nu in shopkopieAfwijking en koppeling. B kan nog uit een
//                   handmatige controle komen en blijft daarom staan.
// weerlegd          klasse D: lost niet op
// niet_verifieerbaar klasse C: referentie aanwezig, lab biedt geen controle
// wachtrij          code aanwezig, nog niet nagetrokken (bv. Janoshik)
// code_weggehaald   het rapport noemt verificatie, de code zelf ontbreekt
// geen_code         nergens een verwijzing om mee te controleren
function standVanRapport(r) {
  if (!r) return 'geen_code';
  const klasse = r.authenticiteitsklasse || null;
  if (klasse === 'A' || klasse === 'B') return 'geverifieerd';
  // Klasse D zegt: de referentie lost niet op, of wijkt af van de kopie.
  // Dat valt alleen vast te stellen als er een referentie IS en als iemand
  // hem heeft nagetrokken - de resolver of een mens. Bij nextgenpeptides
  // stond D op een rapport zonder rapportnummer en zonder sleutel; dan is er
  // niets nagetrokken en is "weerlegd" een bewering, geen bevinding.
  if (klasse === 'D') {
    const heeftReferentie = heeftWaarde(r.verificationKey) || heeftWaarde(r.reportId) || heeftWaarde(r.verificationUrl);
    const nagetrokken = r.klasseBron === 'resolver' || r.klasseBron === 'mens';
    if (heeftReferentie && nagetrokken) return 'weerlegd';
    return 'niet_verifieerbaar';
  }
  if (klasse === 'C') return 'niet_verifieerbaar';
  const heeftCode = heeftWaarde(r.verificationKey) || heeftWaarde(r.reportId) || heeftWaarde(r.verificationUrl);
  if (heeftCode) return 'wachtrij';
  // Het rapport verwijst wel naar een verificatiedienst, maar de code waarmee
  // je die zou gebruiken staat er niet. Dat is iets anders dan een rapport dat
  // nooit over verificatie sprak, en het hoort zichtbaar te blijven.
  if (heeftWaarde(r.verificatieDomein) || heeftWaarde(r.verificatieInstructie)) return 'code_weggehaald';
  return 'geen_code';
}

// --- waar komt een rapport vandaan? ----------------------------------------
//
// Drie herkomsten, en ze zijn niet gelijkwaardig:
//
// eigen_kopie       de shop host het document zelf. Bruikbaar, maar het is
//                   een kopie: bewerken kan en valt zonder controle bij het
//                   lab niet vast te stellen.
// labverwijzing     de shop linkt naar het laboratorium. Sterker, want dat
//                   wijst naar het origineel in plaats van naar een kopie.
// alleen_vermelding er staat dat er een rapport is, zonder document en
//                   zonder link. Daar valt niets mee te doen.
//
// Het labdomein wordt niet geraden: het is het domein waar de verificatielink
// naartoe wijst. Staat die link op het eigen domein van de shop, dan is het
// geen verwijzing naar een lab maar gewoon een eigen kopie.
function hostVan(url) {
  const m = /^https?:\/\/([^/?#]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase().replace(/^www\./, '') : null;
}
function herkomstVanRapport(r, shopHost) {
  if (!r) return 'alleen_vermelding';
  // Het certificaat dat de KOPER zelf meestuurde. Dat is geen openheid van de
  // aanbieder: hij heeft het niet gepubliceerd, wij hebben het gekregen. Zou
  // dit als 'eigen_kopie' tellen, dan zou een shop beter scoren doordat een
  // bezoeker toevallig zijn eigen papier bij de hand had.
  if (r.eigenCoa) return 'eigen_coa_gebruiker';
  const verifHost = hostVan(r.verificationUrl);
  if (verifHost && verifHost !== shopHost) return 'labverwijzing';
  if (publiekeUrl(r.bronUrl)) return 'eigen_kopie';
  if (verifHost) return 'eigen_kopie';
  return 'alleen_vermelding';
}
function telHerkomst(records, shopHost) {
  const t = { eigenKopie: 0, labverwijzing: 0, alleenVermelding: 0, eigenCoaGebruiker: 0 };
  records.forEach((r) => {
    const h = herkomstVanRapport(r, shopHost);
    if (h === 'labverwijzing') t.labverwijzing++;
    else if (h === 'eigen_kopie') t.eigenKopie++;
    else if (h === 'eigen_coa_gebruiker') t.eigenCoaGebruiker++;
    else t.alleenVermelding++;
  });
  return t;
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
// versie 1.3: ongelezen rapporten tellen niet mee in de meerderheidsregel
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
  const gelezen = records.filter(isGelezen);
  const ongelezen = records.length - gelezen.length;
  const verificatie = verificatieBlok(records);
  const weggehaald = verificatie.telling.codeWeggehaald > 0;

  const waarden = {
    O01: bedrijf.juridischeNaam,
    O02: bedrijf.vestigingsadres,
    O03: bedrijf.registratienummer,
    O04: bedrijf.directContact,
    O05: bedrijf.voorwaarden,
    // O06 kijkt naar ALLE treffers: een gevonden document staat publiek op de
    // site, ook als wij het nog niet openden.
    O06: records.some((r) => publiekeUrl(r.bronUrl)),
    // De rest kijkt alleen naar wat we echt gelezen hebben. Zonder gelezen
    // rapporten is er niets te beoordelen, en geeft opMeerderheid null.
    O07: opMeerderheid(gelezen, (r) => heeftWaarde(r.laboratorium)),
    O08: opMeerderheid(gelezen, (r) => heeftWaarde(r.batchnummer)),
    // Intact betekent: er is een code, en nergens is er een weggehaald.
    O09: gelezen.length
      ? (!weggehaald && gelezen.some((r) => heeftWaarde(r.verificationKey) ||
          heeftWaarde(r.reportId) || heeftWaarde(r.verificationUrl)))
      : null,
    O10: gelezen.some((r) => r && (('client' in r) || ('opdrachtgever' in r)))
      ? opMeerderheid(gelezen, (r) => heeftWaarde(r.client) || heeftWaarde(r.opdrachtgever))
      : null
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
    // Hoeveel van de gevonden rapporten zijn ook echt gelezen? Blijft dit
    // achter, dan is de uitkomst op minder bewijs gebaseerd dan het aantal
    // gevonden documenten suggereert.
    gevonden: records.length, gelezen: gelezen.length, ongelezen,
    // Zonder de bedrijfswaarneming is "4 van 10" misleidend: dan is het
    // 4 van 5 beoordeelde punten. De frontend leest dit veld, niet de noemer.
    toelichting: (ongelezen > 0
      ? ('Van de ' + records.length + ' gevonden rapporten zijn er ' + gelezen.length
         + ' gelezen; de rest telt niet mee. ')
      : '') + (volledig ? '' : 'Alleen de rapportpunten zijn beoordeeld; de bedrijfsgegevens draaien in deze check niet mee.')
      || null,
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
function productbewijsBlok(engineResult, recordsIn, shopHost) {
  const records = (recordsIn || []).filter(Boolean);
  const herkomst = telHerkomst(records, shopHost || null);
  // De werkregel vertelt WAT er geteld is. "76 rapporten" beloofde meer dan
  // er lag: 73 daarvan waren links naar het lab, geen gelezen document.
  const delen = [];
  if (herkomst.eigenKopie) delen.push(herkomst.eigenKopie + ' op de site zelf');
  if (herkomst.labverwijzing) delen.push(herkomst.labverwijzing + ' via een link naar het lab');
  if (herkomst.alleenVermelding) delen.push(herkomst.alleenVermelding + ' alleen vermeld');
  // Apart benoemd en achteraan: het staat naast het bewijs van de aanbieder,
  // niet ertussen.
  if (herkomst.eigenCoaGebruiker) {
    delen.push(herkomst.eigenCoaGebruiker + ' uit je eigen certificaat');
  }
  const werkregel = delen.length ? delen.join(' · ') : null;
  const er = engineResult || {};
  const score = er.evidenceScore || {};
  const gate = er.gate || {};
  const verificatie = verificatieBlok(records);

  if (!records.length) {
    return { kleur: 'grey', vorm: 'woord', waarde: 'Niets gevonden', percentage: null, aantal: 0,
      herkomst, werkregel, reden: gate.code || 'NO_COA_FOUND' };
  }
  // Rood komt hier NIET uit de verificatiestand. Dat een referentie niet
  // oplost is een vraag over het document (blok 2); of de inhoud de
  // productclaim tegenspreekt is een vraag over het product, en die staat
  // vast in de categoriebeoordeling. Bij MyPept is het rapport echt en klopt
  // de zuiverheid; alleen de stof klopt niet. Dat is C02, niet klasse D.
  const rodeCategorie = coaCategorieRood(er);
  if (rodeCategorie) {
    return { kleur: 'red', vorm: 'woord', waarde: 'Tegengesproken', percentage: null, aantal: records.length,
      herkomst, werkregel, reden: rodeCategorie };
  }
  if (score.published && score.value != null) {
    return { kleur: 'green', vorm: 'percentage', waarde: score.value, percentage: score.value,
      aantal: records.length, herkomst, coverage: score.coverage == null ? null : score.coverage,
      werkregel: (werkregel ? werkregel + ' · ' : '') + 'dekking ' + Math.round(score.coverage || 0) + '%', reden: null };
  }
  return { kleur: 'orange', vorm: 'telling', waarde: records.length, percentage: null, aantal: records.length,
    herkomst, werkregel, reden: score.reason || gate.code || null };
}

// --- blok 4: wat mogen we over de waarden zeggen ---------------------------
//
// Dit blok is de zichtbare kant van niveaus.js. De twee assen - hebben wij
// het document betrouwbaar uitgelezen, en is de inhoud onafhankelijk
// bevestigd - leveren per uitspraak een van drie standen op. Hier worden die
// geteld en in zinnen gezet.
//
// GEEN eigen oordeel: de standen staan al op elk record (r.niveau), gezet
// door de pijplijn. Dit bestand telt en formuleert.
//
// LET OP - er staat bewust GEEN kleur op. De kleurregel voor dit blok is niet
// vastgesteld; dat is A24 en ligt bij Annemarie. Een kleur verzinnen zou een
// weging invoeren die niemand heeft besloten, en die daarna moeilijk terug te
// draaien is omdat hij al in beeld staat.
const ONDERDEEL_WOORD = {
  vulling: 'hoeveelheid in de vial',
  zuiverheid: 'zuiverheid',
  identiteit: 'identiteit van de stof'
};

function waardenBlok(recordsIn) {
  const records = (recordsIn || []).filter((r) => r && r.niveau && r.niveau.perOnderdeel);
  if (!records.length) {
    return {
      beschikbaar: false, kleur: null, kleurregelOpen: 'A24',
      regels: [], telling: null,
      werkregel: 'Geen rapporten waarvan de leeszekerheid is bepaald'
    };
  }

  const onderdelen = Object.keys(ONDERDEEL_WOORD);
  const telling = {};
  let promotieGeblokkeerd = 0;
  // A14: identiteit gerapporteerd terwijl de methode niet te verifieren is.
  // Apart geteld, want dat is een derde stand en geen half geverifieerd.
  let methodeNietVerifieerbaar = 0;
  onderdelen.forEach((o) => {
    const t = { geverifieerd: 0, gerapporteerd: 0, niets: 0 };
    records.forEach((r) => {
      const vak = r.niveau.perOnderdeel[o];
      if (!vak) return;
      t[vak.uitkomst.tonen] = (t[vak.uitkomst.tonen] || 0) + 1;
      if (vak.uitkomst.geblokkeerdeUpgrade) promotieGeblokkeerd++;
      if (vak.uitkomst.methodeNietVerifieerbaar) methodeNietVerifieerbaar++;
    });
    telling[o] = t;
  });
  // A13: hetzelfde rapport bij twee leveranciers is een analyse, niet twee.
  const gedeeld = records.filter((r) => Array.isArray(r.gedeeldMet) && r.gedeeldMet.length).length;
  // A15b: de shop toont een ander meetresultaat dan het lab. Het rapport is
  // echt; de weergave van de leverancier klopt niet met de bron.
  const afwijkendeKopie = records.filter((r) => r.shopkopieAfwijking).length;
  const labbronGebruikt = records.filter((r) => r.labbronLeidend).length;

  // Een regel per uitspraak, en alleen als er iets over te zeggen valt.
  // "0 van de 12" is geen mededeling maar ruis.
  const regels = [];
  onderdelen.forEach((o) => {
    const t = telling[o];
    const woord = ONDERDEEL_WOORD[o];
    if (t.geverifieerd) {
      regels.push({
        onderdeel: o, stand: 'geverifieerd', aantal: t.geverifieerd,
        zin: 'Bij ' + t.geverifieerd + ' van de ' + records.length + ' rapporten is de ' + woord +
          ' onafhankelijk bevestigd.'
      });
    }
    if (t.gerapporteerd) {
      regels.push({
        onderdeel: o, stand: 'gerapporteerd', aantal: t.gerapporteerd,
        zin: 'Bij ' + t.gerapporteerd + ' van de ' + records.length + ' rapporten staat de ' + woord +
          ' wel in het document, maar hebben wij hem niet onafhankelijk bevestigd.',
        toelichting: niveaus.GERAPPORTEERD_TOELICHTING
      });
    }
    // "Wij zeggen niets" in plaats van "niet getest" of "ontbreekt". Dat is
    // hetzelfde onderscheid als bij de rode vlaggen: wat wij niet hebben
    // kunnen lezen is geen bevinding over de leverancier. De zin zegt daarom
    // wat WIJ niet konden, niet wat de leverancier naliet.
    //
    // Alleen als er verder niets over die uitspraak te melden is. Staat er ook
    // een geverifieerde of gerapporteerde waarde, dan is "wij zeggen niets"
    // eenvoudig onwaar.
    if (t.niets && !t.geverifieerd && !t.gerapporteerd) {
      regels.push({
        onderdeel: o, stand: 'niets', aantal: t.niets,
        zin: 'Over de ' + woord + ' zeggen wij niets: die staat niet leesbaar in de rapporten die wij zagen.'
      });
    }
  });

  if (methodeNietVerifieerbaar) {
    regels.push({
      onderdeel: 'identiteit', stand: 'methode_niet_verifieerbaar', aantal: methodeNietVerifieerbaar,
      zin: (methodeNietVerifieerbaar === 1
        ? 'Bij een rapport staat de identiteit van de stof wel vermeld, '
        : 'Bij ' + methodeNietVerifieerbaar + ' rapporten staat de identiteit van de stof wel vermeld, ') +
        'maar noemt het document geen methode waarmee die bepaling na te gaan is.',
      toelichting: niveaus.IDENTITEIT_TOELICHTING
    });
  }

  if (afwijkendeKopie) {
    regels.push({
      onderdeel: null, stand: 'shopkopie_wijkt_af', aantal: afwijkendeKopie,
      zin: (afwijkendeKopie === 1
        ? 'Bij een rapport toont de leverancier een ander meetresultaat dan het laboratorium zelf teruggeeft.'
        : 'Bij ' + afwijkendeKopie + ' rapporten toont de leverancier een ander meetresultaat dan het ' +
          'laboratorium zelf teruggeeft.') +
        (labbronGebruikt ? ' Wij gebruiken de waarde van het laboratorium.' : ''),
      // De grens die Annemarie trok: wel vaststellen dat het afwijkt, niet
      // concluderen waarom of of het bewust is.
      toelichting: 'Het labrapport zelf is bij het laboratorium opgehaald en is echt. Wat afwijkt is de ' +
        'weergave bij de leverancier. Waarom dat zo is, hebben wij niet vastgesteld.'
    });
  }

  if (gedeeld) {
    regels.push({
      onderdeel: null, stand: 'gedeeld_labbewijs', aantal: gedeeld,
      // De zin die Annemarie zelf voorschreef bij A13.
      zin: gedeeld === 1
        ? 'Dit labrapport wordt ook door een andere leverancier gebruikt.'
        : gedeeld + ' van deze labrapporten worden ook door een andere leverancier gebruikt.',
      toelichting: 'Hetzelfde rapport bij twee leveranciers is een laboratoriumanalyse, geen twee ' +
        'onafhankelijke bewijzen. Waarom het gedeeld wordt, hebben wij niet vastgesteld.'
    });
  }

  if (promotieGeblokkeerd) {
    regels.push({
      onderdeel: null, stand: 'promotie_geblokkeerd', aantal: promotieGeblokkeerd,
      zin: promotieGeblokkeerd === 1
        ? 'Een waarde blijft op "gerapporteerd" staan omdat het laboratorium onvoldoende verifieerbaar is. ' +
          'Dat zegt niets over de waarde zelf.'
        : promotieGeblokkeerd + ' waarden blijven op "gerapporteerd" staan omdat het laboratorium ' +
          'onvoldoende verifieerbaar is. Dat zegt niets over de waarde zelf.'
    });
  }

  return {
    beschikbaar: true, kleur: null, kleurregelOpen: 'A24',
    rapporten: records.length, telling, promotieGeblokkeerd,
    methodeNietVerifieerbaar, gedeeldLabbewijs: gedeeld,
    shopkopieWijktAf: afwijkendeKopie, labbronGebruikt, regels,
    werkregel: records.length + ' rapport(en) beoordeeld op leeszekerheid en verificatie'
  };
}

// Alles bij elkaar, in leesvolgorde.
function bouwBlokken(engineResult, records, bedrijf, shopHost) {
  return {
    versie: '1.5',
    openheid: openheidBlok(records, bedrijf),
    verificatie: verificatieBlok(records),
    productbewijs: productbewijsBlok(engineResult, records, shopHost),
    waarden: waardenBlok(records)
  };
}

module.exports = {
  OPENHEID_PUNTEN, standVanRapport, herkomstVanRapport, telHerkomst, openheidBlok, verificatieBlok, productbewijsBlok, waardenBlok, bouwBlokken
};
