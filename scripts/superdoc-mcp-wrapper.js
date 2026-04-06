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
const LOG_FILE = path.join(SUPERDOC_HOME, 'mcp-wrapper.log');

// Simple logging function
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

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
  log('DAEMON: Starting daemon mode');
  loadEnvFile();

  // Clean up stale socket
  try { fs.unlinkSync(SOCKET); } catch {}

  // Spawn the real MCP server
  log(`DAEMON: Spawning MCP server: ${MCP_COMMAND} ${MCP_ARGS.join(' ')}`);
  const mcp = spawn(MCP_COMMAND, MCP_ARGS, {
    stdio: ['pipe', 'pipe', 'pipe'], // Capture stderr too
    env: { ...process.env },
  });

  // Log MCP server stderr
  mcp.stderr.on('data', (data) => {
    log(`DAEMON: MCP stderr: ${data.toString().trim()}`);
  });

  fs.writeFileSync(PID_FILE, String(process.pid));
  log(`DAEMON: PID file written: ${process.pid}`);

  let currentClient = null;

  // Forward MCP server stdout → current client (filter non-JSON lines)
  const serverReader = readline.createInterface({ input: mcp.stdout, crlfDelay: Infinity });
  serverReader.on('line', (line) => {
    const trimmed = line.trim();
    // Only forward lines that look like JSON (MCP protocol requires JSON-RPC)
    if (!trimmed.startsWith('{')) {
      log(`DAEMON: MCP stdout (filtered, non-JSON): ${line.substring(0, 100)}`);
      return;
    }
    log(`DAEMON: MCP → client: ${line.substring(0, 100)}...`);
    if (currentClient && !currentClient.destroyed) {
      currentClient.write(line + '\n');
    }
  });

  // Accept connections from wrapper clients
  const server = net.createServer((conn) => {
    log('DAEMON: New client connected');
    // Replace the active client
    if (currentClient && !currentClient.destroyed) {
      log('DAEMON: Replacing existing client');
      currentClient.destroy();
    }
    currentClient = conn;

    // Forward client stdin → MCP server
    const clientReader = readline.createInterface({ input: conn, crlfDelay: Infinity });
    clientReader.on('line', (line) => {
      log(`DAEMON: client → MCP: ${line.substring(0, 100)}...`);
      if (!mcp.killed) {
        mcp.stdin.write(line + '\n');
      }
    });

    conn.on('close', () => {
      log('DAEMON: Client connection closed');
      clientReader.close();
      if (currentClient === conn) currentClient = null;
    });

    conn.on('error', (err) => {
      log(`DAEMON: Client connection error: ${err.message}`);
    });
  });

  server.listen(SOCKET);
  log(`DAEMON: Listening on ${SOCKET}`);

  // Cleanup on exit
  function cleanup(reason) {
    log(`DAEMON: Cleanup triggered: ${reason}`);
    try { fs.unlinkSync(SOCKET); } catch {}
    try { fs.unlinkSync(PID_FILE); } catch {}
    if (!mcp.killed) mcp.kill();
    process.exit();
  }

  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));
  mcp.on('exit', (code, signal) => {
    log(`DAEMON: MCP process exited with code=${code} signal=${signal}`);
    cleanup('mcp-exit');
  });

  // Keep daemon alive with setInterval instead of stdin
  setInterval(() => {}, 60000);
  log('DAEMON: Daemon ready and waiting');

  return;
}

// =====================
// CLIENT MODE (default)
// =====================

log('CLIENT: Starting client mode');

function isDaemonRunning() {
  if (!fs.existsSync(PID_FILE)) {
    log('CLIENT: No PID file found');
    return false;
  }
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'));
    process.kill(pid, 0); // signal 0 = check if alive
    const socketExists = fs.existsSync(SOCKET);
    log(`CLIENT: Daemon check - PID ${pid} alive, socket exists: ${socketExists}`);
    return socketExists;
  } catch (e) {
    log(`CLIENT: Daemon check failed: ${e.message}`);
    return false;
  }
}

function startDaemon() {
  log('CLIENT: Starting new daemon');
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
    log('CLIENT: Daemon failed to start - socket not found');
    process.stderr.write('superdoc-mcp-wrapper: daemon failed to start\n');
    process.exit(1);
  }
  log('CLIENT: Daemon started successfully');
}

// Start daemon if needed
if (!isDaemonRunning()) {
  startDaemon();
}

// Connect to daemon and proxy stdio
log('CLIENT: Connecting to daemon socket');
const conn = net.connect(SOCKET);

conn.on('connect', () => {
  log('CLIENT: Connected to daemon');
});

process.stdin.pipe(conn);
conn.pipe(process.stdout);

conn.on('error', (err) => {
  log(`CLIENT: Connection error: ${err.message}`);
  process.stderr.write('superdoc-mcp-wrapper: connection error: ' + err.message + '\n');
  process.exit(1);
});

conn.on('close', () => {
  log('CLIENT: Connection closed');
  process.exit(0);
});

process.stdin.on('end', () => {
  log('CLIENT: stdin ended');
  conn.end();
});
