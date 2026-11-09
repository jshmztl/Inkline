import type { HeaderPair } from './api';

const VAR_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export interface TemplateResult {
  value: string;
  missing: string[];
}

export function resolveTemplate(
  template: string,
  variables: Record<string, string>,
): TemplateResult {
  const missing: string[] = [];
  const value = template.replace(VAR_PATTERN, (source, name: string) => {
    const replacement = variables[name];
    if (replacement === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return source;
    }
    return replacement;
  });
  return { value, missing };
}

export function resolveHeaders(headers: HeaderPair[], variables: Record<string, string>) {
  const missing: string[] = [];
  const resolved = headers.map((header) => {
    const result = resolveTemplate(header.value, variables);
    for (const name of result.missing) {
      if (!missing.includes(name)) missing.push(name);
    }
    return { name: header.name, value: result.value };
  });
  return { headers: resolved, missing };
}
