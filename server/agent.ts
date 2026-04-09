/**
 * Agent class for document editing via SuperDoc SDK and Anthropic Claude.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  createSuperDocClient,
  chooseTools,
  dispatchSuperDocTool,
  getSystemPrompt,
  type SuperDocClient,
  type SuperDocDocument,
} from '@superdoc-dev/sdk';

const MAX_ITERATIONS = 20;

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
    this.systemPrompt = await getSystemPrompt();

    // Load tools for Anthropic
    const { tools } = await chooseTools({ provider: 'anthropic' });
    this.tools = tools as Tool[];
    console.log(`[Agent] Loaded ${this.tools.length} tools`);

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
          const result = await dispatchSuperDocTool(this.doc, toolUse.name, args);
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
