/**
 * Dry run of the one-time retirement (retired-components.ts): lists what the
 * backend WOULD remove on this machine, with sizes. Removes nothing.
 *
 *   cd backend && npm run retire:dry-run [-- <configDir>]
 *
 * The default config dir is the one the backend uses (getBriefcaseConfigDir).
 */

import { getBriefcaseConfigDir } from '../bridges/runtime-paths';
import { formatBytes, planRetirement, retirementDone, RETIREMENT_ID } from './retired-components';

async function main(): Promise<void> {
  const configDir = process.argv[2] || getBriefcaseConfigDir();
  console.log(`Config dir: ${configDir}`);
  if (retirementDone(configDir)) {
    console.log(`Retirement "${RETIREMENT_ID}" already recorded as done; the backend will not run it again.`);
  }
  const plan = await planRetirement(configDir);
  if (plan.targets.length === 0) {
    console.log('Nothing to remove.');
  } else {
    console.log('Would remove:');
    for (const t of plan.targets) {
      console.log(`  ${formatBytes(t.bytes).padStart(10)}  ${t.type.padEnd(7)} ${t.path}  [${t.reason}]`);
    }
    console.log(`Total: ${formatBytes(plan.totalBytes)} (${plan.totalBytes} bytes) in ${plan.targets.length} item(s)`);
  }
  if (plan.recordIds.length > 0) console.log(`Would drop installed.json records: ${plan.recordIds.join(', ')}`);
  console.log(`Would then remove if empty: ${plan.emptyDirs.join(', ')}`);
  for (const s of plan.skipped) console.log(`Left alone: ${s.path} (${s.why})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
