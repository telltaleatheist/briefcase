// Path-containment helpers used to harden endpoints that accept a
// client-supplied filesystem path (LAN-exposure hardening).
//
// These are deliberately low-level, fail-closed primitives: they never
// substitute a default or "best guess" path — callers decide how to reject
// when a path is not contained (per the NO SILENT FALLBACKS rule).
import * as path from 'path';

/**
 * Windows filesystems are case-insensitive; POSIX ones are case-sensitive.
 * Normalize the comparison key accordingly so containment checks are correct
 * on both platforms.
 */
function comparable(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * True when `candidate`, once fully resolved, is exactly one of `roots` or
 * lives beneath one of them. Both the candidate and each root are resolved to
 * absolute paths first, so `..` traversal in the candidate cannot escape a
 * root. A root of `''`/`undefined`/`null` is ignored (never matches).
 */
export function isPathInsideRoots(
  candidate: string,
  roots: Array<string | undefined | null>,
): boolean {
  if (!candidate) {
    return false;
  }

  const resolvedCandidate = comparable(path.resolve(candidate));

  for (const root of roots) {
    if (!root) {
      continue;
    }
    const resolvedRoot = comparable(path.resolve(root));
    if (resolvedCandidate === resolvedRoot) {
      return true;
    }
    const rootWithSep = resolvedRoot.endsWith(path.sep)
      ? resolvedRoot
      : resolvedRoot + path.sep;
    if (resolvedCandidate.startsWith(rootWithSep)) {
      return true;
    }
  }

  return false;
}

/**
 * True when two paths resolve to the same absolute location (platform-aware
 * case sensitivity). Used to match a candidate against a known-good file path
 * (e.g. a media file already tracked in the database).
 */
export function pathsEqual(a: string, b: string): boolean {
  if (!a || !b) {
    return false;
  }
  return comparable(path.resolve(a)) === comparable(path.resolve(b));
}
