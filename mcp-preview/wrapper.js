#!/usr/bin/env node

/**
 * Simple wrapper that filters non-JSON output from the MCP server.
 * This prevents protocol corruption if the SDK outputs any telemetry/logs.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, 'index.js');

// Spawn the actual MCP server
const server = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
});

// Forward stdin to server
process.stdin.pipe(server.stdin);

// Filter server stdout - only forward JSON lines
const rl = createInterface({ input: server.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.startsWith('{')) {
    process.stdout.write(line + '\n');
  }
  // Non-JSON lines are silently dropped
});

// Forward stderr for debugging (goes to Claude Desktop logs)
server.stderr.pipe(process.stderr);

// Handle process exit
server.on('exit', (code) => {
  process.exit(code || 0);
});

process.on('SIGTERM', () => {
  server.kill('SIGTERM');
});

process.on('SIGINT', () => {
  server.kill('SIGINT');
});
