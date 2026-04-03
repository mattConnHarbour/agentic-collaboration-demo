/**
 * Agent class for document editing via SuperDoc SDK and Anthropic Claude.
 */

import { readFileSync, existsSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

// Patch the SDK's binary resolution before importing
// Check locations in order: env var, installed (assets/bin or bin/), dev (node_modules)
if (!process.env.SUPERDOC_CLI_BIN) {
  const execDir = dirname(process.execPath);
  const candidates = [
    join(execDir, '..', 'assets', 'bin', 'superdoc'),  // ~/superdoc/assets/bin/superdoc
    join(execDir, 'superdoc-bin'),                      // ~/superdoc/bin/superdoc-bin
    join(execDir, 'node_modules/@superdoc-dev/sdk-darwin-arm64/bin/superdoc'),  // dev mode
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      process.env.SUPERDOC_CLI_BIN = path;
      console.log(`[Agent] SDK binary found at: ${path}`);
      break;
    }
  }
} else {
  console.log(`[Agent] Using CLI binary from env: ${process.env.SUPERDOC_CLI_BIN}`);
}

import {
  createSuperDocClient,
  dispatchIntentTool,
  type SuperDocClient,
  type SuperDocDocument,
} from '@superdoc-dev/sdk';

// Custom tool dispatch that bypasses catalog loading (needed for bundled binary)
function resolveDocApiMethod(documentHandle: any, operationId: string): Function {
  const tokens = operationId.split('.').slice(1);
  let cursor: any = documentHandle;
  for (const token of tokens) {
    if (typeof cursor !== 'object' || cursor === null || !(token in cursor)) {
      throw new Error(`No SDK doc method found for operation ${operationId}`);
    }
    cursor = cursor[token];
  }
  if (typeof cursor !== 'function') {
    throw new Error(`Resolved member for ${operationId} is not callable`);
  }
  return cursor;
}

// Parse JSON strings that LLMs sometimes pass instead of objects
function parseJsonStrings(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

function dispatchTool(doc: SuperDocDocument, toolName: string, args: Record<string, unknown>): unknown {
  const cleanArgs = parseJsonStrings(args);
  return dispatchIntentTool(toolName, cleanArgs, (operationId, input) => {
    const method = resolveDocApiMethod(doc, operationId);
    return method(input);
  });
}

const MAX_ITERATIONS = 20;

// Load tools from file system (works in dev, bundled, and installed modes)
function loadTools(): Anthropic.Tool[] {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const execDir = dirname(process.execPath);

  // Check locations in order: env var, installed (~/superdoc/assets), bundled, dev
  const installedPath = process.env.SUPERDOC_TOOLS_DIR
    ? join(process.env.SUPERDOC_TOOLS_DIR, 'tools.anthropic.json')
    : null;
  const assetsPath = join(execDir, '..', 'assets', 'tools', 'tools.anthropic.json'); // ~/superdoc/assets/tools/
  const bundledPath = join(execDir, 'tools', 'tools.anthropic.json');
  const devPath = join(__dirname, 'node_modules/@superdoc-dev/sdk/tools/tools.anthropic.json');

  const toolsPath = (installedPath && existsSync(installedPath)) ? installedPath
    : existsSync(assetsPath) ? assetsPath
    : existsSync(bundledPath) ? bundledPath
    : devPath;

  console.log(`[Agent] Loading tools from: ${toolsPath}`);

  if (!existsSync(toolsPath)) {
    throw new Error(`Tools file not found. Checked: ${installedPath || 'N/A'}, ${assetsPath}, ${bundledPath}, ${devPath}`);
  }

  const content = readFileSync(toolsPath, 'utf-8');
  const parsed = JSON.parse(content);

  // The JSON has { contractVersion, tools: [...] } structure
  return parsed.tools || parsed;
}

const SYSTEM_PROMPT = `You are a document editing assistant. You help users edit Word documents using the available tools.

Guidelines:
- Use tools to read, modify, and format document content
- Be concise in your responses
- After making changes, briefly confirm what you did
- If a request is unclear, ask for clarification`;

export type ToolCallCallback = (name: string, args: Record<string, unknown>) => void;

type MessageParam = Anthropic.MessageParam;
type ToolUseBlock = Anthropic.ToolUseBlock;
type Tool = Anthropic.Tool;

export class Agent {
  private client: SuperDocClient | null = null;
  private doc: SuperDocDocument | null = null;
  private anthropic: Anthropic;
  private tools: Tool[] = [];
  private conversationHistory: MessageParam[] = [];
  private systemPrompt: string = '';
  private documentId: string;
  private collaborationUrl: string;

  constructor(documentId: string, collaborationUrl: string) {
    this.documentId = documentId;
    this.collaborationUrl = collaborationUrl;
    this.anthropic = new Anthropic();
  }

  async connect(): Promise<void> {
    // Initialize system prompt
    this.systemPrompt = SYSTEM_PROMPT;
    this.conversationHistory = [];

    // Load tools from file
    this.tools = loadTools();
    console.log(`[Agent] Loaded ${this.tools.length} tools for Anthropic`);

    // Connect to document
    this.client = createSuperDocClient();
    await this.client.connect();

    this.doc = await this.client.open({
      collaboration: {
        providerType: 'y-websocket',
        url: this.collaborationUrl,
        documentId: this.documentId,
      },
    });
    console.log(`[Agent] Connected to document: ${this.documentId}`);
  }

  async process(userMessage: string, onToolCall?: ToolCallCallback): Promise<string> {
    if (!this.doc) {
      throw new Error('Agent not connected. Call connect() first.');
    }

    console.log(`[Agent] Processing: ${userMessage}`);
    this.conversationHistory.push({ role: 'user', content: userMessage });

    const messages: MessageParam[] = [...this.conversationHistory];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: this.systemPrompt,
        messages,
        tools: this.tools,
      });

      // Check if we have tool use
      const toolUseBlocks = response.content.filter(
        (block): block is ToolUseBlock => block.type === 'tool_use'
      );

      // If no tool calls and we have text, we're done
      if (toolUseBlocks.length === 0) {
        const textBlock = response.content.find(block => block.type === 'text');
        const result = textBlock?.type === 'text' ? textBlock.text : 'Done.';
        console.log(`[Agent] Response: ${result}`);
        this.conversationHistory.push({ role: 'assistant', content: result });
        return result;
      }

      // Add assistant message with tool use
      messages.push({ role: 'assistant', content: response.content });

      // Execute tool calls
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        const args = toolUse.input as Record<string, unknown>;
        console.log(`[Agent] Tool: ${toolUse.name}`, args);

        // Report tool call
        onToolCall?.(toolUse.name, args);

        try {
          const result = await dispatchTool(this.doc, toolUse.name, args);
          console.log(`[Agent] Result:`, result);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          });
        } catch (error) {
          console.error(`[Agent] Error:`, error);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({ error: String(error) }),
            is_error: true,
          });
        }
      }

      // Add tool results
      messages.push({ role: 'user', content: toolResults });

      // Check stop reason
      if (response.stop_reason === 'end_turn') {
        const textBlock = response.content.find(block => block.type === 'text');
        const result = textBlock?.type === 'text' ? textBlock.text : 'Done.';
        this.conversationHistory.push({ role: 'assistant', content: result });
        return result;
      }
    }

    const errorMsg = 'I ran into an issue processing your request. Please try again.';
    this.conversationHistory.push({ role: 'assistant', content: errorMsg });
    return errorMsg;
  }

  async saveToFile(outputPath: string): Promise<boolean> {
    if (!this.doc) {
      console.error('[Agent] Cannot save: not connected');
      return false;
    }

    try {
      const result = await this.doc.save({ out: outputPath, force: true });
      console.log(`[Agent] Saved document to: ${outputPath}`);
      return result.saved;
    } catch (e) {
      console.error('[Agent] Save failed:', e);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.doc) {
      await this.doc.close();
      this.doc = null;
    }
    if (this.client) {
      await this.client.dispose();
      this.client = null;
    }
    console.log(`[Agent] Disconnected from document: ${this.documentId}`);
  }
}
