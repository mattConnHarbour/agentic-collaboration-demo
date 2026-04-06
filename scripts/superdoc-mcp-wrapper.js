#!/usr/bin/env node

// superdoc-mcp-wrapper: Keeps SuperDoc MCP server alive across Claude Desktop reconnects.
// Claude Desktop spawns this in "client" mode; it auto-starts a background daemon
// that holds the real MCP server open.

const net = require('net');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// --- Configuration ---
const SUPERDOC_HOME = process.env.SUPERDOC_HOME || path.join(os.homedir(), 'superdoc', 'claude');
const MCP_COMMAND = process.env.MCP_COMMAND || 'npx';
const MCP_ARGS = process.env.MCP_ARGS ? process.env.MCP_ARGS.split(' ') : ['@superdoc-dev/mcp'];
const SOCKET = process.env.MCP_SOCKET || '/tmp/superdoc-mcp.sock';
const PID_FILE = SOCKET + '.pid';

// Load API key from ~/superdoc/.env if it exists
function loadEnvFile() {
  const envPath = path.join(SUPERDOC_HOME, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
          const key = trimmed.substring(0, eqIndex).trim();
          let value = trimmed.substring(eqIndex + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          process.env[key] = value;
        }
      }
    }
  }
}

// =====================
// DAEMON MODE
// =====================
if (process.argv.includes('--daemon')) {
  loadEnvFile();

  // Clean up stale socket
  try { fs.unlinkSync(SOCKET); } catch {}

  // Spawn the real MCP server
  const mcp = spawn(MCP_COMMAND, MCP_ARGS, {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env },
  });

  fs.writeFileSync(PID_FILE, String(process.pid));

  let currentClient = null;

  // Forward MCP server stdout → current client
  const serverReader = readline.createInterface({ input: mcp.stdout, crlfDelay: Infinity });
  serverReader.on('line', (line) => {
    if (currentClient && !currentClient.destroyed) {
      currentClient.write(line + '\n');
    }
  });

  // Accept connections from wrapper clients
  const server = net.createServer((conn) => {
    // Replace the active client
    if (currentClient && !currentClient.destroyed) {
      currentClient.destroy();
    }
    currentClient = conn;

    // Forward client stdin → MCP server
    const clientReader = readline.createInterface({ input: conn, crlfDelay: Infinity });
    clientReader.on('line', (line) => {
      if (!mcp.killed) {
        mcp.stdin.write(line + '\n');
      }
    });

    conn.on('close', () => {
      clientReader.close();
      if (currentClient === conn) currentClient = null;
    });

    conn.on('error', () => {});
  });

  server.listen(SOCKET);

  // Cleanup on exit
  function cleanup() {
    try { fs.unlinkSync(SOCKET); } catch {}
    try { fs.unlinkSync(PID_FILE); } catch {}
    if (!mcp.killed) mcp.kill();
    process.exit();
  }

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  mcp.on('exit', cleanup);

  // Keep daemon alive
  process.stdin.resume();

  return;
}

// =====================
// CLIENT MODE (default)
// =====================

function isDaemonRunning() {
  if (!fs.existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'));
    process.kill(pid, 0); // signal 0 = check if alive
    return fs.existsSync(SOCKET);
  } catch {
    return false;
  }
}

function startDaemon() {
  loadEnvFile();

  const daemon = spawn(process.execPath, [__filename, '--daemon'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MCP_COMMAND, MCP_ARGS: MCP_ARGS.join(' '), MCP_SOCKET: SOCKET, SUPERDOC_HOME },
  });
  daemon.unref();

  // Wait for socket to appear
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(SOCKET) && Date.now() < deadline) {
    execSync('sleep 0.1');
  }

  if (!fs.existsSync(SOCKET)) {
    process.stderr.write('superdoc-mcp-wrapper: daemon failed to start\n');
    process.exit(1);
  }
}

// Start daemon if needed
if (!isDaemonRunning()) {
  startDaemon();
}

// Connect to daemon and proxy stdio
const conn = net.connect(SOCKET);

process.stdin.pipe(conn);
conn.pipe(process.stdout);

conn.on('error', (err) => {
  process.stderr.write('superdoc-mcp-wrapper: connection error: ' + err.message + '\n');
  process.exit(1);
});

conn.on('close', () => process.exit(0));
process.stdin.on('end', () => conn.end());
