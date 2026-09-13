# Bedrijfchecker — frontend

Losstaande, publiek toegankelijke frontend voor Bedrijfchecker. Puur
HTML/CSS/JS in één bestand (`index.html`), geen build-stap nodig. Praat via
`fetch()` met de losse backend in deze zelfde repo (`../src`), gehost op
Railway.

Dit bestand hoort **niet** bij de Node/Express-server (die blijft draaien
zoals hij draait); het leeft hier alleen zodat wijzigingen aan de frontend
via git bijgehouden worden, samen met de rest van dit project.

## Hosting

Gedeployed op One.com, subdomein `checker.deannemethode.nl`, via FTP. Bij
elke wijziging: `index.html` opnieuw uploaden naar de root van dat
subdomein (overschrijft het bestaande bestand).

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
