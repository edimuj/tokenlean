/**
 * Function lookup — find existing functions by name or intent.
 *
 * The prevention half of the dedupe story: before an agent writes `getUserId`,
 * it searches for what already exists and reuses it. Ranking is lexical (name
 * words + signature + body keywords), no embeddings — fast and dependency-free.
 */

// Split an identifier / phrase into lowercase word tokens.
// camelCase, snake_case, kebab, dotted and path-separated all break apart.
export function words(s) {
  return (s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-./\\]/g, ' ')
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
}

function coverage(queryWords, targetWords) {
  if (queryWords.length === 0) return 0;
  const target = new Set(targetWords);
  let hit = 0;
  for (const q of queryWords) if (target.has(q)) hit++;
  return hit / queryWords.length;
}

const estTokens = body => Math.max(1, Math.ceil((body || '').replace(/\s+/g, ' ').trim().length / 4));

/**
 * Rank functions by relevance to a query (a name or an intent phrase).
 * @param {object[]} functions  {name, signature, file, line, body, lang}
 * @param {string} query
 * @param {object} opts { limit=15, minScore=0.3 }
 * @returns {object[]} ranked matches with {name, signature, file, line, score, tokens}
 */
export function searchFunctions(functions, query, opts = {}) {
  const { limit = 15, minScore = 0.3 } = opts;
  const qWords = words(query);
  if (qWords.length === 0) return [];
  const qJoined = qWords.join('');

  const scored = [];
  for (const fn of functions) {
    const nameWords = words(fn.name);
    const nameScore = coverage(qWords, nameWords);

    // Exact / substring name match is a strong signal.
    const nameLc = (fn.name || '').toLowerCase();
    let nameBonus = 0;
    if (nameLc === qJoined) nameBonus = 0.6;
    else if (nameLc.includes(qJoined) || qJoined.includes(nameLc)) nameBonus = 0.25;

    const sigScore = coverage(qWords, words(fn.signature));
    const bodyScore = coverage(qWords, words(fn.body));

    // Name dominates; signature and body refine. Body is weakest (noisy).
    const score = Math.min(1, nameScore + nameBonus + 0.3 * sigScore + 0.12 * bodyScore);
    if (score < minScore) continue;

    scored.push({
      name: fn.name,
      signature: fn.signature || fn.name,
      file: fn.file,
      line: fn.line,
      lang: fn.lang,
      tokens: estTokens(fn.body),
      score: Math.round(score * 100) / 100,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.tokens - b.tokens);
  return scored.slice(0, limit);
}
