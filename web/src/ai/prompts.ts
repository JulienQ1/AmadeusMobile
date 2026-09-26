import type { Lang } from '../settings';
import { KURISU_PROMPT_FULL_JA, KURISU_PROMPTS_SHORT, WEB_SEARCH_CONTEXT } from './prompts.generated';

const LANGUAGE_NAMES_EN: Record<Lang, string> = {
  ja: 'Japanese', en: 'English', zh: 'Simplified Chinese', ko: 'Korean', es: 'Spanish', fr: 'French',
  de: 'German', ru: 'Russian', uk: 'Ukrainian', pt: 'Portuguese', tr: 'Turkish',
};

// Only the FR/DE/RU prompts of the original describe the memory commands; the
// memory system is language-independent, so the others get the same block.
const MEMORY_COMMANDS_JA = `【記憶コマンド（必要な場合のみ）】
返答の最後に記憶コマンドを追加できる。これはユーザーには表示されない。
- [SAVE_FACT: ユーザーに関する恒久的な事実]
- [SAVE_EVENT: {"summary":"出来事の要約","tags":["tag1","tag2"]}]
重要で繰り返し役立つ情報は積極的に保存すること。一度きりの冗談は保存しない。`;

const MEMORY_COMMANDS_EN = `【Memory commands (only when needed)】
At the end of your reply you may add a memory command. It is hidden from the user.
- [SAVE_FACT: A permanent fact about the user]
- [SAVE_EVENT: {"summary":"Summary of the event","tags":["tag1","tag2"]}]
Actively save important, recurring information. Do not save one-off jokes.`;

export function personaPrompt(lang: Lang, detailed: boolean): string {
  let prompt: string;
  if (detailed) {
    prompt = KURISU_PROMPT_FULL_JA;
  } else {
    prompt = KURISU_PROMPTS_SHORT[lang] ?? KURISU_PROMPTS_SHORT.en;
  }
  if (!prompt.includes('SAVE_FACT')) prompt += '\n\n' + (lang === 'ja' ? MEMORY_COMMANDS_JA : MEMORY_COMMANDS_EN);
  return prompt;
}

const REPLY_IN: Record<Exclude<Lang, 'ja'>, string> = {
  en: 'Always reply in English.',
  zh: '请始终用简体中文回复。',
  ko: '항상 한국어로 대답하세요.',
  es: 'Responde siempre en español.',
  fr: 'Réponds toujours en français.',
  de: 'Antworte immer auf Deutsch.',
  ru: 'Всегда отвечай на русском языке.',
  uk: 'Завжди відповідай українською мовою.',
  pt: 'Responda sempre em português.',
  tr: 'Her zaman Türkçe cevap ver.',
};

/**
 * Needed when the persona is not written in the reply language (the detailed
 * Japanese sheet, or the English fallback for uk/pt/tr).
 */
function languageRule(lang: Lang, detailed: boolean): string {
  if (lang === 'ja' || (!detailed && lang in KURISU_PROMPTS_SHORT)) return '';
  return (
    `【Language — highest priority】The character sheet above is written in another language, example dialogues included: ` +
    `use it as reference only. Write every reply in ${LANGUAGE_NAMES_EN[lang]}, even if earlier replies in this conversation ` +
    `were in another language. Keep the emotion tag and memory commands exactly as specified. ${REPLY_IN[lang]}`
  );
}

const VOICE_EXAMPLE: Partial<Record<Lang, string>> = {
  fr: '[SMUG] [VOICE: ふーん、やっと分かったのね。] Ah, tu as enfin compris. [VOICE: 遅すぎるわよ。] Il était temps.',
  en: "[SMUG] [VOICE: ふーん、やっと分かったのね。] Oh, so you finally get it. [VOICE: 遅すぎるわよ。] About time.",
};

/** Japanese voice (VOICEVOX) over text displayed in another language, like a subtitled anime. */
function voiceRule(lang: Lang): string {
  const name = LANGUAGE_NAMES_EN[lang];
  const example = VOICE_EXAMPLE[lang] ?? VOICE_EXAMPLE.en!;
  return (
    `【Voice】Kurisu speaks Japanese aloud while the user reads her reply in ${name}, like a subtitled anime. ` +
    `Before each sentence of the reply, write the Japanese line Kurisu actually says, in her natural spoken tone, ` +
    `inside [VOICE: ...]. Inside VOICE: Japanese only, no emotion tags, no memory commands, no brackets. ` +
    `Outside VOICE: the reply in ${name} only.\nExample: ${example}`
  );
}

/**
 * Rules sent after everything else (memories, context), where small local
 * models still follow them: they otherwise drift into the language of the long
 * character sheet and its example dialogues, or forget the voice lines.
 */
export function finalRules(lang: Lang, detailed: boolean, japaneseVoice: boolean): string {
  return [languageRule(lang, detailed), japaneseVoice && lang !== 'ja' ? voiceRule(lang) : '']
    .filter(Boolean)
    .join('\n\n');
}

export function webSearchContext(lang: Lang): string {
  return WEB_SEARCH_CONTEXT[lang === 'ja' ? 'ja' : 'en'];
}
