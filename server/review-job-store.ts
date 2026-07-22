import type { ReviewResult } from './comment-reviewer.js';

export type ReviewJobStatus = 'pending' | 'processing' | 'complete' | 'error';

export interface ReviewJob {
  id: string;
  status: ReviewJobStatus;
  result: ReviewResult | null;
  createdAt: number;
}

export class ReviewJobStore {
  private jobs = new Map<string, ReviewJob>();

  constructor(private ttlMs = 5 * 60 * 1000) {}

  create(): ReviewJob {
    const job: ReviewJob = {
      id: crypto.randomUUID(),
      status: 'pending',
      result: null,
      createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  get(jobId: string): ReviewJob | undefined {
    return this.jobs.get(jobId);
  }

  markProcessing(jobId: string): void {
    const job = this.require(jobId);
    job.status = 'processing';
  }

  updateProgress(jobId: string, result: ReviewResult): void {
    this.require(jobId).result = result;
  }

  complete(jobId: string, result: ReviewResult): void {
    const job = this.require(jobId);
    job.result = result;
    job.status = result.status === 'error' ? 'error' : 'complete';
  }

  fail(jobId: string, error: string): void {
    const job = this.require(jobId);
    job.status = 'error';
    job.result = {
      status: 'error',
      commentsFound: 0,
      commentsProcessed: 0,
      comments: [],
      error,
    };
  }

  scheduleCleanup(jobId: string): void {
    setTimeout(() => {
      this.jobs.delete(jobId);
      console.log(`[ReviewJobStore] Cleaned up review: ${jobId}`);
    }, this.ttlMs);
  }

  private require(jobId: string): ReviewJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Review job not found: ${jobId}`);
    return job;
  }
}
