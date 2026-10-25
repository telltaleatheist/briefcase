/**
 * JSON as models write it: maybe fenced, maybe with prose around the object,
 * maybe with a trailing comma. Recovered when it is recoverable, null when it
 * is not: never a guessed field.
 */

/** The object or array in `text`, or null when there is none that parses. */
export function parseLenientJson(text: string): unknown {
  const unfenced = text.replace(/```[a-z]*/gi, '').trim();
  if (!unfenced) return null;
  const direct = tryParse(unfenced);
  if (direct !== undefined) return direct;
  const balanced = firstBalanced(unfenced);
  if (balanced === null) return null;
  const parsed = tryParse(balanced) ?? tryParse(balanced.replace(/,\s*([\]}])/g, '$1'));
  return parsed === undefined ? null : parsed;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The first balanced {...} or [...] in the text, string-aware; null when it never closes. */
function firstBalanced(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = inString;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
