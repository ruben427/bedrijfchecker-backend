// Vervangt de Artifact's `sample`-capability (window.claude.use('sample'))
// door een directe Anthropic API-call. sampleJsonSafe() gedraagt zich
// hetzelfde als in de Artifact: vraag om pure JSON, en bij een kapotte/
// afgekapte JSON-reply één keer opnieuw proberen met een stelliger prompt.

const Anthropic = require('@anthropic-ai/sdk');

// Expliciete timeout i.p.v. de SDK-default (10 minuten): dat is bounded dus
// geen oneindige hang zoals bij tavilyClient, maar 10 minuten "vast" op een
// stap voelt voor Ruben nog steeds als hangen. 2 minuten is ruim voor een
// enkele JSON-samplecall; instelbaar via ANTHROPIC_TIMEOUT_MS.
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: Number(process.env.ANTHROPIC_TIMEOUT_MS) || 120000
});
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

// Bij een JSON.parse-fout gaf de foutmelding tot nu toe alleen "Unterminated
// string at position X" — nuttig voor een JS-developer, maar niet te zien
// wat het model daadwerkelijk teruggaf. Vandaar: bij een parse-fout een
// stuk van de ruwe modeloutput rond het probleem meesturen in de foutmelding
// zelf, zodat die al zichtbaar is in de UI (case.error) zonder losse logs.
//
// "empty_response" gaf tot nu toe geen enkel aanknopingspunt (bv. de
// categorize-fout die Ruben zag: "eerste poging: empty_response ||
// herkansing: empty_response") — geen idee of het een lege modelreactie was,
// een stop_reason als 'refusal', of iets anders. detail (optioneel, gezet
// door sampleJson hieronder) geeft dat alsnog mee in de foutmelding zelf.
function extractJson(text, detail) {
  if (!text) throw new Error('empty_response' + (detail ? ' (' + detail + ')' : ''));
  let s = text.trim();
  // Strip een eventueel markdown-codeblok (```json ... ``` of ``` ... ```).
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  const start = s.search(/[\[{]/);
  if (start > 0) s = s.slice(start);
  try {
    return JSON.parse(s);
  } catch (e) {
    const posMatch = /position (\d+)/.exec(e.message);
    let snippet;
    if (posMatch) {
      const pos = Number(posMatch[1]);
      const from = Math.max(0, pos - 120);
      const to = Math.min(s.length, pos + 80);
      snippet = (from > 0 ? '…' : '') + s.slice(from, to).replace(/\s+/g, ' ') + (to < s.length ? '…' : '');
    } else {
      snippet = s.length > 300 ? s.slice(0, 200).replace(/\s+/g, ' ') + '…' : s.replace(/\s+/g, ' ');
    }
    const err = new Error(e.message + ' | ruwe modeloutput rond de fout: "' + snippet + '"');
    err.rawText = s;
    throw err;
  }
}

/**
 * @param {string} prompt - volledige prompttekst (systeemregels + context + schema-hint), zoals in de Artifact.
 * @param {object} opts
 * @param {Array<{data:string, mediaType:string}>} [opts.images] - base64 image data voor documentanalyse.
 * @param {number} [opts.maxTokens]
 */
async function sampleJson(prompt, opts) {
  opts = opts || {};
  const content = [{ type: 'text', text: prompt }];
  (opts.images || []).forEach((img) => {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType || 'image/jpeg', data: img.data } });
  });
  // PDF's (bijv. een geüpload KvK-uittreksel) gaan als 'document'-content mee;
  // Claude leest die native, geen conversie naar afbeeldingen nodig.
  (opts.documents || []).forEach((doc) => {
    content.push({ type: 'document', source: { type: 'base64', media_type: doc.mediaType || 'application/pdf', data: doc.data } });
  });
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens || 4096,
    messages: [{ role: 'user', content }]
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  let detail;
  if (!text) {
    const blocks = (resp.content || []).map((b) => b.type + (typeof b.text === 'string' ? ':' + b.text.length + 'tekens' : '')).join(', ') || 'geen content-blocks';
    detail = 'stop_reason: ' + (resp.stop_reason || 'onbekend') + ', content: [' + blocks + ']';
  }
  return extractJson(text, detail);
}

// opts.label (optioneel): welke stap/call dit is (bv. 'identiteit',
// 'categorize', 'reportA') — wordt vóór de foutmelding gezet zodat een
// mislukte case meteen zegt WAAR het misging, niet alleen wat.
async function sampleJsonSafe(prompt, opts) {
  opts = opts || {};
  try {
    return await sampleJson(prompt, opts);
  } catch (e) {
    try {
      // Eén herkansing met een stelliger prompt, net als in de Artifact-versie.
      const retryPrompt = prompt +
        '\n\nLET OP: je vorige antwoord was geen geldige of volledige JSON. Antwoord dit keer UITSLUITEND met compacte, geldige JSON, zonder uitleg ervoor of erna, zonder markdown-codeblok. Begin direct met { of [. Houd tekstvelden kort (maximaal 1-2 zinnen per veld).';
      return await sampleJson(retryPrompt, opts);
    } catch (e2) {
      const label = opts.label ? '[' + opts.label + '] ' : '';
      const err = new Error(label + 'eerste poging: ' + e.message + ' || herkansing: ' + e2.message);
      throw err;
    }
  }
}

module.exports = { sampleJson, sampleJsonSafe, MODEL };
