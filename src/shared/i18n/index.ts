// Lightweight i18n runtime shared between extension host and webview.
//
// Conventions:
// - Keys are dotted paths into a deep object literal (one per locale).
// - Locale files are the SINGLE source of truth for user-visible text.
// - To add a language, create a new file alongside `zh-CN.ts`/`en.ts` and
//   register it in `LOCALES` below.
// - Use `{name}` placeholders in strings. Pass values via the second argument
//   to `t`.
// - Default locale is `zh-CN` so missing English keys gracefully fall back.

import zhCN from './zh-CN';
import en from './en';

export type Locale = 'zh-CN' | 'en';

const LOCALES: Record<Locale, unknown> = {
  'zh-CN': zhCN,
  en
};

const DEFAULT_LOCALE: Locale = 'zh-CN';

let currentLocale: Locale = DEFAULT_LOCALE;

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = LOCALES[locale] ? locale : DEFAULT_LOCALE;
}

/** Normalise a VS Code language tag (e.g. `zh-cn`, `en-us`) to our `Locale`. */
export function normalizeLocale(lang: string | undefined | null): Locale {
  if (!lang) {
    return DEFAULT_LOCALE;
  }
  const lower = String(lang).toLowerCase();
  if (lower === 'zh-cn' || lower === 'zh-hans' || lower.startsWith('zh-hans') || lower.startsWith('zh-cn') || lower === 'zh') {
    return 'zh-CN';
  }
  if (lower.startsWith('zh')) {
    // Treat all Chinese variants as zh-CN for now; add zh-TW later if needed.
    return 'zh-CN';
  }
  return 'en';
}

function lookup(dict: unknown, parts: string[]): unknown {
  let cur: unknown = dict;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (m, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const v = vars[key];
      return v === undefined || v === null ? '' : String(v);
    }
    return m;
  });
}

/**
 * Look up a translated string by dotted path. Falls back to the default
 * locale when the key is missing in the active locale, and finally to the
 * key itself so missing translations are visible during development.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const parts = key.split('.');
  let value = lookup(LOCALES[currentLocale], parts);
  if (typeof value !== 'string') {
    value = lookup(LOCALES[DEFAULT_LOCALE], parts);
  }
  if (typeof value !== 'string') {
    return key;
  }
  return format(value, vars);
}
