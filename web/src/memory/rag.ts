// BM25 retrieval over stored memories, ported from NativeRAGService.cs
// (same tokenizer: kana/kanji runs and ASCII words; k1 = 1.5, b = 0.75).

const STOP_WORDS = new Set([
  'の', 'に', 'は', 'を', 'た', 'が', 'で', 'て', 'と', 'し', 'れ', 'さ', 'ある', 'いる', 'も', 'する', 'から', 'な', 'こと', 'として',
  'い', 'や', 'など', 'なっ', 'ない', 'この', 'ため', 'その', 'あっ', 'よう', 'また', 'もの', 'という', 'あり', 'まで', 'られ', 'なる',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'and', 'in', 'that', 'it', 'for', 'on', 'with', 'as', 'at', 'by',
  'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'est', 'je', 'tu',
]);

export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[぀-ゟ]+|[゠-ヿ]+|[一-龯]+|[\p{L}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  for (const m of matches) {
    if (STOP_WORDS.has(m)) continue;
    tokens.push(m);
    // Kanji runs rarely repeat verbatim; bigrams let "研究所" match "研究".
    if (/^[一-龯]{3,}$/.test(m)) for (let i = 0; i < m.length - 1; i++) tokens.push(m.slice(i, i + 2));
  }
  return tokens;
}

export function searchMemories(query: string, docs: string[], topK = 5, threshold = 0.1): string[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !docs.length) return [];
  const tokenized = docs.map(tokenize);
  const avgdl = tokenized.reduce((s, d) => s + d.length, 0) / tokenized.length || 1;
  const df = new Map<string, number>();
  for (const d of tokenized) for (const tok of new Set(d)) df.set(tok, (df.get(tok) ?? 0) + 1);

  const k1 = 1.5;
  const b = 0.75;
  const scored = tokenized.map((doc, i) => {
    const tf = new Map<string, number>();
    for (const tok of doc) tf.set(tok, (tf.get(tok) ?? 0) + 1);
    let score = 0;
    for (const tok of q) {
      const n = df.get(tok);
      if (!n) continue;
      const idf = Math.log10((docs.length - n + 0.5) / (n + 0.5) + 1);
      const f = tf.get(tok) ?? 0;
      const denom = f + k1 * (1 - b + (b * Math.max(1, doc.length)) / avgdl);
      if (denom > 0) score += (idf * (f * (k1 + 1))) / denom;
    }
    return { i, score };
  });
  return scored
    .filter((s) => s.score >= threshold)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, topK)
    .map((s) => docs[s.i]);
}

export function ragContext(query: string, docs: string[]): string {
  const hits = searchMemories(query, docs);
  if (!hits.length) return '';
  return ['【関連する記憶（検索結果）】', ...hits.map((h) => `- ${h}`)].join('\n');
}
