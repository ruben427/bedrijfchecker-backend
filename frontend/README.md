# Bedrijfchecker — frontend

**LET OP - er zijn TWEE frontends, en ze zijn allebei in gebruik.**

| Bestand | Wat het is | Waar het staat |
|---|---|---|
| `../bedrijfchecker.html` (repo-root) | **de checker zelf** - dit is het product | checker.deannemethode.nl/bedrijfchecker.html |
| `frontend/index.html` (dit bestand) | de publieke landingspagina met inschrijfformulier voor de lancering | checker.deannemethode.nl/ |

Ze delen `bedrijfchecker.css` en `solike.css`, maar het zijn twee losse
apps die uit elkaar zijn gelopen. Een wijziging aan de checker hoort in
`../bedrijfchecker.html`; deze README beschreef hieronder jarenlang alleen
`index.html` en op 20 september 2026 is daardoor twee dagen frontend-werk
in het verkeerde bestand beland.

---

Losstaande, publiek toegankelijke frontend. Puur HTML/CSS/JS in één
bestand, geen build-stap nodig. Praat via `fetch()` met de losse backend in
deze zelfde repo (`../src`), gehost op Railway.

Dit bestand hoort **niet** bij de Node/Express-server (die blijft draaien
zoals hij draait); het leeft hier alleen zodat wijzigingen aan de frontend
via git bijgehouden worden, samen met de rest van dit project.

## Hosting

Gedeployed op One.com, subdomein `checker.deannemethode.nl`, via FTP, naar
de root van dat subdomein. Bij elke wijziging het gewijzigde bestand
opnieuw uploaden:

- `../bedrijfchecker.html` - de checker
- `index.html` - de landingspagina
- `../bedrijfchecker.css` en `admin-coa.html` waar van toepassing

Het loont om na een upload te controleren of het bestand dat je in de
browser opent ook echt het bestand is dat je hebt gewijzigd.

## Configuratie

Bovenin het `<script>`-blok in `index.html` staat `API_BASE`, hardcoded op
de live backend-URL:

```js
var API_BASE = 'https://bedrijfchecker-backend-production.up.railway.app';
```

Als de backend-URL ooit verandert (nieuwe Railway-service, eigen domein),
moet die regel hier aangepast worden.

**Let op:** de backend accepteert alleen verzoeken van domeinen die in de
`ALLOWED_ORIGINS`-environment variable op Railway staan. Draait deze
frontend op een ander domein dan `https://checker.deannemethode.nl`, dan
moet dat domein daar ook aan toegevoegd worden (comma-separated), anders
blokkeert de browser de verzoeken (CORS).
