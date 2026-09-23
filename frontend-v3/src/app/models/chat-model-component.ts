/**
 * The scorer's model and vision projector (backend config/model-catalog.ts
 * SCORER_MODELS) travel as 'llama-model' components so the installer puts them
 * in the shared models dir, but they are NOT chat models: the classic analysis
 * never uses them, the chat engine never loads them, and the bundled llama
 * engine cannot run them. Their ids all start with this prefix (pinned by a
 * backend spec).
 */
export const SCORER_COMPONENT_ID_PREFIX = 'scorer-';

/** True for a local chat model a user can pick for analysis: a llama-model that is not a scorer file. */
export function isChatModelComponent(c: { id: string; kind: string }): boolean {
  return c.kind === 'llama-model' && !c.id.startsWith(SCORER_COMPONENT_ID_PREFIX);
}
