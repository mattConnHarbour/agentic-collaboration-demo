/**
 * Agent class for document editing via SuperDoc SDK and OpenAI.
 */

import OpenAI from 'openai';
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

export class Agent {
  private client: SuperDocClient | null = null;
  private doc: SuperDocDocument | null = null;
  private openai: OpenAI;
  private tools: OpenAI.ChatCompletionTool[] = [];
  private conversationHistory: OpenAI.ChatCompletionMessageParam[] = [];
  private documentId: string;
  private collaborationUrl: string;

  constructor(documentId: string, collaborationUrl: string) {
    this.documentId = documentId;
    this.collaborationUrl = collaborationUrl;
    this.openai = new OpenAI();
  }

  async connect(): Promise<void> {
    // Initialize conversation with system prompt
    const systemPrompt = await getSystemPrompt();
    this.conversationHistory = [{ role: 'system', content: systemPrompt }];

    // Load tools
    const { tools } = await chooseTools({ provider: 'openai' });
    this.tools = tools as OpenAI.ChatCompletionTool[];
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

    const messages: OpenAI.ChatCompletionMessageParam[] = [...this.conversationHistory];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4.1',
        messages,
        tools: this.tools,
      });

      const message = response.choices[0].message;
      messages.push(message);

      // No tool calls - we're done
      if (!message.tool_calls?.length) {
        const result = message.content || 'Done.';
        console.log(`[Agent] Response: ${result}`);
        this.conversationHistory.push({ role: 'assistant', content: result });
        return result;
      }

      // Execute tool calls
      for (const call of message.tool_calls) {
        if (call.type !== 'function') continue;

        const args = JSON.parse(call.function.arguments);
        console.log(`[Agent] Tool: ${call.function.name}`, args);

        // Report tool call
        onToolCall?.(call.function.name, args);

        try {
          const result = await dispatchSuperDocTool(this.doc, call.function.name, args);
          console.log(`[Agent] Result:`, result);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        } catch (error) {
          console.error(`[Agent] Error:`, error);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: String(error) }),
          });
        }
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
