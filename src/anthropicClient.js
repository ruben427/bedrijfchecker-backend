// Vervangt de Artifact's `sample`-capability (window.claude.use('sample'))
// door een directe Anthropic API-call. sampleJsonSafe() gedraagt zich
// hetzelfde als in de Artifact: vraag om pure JSON, en bij een kapotte/
// afgekapte JSON-reply één keer opnieuw proberen met een stelliger prompt.

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

function extractJson(text) {
  if (!text) throw new Error('empty_response');
  let s = text.trim();
  // Strip een eventueel markdown-codeblok (```json ... ``` of ``` ... ```).
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  const start = s.search(/[\[{]/);
  if (start > 0) s = s.slice(start);
  return JSON.parse(s);
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
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens || 4096,
    temperature: 0,
    messages: [{ role: 'user', content }]
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return extractJson(text);
}

async function sampleJsonSafe(prompt, opts) {
  try {
    return await sampleJson(prompt, opts);
  } catch (e) {
    // Eén herkansing met een stelliger prompt, net als in de Artifact-versie.
    const retryPrompt = prompt +
      '\n\nLET OP: je vorige antwoord was geen geldige of volledige JSON. Antwoord dit keer UITSLUITEND met compacte, geldige JSON, zonder uitleg ervoor of erna, zonder markdown-codeblok. Begin direct met { of [. Houd tekstvelden kort (maximaal 1-2 zinnen per veld).';
    return await sampleJson(retryPrompt, opts);
  }
}

module.exports = { sampleJson, sampleJsonSafe, MODEL };
