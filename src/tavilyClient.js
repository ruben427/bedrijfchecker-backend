// Vervangt de Artifact's `mcp`-capability (Tavily via window.claude.use('mcp'))
// door directe calls naar de publieke Tavily REST API.
// Endpoints en auth bevestigd via docs.tavily.com (Bearer token, sep. 2026):
//   POST https://api.tavily.com/search   { query, max_results, search_depth }
//   POST https://api.tavily.com/extract  { urls, extract_depth }
//   POST https://api.tavily.com/research { input, model }

const BASE = 'https://api.tavily.com';

// Zonder eigen timeout kan een enkele vastgelopen Tavily-call de hele audit
// voor onbepaalde tijd laten hangen: fetch() zonder AbortController wacht
// oneindig door als het verzoek nooit een response (of netwerkfout) krijgt,
// en de await in tavilySearch/tavilyExtract/tavilyResearch — en dus in
// runAudit — blokkeert dan voor altijd zonder dat de catch in runAudit ooit
// bereikt wordt (case blijft 'bezig' vastzitten op de stap die net loopt).
// Vandaar: elk verzoek krijgt een harde deadline via AbortController, zodat
// een stalled call altijd binnen TAVILY_TIMEOUT_MS als fout naar boven komt
// en de bestaande per-query/per-stap foutafhandeling hieronder gewoon kan
// doen waar die voor gebouwd is (record de fout, ga door).
const TIMEOUT_MS = Number(process.env.TAVILY_TIMEOUT_MS) || 30000;

async function tavilyFetch(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + process.env.TAVILY_API_KEY
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const err = new Error('tavily_' + path.replace('/', '') + '_failed: HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error('tavily_' + path.replace('/', '') + '_timeout: geen antwoord binnen ' + TIMEOUT_MS + 'ms');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function tavilySearch(queries) {
  const all = [];
  for (const query of queries) {
    try {
      const payload = await tavilyFetch('/search', { query, max_results: 5, search_depth: 'advanced' });
      (payload.results || []).forEach((r) => all.push({ query, url: r.url, title: r.title, content: r.content }));
    } catch (e) {
      all.push({ query, error: e.message });
    }
  }
  return all;
}

async function tavilyExtract(urls) {
  try {
    const payload = await tavilyFetch('/extract', { urls, extract_depth: 'basic' });
    return {
      ok: (payload.results || []).map((r) => ({ url: r.url, title: r.title, content: (r.raw_content || '').slice(0, 4000) })),
      failed: payload.failed_results || []
    };
  } catch (e) {
    return { ok: [], failed: urls.map((u) => ({ url: u, error: e.message })) };
  }
}

async function tavilyResearch(input) {
  try {
    const payload = await tavilyFetch('/research', { input, model: 'mini' });
    return { content: payload.content || payload.answer || '', sources: payload.sources || payload.citations || [] };
  } catch (e) {
    return { content: '', sources: [], error: e.message };
  }
}

module.exports = { tavilySearch, tavilyExtract, tavilyResearch };
