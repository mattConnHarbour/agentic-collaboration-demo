#!/usr/bin/env node

/**
 * SuperDoc Preview MCP Server
 *
 * Provides tools to launch SuperDoc preview in a browser for document editing.
 * Downloads and caches the preview binary on first use.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import { exec } from 'child_process';
import https from 'https';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

// --- Configuration ---
const SUPERDOC_HOME = process.env.SUPERDOC_HOME || path.join(os.homedir(), '.superdoc-preview');
const BINARY_NAME = process.platform === 'win32' ? 'superdoc-preview.exe' : 'superdoc-preview';
const BINARY_PATH = path.join(SUPERDOC_HOME, 'bin', BINARY_NAME);
const PID_FILE = path.join(SUPERDOC_HOME, 'preview.pid');
const LOG_FILE = path.join(SUPERDOC_HOME, 'mcp.log');

// GitHub release URL - update this when publishing releases
const RELEASE_BASE_URL = process.env.SUPERDOC_RELEASE_URL ||
  'https://github.com/mattConnHarbour/agentic-collaboration-demo/releases/latest/download';

// Platform-specific binary names
const PLATFORM_BINARIES = {
  'darwin-arm64': 'superdoc-preview-darwin-arm64',
  'darwin-x64': 'superdoc-preview-darwin-x64',
  'linux-x64': 'superdoc-preview-linux-x64',
  'win32-x64': 'superdoc-preview-win32-x64.exe',
};

// --- Logging ---
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  try {
    fs.mkdirSync(SUPERDOC_HOME, { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

// --- Binary Management ---
function getPlatformKey() {
  return `${process.platform}-${process.arch}`;
}

function isBinaryInstalled() {
  return fs.existsSync(BINARY_PATH);
}

async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const follow = (url, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      const protocol = url.startsWith('https') ? https : require('http');
      protocol.get(url, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          follow(response.headers.location, redirectCount + 1);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }

        const fileStream = createWriteStream(destPath);
        response.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          resolve();
        });
        fileStream.on('error', reject);
      }).on('error', reject);
    };

    follow(url);
  });
}

async function downloadBinary() {
  const platformKey = getPlatformKey();
  const binaryName = PLATFORM_BINARIES[platformKey];

  if (!binaryName) {
    throw new Error(`Unsupported platform: ${platformKey}. Supported: ${Object.keys(PLATFORM_BINARIES).join(', ')}`);
  }

  const downloadUrl = `${RELEASE_BASE_URL}/${binaryName}`;
  log(`Downloading binary from: ${downloadUrl}`);

  // Create directories
  fs.mkdirSync(path.dirname(BINARY_PATH), { recursive: true });

  // Download
  await downloadFile(downloadUrl, BINARY_PATH);

  // Make executable
  if (process.platform !== 'win32') {
    fs.chmodSync(BINARY_PATH, 0o755);
  }

  log(`Binary installed to: ${BINARY_PATH}`);
}

async function ensureBinary() {
  if (isBinaryInstalled()) {
    return BINARY_PATH;
  }

  // Get the directory where this script lives (more reliable than cwd)
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);

  // Check relative to script directory (for local development in repo)
  const repoBinary = path.join(scriptDir, '..', 'bin', 'superdoc-preview');
  if (fs.existsSync(repoBinary)) {
    log(`Using repo binary: ${repoBinary}`);
    return repoBinary;
  }

  // Check for local development binary (cwd-based)
  const localBinary = path.join(process.cwd(), 'bin', 'superdoc-preview');
  if (fs.existsSync(localBinary)) {
    log(`Using local development binary: ${localBinary}`);
    return localBinary;
  }

  // Check in parent directories (for when running from mcp-preview/)
  const parentBinary = path.join(process.cwd(), '..', 'bin', 'superdoc-preview');
  if (fs.existsSync(parentBinary)) {
    log(`Using parent directory binary: ${parentBinary}`);
    return parentBinary;
  }

  // Download from GitHub
  log('Binary not found, downloading...');
  await downloadBinary();
  return BINARY_PATH;
}

// --- Path Helpers ---
function expandPath(inputPath) {
  if (!inputPath) return inputPath;
  // Expand ~ to home directory
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  if (inputPath === '~') {
    return os.homedir();
  }
  return inputPath;
}

// --- Document Finding ---
const execAsync = promisify(exec);

async function findDocuments(directory, pattern = '*.docx', maxDepth = 3) {
  const searchDir = expandPath(directory || '~');

  // Validate directory exists
  if (!fs.existsSync(searchDir)) {
    throw new Error(`Directory not found: ${searchDir}`);
  }

  try {
    // Use find command for efficient searching
    const cmd = `find "${searchDir}" -maxdepth ${maxDepth} -type f -iname "${pattern}" 2>/dev/null | head -50`;
    const { stdout } = await execAsync(cmd, { timeout: 10000 });

    const files = stdout.trim().split('\n').filter(f => f.length > 0);

    // Get file info for each result
    const results = files.map(filePath => {
      try {
        const stats = fs.statSync(filePath);
        return {
          path: filePath,
          name: path.basename(filePath),
          size: stats.size,
          modified: stats.mtime.toISOString(),
        };
      } catch {
        return { path: filePath, name: path.basename(filePath) };
      }
    });

    return {
      directory: searchDir,
      pattern,
      count: results.length,
      files: results,
    };
  } catch (error) {
    throw new Error(`Search failed: ${error.message}`);
  }
}

// --- Preview Server Management ---
function isPreviewRunning() {
  if (!fs.existsSync(PID_FILE)) {
    return { running: false };
  }

  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
    process.kill(pid, 0); // Signal 0 = check if process exists
    return { running: true, pid };
  } catch {
    // Process not running, clean up stale PID file
    try { fs.unlinkSync(PID_FILE); } catch {}
    return { running: false };
  }
}

function stopPreview() {
  const status = isPreviewRunning();
  if (!status.running) {
    return { success: true, message: 'Preview was not running' };
  }

  try {
    process.kill(status.pid, 'SIGTERM');
    try { fs.unlinkSync(PID_FILE); } catch {}
    return { success: true, message: `Stopped preview server (PID: ${status.pid})` };
  } catch (err) {
    return { success: false, message: `Failed to stop preview: ${err.message}` };
  }
}

async function openPreview(documentPath, options = {}) {
  const { port = 3050, noBrowser = false } = options;

  // Expand ~ and resolve to absolute path
  const expandedPath = expandPath(documentPath);
  const absolutePath = path.isAbsolute(expandedPath)
    ? expandedPath
    : path.resolve(process.cwd(), expandedPath);

  // Validate file exists
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  // Stop existing preview if running
  const status = isPreviewRunning();
  if (status.running) {
    log(`Stopping existing preview (PID: ${status.pid})`);
    stopPreview();
    // Give it a moment to shut down
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Get binary path
  const binaryPath = await ensureBinary();
  log(`Using binary: ${binaryPath}`);

  // Build arguments
  const args = ['--file', absolutePath, '--port', String(port)];
  if (noBrowser) {
    args.push('--no-browser');
  }

  log(`Launching preview: ${binaryPath} ${args.join(' ')}`);

  // Spawn the preview server (detached so it survives MCP server exit)
  const child = spawn(binaryPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });

  child.unref();

  // Save PID
  fs.mkdirSync(SUPERDOC_HOME, { recursive: true });
  fs.writeFileSync(PID_FILE, String(child.pid));

  const url = `http://localhost:${port}`;
  log(`Preview started (PID: ${child.pid}) at ${url}`);

  return {
    success: true,
    pid: child.pid,
    url,
    documentPath: absolutePath,
    message: `Preview server started at ${url}`,
  };
}

// --- MCP Server Setup ---
const server = new Server(
  {
    name: 'superdoc-preview',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'open_preview',
        description: 'Open a document in the SuperDoc preview browser app for viewing and editing. The preview includes an AI chat assistant that can help edit the document.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the document file (DOCX format). Can be absolute or relative to current working directory.',
            },
            port: {
              type: 'number',
              description: 'Port to run the preview server on (default: 3050)',
              default: 3050,
            },
            no_browser: {
              type: 'boolean',
              description: 'If true, start the server without automatically opening the browser',
              default: false,
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'stop_preview',
        description: 'Stop the running SuperDoc preview server',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'preview_status',
        description: 'Check if the SuperDoc preview server is currently running',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'find_documents',
        description: 'Search for Word documents (.docx files) in a directory. Use this to help locate documents when the user mentions a filename without the full path.',
        inputSchema: {
          type: 'object',
          properties: {
            directory: {
              type: 'string',
              description: 'Directory to search in. Supports ~ for home directory. Defaults to home directory if not specified.',
            },
            pattern: {
              type: 'string',
              description: 'Filename pattern to search for (e.g., "*.docx", "report*.docx", "*.doc*"). Defaults to "*.docx".',
              default: '*.docx',
            },
            max_depth: {
              type: 'number',
              description: 'Maximum directory depth to search (default: 3)',
              default: 3,
            },
          },
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  log(`Tool called: ${name} with args: ${JSON.stringify(args)}`);

  try {
    switch (name) {
      case 'open_preview': {
        const result = await openPreview(args.path, {
          port: args.port,
          noBrowser: args.no_browser,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'stop_preview': {
        const result = stopPreview();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'preview_status': {
        const status = isPreviewRunning();
        const result = status.running
          ? { running: true, pid: status.pid, message: `Preview server is running (PID: ${status.pid})` }
          : { running: false, message: 'Preview server is not running' };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'find_documents': {
        const result = await findDocuments(
          args.directory,
          args.pattern || '*.docx',
          args.max_depth || 3
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    log(`Tool error: ${error.message}`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  log('Starting SuperDoc Preview MCP server');

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('MCP server connected and ready');
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`);
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
