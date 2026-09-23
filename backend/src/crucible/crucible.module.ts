/**
 * Briefcase's Crucible integration: the server registry and routing record,
 * pairing, probing and the settings door (P1 of docs/crucible-migration-plan.md),
 * and installing Crucible, the first-run hold and coordination (P2).
 *
 * BOOT TOLERANCE. Nothing here does I/O in a constructor or an awaited
 * `onModuleInit`. What runs at boot is auto-connect and the startup
 * coordination pass, each started in `onApplicationBootstrap` as a timer that
 * is never awaited, and the Windows install-door watch (a no-op elsewhere). The library,
 * downloads, editor and Collections have no import path into this module, and
 * nothing outside it uses Crucible yet.
 */
import { Module } from '@nestjs/common';
import { compareReleases, latestRelease } from '@crucible/bootstrap';
import { getBriefcaseConfigDir } from '../bridges/runtime-paths';
import { CrucibleAutoConnectService } from './auto-connect.service';
import { CrucibleClientFactory } from './client-factory';
import { systemClipboard } from './clipboard';
import { CrucibleConnectService } from './connect.service';
import { CRUCIBLE_CLIPBOARD, CRUCIBLE_PAIRING_HOST, CRUCIBLE_STATE_DIR } from './crucible.constants';
import { CrucibleController } from './crucible.controller';
import { CrucibleServersService } from './crucible-servers.service';
import { processPairingFileHost } from './pairing-file';
import { CrucibleProbeService } from './probe';
import { CrucibleRegistryService } from './registry.service';
import { CrucibleSettingsBridge } from './settings-bridge.service';
import { CrucibleCoordinationService } from './coordinate.service';
import { CrucibleSetupController } from './crucible-setup.controller';
import { discoveredRow } from './discovery';
import { readCruciblePairingFile, type PairingFileHost } from './pairing-file';
import { PROBE_TIMEOUT_MS } from './probe';
import { processLocalControls } from './install/engine-presence';
import { crucibleProcessRunner } from './install/host-runner';
import { HostInstallDoor } from './install/install-door';
import { loadBootstrap, processInstallHost } from './install/install';
import { CRUCIBLE_INSTALL_DEPS, CrucibleInstallService, type InstallDeps } from './install/install.service';

/**
 * The real machine, the real release channel and the real bootstrap package.
 * The Crucible running here is asked its version through its pairing file:
 * none means nothing is installed; one that will not answer is an error (the
 * never-older gate refuses to install over an engine that will not say what
 * it is).
 */
function processInstallDeps(registry: CrucibleRegistryService, factory: CrucibleClientFactory, pairingHost: PairingFileHost): InstallDeps {
  return {
    host: processInstallHost(() => discoveredRow(registry.list(), pairingHost)),
    sources: {
      latest: () => latestRelease(),
      running: async () => {
        const found = readCruciblePairingFile(pairingHost);
        if (found === null) return null;
        const info = await factory
          .clientForCredentials(found.pairing.url, found.pairing.token, { timeoutMs: PROBE_TIMEOUT_MS })
          .info({ timeoutMs: PROBE_TIMEOUT_MS });
        return info.server.version;
      },
      compare: compareReleases,
    },
    bootstrap: loadBootstrap,
    runner: crucibleProcessRunner,
    localControls: () => processLocalControls(crucibleProcessRunner),
    door: new HostInstallDoor(),
  };
}

@Module({
  controllers: [CrucibleController, CrucibleSetupController],
  providers: [
    { provide: CRUCIBLE_STATE_DIR, useFactory: () => getBriefcaseConfigDir() },
    { provide: CRUCIBLE_PAIRING_HOST, useFactory: () => processPairingFileHost() },
    { provide: CRUCIBLE_CLIPBOARD, useValue: systemClipboard },
    CrucibleRegistryService,
    CrucibleClientFactory,
    CrucibleProbeService,
    CrucibleConnectService,
    CrucibleSettingsBridge,
    CrucibleAutoConnectService,
    CrucibleServersService,
    CrucibleCoordinationService,
    {
      provide: CRUCIBLE_INSTALL_DEPS,
      useFactory: processInstallDeps,
      inject: [CrucibleRegistryService, CrucibleClientFactory, CRUCIBLE_PAIRING_HOST],
    },
    CrucibleInstallService,
  ],
  // CrucibleServersService is the seam the rest of the backend uses (list/get/clientFor).
  exports: [
    CrucibleServersService, CrucibleRegistryService, CrucibleClientFactory, CrucibleProbeService, CrucibleAutoConnectService,
    CrucibleCoordinationService,
  ],
})
export class CrucibleModule {}
