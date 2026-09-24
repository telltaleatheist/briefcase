/**
 * NO WEB PAGE MAY DRIVE THE CRUCIBLE DOORS.
 *
 * Without this, any page open in a browser on this computer could add its own
 * "Crucible" (POST /crucible/servers with a connect code for a server it runs)
 * and then ask Briefcase to copy the user's Claude/OpenAI keys to it
 * (POST /crucible/ai/keys/copy), or start an install. A plain HTML form POST
 * needs no preflight, so CORS alone never stopped that.
 *
 * The rule is the app-wide one (common/app-origin.ts, also applied to every
 * write by main.ts's middleware): a state-changing request needs no Origin
 * (Node, curl, the Electron main process) or one of the app's own origins.
 * This guard keeps the Crucible doors closed even where that middleware is not
 * installed (a test module, a future second entry point). Reads are unaffected.
 */
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { environment } from '../config/environment';
import { OriginPolicy, writeAllowed } from '../common/app-origin';

export function originAllowed(
  method: string,
  origin: string | string[] | undefined,
  policy: OriginPolicy = environment.originPolicy,
  requestHost?: string | string[],
): boolean {
  return writeAllowed(method, origin, policy, requestHost);
}

@Injectable()
export class LoopbackOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ method: string; headers: Record<string, string | string[] | undefined> }>();
    if (!originAllowed(req.method, req.headers['origin'], environment.originPolicy, req.headers['host'])) {
      throw new ForbiddenException('Crucible settings can only be changed from Briefcase itself.');
    }
    return true;
  }
}
