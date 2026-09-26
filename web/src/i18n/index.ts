import { settings, type Lang } from '../settings';
import { EXTRA } from './extra';

const files = import.meta.glob<Record<string, string>>('./locales/*.json', { eager: true, import: 'default' });

const tables: Record<string, Record<string, string>> = {};
for (const [path, table] of Object.entries(files)) {
  const code = path.replace(/^.*\/([a-z]+)\.json$/, '$1');
  tables[code] = { ...table, ...(EXTRA[code] ?? {}) };
}
for (const [code, extra] of Object.entries(EXTRA)) {
  tables[code] ??= { ...extra };
}

export function lang(): Lang {
  return settings.get().language;
}

/** Translation with fallback to English, then to the given default (or the key). */
export function t(key: string, fallback?: string): string {
  const table = tables[lang()];
  return table?.[key] ?? tables.en?.[key] ?? fallback ?? key;
}

/** BCP-47 tag for speech services. */
export function speechLocale(code: Lang = lang()): string {
  const map: Record<Lang, string> = {
    ja: 'ja-JP', en: 'en-US', zh: 'zh-CN', ko: 'ko-KR', es: 'es-ES', fr: 'fr-FR',
    de: 'de-DE', ru: 'ru-RU', uk: 'uk-UA', pt: 'pt-BR', tr: 'tr-TR',
  };
  return map[code];
}

/** Applies translations to elements carrying data-i18n / data-i18n-placeholder attributes. */
export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder!);
  });
  document.documentElement.lang = lang();
}
