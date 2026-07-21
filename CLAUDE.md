# Comment Review Agent Demo

An AI agent that processes document comments and applies tracked changes using the SuperDoc SDK and OpenAI.

## Current Development State

**Status**: In Progress - Core workflow implemented, debugging comment text retrieval

### What Works
- Vue client with SuperDoc editor and comment panel
- "Request Review" button triggers server-side review
- Server connects to document via SDK collaboration
- `comments.list()` returns comments with anchored text and targets
- `comments.get({ id })` fetches individual comment details
- Job polling UI shows progress

### Current Issue
The `comments.list()` API returns comments but the `text` field (comment body/instruction) is empty. Attempted fix: fetch full details via `comments.get({ id })` - needs testing.

**Last error**: `comments get: missing required --id` - fixed by changing `{ commentId }` to `{ id }`.

### Next Steps
1. Test if `comments.get({ id })` returns the comment `text` field
2. If text is still empty, investigate why comment body isn't being stored/returned
3. Complete the workflow: LLM revision → tracked change → reply to comment

## Architecture

```
Vue Client (5173)              Server (3050)
┌─────────────────────┐        ┌─────────────────────────────┐
│ SuperDoc Editor     │◄──────►│ /collaboration/:docId (WS)  │
│ Comment Panel       │        │ /review (POST) → job        │
│ Request Review btn  │───────►│ /review/jobs/:id (GET)      │
└─────────────────────┘        └─────────────────────────────┘
                                         │
                                         ▼
                               ┌─────────────────────────────┐
                               │ CommentReviewer             │
                               │ - connects via SDK          │
                               │ - lists comments            │
                               │ - calls OpenAI for revision │
                               │ - applies tracked change    │
                               │ - replies to comment        │
                               └─────────────────────────────┘
```

## Project Structure

```
client/
  src/App.vue              Main Vue component with editor + review UI
  package.json             Vue/Vite dependencies

server/
  server.ts                Fastify server with collaboration + review endpoints
  comment-reviewer.ts      Core review logic (SDK + OpenAI)
  package.json             Server dependencies (@superdoc-dev/sdk, openai)

.env                       Environment variables (OPENAI_API_KEY)
package.json               Root scripts (dev, install:all)
```

## Key Files

### `server/comment-reviewer.ts`

Core review logic:

```typescript
export class CommentReviewer {
  async connect(): Promise<void> {
    this.client = createSuperDocClient();
    await this.client.connect();
    this.doc = await this.client.open({
      collaboration: {
        providerType: 'y-websocket',
        url: this.collaborationUrl,
        documentId: this.documentId,
      },
    });
  }

  async review(onProgress?: (result: ReviewResult) => void): Promise<ReviewResult> {
    // 1. List open, root-level comments
    const commentsResult = await this.doc.comments.list({ includeResolved: false });
    const rootComments = allComments.filter(c => !c.parentCommentId && c.status === 'open');

    // 2. Process each comment
    for (const comment of rootComments) {
      // Fetch full details (list may not include text)
      const fullComment = await this.doc.comments.get({ id: comment.id });

      // 3. Generate revision via OpenAI
      const { revisedText, explanation } = await this.generateRevision(
        fullComment.anchoredText,
        fullComment.text  // <-- This is the comment instruction
      );

      // 4. Apply tracked change
      await this.doc.replace(
        { target: fullComment.target, value: revisedText },
        { changeMode: 'tracked' }
      );

      // 5. Reply to comment
      await this.doc.comments.create({
        text: `I've made this change...\n\n${explanation}`,
        parentCommentId: comment.id,
      });
    }
  }
}
```

### `server/server.ts`

Review endpoints:

```typescript
// POST /review - start a review job
fastify.post('/review', async (request) => {
  const { documentId } = request.body;
  const jobId = crypto.randomUUID();

  // Run review in background
  const reviewer = new CommentReviewer(documentId, collaborationUrl);
  await reviewer.connect();
  reviewer.review((progress) => {
    reviews.get(jobId).result = progress;
  }).then(() => {
    reviews.get(jobId).status = 'complete';
    reviewer.disconnect();
  });

  return { jobId };
});

// GET /review/jobs/:jobId - poll for status
fastify.get('/review/jobs/:jobId', async (request) => {
  const job = reviews.get(jobId);
  return { id: job.id, status: job.status, result: job.result };
});
```

### `client/src/App.vue`

Review UI (key parts):

```javascript
const requestReview = async () => {
  reviewStatus.value = 'processing';
  const response = await fetch(`${backendUrl}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentId: roomId.value }),
  });
  const { jobId } = await response.json();
  const result = await pollForReviewResult(jobId);
  reviewResult.value = result;
  reviewStatus.value = result.status;
};

const pollForReviewResult = async (jobId) => {
  while (true) {
    const response = await fetch(`${backendUrl}/review/jobs/${jobId}`);
    const job = await response.json();
    if (job.status === 'complete' || job.status === 'error') {
      return job.result;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
};
```

## SDK API Reference

### Comments API

```typescript
// List comments (returns items without full text body)
const result = await doc.comments.list({ includeResolved: false });
// result.items[]: { id, status, anchoredText, target, parentCommentId, ... }

// Get full comment details (includes text body)
const comment = await doc.comments.get({ id: commentId });
// comment: { id, text, anchoredText, target, status, ... }

// Create comment or reply
await doc.comments.create({
  text: 'Comment body',
  target: { kind: 'text', segments: [...] },  // for root comment
  // OR
  parentCommentId: 'xxx',  // for reply
});
```

### Replace with Tracked Changes

```typescript
await doc.replace(
  { target: comment.target, value: 'New text' },
  { changeMode: 'tracked' }
);
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for LLM revision |

## Scripts

| Script | Description |
|--------|-------------|
| `npm run install:all` | Install dependencies for root + client + server |
| `npm run dev` | Run client (5173) + server (3050) concurrently |
| `npm run dev:server` | Run only the server |
| `npm run dev:client` | Run only the Vue client |

## Common Issues

### Port already in use
```bash
lsof -ti:3050 | xargs -r kill -9
lsof -ti:5173 | xargs -r kill -9
```

### Comment text is empty
The `comments.list()` API may not return the `text` field. Use `comments.get({ id })` to fetch full details.

### SDK parameter naming
- Use `{ id }` not `{ commentId }` for `comments.get()`
- Use `{ parentCommentId }` for replies in `comments.create()`

## Origin

Cloned from https://github.com/mattConnHarbour/agentic-collaboration-demo and repurposed from chat-based editing to comment review workflow.
