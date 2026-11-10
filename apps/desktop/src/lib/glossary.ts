import { glossary as defaultGlossary, type GlossaryEntry } from './docTask';

const STORAGE_KEY = 'aw-glossary';

export { defaultGlossary };

export function readGlossary(): GlossaryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultGlossary.map((entry) => ({ ...entry }));
    const parsed = JSON.parse(raw) as GlossaryEntry[];
    if (!Array.isArray(parsed)) return defaultGlossary.map((entry) => ({ ...entry }));
    const entries = parsed
      .filter((entry) => entry && typeof entry.term === 'string' && entry.term.trim())
      .map((entry) => ({
        term: entry.term.trim(),
        label: String(entry.label ?? ''),
        description: String(entry.description ?? ''),
      }));
    return entries;
  } catch {
    return defaultGlossary.map((entry) => ({ ...entry }));
  }
}

export function writeGlossary(entries: GlossaryEntry[]) {
  const cleaned = entries
    .map((entry) => ({
      term: entry.term.trim(),
      label: entry.label.trim(),
      description: entry.description.trim(),
    }))
    .filter((entry) => entry.term);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
  } catch {
    // 本地存储不可用时仅保留内存状态。
  }
  return cleaned;
}
