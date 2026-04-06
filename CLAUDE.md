# Agentic Collaboration Demo

A chat-based AI agent that edits documents using the SuperDoc SDK and Anthropic Claude. See the [README](./README.md) for setup instructions.

## Architecture

```
Vue Client (5173)          Collaboration Server (3050)          AI Agent
┌─────────────────┐        ┌─────────────────────────┐        ┌─────────────────┐
│ SuperDoc Editor │◄──────►│ /collaboration/:docId   │◄──────►│ SDK client.open │
│ Chat Sidebar    │◄──────►│ /chat (HTTP polling)    │◄──────►│ Anthropic Claude│
└─────────────────┘        └─────────────────────────┘        └─────────────────┘
```

- **Client**: Vue 3 app with SuperDoc editor and chat sidebar
- **Server**: Fastify with WebSocket for collaboration (Yjs) and HTTP chat API
- **Agent**: Integrated into server, uses SuperDoc SDK + Anthropic Claude for document editing

## Project Structure

```
client/
  src/App.vue          Main Vue component with editor + chat
  package.json         Vue/Vite dependencies

server/
  server.ts            Fastify server with collaboration + chat endpoints
  agent.ts             AI agent with agentic loop (Anthropic Claude)
  job.ts               Async job management for chat requests
  package.json         Server dependencies

bin/                   Compiled binary output (after build)
  superdoc-preview     Standalone binary (~72MB)
  client/dist/         Bundled Vue client
  tools/               SDK tool definitions
  node_modules/        SDK binary dependencies

.env                   Environment variables (ANTHROPIC_API_KEY)
package.json           Root scripts (dev, build, install:all)
```

## Key Patterns

### SDK Client Setup

```typescript
import { createSuperDocClient, chooseTools, dispatchSuperDocTool, getSystemPrompt } from '@superdoc-dev/sdk';

const client = createSuperDocClient();
await client.connect();

const doc = await client.open({
  collaboration: {
    providerType: 'y-websocket',
    url: 'ws://localhost:3050/collaboration',
    documentId: 'my-doc',
  },
});
```

### Getting Tools for LLM

Tools are loaded from the SDK's JSON file:

```typescript
import { readFileSync } from 'fs';

const toolsPath = 'node_modules/@superdoc-dev/sdk/tools/tools.anthropic.json';
const content = readFileSync(toolsPath, 'utf-8');
const { tools } = JSON.parse(content);
// Returns array of Anthropic-compatible tool definitions
```

The binary build copies this to `bin/tools/tools.anthropic.json`.

### Executing Tools

```typescript
const result = await dispatchSuperDocTool(doc, 'insert_content', {
  value: 'Hello, world!',
  type: 'text',
});
```

### Agentic Loop Pattern

```typescript
const MAX_ITERATIONS = 20;  // Prevent infinite loops

for (let i = 0; i < MAX_ITERATIONS; i++) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: systemPrompt,
    messages,
    tools,
  });

  const toolUseBlocks = response.content.filter(block => block.type === 'tool_use');

  if (toolUseBlocks.length === 0) {
    const textBlock = response.content.find(block => block.type === 'text');
    return textBlock?.text || 'Done.';  // Done - no more tool calls
  }

  messages.push({ role: 'assistant', content: response.content });

  const toolResults = [];
  for (const toolUse of toolUseBlocks) {
    const result = await dispatchSuperDocTool(doc, toolUse.name, toolUse.input);
    toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });
  }
  messages.push({ role: 'user', content: toolResults });
}
```

### Two-Array Conversation Pattern

The agent uses two arrays to manage conversation:

- **`conversationHistory`**: Persistent array with system prompt + user messages + final assistant text responses (no tool calls)
- **`messages`**: Working array built fresh each turn from `[...conversationHistory]`, accumulates tool calls during processing

This keeps context clean - the LLM sees past conversation outcomes but not old tool call details.

## SuperDoc Configuration

### Layout Engine Options

Use `layoutEngineOptions` instead of deprecated `pagination`:

```javascript
new SuperDoc({
  // ...
  layoutEngineOptions: {
    flowMode: 'semantic',  // Continuous flow without pagination
  },
});
```

**Flow modes**:
- `'paginated'` (default): Standard page-first layout
- `'semantic'`: Continuous semantic flow without visible pagination boundaries

### Toolbar Configuration

```javascript
new SuperDoc({
  toolbar: '#superdoc-toolbar',
  toolbarGroups: ['center'],  // Reduces toolbar size
  modules: {
    toolbar: {
      excludeItems: ['link', 'table', 'image'],  // Remove specific buttons
    },
  },
});
```

## Chat API (HTTP Polling)

The chat system uses HTTP polling instead of WebSockets for simplicity:

```typescript
// POST /chat - Create a job
const { jobId } = await fetch('/chat', {
  method: 'POST',
  body: JSON.stringify({ sessionId, documentId, prompt })
}).then(r => r.json());

// GET /chat/jobs/:jobId - Poll for result
const { status, result, toolCalls } = await fetch(`/chat/jobs/${jobId}`).then(r => r.json());
// status: 'pending' | 'processing' | 'complete' | 'error'
```

Jobs are processed asynchronously and cleaned up after 5 minutes.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for the agent |
| `SUPERDOC_CLI_BIN` | No | Path to SDK CLI binary (auto-detected in dev/bundled modes) |

The `.env` file should be in the root directory. The server loads it with:

```typescript
dotenv.config({ path: '../.env' });
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run install:all` | Install dependencies for root + client + server |
| `npm run dev` | Run server + client concurrently |
| `npm run dev:server` | Run only the server (includes agent) |
| `npm run dev:client` | Run only the Vue client |
| `npm run build` | Build client + server binary |
| `npm run build:dist` | Clean build (removes bin/ first) |
| `npm run start` | Run the server in production mode |
| `npm run preview` | Run the compiled binary |

### Building the Binary

```bash
npm run build:dist
```

This produces a standalone binary at `bin/superdoc-preview` (~72MB) that includes:
- Compiled server + agent (Bun-compiled)
- Vue client (in `bin/client/dist/`)
- SDK tools JSON (in `bin/tools/`)
- SDK CLI binary (in `bin/node_modules/`)

### Running the Binary

```bash
# Open a document (auto-opens browser)
./bin/superdoc-preview sample.docx

# With options
./bin/superdoc-preview --file sample.docx --port 3050 --no-browser

# Positional argument also works
./bin/superdoc-preview sample.docx --no-browser
```

CLI options:
- `--file, -f <path>`: Path to DOCX file to open
- `--port, -p <number>`: Server port (default: 3050)
- `--no-browser`: Don't auto-open browser

## Common Issues

### Agent not available (503 error)

- In bundled binary mode, set `SUPERDOC_CLI_BIN` env var pointing to the SDK CLI binary
- In dev mode, the SDK binary is auto-detected from node_modules

### Tool loop runs forever

The agent has `MAX_ITERATIONS = 20` to prevent infinite tool-calling loops.

### Yjs "already imported" warning

This warning appears when Yjs is imported multiple times (from server and SDK). It's harmless but indicates potential bundle optimization opportunities.

### Port already in use

Kill existing processes: `lsof -ti:3050 | xargs kill -9`

## SDK Version

This example uses `@superdoc-dev/sdk@^1.1.0` and `superdoc@^1.24.2`. Key SDK exports:

- `createSuperDocClient()` - Create SDK client for document operations
- `dispatchSuperDocTool(doc, name, args)` - Execute a tool on the document
- `Editor.open(buffer, options)` - Open a document in headless mode (for seeding)
- `editor.generateCollaborationUpdate()` - Generate Yjs binary update from document

Tool definitions are loaded from `@superdoc-dev/sdk/tools/tools.anthropic.json`.

## Collaboration Server

The server uses `@superdoc-dev/superdoc-yjs-collaboration` with Fastify:

```typescript
const SuperDocCollaboration = new CollaborationBuilder()
  .withName('SuperDoc Collaboration service')
  .withDebounce(2000)
  .onConfigure(handleConfig)
  .onLoad(handleLoad)
  .onAuthenticate(handleAuth)
  .build();

// WebSocket route
fastify.get('/collaboration/:documentId', { websocket: true }, (socket, request) => {
  SuperDocCollaboration.welcome(socket, request);
});
```

The `onChange` and `onAutoSave` callbacks are optional and not needed for this example.

## Document Seeding

When a DOCX file is provided via CLI, the server seeds the collaboration room with its content:

```typescript
async function seedCollaborationState(docPath: string, roomId: string): Promise<void> {
  const fileBytes = readFileSync(docPath);
  const editor = await Editor.open(Buffer.from(fileBytes), {
    isHeadless: true,
    documentId: roomId,
    telemetry: { enabled: false },
    user: { id: 'seed-bot', name: 'Seed Bot', email: 'seed-bot@superdoc.dev' },
  });

  try {
    const update = await editor.generateCollaborationUpdate();
    documentStates.set(roomId, update);  // Store Yjs binary for handleLoad
  } finally {
    editor.destroy();
  }
}
```

The seeding flow:
1. `Editor.open()` opens the DOCX in headless mode (no UI)
2. `generateCollaborationUpdate()` produces a Yjs binary update
3. The update is stored in `documentStates` Map
4. When clients connect, `handleLoad` returns this seeded state
5. Auto-save periodically updates the stored state as users edit

## Deployment

Split deployment: frontend on Cloudflare Pages, backend (server + agent) on Railway.

```
Cloudflare Pages                         Railway
┌──────────────────┐                    ┌─────────────────────────────────┐
│  Vue Client      │───── wss:// ──────►│  server.ts                      │
│  (static)        │                    │  └── agent.ts (integrated)      │
└──────────────────┘                    └─────────────────────────────────┘
```

### Railway (Backend)

1. New Project → Deploy from GitHub
2. Configure:
   - **Build Command**: `npm run install:all`
   - **Start Command**: `npm run start`
3. Add environment variable: `ANTHROPIC_API_KEY`
4. Deploy → copy the generated URL (e.g., `https://xxx.up.railway.app`)

### Cloudflare Pages (Frontend)

1. Connect GitHub repo
2. Configure:
   - **Root Directory**: `client`
   - **Build Command**: `npm install && npm run build`
   - **Output Directory**: `dist`
3. Add environment variable: `VITE_BACKEND_URL` = Railway URL (with `https://`)
4. Deploy

### How It Works

- Server serves static files from `client/dist` if available (bundled mode)
- Client uses `VITE_BACKEND_URL` env var for backend connections (falls back to `localhost:3050` for dev)
- Agent is integrated into server process (no separate spawn needed)

## Claude Desktop Integration (WIP)

A new simplified installation for Claude Desktop users is being developed.

### Target Architecture

```
Claude Desktop                              Browser
┌─────────────────────┐                    ┌─────────────────┐
│ MCP Tools           │                    │ Preview App     │
│ (via keepalive)     │                    │ (Vue + Editor)  │
└─────────┬───────────┘                    └────────┬────────┘
          │                                         │
          ▼                                         ▼
┌─────────────────────┐                    ┌─────────────────┐
│ mcp-wrapper.js      │                    │ server.ts       │
│ (daemon pattern)    │                    │ (self-daemon)   │
└─────────┬───────────┘                    └────────┬────────┘
          │                                         │
          ▼                                         ▼
┌─────────────────────┐                    ┌─────────────────┐
│ npx @superdoc/mcp   │                    │ Collaboration   │
│ (real MCP server)   │                    │ + AI Agent      │
└─────────────────────┘                    └─────────────────┘
```

### Installation Directory Structure

```
~/superdoc/claude/
├── .env                    # ANTHROPIC_API_KEY (user-provided)
├── mcp-wrapper.js          # MCP keepalive daemon wrapper
├── preview.pid             # Current preview server PID
└── preview/
    ├── server.js           # Preview server (compiled)
    ├── agent.js            # AI agent
    ├── job.js              # Job management
    ├── package.json
    └── node_modules/       # Dependencies (@superdoc-dev/sdk, etc.)
```

### Install Script

Single curl command installs everything:

```bash
curl -fsSL https://raw.githubusercontent.com/mattConnHarbour/agentic-collaboration-demo/claude-desktop/superdoc-setup.sh | bash
```

The script:
1. Downloads MCP wrapper and preview server code
2. Runs `npm install` for dependencies
3. Configures Claude Desktop MCP (`~/Library/Application Support/Claude/claude_desktop_config.json`)
4. Installs skill to `~/.claude/skills/superdoc/skill.md`

### Key Design Decisions

1. **No bundled binary** - Uses Node.js directly since npm/npx is required anyway
2. **MCP keepalive wrapper** - Daemon pattern keeps MCP server alive across Claude Desktop reconnects
3. **Self-daemonizing preview** - Preview server forks to background so Claude doesn't block
4. **Dynamic port selection** - Server picks available port to avoid conflicts
5. **Graceful API key handling** - Preview works without key, chat disabled with tooltip

### Pending Server Enhancements

The preview server (`server/server.ts`) needs these updates:

1. **Self-daemonize pattern** - Parent spawns detached child and exits immediately
2. **Dynamic port selection** - Find available port, write to PID file
3. **PID file management** - Kill old server before starting new one
4. **WebSocket disconnect cleanup** - 30s grace period before shutting down
5. **Inactivity timeout** - Shutdown after 5min with no connections
6. **File watching** - Track mtime to detect external changes vs internal saves
7. **API key check endpoint** - `/api/has-key` for client to check availability

### Pending Client Enhancements

The Vue client needs:

1. **Disabled chat UI** - When no API key, show tooltip explaining why
2. **File changed banner** - When external changes detected, offer reload

### Skill File

Simplified skill at `~/.claude/skills/superdoc/skill.md`:

```markdown
# SuperDoc

Edit Word documents (.docx) using MCP tools (automatic).

## Preview in Browser

node ~/superdoc/claude/preview/server.js /path/to/document.docx

## Set API Key (for AI chat in preview)

echo "ANTHROPIC_API_KEY=sk-ant-..." > ~/superdoc/claude/.env
```

### Files to Create/Update

- `superdoc-setup.sh` - Main install script (CREATED, needs completion)
- `scripts/superdoc-mcp-wrapper.js` - MCP keepalive wrapper (needs update for ~/superdoc/claude/.env)
- `server/server.ts` - Preview server (needs all enhancements)
- `client/src/App.vue` - Vue client (needs disabled chat + file banner)
- Remove `install.sh` - Old binary-based installer
- Remove `.github/workflows/release.yml` - Old binary release workflow
