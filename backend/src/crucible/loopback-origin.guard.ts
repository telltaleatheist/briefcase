/**
 * NO WEB PAGE MAY DRIVE THE CRUCIBLE DOORS.
 *
 * The backend's CORS reflects any origin on loopback (config/environment.ts),
 * and a plain HTML form POST needs no preflight at all, so without this any
 * page open in a browser on this computer could add its own "Crucible"
 * (POST /crucible/servers with a connect code for a server it runs) and then
 * ask Briefcase to copy the user's Claude/OpenAI keys to it
 * (POST /crucible/ai/keys/copy), or start an install.
 *
 * Briefcase's own renderer is served from the backend itself
 * (http://localhost:<port> or 127.0.0.1), and a browser always sends Origin
 * on a cross-origin POST/PUT/PATCH/DELETE. So a state-changing request is let
 * through only when it carries no Origin (Node, curl, the Electron main
 * process) or an Origin on this computer's loopback. In LAN mode
 * (BRIEFCASE_LAN=1) a private-range host on the backend's own port is Briefcase
 * too, as config/environment.ts's LAN CORS rule already says. Reads are unaffected.
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { environment } from '../config/environment';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isLoopbackOrigin(origin: string, lan: { port: string | number } | null = null): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    return lan !== null && url.port === String(lan.port)
      && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  } catch {
    return false; // "null" (sandboxed frames, data: URLs) and anything unparsable
  }
}

export function originAllowed(
  method: string,
  origin: string | string[] | undefined,
  lan: { port: string | number } | null = environment.lanMode ? { port: environment.port } : null,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  if (origin === undefined) return true;
  const value = Array.isArray(origin) ? origin[0] : origin;
  return typeof value === 'string' && isLoopbackOrigin(value, lan);
}

@Injectable()
export class LoopbackOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ method: string; headers: Record<string, string | string[] | undefined> }>();
    if (!originAllowed(req.method, req.headers['origin'])) {
      throw new ForbiddenException('Crucible settings can only be changed from Briefcase itself.');
    }
    return true;
  }
}
