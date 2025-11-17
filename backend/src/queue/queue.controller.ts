// Queue Controller - Manage batch and analysis queues

import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { QueueManagerService } from './queue-manager.service';
import { Task } from '../common/interfaces/task.interface';

@Controller('queue')
export class QueueController {
  constructor(private readonly queueManager: QueueManagerService) {}

  /**
   * Add a job to a queue
   * POST /queue/add
   * Body: { queueType, url?, videoId?, displayName?, tasks: Task[] }
   */
  @Post('add')
  async addJob(
    @Body()
    body: {
      queueType: 'batch' | 'analysis';
      url?: string;
      videoId?: string; // For transcribe/analyze tasks on existing library videos
      displayName?: string;
      tasks: Task[];
    },
  ) {
    if (!body.queueType) {
      throw new HttpException('Queue type is required', HttpStatus.BAD_REQUEST);
    }

    if (!body.tasks || body.tasks.length === 0) {
      throw new HttpException(
        'At least one task is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const jobId = this.queueManager.addJob({
      queueType: body.queueType,
      url: body.url,
      videoId: body.videoId,
      displayName: body.displayName,
      tasks: body.tasks,
    });

    return {
      success: true,
      jobId,
      message: 'Job added to queue',
    };
  }

  /**
   * Add multiple jobs to a queue (bulk add)
   * POST /queue/add-bulk
   * Body: { queueType, jobs: Array<{ url?, displayName?, tasks }> }
   */
  @Post('add-bulk')
  async addBulkJobs(
    @Body()
    body: {
      queueType: 'batch' | 'analysis';
      jobs: Array<{
        url?: string;
        displayName?: string;
        tasks: Task[];
      }>;
    },
  ) {
    if (!body.queueType) {
      throw new HttpException('Queue type is required', HttpStatus.BAD_REQUEST);
    }

    if (!body.jobs || body.jobs.length === 0) {
      throw new HttpException('At least one job is required', HttpStatus.BAD_REQUEST);
    }

    const jobIds: string[] = [];

    for (const job of body.jobs) {
      const jobId = this.queueManager.addJob({
        queueType: body.queueType,
        url: job.url,
        displayName: job.displayName,
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
   * Get queue status
   * GET /queue/status?type=batch|analysis
   */
  @Get('status')
  async getStatus(@Query('type') type: 'batch' | 'analysis') {
    if (!type) {
      throw new HttpException('Queue type is required', HttpStatus.BAD_REQUEST);
    }

    const status = this.queueManager.getQueueStatus(type);

    return {
      success: true,
      status,
    };
  }

  /**
   * Get all jobs in a queue
   * GET /queue/jobs?type=batch|analysis
   */
  @Get('jobs')
  async getJobs(@Query('type') type: 'batch' | 'analysis') {
    if (!type) {
      throw new HttpException('Queue type is required', HttpStatus.BAD_REQUEST);
    }

    const jobs = this.queueManager.getAllJobs(type);

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
   * Clear completed/failed jobs
   * DELETE /queue/clear?type=batch|analysis
   */
  @Delete('clear')
  async clearCompleted(@Query('type') type: 'batch' | 'analysis') {
    if (!type) {
      throw new HttpException('Queue type is required', HttpStatus.BAD_REQUEST);
    }

    this.queueManager.clearCompletedJobs(type);

    return {
      success: true,
      message: 'Completed and failed jobs cleared',
    };
  }
}
