/**
 * A stored AI model choice, `provider:model`, split into the `aiProvider` and
 * `aiModel` the queue's analyze task carries (backend crucible/llm/target.ts
 * reads them back): `local:<id>` is a model on the Crucible server itself,
 * `claude:` / `openai:` / `ollama:` its upstreams. `crucible:<id>` is read as
 * `local:`. A value with no provider prefix is a model on the server (never
 * Ollama by default); a Crucible-spelled `anthropic/…` id keeps its own prefix,
 * which the backend reads first.
 */
export function splitAiModelValue(value: string): { aiProvider: string; aiModel: string } {
  const trimmed = (value ?? '').trim();
  const match = /^(local|claude|openai|ollama|crucible):(.+)$/.exec(trimmed);
  if (match) return { aiProvider: match[1] === 'crucible' ? 'local' : match[1], aiModel: match[2] };
  return { aiProvider: 'local', aiModel: trimmed };
}
