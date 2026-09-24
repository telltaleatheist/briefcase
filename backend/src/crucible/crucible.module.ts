/**
 * Briefcase's Crucible integration: the server registry and routing record,
 * pairing, probing and the settings door (P1 of docs/crucible-migration-plan.md),
 * and installing Crucible, the first-run hold and coordination (P2).
 *
 * P7 adds the one readiness signal (readiness.service.ts): is Crucible there
 * for AI work, what repairs it, and the gate every AI door asks.
 *
 * BOOT TOLERANCE. Nothing here does I/O in a constructor or an awaited
 * `onModuleInit`. What runs at boot is auto-connect, the startup coordination
 * pass and the first readiness derivation, each started in
 * `onApplicationBootstrap` as a timer that is never awaited, and the Windows
 * install-door watch (a no-op elsewhere). The library, downloads, imports,
 * processing, the editor and Collections never wait on anything here.
 */
import { Module } from '@nestjs/common';
import { compareReleases, latestRelease } from '@crucible/bootstrap';
import { getBriefcaseConfigDir } from '../bridges/runtime-paths';
import { CrucibleAutoConnectService } from './auto-connect.service';
import { CrucibleClientFactory } from './client-factory';
import { systemClipboard } from './clipboard';
import { CrucibleConnectService } from './connect.service';
import { CRUCIBLE_CLIPBOARD, CRUCIBLE_IN_FLIGHT_LEDGER, CRUCIBLE_PAIRING_HOST, CRUCIBLE_STATE_DIR } from './crucible.constants';
import { InFlightLedger } from './in-flight-ledger';
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
import { CrucibleReadinessController } from './readiness.controller';
import { CrucibleReadinessService } from './readiness.service';

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
  controllers: [CrucibleController, CrucibleSetupController, CrucibleReadinessController],
  providers: [
    { provide: CRUCIBLE_STATE_DIR, useFactory: () => getBriefcaseConfigDir() },
    { provide: CRUCIBLE_PAIRING_HOST, useFactory: () => processPairingFileHost() },
    { provide: CRUCIBLE_CLIPBOARD, useValue: systemClipboard },
    { provide: CRUCIBLE_IN_FLIGHT_LEDGER, useFactory: (dir: string) => InFlightLedger.inDir(dir), inject: [CRUCIBLE_STATE_DIR] },
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
    CrucibleReadinessService,
  ],
  // CrucibleServersService is the seam the rest of the backend uses (list/get/clientFor).
  exports: [
    CrucibleServersService, CrucibleRegistryService, CrucibleClientFactory, CrucibleProbeService, CrucibleAutoConnectService,
    CrucibleCoordinationService,
    // P3: the AI pane edits the connected server's upstreams, and the key copy asks which server is this computer's.
    CrucibleSettingsBridge, CRUCIBLE_PAIRING_HOST,
    // P4: the in-flight ledger the chat service writes and the queue's sweeps read.
    CRUCIBLE_IN_FLIGHT_LEDGER,
    // P7: the readiness signal and the gate every AI door asks.
    CrucibleReadinessService,
  ],
})
export class CrucibleModule {}
