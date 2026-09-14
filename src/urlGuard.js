// Bescherming tegen SSRF.
//
// Waarom dit nodig is: de leverancier-URL is gebruikersinvoer, en de crawler
// haalt hem server-side op. Zonder controle kan iemand er een intern adres
// invullen — de metadata-service van de cloudprovider, een database op het
// interne netwerk, of localhost — en laat hij jouw server dingen ophalen die
// vanaf buiten niet bereikbaar zijn.
//
// Dit gold al voor docFetcher en de crawler; het diagnose-endpoint maakt het
// alleen zichtbaarder. De guard hoort dus op alle drie.
//
// Beperking, expliciet: dit controleert de hostname, niet het IP waar DNS
// uiteindelijk naartoe wijst. Een domein dat bewust naar 127.0.0.1 resolvet
// komt hier doorheen. Volledige afdekking vraagt om resolven vóór connect
// (DNS-pinning); dat is een aparte stap, geen reden om deze te laten liggen.

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,          // link-local, incl. cloud metadata 169.254.169.254
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./ // carrier-grade NAT
];

const GEBLOKKEERDE_NAMEN = /^(localhost|metadata|metadata\.google\.internal|instance-data)$/i;

function isPublicHttpUrl(input) {
  let u;
  try {
    u = new URL(String(input || ''));
  } catch (e) {
    return { ok: false, reden: 'ongeldige URL' };
  }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reden: 'alleen http en https' };
  // Inloggegevens in een URL zijn nooit nodig en verbergen vaak een redirect-truc.
  if (u.username || u.password) return { ok: false, reden: 'URL met inloggegevens' };

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reden: 'geen hostnaam' };
  if (GEBLOKKEERDE_NAMEN.test(host)) return { ok: false, reden: 'interne hostnaam' };
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localdomain')) {
    return { ok: false, reden: 'interne hostnaam' };
  }
  // IPv6: alles behalve publiek unicast weigeren (::1, fc00::/7, fe80::/10).
  if (host.includes(':')) {
    if (host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return { ok: false, reden: 'intern IPv6-adres' };
    return { ok: true, url: u.toString() };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (PRIVATE_V4.some((re) => re.test(host))) return { ok: false, reden: 'intern IP-adres' };
    return { ok: true, url: u.toString() };
  }
  // Een gewone hostnaam moet minstens één punt hebben; 'router' of 'nas' zijn
  // interne namen, geen websites.
  if (!host.includes('.')) return { ok: false, reden: 'geen publieke domeinnaam' };
  return { ok: true, url: u.toString() };
}

module.exports = { isPublicHttpUrl };
