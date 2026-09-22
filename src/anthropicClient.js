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
  //
  // LET OP: een 'document'-block accepteert ALLEEN application/pdf. Een JPEG
  // of PNG die hier binnenkomt levert een 400 invalid_request_error op. Dat
  // gebeurde bij elk gecrawld COA van nextgenpeptides.nl (21 .jpeg-bestanden):
  // de aanroeper gaf ze als 'documents' mee, de API weigerde ze allemaal, en
  // de fout werd verderop stil weggevangen. Daarom routeren we hier op
  // mediatype in plaats van te vertrouwen op de aanroeper.
  (opts.documents || []).forEach((doc) => {
    const mt = (doc.mediaType || 'application/pdf').toLowerCase();
    if (mt.startsWith('image/')) {
      content.push({ type: 'image', source: { type: 'base64', media_type: mt, data: doc.data } });
    } else {
      content.push({ type: 'document', source: { type: 'base64', media_type: mt, data: doc.data } });
    }
  });
  // ROOT CAUSE van de "empty_response"/afgekapte-JSON-fouten (bv. de
  // categorize-fout die Ruben zag, met detail "stop_reason: max_tokens,
  // content: [thinking]"): claude-sonnet-5 gebruikt kennelijk standaard
  // extended thinking, en die 'thinking'-tokens komen uit HETZELFDE
  // max_tokens-budget als de uiteindelijke tekst. Bij een omvangrijke
  // prompt (zoals categorize, met de hele COA-dataset erin) at het denken
  // het budget van 4096 soms volledig op — nul tokens over voor de JSON
  // zelf. We willen hier sowieso geen chain-of-thought (EVIDENCE_RULES eist
  // toch al kaal JSON, geen toelichting erbuiten), dus schakel het uit i.p.v.
  // te gokken hoeveel budget denken nodig heeft. max_tokens ook iets ruimer
  // gezet als marge voor stappen met veel velden (categorize, reportA/B).
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens || 8192,
    thinking: { type: 'disabled' },
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
// Een API-fout komt binnen als een ruwe JSON-dump: 400 gevolgd door het hele
// foutobject. De aanroeper kapt die melding af, en dan blijft er precies het
// nutteloze deel over: 400 {"type":"error","error":{"type":"inval
//
// Dat is echt gebeurd. Eenentwintig COA's van nextgenpeptides faalden een
// week lang op "media_type moet application/pdf zijn", maar die zin stond
// voorbij het afkappunt. Daarom halen we hier de boodschap van de API zelf
// naar voren, zodat het eerste dat je leest ook het probleem is.
function kernVanFout(e) {
  const ruw = (e && e.message) || 'onbekend';
  const berichten = [];
  const re = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(ruw)) !== null) {
    const tekst = m[1].replace(/\\"/g, '"');
    if (tekst && berichten.indexOf(tekst) === -1) berichten.push(tekst);
  }
  if (!berichten.length) return ruw;
  const status = (ruw.match(/\b([45]\d\d)\b/) || [])[1];
  return (status ? status + ' ' : '') + berichten.join(' / ');
}

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
      const err = new Error(label + 'eerste poging: ' + kernVanFout(e) + ' || herkansing: ' + kernVanFout(e2));
      throw err;
    }
  }
}

module.exports = { sampleJson, sampleJsonSafe, kernVanFout, MODEL };
