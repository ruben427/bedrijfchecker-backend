// Zelfde client-side/server-side URL-validatie als in de Artifact
// (isValidWebUrl in bedrijfchecker.html) — hier ook server-side toegepast
// zodat de API nooit vertrouwt op alleen de frontend-check.

function normalizeUrl(input) {
  const s = (input || '').trim();
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : 'https://' + s;
}

function isValidWebUrl(input) {
  const s = (input || '').trim();
  if (!s) return false;
  const withScheme = /^https?:\/\//i.test(s) ? s : 'https://' + s;
  try {
    const u = new URL(withScheme);
    if (!/^https?:$/.test(u.protocol)) return false;
    const host = u.hostname;
    if (!host || host.indexOf('.') === -1) return false;
    return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(host);
  } catch (e) { return false; }
}

module.exports = { normalizeUrl, isValidWebUrl };
