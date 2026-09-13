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
