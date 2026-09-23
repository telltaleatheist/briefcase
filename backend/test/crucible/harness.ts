/** Every Crucible service, wired by hand as CrucibleModule wires them, over a temp dir. */
import { CrucibleRegistryService } from '../../src/crucible/registry.service';
import { CrucibleClientFactory } from '../../src/crucible/client-factory';
import { CrucibleProbeService } from '../../src/crucible/probe';
import { CrucibleConnectService } from '../../src/crucible/connect.service';
import { CrucibleAutoConnectService } from '../../src/crucible/auto-connect.service';
import { CrucibleSettingsBridge } from '../../src/crucible/settings-bridge.service';
import type { PairingFileHost } from '../../src/crucible/pairing-file';
import type { CrucibleServersChangedPayload } from '../../src/crucible/wire/settings-wire';
import { pairingHost, tempDir } from './helpers';

export interface Harness {
  dir: string;
  registry: CrucibleRegistryService;
  factory: CrucibleClientFactory;
  probes: CrucibleProbeService;
  connect: CrucibleConnectService;
  autoConnect: CrucibleAutoConnectService;
  settings: CrucibleSettingsBridge;
  clipboard: string[];
  emitted: CrucibleServersChangedPayload[];
}

/** Every service, wired as the module wires them, over a temp dir. */
export function harness(host: PairingFileHost = pairingHost(null), dir = tempDir()): Harness {
  const emitted: CrucibleServersChangedPayload[] = [];
  const ws = { emitCrucibleServersChanged: (p: CrucibleServersChangedPayload) => emitted.push(p) };
  const registry = new CrucibleRegistryService(dir, ws as never);
  const factory = new CrucibleClientFactory(registry);
  const probes = new CrucibleProbeService(factory, registry);
  const clipboard: string[] = [];
  const connect = new CrucibleConnectService(registry, probes, host, async (text) => { clipboard.push(text); });
  const autoConnect = new CrucibleAutoConnectService(registry, factory, host);
  const settings = new CrucibleSettingsBridge(factory);
  return { dir, registry, factory, probes, connect, autoConnect, settings, clipboard, emitted };
}
