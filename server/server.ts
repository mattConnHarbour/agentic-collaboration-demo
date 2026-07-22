import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocketPlugin from '@fastify/websocket';
import { Doc as YDoc, encodeStateAsUpdate } from 'yjs';

import {
  CollaborationBuilder,
  type CollaborationParams,
  type UserContext,
  type ServiceConfig
} from '@superdoc-dev/superdoc-yjs-collaboration';

import { CommentReviewer } from './comment-reviewer.js';
import { ReviewJobStore } from './review-job-store.js';

// Get package versions
const __dirname = dirname(fileURLToPath(import.meta.url));
const sdkVersion = JSON.parse(readFileSync(join(__dirname, 'node_modules/@superdoc-dev/sdk/package.json'), 'utf-8')).version;
const collabVersion = JSON.parse(readFileSync(join(__dirname, 'node_modules/@superdoc-dev/superdoc-yjs-collaboration/package.json'), 'utf-8')).version;

const reviewJobs = new ReviewJobStore();

// ============================================================================
// Collaboration Hooks
// ============================================================================

const handleConfig = (config: ServiceConfig): void => {
  console.log('[Server] Collaboration service configured');
};

const handleAuth = async ({ documentId }: CollaborationParams): Promise<UserContext> => {
  console.log(`[Server] Auth for document: ${documentId}`);
  return {
    user: { userid: 'abc', username: 'testuser' },
    organizationid: 'someorg123',
    custom: { someCustomKey: 'somevalue' }
  };
};

const handleLoad = async (params: CollaborationParams): Promise<Uint8Array> => {
  console.log(`[Server] Loading document: ${params.documentId}`);
  const ydoc = new YDoc();
  return encodeStateAsUpdate(ydoc);
};

const SuperDocCollaboration = new CollaborationBuilder()
  .withName('SuperDoc Collaboration service')
  .withDebounce(2000)
  .onConfigure(handleConfig)
  .onLoad(handleLoad)
  .onAuthenticate(handleAuth)
  .build();

// ============================================================================
// Server Setup
// ============================================================================

async function main() {
  const fastify = Fastify({ logger: false });
  const port = parseInt(process.env.PORT || '3050', 10);
  const collaborationUrl = `ws://localhost:${port}/collaboration`;

  // Register plugins
  await fastify.register(cors, { origin: true });
  await fastify.register(websocketPlugin);

  // Health check
  fastify.get('/health', async () => ({
    status: 'ok',
    versions: {
      sdk: sdkVersion,
      collab: collabVersion,
    },
  }));

  // Collaboration WebSocket
  fastify.get('/collaboration/:documentId', { websocket: true }, (socket, request) => {
    const documentId = (request.params as { documentId: string }).documentId;
    console.log(`[Server] Collaboration client connected: ${documentId}`);
    SuperDocCollaboration.welcome(socket as any, request as any);
  });

  // ============================================================================
  // Review API (Comment Review)
  // ============================================================================

  // Trigger a comment review
  fastify.post('/review', async (request) => {
    const { documentId } = request.body as {
      documentId: string;
    };

    if (!documentId) {
      return { error: 'Missing required field: documentId' };
    }

    const job = reviewJobs.create();
    const jobId = job.id;

    console.log(`[Server] Review job created: ${jobId} for document: ${documentId}`);

    // Fire and forget - process asynchronously
    (async () => {
      reviewJobs.markProcessing(jobId);

      let reviewer: CommentReviewer | null = null;
      try {
        reviewer = new CommentReviewer(documentId, collaborationUrl);
        await reviewer.connect();
        const result = await reviewer.review((progress) => {
          reviewJobs.updateProgress(jobId, progress);
        });
        reviewJobs.complete(jobId, result);
        console.log(`[Server] Review job complete: ${jobId}`);
      } catch (err: any) {
        console.error(`[Server] Review job failed: ${jobId}`, err);
        reviewJobs.fail(jobId, err.message);
      } finally {
        if (reviewer) {
          try {
            await reviewer.disconnect();
          } catch (err) {
            // Cleanup must never terminate the long-running API process.
            console.error(`[Server] Reviewer cleanup failed: ${jobId}`, err);
          }
        }
        reviewJobs.scheduleCleanup(jobId);
      }
    })();

    return { jobId };
  });

  // Poll for review result
  fastify.get('/review/jobs/:jobId', async (request) => {
    const { jobId } = request.params as { jobId: string };
    const job = reviewJobs.get(jobId);

    if (!job) {
      return { error: 'Review job not found' };
    }

    return {
      id: job.id,
      status: job.status,
      result: job.result,
    };
  });

  // Start server
  await fastify.listen({ port, host: '0.0.0.0' });

  console.log('[Server] ' + '='.repeat(50));
  console.log(`[Server] Listening at http://0.0.0.0:${port}`);
  console.log(`[Server] Collaboration: ws://localhost:${port}/collaboration/:documentId`);
  console.log(`[Server] Review API: POST /review, GET /review/jobs/:jobId`);
  console.log('[Server] ' + '='.repeat(50));
}

main().catch((err) => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
