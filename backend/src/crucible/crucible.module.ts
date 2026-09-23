/**
 * Briefcase's Crucible integration: the server registry and routing record,
 * pairing, probing and the settings door. P1 of docs/crucible-migration-plan.md.
 *
 * BOOT TOLERANCE. Nothing here does I/O in a constructor or an awaited
 * `onModuleInit`. The only thing that runs at boot is auto-connect, started in
 * `onApplicationBootstrap` as a timer that is never awaited. The library,
 * downloads, editor and Collections have no import path into this module, and
 * nothing outside it uses Crucible yet.
 */
import { Module } from '@nestjs/common';
import { getBriefcaseConfigDir } from '../bridges/runtime-paths';
import { CrucibleAutoConnectService } from './auto-connect.service';
import { CrucibleClientFactory } from './client-factory';
import { systemClipboard } from './clipboard';
import { CrucibleConnectService } from './connect.service';
import { CRUCIBLE_CLIPBOARD, CRUCIBLE_PAIRING_HOST, CRUCIBLE_STATE_DIR } from './crucible.constants';
import { CrucibleController } from './crucible.controller';
import { processPairingFileHost } from './pairing-file';
import { CrucibleProbeService } from './probe';
import { CrucibleRegistryService } from './registry.service';
import { CrucibleSettingsBridge } from './settings-bridge.service';

@Module({
  controllers: [CrucibleController],
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
  ],
  exports: [CrucibleRegistryService, CrucibleClientFactory, CrucibleProbeService, CrucibleAutoConnectService],
})
export class CrucibleModule {}
