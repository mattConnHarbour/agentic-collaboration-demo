/**
 * Comment Reviewer - processes document comments and applies tracked changes.
 *
 * Workflow:
 * 1. List all open, root-level comments
 * 2. For each comment:
 *    - Read the anchored text and comment instruction
 *    - Use LLM to determine the revision
 *    - Apply the change as a tracked change
 *    - Reply to the comment explaining what was done
 */

import OpenAI from 'openai';
import {
  createSuperDocClient,
  type SuperDocClient,
  type SuperDocDocument,
} from '@superdoc-dev/sdk';

export type ReviewStatus = 'pending' | 'processing' | 'complete' | 'error';

export interface CommentProgress {
  commentId: string;
  anchoredText: string;
  commentText: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  revisedText?: string;
  explanation?: string;
  error?: string;
}

export interface ReviewResult {
  status: ReviewStatus;
  commentsFound: number;
  commentsProcessed: number;
  comments: CommentProgress[];
  error?: string;
}

export class CommentReviewer {
  private client: SuperDocClient | null = null;
  private doc: SuperDocDocument | null = null;
  private openai: OpenAI;
  private documentId: string;
  private collaborationUrl: string;
  private commentInstructions: Record<string, string>;
  private requestedCommentIds: Set<string> | null;

  constructor(
    documentId: string,
    collaborationUrl: string,
    commentInstructions: Record<string, string> = {},
    requestedCommentIds: string[] = [],
  ) {
    this.documentId = documentId;
    this.collaborationUrl = collaborationUrl;
    this.commentInstructions = commentInstructions;
    this.requestedCommentIds = requestedCommentIds.length ? new Set(requestedCommentIds) : null;
    this.openai = new OpenAI();
  }

  async connect(): Promise<void> {
    this.client = createSuperDocClient({
      user: {
        name: 'Agent',
        email: 'agent@superdoc.dev',
      },
    });
    await this.client.connect();

    this.doc = await this.client.open({
      collaboration: {
        providerType: 'y-websocket',
        url: this.collaborationUrl,
        documentId: this.documentId,
      },
      trackChanges: {
        replacements: 'paired',
      },
    });
    console.log(`[CommentReviewer] Connected to document: ${this.documentId}`);
  }

  async review(onProgress?: (result: ReviewResult) => void): Promise<ReviewResult> {
    if (!this.doc) {
      throw new Error('CommentReviewer not connected. Call connect() first.');
    }

    const result: ReviewResult = {
      status: 'processing',
      commentsFound: 0,
      commentsProcessed: 0,
      comments: [],
    };

    try {
      // List all comments
      console.log('[CommentReviewer] Listing comments...');
      const commentsResult = await this.doc.comments.list({ includeResolved: false });
      const allComments = commentsResult?.items ?? [];

      // Debug: log raw comment data
      console.log(`[CommentReviewer] Raw comments:`, JSON.stringify(allComments, null, 2));

      // Filter to root-level, open comments only
      const rootComments = allComments.filter(
        (c: any) =>
          !c.parentCommentId &&
          (!this.requestedCommentIds || this.requestedCommentIds.has(c.id)) &&
          c.status === 'open' &&
          c.target &&
          c.anchoredText &&
          Boolean(c.text || this.commentInstructions[c.id])
      );

      result.commentsFound = rootComments.length;
      console.log(`[CommentReviewer] Found ${rootComments.length} comments to review`);

      if (rootComments.length === 0) {
        result.status = 'complete';
        return result;
      }

      // Initialize progress for each comment
      for (const comment of rootComments) {
        result.comments.push({
          commentId: comment.id,
          anchoredText: comment.anchoredText || '',
          commentText: comment.text || '',
          status: 'pending',
        });
      }
      onProgress?.(result);

      // Process each comment
      for (let i = 0; i < rootComments.length; i++) {
        const comment = rootComments[i];
        const progress = result.comments[i];
        progress.status = 'processing';
        onProgress?.(result);

        try {
          await this.processComment(comment, progress);
          progress.status = 'done';
          result.commentsProcessed++;
        } catch (err: any) {
          console.error(`[CommentReviewer] Error processing comment ${comment.id}:`, err);
          progress.status = 'error';
          progress.error = err.message;
        }
        onProgress?.(result);
      }

      result.status = 'complete';
    } catch (err: any) {
      console.error('[CommentReviewer] Review failed:', err);
      result.status = 'error';
      result.error = err.message;
    }

    return result;
  }

  private async processComment(comment: any, progress: CommentProgress): Promise<void> {
    console.log(`[CommentReviewer] Processing comment: ${comment.id}`);

    // Fetch full comment details (list may not include text)
    let fullComment = await this.doc!.comments.get({ id: comment.id });
    console.log(`[CommentReviewer] Full comment:`, JSON.stringify(fullComment, null, 2));

    // A real comment may inherit tracked-change metadata when its selection
    // overlaps an existing redline. Read that redline before accepting it so
    // the agent can incorporate the drafter's proposed insertion/deletion.
    const overlappingChangeId = fullComment.trackedChangeLink?.trackedChangeId;
    let overlappingChange: any = null;
    if (overlappingChangeId) {
      overlappingChange = await this.doc!.trackChanges.get({ id: overlappingChangeId });
      console.log(`[CommentReviewer] Overlapping tracked change:`, JSON.stringify(overlappingChange, null, 2));
    }

    // Get the anchored text and instruction
    const anchoredText = fullComment.anchoredText || comment.anchoredText || '';
    const rawCommentInstruction =
      fullComment.text ||
      comment.text ||
      this.commentInstructions[comment.id] ||
      '';
    const commentInstruction = rawCommentInstruction
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!anchoredText) {
      throw new Error('Comment has no anchored text');
    }

    if (!commentInstruction) {
      throw new Error('Comment has no instruction text. The comment body may be empty.');
    }

    // Update progress with actual values
    progress.anchoredText = anchoredText;
    progress.commentText = commentInstruction;

    console.log(`[CommentReviewer] Anchored: "${anchoredText.substring(0, 50)}..."`);
    console.log(`[CommentReviewer] Instruction: "${commentInstruction.substring(0, 50)}..."`);

    // Use LLM to determine the revision
    const { revisedText, explanation } = await this.generateRevision(
      anchoredText,
      commentInstruction,
      overlappingChange,
    );
    progress.revisedText = revisedText;
    progress.explanation = explanation;

    console.log(`[CommentReviewer] Revised: "${revisedText.substring(0, 50)}..."`);

    // The consolidated revision is ready. Accept the drafter's old redline,
    // then refetch the comment so reply/edit operations use its remapped anchor.
    if (overlappingChangeId) {
      console.log(`[CommentReviewer] Accepting reviewed tracked change: ${overlappingChangeId}`);
      await this.doc!.trackChanges.decide({
        decision: 'accept',
        target: {
          kind: 'id',
          id: overlappingChangeId,
        },
      });
      fullComment = await this.doc!.comments.get({ id: comment.id });
      console.log(`[CommentReviewer] Refetched comment after accepting overlap:`, JSON.stringify(fullComment, null, 2));
    }

    // Reply while the original comment anchor is still valid. A tracked
    // replacement can invalidate that target before a reply is attached.
    await this.doc!.comments.create({
      text: `I'm applying a tracked revision.\n\n${explanation}\n\nPlease review and accept or reject the change.`,
      parentId: comment.id,
    });
    console.log(`[CommentReviewer] Added rationale reply to comment ${comment.id}`);

    // Apply the change as a tracked replacement. Comment targets use a segment-based text
    // shape, while replace() expects a selection with text positions.
    const target = fullComment.target || comment.target;
    const segments = target?.kind === 'text' ? target.segments : null;
    if (segments?.length) {
      const first = segments[0];
      const last = segments[segments.length - 1];
      const selection = {
        kind: 'selection' as const,
        start: {
          kind: 'text' as const,
          blockId: first.blockId,
          offset: first.range.start,
        },
        end: {
          kind: 'text' as const,
          blockId: last.blockId,
          offset: last.range.end,
        },
      };

      // Insert first so the original end offset is still resolvable. A tracked
      // deletion remains visible but is removed from the editable position map.
      await this.doc!.insert({
        target: {
          kind: 'selection',
          start: selection.end,
          end: selection.end,
        },
        value: revisedText,
        changeMode: 'tracked',
      });
      await this.doc!.delete({
        target: selection,
        changeMode: 'tracked',
      });
      console.log(`[CommentReviewer] Applied whole-range tracked change for comment ${comment.id}`);
    } else {
      console.warn(`[CommentReviewer] Comment ${comment.id} has no target, skipping replace`);
    }

  }

  private async generateRevision(
    anchoredText: string,
    instruction: string,
    overlappingChange?: any,
  ): Promise<{ revisedText: string; explanation: string }> {
    const systemPrompt = `You are a document editor assistant. The user has left a comment on a piece of text, instructing you to make a change.

Your task:
1. Read the original text that was commented on
2. Read the comment (which is an instruction for how to change the text)
3. Produce the revised text that fulfills the comment's instruction

Respond with ONLY a JSON object in this exact format:
{
  "revisedText": "the new text that should replace the original",
  "explanation": "a concise 2-3 sentence editorial rationale explaining the issue in the original, the approach taken, and why the revision better satisfies the comment"
}

The explanation must provide useful reasoning rather than merely repeat or quote the revised text.
Do not include any other text, markdown formatting, or code blocks. Just the JSON object.`;

    const redlineContext = overlappingChange
      ? `\nExisting tracked revision within the commented range:
- Change type: ${overlappingChange.type || 'unknown'}
- Deleted text: ${overlappingChange.deletedText || '(none)'}
- Inserted text: ${overlappingChange.insertedText || '(none)'}

Treat the existing tracked revision as the drafter's proposed intent. Incorporate it when producing one consolidated revision that also satisfies the comment.`
      : '';

    const userPrompt = `Original text: "${anchoredText}"

Comment instruction: "${instruction}"
${redlineContext}

Provide the revised text that addresses this comment.`;

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4.1',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
    });

    const responseText = completion.choices[0]?.message?.content?.trim() ?? '';

    try {
      const parsed = JSON.parse(responseText);
      if (!parsed.revisedText) {
        throw new Error('LLM did not provide revisedText');
      }
      return {
        revisedText: parsed.revisedText,
        explanation: parsed.explanation || 'Made the requested change.',
      };
    } catch {
      throw new Error(`Failed to parse LLM response: ${responseText.substring(0, 100)}`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.doc) {
      // Collaboration mutations have already been propagated. The SDK still
      // marks its local session dirty and requires an explicit close decision.
      await this.doc.close({ discard: true });
      this.doc = null;
    }
    if (this.client) {
      await this.client.dispose();
      this.client = null;
    }
    console.log(`[CommentReviewer] Disconnected from document: ${this.documentId}`);
  }
}
