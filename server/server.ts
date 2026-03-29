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

import { Agent } from './agent.js';
import { Job } from './job.js';

// Get package versions
const __dirname = dirname(fileURLToPath(import.meta.url));
const sdkVersion = JSON.parse(readFileSync(join(__dirname, 'node_modules/@superdoc-dev/sdk/package.json'), 'utf-8')).version;
const collabVersion = JSON.parse(readFileSync(join(__dirname, 'node_modules/@superdoc-dev/superdoc-yjs-collaboration/package.json'), 'utf-8')).version;

// ============================================================================
// Agent Registry
// ============================================================================

const agents = new Map<string, Agent>();

async function getOrCreateAgent(sessionId: string, documentId: string, collaborationUrl: string): Promise<Agent> {
  let agent = agents.get(sessionId);
  if (!agent) {
    agent = new Agent(documentId, collaborationUrl);
    await agent.connect();
    agents.set(sessionId, agent);
    console.log(`[Server] Created agent for session: ${sessionId}`);
  }
  return agent;
}

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

  // Agent health check
  fastify.get('/health/agent', async (request) => {
    const sessionId = (request.query as { session?: string }).session;
    if (sessionId) {
      const agent = agents.get(sessionId);
      return { status: agent ? 'connected' : 'not_found', session: sessionId };
    }
    return { status: 'ok', activeSessions: agents.size, activeJobs: Job.count };
  });

  // Collaboration WebSocket
  fastify.get('/collaboration/:documentId', { websocket: true }, (socket, request) => {
    const documentId = (request.params as { documentId: string }).documentId;
    console.log(`[Server] Collaboration client connected: ${documentId}`);
    SuperDocCollaboration.welcome(socket as any, request as any);
  });

  // ============================================================================
  // Chat API (HTTP + Polling)
  // ============================================================================

  // Create a chat job
  fastify.post('/chat', async (request) => {
    const { sessionId, documentId, prompt } = request.body as {
      sessionId: string;
      documentId: string;
      prompt: string;
    };

    if (!sessionId || !documentId || !prompt) {
      return { error: 'Missing required fields: sessionId, documentId, prompt' };
    }

    const job = Job.create();

    // Fire and forget - process asynchronously
    getOrCreateAgent(sessionId, documentId, collaborationUrl)
      .then(agent => job.process(agent, prompt));

    return { jobId: job.id };
  });

  // Poll for job result
  fastify.get('/chat/jobs/:jobId', async (request) => {
    const { jobId } = request.params as { jobId: string };
    const job = Job.get(jobId);

    if (!job) {
      return { error: 'Job not found' };
    }

    return job.toJSON();
  });

  // Start server
  await fastify.listen({ port, host: '0.0.0.0' });

  console.log('[Server] ' + '='.repeat(50));
  console.log(`[Server] Listening at http://0.0.0.0:${port}`);
  console.log(`[Server] Collaboration: ws://localhost:${port}/collaboration/:documentId`);
  console.log(`[Server] Chat API: POST /chat, GET /chat/jobs/:jobId`);
  console.log('[Server] ' + '='.repeat(50));
}

main().catch((err) => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
