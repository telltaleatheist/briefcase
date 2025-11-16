/**
 * Console Testing Script for Progress Bars Investigation
 *
 * Copy and paste these commands into the browser console to test progress bar rendering
 */

// ========================================
// STEP 1: Get Angular Component Instances
// ========================================

console.log('=== PROGRESS BAR INVESTIGATION ===\n');

// Get the DownloadQueueComponent instance
function getDownloadQueueComponent() {
  const elem = document.querySelector('app-download-queue');
  if (!elem) {
    console.error('❌ DownloadQueueComponent not found in DOM');
    return null;
  }
  return ng.getComponent(elem);
}

// Get the VideoProcessingQueueService instance
function getQueueService() {
  const elem = document.querySelector('app-download-queue');
  if (!elem) {
    console.error('❌ DownloadQueueComponent not found in DOM');
    return null;
  }
  const component = ng.getComponent(elem);
  return component?.['videoProcessingQueueService'];
}

// ========================================
// STEP 2: Inspect Current Jobs
// ========================================

function inspectJobs() {
  console.log('\n📋 INSPECTING CURRENT JOBS\n');

  const service = getQueueService();
  if (!service) return;

  const jobs = service.getCurrentJobs();
  console.log(`Found ${jobs.size} jobs in queue`);

  jobs.forEach((job, jobId) => {
    console.log(`\n🎬 Job: ${job.displayName} (${jobId})`);
    console.log(`   Status: ${job.overallStatus}, Progress: ${job.overallProgress}%`);
    console.log(`   Children (${job.childProcesses.length}):`);

    job.childProcesses.forEach((child, index) => {
      console.log(`     ${index + 1}. ${child.displayName}:`);
      console.log(`        - ID: ${child.id}`);
      console.log(`        - Status: ${child.status}`);
      console.log(`        - Progress: ${child.progress}%`);
      console.log(`        - Backend Job ID: ${child.backendJobId || 'Not set'}`);
    });
  });

  return jobs;
}

// ========================================
// STEP 3: Set Progress to 50% for Testing
// ========================================

function setProgressTo50Percent() {
  console.log('\n🔧 SETTING PROGRESS TO 50% FOR ALL CHILDREN\n');

  const service = getQueueService();
  if (!service) {
    console.error('❌ Cannot access VideoProcessingQueueService');
    return;
  }

  const jobs = service.getCurrentJobs();

  if (jobs.size === 0) {
    console.warn('⚠️  No jobs found in queue. Add a job first.');
    return;
  }

  // Get the first job
  const firstJob = Array.from(jobs.values())[0];
  console.log(`Selected job: ${firstJob.displayName}`);

  // Update all children to 50% progress
  firstJob.childProcesses.forEach((child, index) => {
    console.log(`  Setting ${child.displayName} to 50%...`);
    child.progress = 50;
    child.status = 'processing'; // Ensure it's processing
  });

  // Recalculate overall progress
  const totalProgress = firstJob.childProcesses.reduce((sum, c) => sum + c.progress, 0);
  firstJob.overallProgress = Math.round(totalProgress / firstJob.childProcesses.length);

  console.log(`  Overall progress: ${firstJob.overallProgress}%`);

  // Update the job in the service
  const currentJobs = new Map(jobs);
  currentJobs.set(firstJob.id, firstJob);

  // Trigger update (access private field - hacky but works for testing)
  service['jobs'].next(currentJobs);

  console.log('✅ Progress updated! Check the UI now.');

  // Trigger change detection
  const component = getDownloadQueueComponent();
  if (component?.cdr) {
    component.cdr.detectChanges();
    console.log('✅ Change detection triggered');
  }

  return firstJob;
}

// ========================================
// STEP 4: Inspect Generated Cascade Children
// ========================================

function inspectCascadeChildren() {
  console.log('\n🔍 INSPECTING CASCADE CHILDREN GENERATION\n');

  const component = getDownloadQueueComponent();
  if (!component) return;

  const jobs = component.allJobsAsListItems;
  console.log(`Found ${jobs.length} job items for display`);

  jobs.forEach((job, index) => {
    console.log(`\n📦 Job ${index + 1}: ${job.displayName}`);

    // Call the generator directly
    if (component.generateJobStages) {
      const children = component.generateJobStages(job);
      console.log(`  Generated ${children.length} cascade children:`);

      children.forEach((child, i) => {
        console.log(`    ${i + 1}. ${child.label}:`);
        console.log(`       - ID: ${child.id}`);
        console.log(`       - Status: ${child.status}`);
        console.log(`       - Progress:`, child.progress);
        console.log(`       - Has progress object: ${!!child.progress}`);
        console.log(`       - Progress value: ${child.progress?.value}`);
        console.log(`       - Progress indeterminate: ${child.progress?.indeterminate}`);
      });
    } else {
      console.warn('  ⚠️  generateJobStages method not found');
    }
  });
}

// ========================================
// STEP 5: Check Template Rendering
// ========================================

function checkTemplateRendering() {
  console.log('\n🎨 CHECKING TEMPLATE RENDERING\n');

  // Find cascade children in DOM
  const cascadeChildren = document.querySelectorAll('.cascade-child');
  console.log(`Found ${cascadeChildren.length} cascade children in DOM`);

  cascadeChildren.forEach((elem, index) => {
    console.log(`\n  Child ${index + 1}:`);

    const label = elem.querySelector('.child-label')?.textContent;
    console.log(`    Label: ${label}`);

    const progressBar = elem.querySelector('.child-progress-bar');
    console.log(`    Has .child-progress-bar: ${!!progressBar}`);

    if (progressBar) {
      const progressFill = progressBar.querySelector('.progress-fill');
      console.log(`    Has .progress-fill: ${!!progressFill}`);
      if (progressFill) {
        const width = progressFill.style.width;
        console.log(`    Progress fill width: ${width}`);
      }
    }

    const statusIcon = elem.querySelector('.child-status-icon');
    console.log(`    Has status icon: ${!!statusIcon}`);
  });
}

// ========================================
// STEP 6: Complete Investigation Flow
// ========================================

function runFullInvestigation() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║   PROGRESS BAR FULL INVESTIGATION         ║');
  console.log('╚════════════════════════════════════════════╝\n');

  console.log('Step 1: Inspecting jobs...');
  const jobs = inspectJobs();

  if (!jobs || jobs.size === 0) {
    console.error('\n❌ No jobs found. Please add a job to the queue first.');
    return;
  }

  console.log('\nStep 2: Setting progress to 50%...');
  setProgressTo50Percent();

  console.log('\nStep 3: Waiting for UI update...');
  setTimeout(() => {
    console.log('\nStep 4: Inspecting cascade children generation...');
    inspectCascadeChildren();

    console.log('\nStep 5: Checking template rendering...');
    checkTemplateRendering();

    console.log('\n✅ Investigation complete! Review the logs above.');
  }, 500);
}

// ========================================
// QUICK ACCESS COMMANDS
// ========================================

console.log('Available commands:');
console.log('  inspectJobs()            - View all jobs and their children');
console.log('  setProgressTo50Percent() - Set all children to 50% progress');
console.log('  inspectCascadeChildren() - See generated cascade children');
console.log('  checkTemplateRendering() - Check DOM for progress bars');
console.log('  runFullInvestigation()   - Run all checks in sequence');
console.log('\nRecommended: Start with runFullInvestigation()');
