// Queue Controller - Manage unified job queue

import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { QueueManagerService } from './queue-manager.service';
import { Task } from '../common/interfaces/task.interface';

@Controller('queue')
export class QueueController {
  constructor(private readonly queueManager: QueueManagerService) {}

  /**
   * Add a job to the unified queue
   * POST /queue/jobs
   * Body: { url?, videoId?, videoPath?, displayName?, tasks: Task[] }
   */
  @Post('jobs')
  async addJob(
    @Body()
    body: {
      url?: string;
      videoId?: string; // For transcribe/analyze tasks on existing library videos
      videoPath?: string; // For local file processing
      displayName?: string;
      libraryId?: string; // Target library for import
      tasks: Task[];
    },
  ) {
    if (!body.tasks || body.tasks.length === 0) {
      throw new HttpException(
        'At least one task is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const jobId = this.queueManager.addJob({
      url: body.url,
      videoId: body.videoId,
      videoPath: body.videoPath,
      displayName: body.displayName,
      libraryId: body.libraryId,
      tasks: body.tasks,
    });

    return {
      success: true,
      jobId,
      message: 'Job added to queue',
    };
  }

  /**
   * Add multiple jobs to the unified queue (bulk add)
   * POST /queue/jobs/bulk
   * Body: { jobs: Array<{ url?, videoId?, videoPath?, displayName?, tasks }> }
   */
  @Post('jobs/bulk')
  async addBulkJobs(
    @Body()
    body: {
      jobs: Array<{
        url?: string;
        videoId?: string;
        videoPath?: string;
        displayName?: string;
        libraryId?: string;
        tasks: Task[];
      }>;
    },
  ) {
    if (!body.jobs || body.jobs.length === 0) {
      throw new HttpException('At least one job is required', HttpStatus.BAD_REQUEST);
    }

    const jobIds: string[] = [];

    for (const job of body.jobs) {
      const jobId = this.queueManager.addJob({
        url: job.url,
        videoId: job.videoId,
        videoPath: job.videoPath,
        displayName: job.displayName,
        libraryId: job.libraryId,
        tasks: job.tasks,
      });
      jobIds.push(jobId);
    }

    return {
      success: true,
      jobIds,
      message: `${jobIds.length} jobs added to queue`,
    };
  }

  /**
   * Get unified queue status
   * GET /queue/status
   */
  @Get('status')
  async getStatus() {
    const status = this.queueManager.getQueueStatus();

    return {
      success: true,
      status,
    };
  }

  /**
   * Get all jobs in the unified queue
   * GET /queue/jobs
   */
  @Get('jobs')
  async getJobs() {
    const jobs = this.queueManager.getAllJobs();

    return {
      success: true,
      jobs,
    };
  }

  /**
   * Get a specific job
   * GET /queue/job/:jobId
   */
  @Get('job/:jobId')
  async getJob(@Param('jobId') jobId: string) {
    const job = this.queueManager.getJob(jobId);

    if (!job) {
      throw new HttpException('Job not found', HttpStatus.NOT_FOUND);
    }

    return {
      success: true,
      job,
    };
  }

  /**
   * Delete a job
   * DELETE /queue/job/:jobId
   */
  @Delete('job/:jobId')
  async deleteJob(@Param('jobId') jobId: string) {
    const deleted = this.queueManager.deleteJob(jobId);

    if (!deleted) {
      throw new HttpException('Job not found', HttpStatus.NOT_FOUND);
    }

    return {
      success: true,
      message: 'Job deleted',
    };
  }

  /**
   * Cancel a job
   * POST /queue/job/:jobId/cancel
   */
  @Post('job/:jobId/cancel')
  async cancelJob(@Param('jobId') jobId: string) {
    const cancelled = this.queueManager.cancelJob(jobId);

    if (!cancelled) {
      throw new HttpException(
        'Job not found or cannot be cancelled',
        HttpStatus.BAD_REQUEST,
      );
    }

    return {
      success: true,
      message: 'Job cancelled',
    };
  }

  /**
   * Clear completed/failed jobs from unified queue
   * DELETE /queue/jobs/completed
   */
  @Delete('jobs/completed')
  async clearCompleted() {
    this.queueManager.clearCompletedJobs();

    return {
      success: true,
      message: 'Completed and failed jobs cleared',
    };
  }

  /**
   * Quick add for browser extension (simplified endpoint)
   * POST /queue/quick-add
   * Body: { url: string, displayName?: string }
   * Creates a standard download+import+transcribe+analyze job
   */
  @Post('quick-add')
  async quickAdd(
    @Body()
    body: {
      url: string;
      displayName?: string;
      libraryId?: string;
      includeTranscript?: boolean;
      includeAnalysis?: boolean;
      aiModel?: string;
    },
  ) {
    if (!body.url) {
      throw new HttpException('URL is required', HttpStatus.BAD_REQUEST);
    }

    // Build standard task list
    const tasks: Task[] = [
      { type: 'get-info' },
      { type: 'download', options: {} },
      { type: 'import', options: {} },
    ];

    // Add optional tasks
    if (body.includeTranscript !== false) {
      tasks.push({ type: 'transcribe', options: {} });
    }

    if (body.includeAnalysis) {
      tasks.push({
        type: 'analyze',
        options: { aiModel: body.aiModel || 'claude-3.5-sonnet' },
      });
    }

    const jobId = this.queueManager.addJob({
      url: body.url,
      displayName: body.displayName,
      libraryId: body.libraryId,
      tasks,
    });

    return {
      success: true,
      jobId,
      message: 'Quick job added to queue',
    };
  }
}
