/**
 * A decide request, checked before it crosses to Crucible's decision door:
 * snap's own schema checks (snap/schema.py), refused as `bad_request` with the
 * mistake named, so a bad request never touches the card.
 *
 * Moved out of scorer-decide.ts when P7 removed the scorer's own llama-server
 * (the decider that file held); the Crucible transport (crucible-decide.ts)
 * is the only caller.
 */

import { DecideRequest, ScorerError, ScorerQuestion } from './scorer.types';

/**
 * Images per request. Each image costs up to 4096 tokens for Qwen-VL
 * projectors, so 8 keeps a request inside a modest context and makes a runaway
 * client fail by name.
 */
export const MAX_IMAGES = 8;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** The checks snap's pydantic schema makes, refused as bad_request. Counts keep their own names. */
export function validateDecideRequest(req: DecideRequest): void {
  const bad = (msg: string): never => {
    throw new ScorerError('bad_request', msg);
  };
  if (!req || typeof req !== 'object') bad('the request must be an object');
  if (req.state === null || req.state === undefined) bad('state is required and may not be null');
  if (!Array.isArray(req.questions) || req.questions.length < 1) bad('questions must be a non-empty array');
  if (req.nProbs !== undefined && (!Number.isInteger(req.nProbs) || req.nProbs < 1)) {
    bad(`nProbs must be a positive integer, got ${req.nProbs}`);
  }
  if (req.missingLabels !== undefined && req.missingLabels !== 'error' && req.missingLabels !== 'floor') {
    bad(`missingLabels must be 'error' or 'floor', got ${JSON.stringify(req.missingLabels)}`);
  }

  const names = new Set<string>();
  for (const q of req.questions) {
    if (!q || typeof q.name !== 'string' || !q.name) bad('every question needs a non-empty name');
    if (names.has(q.name)) bad(`duplicate question name '${q.name}'`);
    names.add(q.name);
    if (typeof q.instructions !== 'string' || !q.instructions) bad(`question '${q.name}' has empty instructions`);
    if (q.type === 'choice') {
      if (!Array.isArray(q.options) || q.options.length < 2) bad(`question '${q.name}' needs at least 2 options`);
      for (const o of q.options) {
        if (!o || typeof o.name !== 'string' || !o.name || typeof o.description !== 'string' || !o.description) {
          bad(`question '${q.name}' has an option with an empty name or description`);
        }
      }
    } else if (q.type === 'score') {
      if (!Array.isArray(q.levels) || q.levels.length < 2) bad(`question '${q.name}' needs at least 2 levels`);
      if (q.levels.some((l) => typeof l !== 'string' || !l)) bad(`question '${q.name}' has an empty level`);
      if (new Set(q.levels).size !== q.levels.length) bad(`question '${q.name}': levels must be unique`);
    } else if (q.type !== 'yesno') {
      bad(`question '${(q as ScorerQuestion).name}' has an unknown type`);
    }
  }

  // Strict: an engine's base64 decoder may stop silently at the first character
  // outside [A-Za-z0-9+/], so a data: URI or a line-wrapped string would reach
  // the model as a truncated file.
  const images = req.images ?? [];
  if (!Array.isArray(images)) bad('images must be an array of base64 strings');
  images.forEach((s, i) => {
    if (typeof s !== 'string' || !s) bad(`images[${i}] is empty`);
    if (s.length % 4 !== 0 || !BASE64_RE.test(s)) {
      bad(`images[${i}] is not base64 (standard alphabet, padded, no whitespace or data: prefix)`);
    }
    if (Buffer.from(s, 'base64').length === 0) bad(`images[${i}] decodes to zero bytes`);
  });

  if (typeof req.state === 'string' && !req.state.trim() && images.length === 0) {
    bad('state may not be empty unless images carry the state');
  }
}
