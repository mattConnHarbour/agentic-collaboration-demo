/**
 * Job class for managing async chat processing requests.
 */

import { Agent } from './agent.js';

export type JobStatus = 'pending' | 'processing' | 'complete' | 'error';

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  timestamp: number;
}

const JOB_TTL = 5 * 60 * 1000; // 5 minutes

export class Job {
  private static registry = new Map<string, Job>();

  readonly id: string;
  private _status: JobStatus = 'pending';
  private _result?: string;
  private _error?: string;
  private _toolCalls: ToolCall[] = [];
  readonly createdAt: number;

  private constructor(id: string) {
    this.id = id;
    this.createdAt = Date.now();
  }

  get status(): JobStatus {
    return this._status;
  }

  get result(): string | undefined {
    return this._result;
  }

  get error(): string | undefined {
    return this._error;
  }

  get toolCalls(): ToolCall[] {
    return this._toolCalls;
  }

  addToolCall(name: string, args: Record<string, unknown>): void {
    this._toolCalls.push({ name, args, timestamp: Date.now() });
  }

  static create(): Job {
    const id = crypto.randomUUID();
    const job = new Job(id);
    Job.registry.set(id, job);
    console.log(`[Job] Created: ${id}`);
    return job;
  }

  static get(id: string): Job | undefined {
    return Job.registry.get(id);
  }

  static get count(): number {
    return Job.registry.size;
  }

  async process(agent: Agent, prompt: string): Promise<void> {
    this._status = 'processing';
    console.log(`[Job] Processing: ${this.id}`);

    try {
      this._result = await agent.process(prompt, (name, args) => {
        this.addToolCall(name, args);
      });
      this._status = 'complete';
      console.log(`[Job] Complete: ${this.id}`);
    } catch (e) {
      this._status = 'error';
      this._error = e instanceof Error ? e.message : String(e);
      console.error(`[Job] Failed: ${this.id}`, e);
    }

    this.scheduleCleanup();
  }

  private scheduleCleanup(): void {
    setTimeout(() => {
      Job.registry.delete(this.id);
      console.log(`[Job] Cleaned up: ${this.id}`);
    }, JOB_TTL);
  }

  toJSON(): object {
    return {
      id: this.id,
      status: this._status,
      result: this._result,
      error: this._error,
      toolCalls: this._toolCalls,
    };
  }
}
