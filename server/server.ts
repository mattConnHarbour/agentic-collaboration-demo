import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve, basename } from 'path';
import { homedir } from 'os';

// Load .env from multiple locations: installed (~superdoc/.env) or dev (../.env)
const envPaths = [
  join(homedir(), 'superdoc', '.env'),  // installed mode
  join(dirname(process.execPath), '..', '.env'),  // relative to binary
  '../.env',  // dev mode
];
for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log(`[Server] Loaded env from: ${envPath}`);
    break;
  }
}
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocketPlugin from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { Doc as YDoc, encodeStateAsUpdate } from 'yjs';
import { Editor } from 'superdoc/super-editor';

import {
  CollaborationBuilder,
  type CollaborationParams,
  type UserContext,
  type ServiceConfig
} from '@superdoc-dev/superdoc-yjs-collaboration';

import { Job } from './job.js';

// Check if we can load the agent (requires SDK binary)
let Agent: typeof import('./agent.js').Agent | null = null;
const isStandaloneBinary = process.execPath.includes('superdoc-preview');

// Check if CLI binary is available via env var
const cliBinaryPath = process.env.SUPERDOC_CLI_BIN;
const hasExternalCli = cliBinaryPath && existsSync(cliBinaryPath);

if (!isStandaloneBinary || hasExternalCli) {
  // Development mode OR user has CLI installed externally
  const agentModule = await import('./agent.js');
  Agent = agentModule.Agent;
  if (hasExternalCli) {
    console.log(`[Server] AI agent enabled (using CLI at ${cliBinaryPath})`);
  } else {
    console.log('[Server] AI agent enabled (development mode)');
  }
} else {
  console.log('[Server] AI agent disabled (set SUPERDOC_CLI_BIN to enable)');
}

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs(): { file?: string; port: number; noBrowser: boolean } {
  const args = process.argv.slice(2);
  let file: string | undefined;
  let port = parseInt(process.env.PORT || '3050', 10);
  let noBrowser = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--file' || arg === '-f') {
      file = args[++i];
    } else if (arg === '--port' || arg === '-p') {
      port = parseInt(args[++i], 10);
    } else if (arg === '--no-browser') {
      noBrowser = true;
    } else if (!arg.startsWith('-') && !file) {
      // Positional argument - treat as file path
      file = arg;
    }
  }

  return { file, port, noBrowser };
}

const cliArgs = parseArgs();

// Resolve file path if provided
let documentFilePath: string | undefined;
let documentFileName: string | undefined;

if (cliArgs.file) {
  documentFilePath = resolve(cliArgs.file);
  documentFileName = basename(documentFilePath);

  if (!existsSync(documentFilePath)) {
    console.error(`[Server] Error: File not found: ${documentFilePath}`);
    process.exit(1);
  }
  console.log(`[Server] Document: ${documentFilePath}`);
}

// Helper to open browser
function openBrowser(url: string) {
  const platform = process.platform;
  let cmd: string;

  if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (platform === 'win32') {
    cmd = `start "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, (err) => {
    if (err) {
      console.log(`[Server] Could not open browser automatically. Visit: ${url}`);
    }
  });
}

// Get directory paths
// Handle both development mode and bundled binary mode
const __dirname = dirname(fileURLToPath(import.meta.url));
const execDir = dirname(process.execPath);

// Detect if running as bundled binary (check if __dirname is virtual bun path)
const isBundled = __dirname.startsWith('/$bunfs') || !existsSync(join(__dirname, 'package.json'));

// In bundled/installed mode, assets are at ../assets/ relative to binary
// In dev mode, use the normal project structure
const serverRoot = isBundled ? execDir : (__dirname.endsWith('dist') ? dirname(__dirname) : __dirname);
const projectRoot = isBundled ? dirname(execDir) : dirname(serverRoot); // ~/superdoc/ in installed mode

// Get package versions - try to read from node_modules, fall back to embedded versions
let sdkVersion = '1.2.0';  // Fallback version
let collabVersion = '1.0.0';  // Fallback version
try {
  const sdkPkgPath = join(serverRoot, 'node_modules/@superdoc-dev/sdk/package.json');
  const collabPkgPath = join(serverRoot, 'node_modules/@superdoc-dev/superdoc-yjs-collaboration/package.json');
  if (existsSync(sdkPkgPath)) {
    sdkVersion = JSON.parse(readFileSync(sdkPkgPath, 'utf-8')).version;
  }
  if (existsSync(collabPkgPath)) {
    collabVersion = JSON.parse(readFileSync(collabPkgPath, 'utf-8')).version;
  }
} catch {
  // Use fallback versions
}
console.log(`[Server] SDK version: ${sdkVersion}`);

// ============================================================================
// Agent Registry
// ============================================================================

const agents = new Map<string, any>();
let saverAgent: any = null;  // Dedicated agent for auto-saving

async function getOrCreateAgent(sessionId: string, documentId: string, collaborationUrl: string): Promise<any | null> {
  if (!Agent) {
    return null;
  }
  let agent = agents.get(sessionId);
  if (!agent) {
    agent = new Agent(documentId, collaborationUrl);
    await agent.connect();
    agents.set(sessionId, agent);
    console.log(`[Server] Created agent for session: ${sessionId}`);
  }
  return agent;
}

async function createSaverAgent(documentId: string, collaborationUrl: string): Promise<void> {
  if (!Agent) {
    console.log('[Server] Saver agent disabled (SDK not available)');
    return;
  }
  saverAgent = new Agent(documentId, collaborationUrl);
  await saverAgent.connect();
  console.log(`[Server] Saver agent connected for: ${documentId}`);
}

// ============================================================================
// Collaboration Hooks
// ============================================================================

// In-memory store for document states
const documentStates = new Map<string, Uint8Array>();

// Seed collaboration state from docx file
async function seedCollaborationState(docPath: string, roomId: string): Promise<void> {
  console.log(`[Server] Seeding collaboration state for room: ${roomId}`);

  const fileBytes = readFileSync(docPath);
  const editor = await Editor.open(Buffer.from(fileBytes), {
    isHeadless: true,
    documentId: roomId,
    telemetry: { enabled: false },
    user: { name: 'Seed Bot', email: 'seed-bot@superdoc.dev', image: null },
  });

  try {
    const update = await editor.generateCollaborationUpdate();
    documentStates.set(roomId, update);
    console.log(`[Server] Seeded state for ${roomId}: ${update.byteLength} bytes`);
  } finally {
    editor.destroy();
  }
}

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
  const { documentId } = params;

  // Check if we have a stored/seeded state for this document
  const storedState = documentStates.get(documentId);
  if (storedState) {
    console.log(`[Server] Loading stored state for: ${documentId} (${storedState.length} bytes)`);
    return storedState;
  }

  // No seeded state - return empty state
  console.log(`[Server] No seeded state for: ${documentId} (empty)`);
  const ydoc = new YDoc();
  return encodeStateAsUpdate(ydoc);
};

const handleAutoSave = async (params: CollaborationParams): Promise<void> => {
  const { documentId, document } = params;
  if (document) {
    const state = encodeStateAsUpdate(document as YDoc);
    documentStates.set(documentId, state);
    console.log(`[Server] Auto-saved state for: ${documentId} (${state.length} bytes)`);

    // Save to disk if we have a file path and saver agent
    if (documentFilePath && saverAgent) {
      try {
        const saved = await saverAgent.saveToFile(documentFilePath);
        if (saved) {
          console.log(`[Server] Auto-saved to disk: ${documentFilePath}`);
        }
      } catch (e) {
        console.error(`[Server] Failed to save document:`, e);
      }
    }
  }
};

const SuperDocCollaboration = new CollaborationBuilder()
  .withName('SuperDoc Collaboration service')
  .withDebounce(2000)
  .onConfigure(handleConfig)
  .onLoad(handleLoad)
  .onAutoSave(handleAutoSave)
  .onAuthenticate(handleAuth)
  .build();

// ============================================================================
// Server Setup
// ============================================================================

async function main() {
  const fastify = Fastify({ logger: false });
  const port = cliArgs.port;
  const collaborationUrl = `ws://localhost:${port}/collaboration`;

  // Seed collaboration state from docx file if provided
  if (documentFilePath) {
    await seedCollaborationState(documentFilePath, 'preview-session');
  }

  // Register plugins
  await fastify.register(cors, { origin: true });
  await fastify.register(websocketPlugin);

  // Add content type parser for binary document uploads
  fastify.addContentTypeParser(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    { parseAs: 'buffer' },
    (req, body, done) => done(null, body)
  );

  // Serve static files from client dist
  // Check in order: env var, installed (assets/client), dev (client/dist)
  const clientDistPath = process.env.SUPERDOC_CLIENT_DIR
    || (existsSync(join(projectRoot, 'assets/client')) ? join(projectRoot, 'assets/client') : null)
    || (existsSync(join(projectRoot, 'client/dist')) ? join(projectRoot, 'client/dist') : null);

  if (clientDistPath && existsSync(clientDistPath)) {
    await fastify.register(fastifyStatic, {
      root: clientDistPath,
      prefix: '/',
    });
    console.log(`[Server] Serving static files from: ${clientDistPath}`);
  }

  // Health check
  fastify.get('/health', async () => ({
    status: 'ok',
    versions: {
      sdk: sdkVersion,
      collab: collabVersion,
    },
  }));

  // Config endpoint - returns document URL for client
  fastify.get('/api/config', async (request) => {
    const config = {
      documentUrl: documentFilePath ? `/api/document` : null,
      documentName: documentFileName || null,
    };
    console.log(`[Server] GET /api/config -> ${JSON.stringify(config)}`);
    return config;
  });

  // Serve the document file
  fastify.get('/api/document', async (request, reply) => {
    console.log(`[Server] GET /api/document requested`);

    if (!documentFilePath) {
      console.log(`[Server] No document file path configured`);
      reply.code(404);
      return { error: 'No document loaded' };
    }

    if (!existsSync(documentFilePath)) {
      console.log(`[Server] Document file not found: ${documentFilePath}`);
      reply.code(404);
      return { error: 'Document file not found' };
    }

    const fileContent = readFileSync(documentFilePath);
    console.log(`[Server] Serving document: ${documentFileName} (${fileContent.length} bytes)`);

    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .header('Content-Disposition', `inline; filename="${documentFileName}"`)
      .send(fileContent);
  });

  // Save (overwrite) the document file
  fastify.put('/api/document', async (request, reply) => {
    console.log(`[Server] PUT /api/document requested`);

    if (!documentFilePath) {
      console.log(`[Server] No document file path configured`);
      reply.code(400);
      return { error: 'No document loaded' };
    }

    try {
      const body = request.body as Buffer;
      const { writeFileSync } = await import('fs');
      writeFileSync(documentFilePath, body);
      console.log(`[Server] Document saved: ${documentFileName} (${body.length} bytes)`);
      return { success: true, size: body.length };
    } catch (e) {
      console.error(`[Server] Save failed:`, e);
      reply.code(500);
      return { error: 'Failed to save document' };
    }
  });

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
  fastify.post('/chat', async (request, reply) => {
    if (!Agent) {
      reply.code(503);
      return { error: 'AI agent not available. Set SUPERDOC_CLI_BIN to enable.' };
    }

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
      .then(agent => {
        if (agent) job.process(agent, prompt);
      });

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

  // Create saver agent after server is listening (so collaboration WebSocket is available)
  if (documentFilePath) {
    await createSaverAgent('preview-session', collaborationUrl);
  }

  const serverUrl = `http://localhost:${port}`;

  console.log('[Server] ' + '='.repeat(50));
  console.log(`[Server] SuperDoc Preview Server`);
  console.log('[Server] ' + '='.repeat(50));
  console.log(`[Server] URL: ${serverUrl}`);
  if (documentFileName) {
    console.log(`[Server] Document: ${documentFileName}`);
  }
  console.log(`[Server] Collaboration: ws://localhost:${port}/collaboration/:documentId`);
  console.log('[Server] ' + '='.repeat(50));

  // Auto-open browser unless disabled
  if (!cliArgs.noBrowser && documentFilePath) {
    openBrowser(serverUrl);
  }
}

main().catch((err) => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
