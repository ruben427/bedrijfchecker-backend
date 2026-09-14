# Bedrijfchecker backend (v1 — publieke gratis Evidence Check)

Losstaande, publiek toegankelijke versie van de Bedrijfchecker-audit, zonder
dat bezoekers een Claude-account nodig hebben. Poort van de deterministische
scoring-engine en de research/synthese-pipeline uit de Claude Artifact
(`bedrijfchecker.html`) naar een gewone Node.js/Express-server met een eigen
Postgres-database, Anthropic API-key en Tavily API-key.

## Structuur

- `src/scoringEngine.js` — deterministische Supplier Evidence Scoring & Result
  Logic v1.0 (gate, dependency rule, COA-cap, Free Evidence Score). Puur JS,
  geen model-call — 1-op-1 overgenomen uit de Artifact.
- `src/pipeline.js` — de 8 research-stappen, categorisatie en narratieve
  synthese (evidence-regels en prompts identiek aan de Artifact-versie).
- `src/anthropicClient.js` — vervangt de Artifact's `sample`-capability door
  een directe Anthropic API-call.
- `src/tavilyClient.js` — vervangt de Artifact's `mcp`(Tavily)-capability door
  directe calls naar `api.tavily.com` (search/extract/research).
- `src/db.js` — Postgres-laag (tabel `cases`), vervangt de Artifact's
  `db`-capability.
- `src/server.js` — Express-app met de API-routes.

## API

- `GET /api/audits` — lijst eerder gedraaide audits.
- `GET /api/audits/:id` — status/resultaat van één audit (client pollt dit).
- `POST /api/audits` — start een nieuwe audit. `multipart/form-data` met veld
  `website` (verplicht) en optioneel `naam`, `land`, `kvkNummer`, `notities`,
  plus bestanden onder `files` (COA's/screenshots). Geeft `400` met
  `{"error":"invalid_url","message":"Vul een geldige web URL in."}` bij een
  ongeldige URL.
- `POST /api/audits/:id/stop` — zet een lopende audit op status `gestopt`.
- `POST /api/audits/:id/retry-step` — herdraai één stap (`{"key":"..."}`).

## Environment variables

Zie `.env.example`. Op Railway worden deze als project-variabelen gezet
(geen `.env`-bestand nodig in productie); `DATABASE_URL` wordt automatisch
ingevuld zodra je een Postgres-service aan hetzelfde Railway-project
toevoegt en de variabele daaraan koppelt.

## Lokaal draaien

```
npm install
cp .env.example .env   # vul de keys in
npm start
```

## Deployen op Railway

1. Nieuw project → "Deploy from GitHub repo" → kies deze repo.
2. Voeg een Postgres-service toe aan hetzelfde project ("+ New" → "Database"
   → "Add PostgreSQL"). Koppel de variabele `DATABASE_URL` van de
   Postgres-service aan de backend-service (Railway doet dit met een
   referentie-variabele automatisch als je "Connect" gebruikt).
3. Zet bij de backend-service onder "Variables": `ANTHROPIC_API_KEY`,
   `ANTHROPIC_MODEL`, `TAVILY_API_KEY`, `ALLOWED_ORIGINS` (domein van de
   frontend).
4. Railway detecteert `package.json` automatisch (Nixpacks) en gebruikt
   `railway.json` voor de startcommand. Elke push naar de gekoppelde branch
   triggert een nieuwe deploy.

## Nog niet gebouwd (buiten v1-scope)

- Frontend die met deze API praat (de bestaande HTML/CSS uit de Artifact
  moet nog aangepast worden om `fetch()` naar deze endpoints te gebruiken
  i.p.v. `window.claude`-capabilities).
- KvK-integratie en de betaalde Deep Dive-tier (bewust uitgesteld, zie
  het project-document "Publieke Backend (Path B)").

## Toegang en misbruikbestendiging (fase 0)

De API was publiek zonder enige toegangscontrole. Drie dingen zijn dichtgezet:

**1. Eigenaarskoppeling zonder login.** Elke browser houdt één willekeurig
`ownerToken` in localStorage en stuurt dat mee als `X-Owner-Token`. De server
bewaart alleen de SHA-256 ervan in `cases.owner_token_hash`. Gevolg:

- `GET /api/audits` geeft alleen de cases van die browser terug (was: alle
  cases van iedereen);
- `GET /api/audits/:id` en alle acties erop vereisen eigenaarschap;
- `GET /api/audits/:id/documents/:docId` gaf eerder de ruwe bytes van een
  geüpload KvK-uittreksel aan iedereen die het case-id en doc-id kende.

Een case die niet van jou is geeft `404`, niet `403` — anders verklapt het
statusverschil zelf welke case-ids bestaan.

**2. Rate limiting** (`src/rateLimit.js`), met het startlimiet vóór de
relevantiecheck. Die check is een betaalde AI-call die draait voordat er een
case bestaat, dus een geweigerde aanvraag kostte al geld.

**3. Methodescheiding** (`src/serialize.js`). Drie vormen: `caseSummary` voor
het overzicht, `ownerCase` voor de eigenaar, en `publicCase` — de uitslag
zonder rekentrace, pijlerinterne waarden of ruwe fasedata, klaar voor een
toekomstige deellink. `publicCase` is een whitelist; een blacklist lekt bij het
eerste nieuwe veld. Foutmeldingen geven een code plus een referentienummer
terug, nooit `e.message`.

### Na deployen

Zet `ADMIN_TOKEN` in Railway. Bestaande cases hebben nog geen eigenaar en zijn
daarmee alleen via dat token bereikbaar. Om ze aan je eigen browser te koppelen:
open de app, lees `localStorage.getItem('bedrijfchecker.ownerToken')` uit de
console, en draai eenmalig:

```sql
UPDATE cases SET owner_token_hash = encode(sha256('<jouw token>'::bytea), 'hex')
WHERE owner_token_hash IS NULL;
```

## COA-documentarchief (fase 1)

`src/coaStore.js` — analyseer elk uniek COA-document precies één keer, ooit,
voor alle gebruikers en leveranciers samen.

Drie tabellen, **geen bestandsopslag**. Van elk document bewaren we alleen de
SHA-256 van de bytes en het analyseresultaat:

- `coa_documents` — wat het is. Gesleuteld op de hash. Bevat de extractie
  (OCR/vision), de extractorversie, en later de labverificatie.
- `coa_sources` — waar we het zagen. Eén rij per URL per leverancier, met de
  HTTP-vingerafdruk (`ETag`/`Last-Modified`/lengte).
- `coa_source_events` — de geschiedenis. Hier komen de signalen uit.

**Waarom niet op URL cachen.** Dan zie je nooit dat het bestand áchter die URL
is vervangen — en dat is precies het geval dat we willen vangen. De URL is de
opzoeksleutel, de hash is de geldigheidscontrole.

De lus in de `coaDataset`-stap:

1. `HEAD` op de URL. Vingerafdruk ongewijzigd en analyse aanwezig → hergebruiken,
   geen download en geen vision-call.
2. Anders downloaden en hashen. Hash al bekend (ook van een ándere shop) →
   analyse hergebruiken.
3. Alleen bij onbekende bytes draait de vision-call, en het resultaat wordt
   opgeslagen op `(sha256, COA_EXTRACTOR_VERSION)`.
4. URLs die eerder wél en nu niet in de index staan, krijgen `status = 'gone'` —
   ze worden niet verwijderd.

De dure stap hangt dus aan de **hash**, niet aan de download. Opnieuw
downloaden kost niets; opnieuw analyseren wel, en dat gebeurt nooit twee keer
voor dezelfde bytes.

`COA_EXTRACTOR_VERSION` staat boven in `src/pipeline.js`. Verhoog die alleen
bewust: elke wijziging betekent dat álle eerder gelezen COA's opnieuw door
vision gaan.

### Signalen die hieruit komen

Zichtbaar in `phaseData.coaDataset.data.archief`:

| Signaal | Betekenis |
|---|---|
| `vervangen` | zelfde URL, andere inhoud dan bij de vorige controle |
| `verdwenen` | stond er eerder wel, nu niet meer |
| `terug` | was verdwenen, staat er weer |
| `gedeeld rapport` | ditzelfde document staat ook bij een andere leverancier |
| `hergebruikt` | analyse kwam uit het archief, niet opnieuw gedraaid |

Deze zijn alleen zichtbaar mét geschiedenis, en geschiedenis bouwt niet met
terugwerkende kracht op — daarom staat dit vóór de leeslaag en de resolver.

## COA-crawler (fase 1b)

`src/coaCrawler.js` — vind de COA-bibliotheek van een leverancier
deterministisch, in plaats van hem te laten raden.

**Waarom.** Een testrun op `retaeu.nl` (14 sep) leverde via de AI-zoekstap
**2** COA's op. Eén daarvan kwam van Scribd en had batchnummer `RET48901`,
terwijl alle batches op retaeu's eigen pagina vijf cijfers hebben — bewijs van
een andere leverancier dus, toegeschreven aan deze. Op
`retaeu.nl/nl/certificate-of-analysis/` staan er **26**, netjes in een tabel.

Zoekmachine-snippets zijn de verkeerde bron voor iets wat gewoon op de site
staat. De crawler:

1. haalt de homepage op en zoekt links die over certificaten gaan;
2. probeert daarnaast een vaste lijst gebruikelijke paden
   (`/certificate-of-analysis/`, `/coa/`, `/lab-results/`, …);
3. pakt op elke gevonden pagina álle links naar PDF/PNG/JPG;
4. neemt de tekst van de tabelrij mee als context — product, batch, purity en
   labnaam zoals de leverancier ze zélf opgeeft.

Die rijtekst is **geen bewijs**. Het is vergelijkingsmateriaal: wijkt de purity
in de tabel af van die in het rapport, dan is dat een bevinding.

**Twee valkuilen die zijn afgevangen.** COA-tabellen bevatten per rij ook een
productfoto, en die is eveneens `.png` — verkleinde varianten (`-300x300`)
vallen af, en afbeeldingen tellen alleen mee als de pagina helemaal geen
aangelinkte documenten heeft. En een document dat gevonden maar niet
opgehaald kan worden krijgt `accessStatus: 'inaccessible'`, niet `readable`:
het bestaat wél, maar het is geen bruikbaar bewijs.

`COA_AUTOFETCH_MAX` stond op **4** en staat nu op **30**. Met 4 zag je een
willekeurige greep uit de bibliotheek en trok je er conclusies over de rest uit.

De crawler gooit nooit. Geen COA-pagina, een blokkade of een time-out levert
een lege lijst met een reden op in `phaseData.coaDataset.data.crawl`.
