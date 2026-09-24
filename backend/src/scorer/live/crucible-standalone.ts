/**
 * The app's own Crucible services for the scorer's LIVE tools (snap-smoke.ts,
 * flags/eval/flag-eval.ts), wired by hand as CrucibleModule wires them. Since
 * P7 Crucible's decision door is the only transport the scorer has.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getBriefcaseConfigDir } from '../../bridges/runtime-paths';
import { CrucibleClientFactory } from '../../crucible/client-factory';
import { CrucibleServersService } from '../../crucible/crucible-servers.service';
import { chatsInFlight } from '../../crucible/in-flight-sweep';
import { CrucibleChatService } from '../../crucible/llm/crucible-chat.service';
import { readCruciblePairingFile } from '../../crucible/pairing-file';
import { CrucibleProbeService } from '../../crucible/probe';
import { CrucibleRegistryService } from '../../crucible/registry.service';
import { CrucibleScorerService } from '../crucible-scorer.service';

/**
 * The app's own Crucible services, wired by hand as CrucibleModule wires them:
 * NAME from Briefcase's registry, or this machine's Crucible read from its
 * pairing file into a throwaway registry (nothing of the user's is written).
 */
export function crucibleServices(which: string | true): { scorer: CrucibleScorerService; chat: CrucibleChatService; server: string | null; factory: CrucibleClientFactory } {
  let dir: string;
  let server: string | null = null;
  if (which === true) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-live-crucible-'));
  } else {
    dir = getBriefcaseConfigDir();
    server = which;
  }
  const registry = new CrucibleRegistryService(dir);
  if (which === true) {
    const reading = readCruciblePairingFile();
    if (reading === null) throw new Error('no Crucible on this machine (~/.crucible/pairing is missing); pass --crucible NAME');
    registry.add({ name: 'local', url: reading.pairing.url, token: reading.pairing.token });
    server = 'local';
  } else if (!registry.names().includes(which)) {
    throw new Error(`no Crucible server named "${which}" in ${dir} (have: ${registry.names().join(', ') || 'none'})`);
  }
  const factory = new CrucibleClientFactory(registry);
  const probes = new CrucibleProbeService(factory, registry);
  const servers = new CrucibleServersService(registry, factory);
  const chat = new CrucibleChatService(servers, factory, probes);
  return { scorer: new CrucibleScorerService(chat, servers), chat, server, factory };
}

/** /v1/activity's answer to "is the card someone else's?": null when free, else the sentence. */
export async function cardHeldByOther(factory: CrucibleClientFactory, server: string): Promise<string | null> {
  const activity = await (await factory.clientFor(server)).activity();
  const mine = (client: string | null | undefined) => client === 'briefcase';
  if (activity.lease && !mine(activity.lease.client)) return `a lease by ${activity.lease.client ?? 'another client'} (${activity.lease.act})`;
  const running = activity.running.filter((j) => !mine(j.client));
  if (running.length) return `running ${running.map((j) => `${j.client ?? '?'}'s ${j.type}`).join(', ')}`;
  const queued = activity.queued.filter((j) => !mine(j.client));
  if (queued.length) return `queued ${queued.map((j) => `${j.client ?? '?'}'s ${j.type}`).join(', ')}`;
  const chats = chatsInFlight(activity);
  if (chats === null) return 'chats the server does not count (it states no chat activity)';
  if (chats > 0) return `${chats} chat(s) in flight`;
  return null;
}
