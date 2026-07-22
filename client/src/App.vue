<script setup>
import 'superdoc/style.css';
import { onMounted, onBeforeUnmount, shallowRef, ref } from 'vue';
import { SuperDoc } from 'superdoc';
import { CommentReviewQueueController } from './comment-review-queue.js';
import { CommentReviewController } from './comment-review-controller.js';

import sampleDocument from '/sample-document.docx?url';
import blankDocument from '/blank.docx?url';

// Backend URL: use VITE_BACKEND_URL env var, or fall back to localhost for dev
const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3050';
const wsUrl = backendUrl.replace(/^http/, 'ws');
const COLLAB_URL = `${wsUrl}/collaboration`;

// The initial room can be overridden; imports create a fresh room so Yjs
// history from an earlier document cannot accumulate in the replacement.
const roomId = ref(import.meta.env.VITE_DOCUMENT_ID || 'comment-review-demo');
const roomCopied = ref(false);

const superdoc = shallowRef(null);
const queuedCommentCount = ref(0);
const documentReady = ref(false);
const documentLoadError = ref('');
let collaborationReady = false;
let readinessRun = 0;

// Review state
const reviewStatus = ref('idle'); // 'idle' | 'reviewing' | 'complete' | 'error'
const reviewResult = ref(null);
const backendVersions = ref({ sdk: null, collab: null });
const reviewController = new CommentReviewController(backendUrl);

const commentQueueController = new CommentReviewQueueController({
  getComments: () => superdoc.value?.commentsStore?.commentsList || [],
  isReviewing: () => !documentReady.value || reviewStatus.value === 'reviewing',
  onQueueCountChange: (count) => { queuedCommentCount.value = count; },
  onReviewRequested: () => requestReview(),
});

const USER_COLORS = ['#a11134', '#2a7e34', '#b29d11', '#2f4597', '#ab5b22'];

const getCommentSignature = () => (superdoc.value?.commentsStore?.commentsList || [])
  .map((comment) => {
    const values = typeof comment.getValues === 'function' ? comment.getValues() : comment;
    return values.commentId || values.id || '';
  })
  .sort()
  .join('|');

const waitForDocumentAndComments = async () => {
  const run = ++readinessRun;
  const timeoutAt = Date.now() + 60_000;
  let previousSignature = null;
  let stableSince = 0;

  documentReady.value = false;
  documentLoadError.value = '';

  while (run === readinessRun && Date.now() < timeoutAt) {
    const commentsSynced = superdoc.value?.commentsStore?.hasSyncedCollaborationComments === true;
    if (collaborationReady && superdoc.value?.activeEditor && commentsSynced) {
      const signature = getCommentSignature();
      if (signature !== previousSignature) {
        previousSignature = signature;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 750) {
        commentQueueController.arm();
        documentReady.value = true;
        console.log('[Client] Document and comments fully loaded');
        return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  if (run === readinessRun) {
    documentLoadError.value = 'Document and comments did not finish loading. Restart the demo and try again.';
  }
};

const createRoomId = () => `comment-review-${crypto.randomUUID().slice(0, 8)}`;

const initSuperDoc = (documentSource = sampleDocument) => {
  console.log('[Client] Initializing SuperDoc for room:', roomId.value);

  superdoc.value = new SuperDoc({
    selector: '#superdoc',
    toolbar: '#superdoc-toolbar',
    toolbarGroups: ['center', 'right'],
    document: {
      id: roomId.value,
      type: 'docx',
      isNewFile: true,
      ...(typeof documentSource === 'string'
        ? { url: documentSource }
        : { data: documentSource, name: documentSource.name || 'document.docx' }),
    },
    layoutEngineOptions: {
      flowMode: 'semantic',
    },
    colors: USER_COLORS,
    user: generateUserInfo(),
    onCommentsUpdate: (payload) => commentQueueController.handleCommentsUpdate(payload),
    onCollaborationReady: () => {
      collaborationReady = true;
      waitForDocumentAndComments();
    },
    modules: {
      collaboration: {
        url: `${COLLAB_URL}`,
        token: 'token',
      },
      toolbar: {
        excludeItems: ['link', 'table', 'image'],
      },
    },
  });
};

const requestReview = async () => {
  if (!documentReady.value || reviewStatus.value === 'reviewing') return;

  reviewStatus.value = 'reviewing';
  reviewResult.value = null;

  try {
    console.log('[Review] Starting review for room:', roomId.value);

    const result = await reviewController.review({
      documentId: roomId.value,
      onProgress: (progress) => { reviewResult.value = progress; },
    });
    reviewResult.value = result;
    reviewStatus.value = 'complete';
    console.log('[Review] Complete:', result);
  } catch (e) {
    console.error('[Review] Error:', e);
    reviewStatus.value = 'error';
    reviewResult.value = { error: e.message };
  } finally {
    commentQueueController.reviewSettled();
  }
};

const resetReview = () => {
  reviewStatus.value = 'idle';
  reviewResult.value = null;
};

const generateUserInfo = () => {
  const randomUser = Math.random().toString(36).substring(2, 8);
  return {
    name: `User-${randomUser}`,
    email: `${randomUser}@superdoc.dev`,
    color: USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)],
  };
};

// File input ref for import
const fileInput = ref(null);

const handleImport = () => {
  fileInput.value?.click();
};

const replaceDocument = async (file) => {
  if (!file || !superdoc.value) return;

  try {
    commentQueueController.pause();
    documentReady.value = false;
    documentLoadError.value = '';
    readinessRun++;
    collaborationReady = false;
    superdoc.value.destroy();
    superdoc.value = null;
    roomId.value = createRoomId();
    resetReview();
    initSuperDoc(file);
    console.log(`[Client] Document imported into fresh room ${roomId.value}:`, file.name);
  } catch (e) {
    documentLoadError.value = e.message || 'Document import failed.';
    console.error('[Client] Import failed:', e);
  }
};

const onFileSelected = async (event) => {
  const file = event.target.files?.[0];
  await replaceDocument(file);

  event.target.value = '';
};

const handleBlankDocument = async () => {
  try {
    const response = await fetch(blankDocument);
    if (!response.ok) throw new Error(`Blank document request failed (${response.status})`);
    const file = new File([await response.blob()], 'blank.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await replaceDocument(file);
  } catch (e) {
    console.error('[Client] Blank document import failed:', e);
  }
};

const handleExport = async () => {
  if (!superdoc.value) return;

  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const filename = `SuperDoc_${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${String(now.getFullYear()).slice(-2)}`;
    await superdoc.value.export({ exportedName: filename });
    console.log('[Client] Document exported:', filename);
  } catch (e) {
    console.error('[Client] Export failed:', e);
  }
};

const copyRoomId = async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    roomCopied.value = true;
    setTimeout(() => { roomCopied.value = false; }, 1500);
    console.log('[Client] Room URL copied:', window.location.href);
  } catch (e) {
    console.error('[Client] Copy failed:', e);
  }
};

const checkBackendHealth = async () => {
  try {
    const data = await reviewController.health();
    backendVersions.value = data.versions || backendVersions.value;
    console.log('[Client] Backend healthy:', data);
  } catch (e) {
    console.error('[Client] Backend unreachable:', e);
  }
};

onMounted(() => {
  initSuperDoc();
  checkBackendHealth();
});

onBeforeUnmount(() => {
  readinessRun++;
  commentQueueController.destroy();
  reviewController.destroy();
  superdoc.value?.destroy();
  superdoc.value = null;
});
</script>

<template>
  <div class="app-wrapper">
    <div v-if="!documentReady" class="loading-overlay">
      <div class="loading-card">
        <div v-if="!documentLoadError" class="spinner"></div>
        <strong>{{ documentLoadError || 'Loading document and comments…' }}</strong>
      </div>
    </div>
    <!-- Top Header Bar -->
    <header class="top-header">
      <div class="logo">
        <img src="/logo.webp" alt="SuperDoc" class="logo-img" />
        <span class="logo-text">SuperDoc</span>
      </div>
      <div class="header-actions">
        <button class="header-btn with-text" @click="copyRoomId" title="Click to copy room ID">
          <span>{{ roomCopied ? 'Copied!' : `room: ${roomId}` }}</span>
        </button>
        <input
          type="file"
          ref="fileInput"
          @change="onFileSelected"
          accept=".docx,.doc"
          style="display: none"
        />
        <button class="header-btn with-text" @click="handleImport" title="Import">
          <span>Import</span>
          <svg viewBox="0 0 640 640" fill="currentColor">
            <path d="M352 173.3L352 384C352 401.7 337.7 416 320 416C302.3 416 288 401.7 288 384L288 173.3L246.6 214.7C234.1 227.2 213.8 227.2 201.3 214.7C188.8 202.2 188.8 181.9 201.3 169.4L297.3 73.4C309.8 60.9 330.1 60.9 342.6 73.4L438.6 169.4C451.1 181.9 451.1 202.2 438.6 214.7C426.1 227.2 405.8 227.2 393.3 214.7L352 173.3zM320 464C364.2 464 400 428.2 400 384L480 384C515.3 384 544 412.7 544 448L544 480C544 515.3 515.3 544 480 544L160 544C124.7 544 96 515.3 96 480L96 448C96 412.7 124.7 384 160 384L240 384C240 428.2 275.8 464 320 464zM464 488C477.3 488 488 477.3 488 464C488 450.7 477.3 440 464 440C450.7 440 440 450.7 440 464C440 477.3 450.7 488 464 488z"/>
          </svg>
        </button>
        <button class="header-btn with-text" @click="handleBlankDocument" title="Import a blank document">
          <span>Blank document</span>
        </button>
        <button class="header-btn" @click="handleExport" title="Export">
          <svg viewBox="0 0 640 640" fill="currentColor">
            <path d="M352 96C352 78.3 337.7 64 320 64C302.3 64 288 78.3 288 96L288 306.7L246.6 265.3C234.1 252.8 213.8 252.8 201.3 265.3C188.8 277.8 188.8 298.1 201.3 310.6L297.3 406.6C309.8 419.1 330.1 419.1 342.6 406.6L438.6 310.6C451.1 298.1 451.1 277.8 438.6 265.3C426.1 252.8 405.8 252.8 393.3 265.3L352 306.7L352 96zM160 384C124.7 384 96 412.7 96 448L96 480C96 515.3 124.7 544 160 544L480 544C515.3 544 544 515.3 544 480L544 448C544 412.7 515.3 384 480 384L433.1 384L376.5 440.6C345.3 471.8 294.6 471.8 263.4 440.6L206.9 384L160 384zM464 440C477.3 440 488 450.7 488 464C488 477.3 477.3 488 464 488C450.7 488 440 477.3 440 464C440 450.7 450.7 440 464 440z"/>
          </svg>
        </button>
      </div>
    </header>

    <div class="main-content">
      <!-- Editor Area -->
      <div class="editor-area">
        <div id="superdoc-toolbar" class="editor-toolbar"></div>
        <div class="editor-container">
          <div id="superdoc" class="main-editor"></div>
        </div>
      </div>

      <!-- Review Sidebar -->
      <aside class="review-sidebar">
        <div class="review-header">
          <div class="review-title">
            <svg class="review-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span>Comment Review</span>
            <a v-if="backendVersions.sdk" class="version-pill" :href="`https://www.npmjs.com/package/@superdoc-dev/sdk/v/${backendVersions.sdk}`" target="_blank">sdk {{ backendVersions.sdk }}</a>
          </div>
          <p class="review-description">
            New comments are reviewed automatically in real time. Click "Request Review" to process existing open comments on demand.
          </p>
        </div>

        <!-- Review Content -->
        <div class="review-content">
          <div v-if="queuedCommentCount" class="queue-banner">
            <span class="queue-dot"></span>
            <span>{{ queuedCommentCount }} comment{{ queuedCommentCount === 1 ? '' : 's' }} queued</span>
          </div>

          <!-- Idle State -->
          <div v-if="reviewStatus === 'idle'" class="review-idle">
            <div class="review-instructions">
              <h3>How it works:</h3>
              <ol>
                <li>Select text in the document</li>
                <li>Add a comment with your instruction (e.g., "make this more formal")</li>
                <li>The agent automatically queues and reviews new comments in real time</li>
                <li>Or click "Request Review" below to process existing open comments</li>
                <li>The agent replies in the thread and applies a tracked revision</li>
              </ol>
            </div>
          </div>

          <!-- Reviewing State -->
          <div v-else-if="reviewStatus === 'reviewing'" class="review-progress">
            <div class="progress-header">
              <div class="spinner"></div>
              <span>Reviewing comments...</span>
            </div>

            <div v-if="reviewResult" class="progress-stats">
              <div class="stat">
                <span class="stat-value">{{ reviewResult.commentsFound }}</span>
                <span class="stat-label">Found</span>
              </div>
              <div class="stat">
                <span class="stat-value">{{ reviewResult.commentsProcessed }}</span>
                <span class="stat-label">Processed</span>
              </div>
            </div>

            <div v-if="reviewResult?.comments?.length" class="comment-list">
              <div
                v-for="comment in reviewResult.comments"
                :key="comment.commentId"
                class="comment-item"
                :class="comment.status"
              >
                <div class="comment-status-icon">
                  <span v-if="comment.status === 'pending'" class="status-pending">-</span>
                  <span v-else-if="comment.status === 'processing'" class="status-processing">...</span>
                  <span v-else-if="comment.status === 'done'" class="status-done">&#10003;</span>
                  <span v-else-if="comment.status === 'error'" class="status-error">&#10007;</span>
                </div>
                <div class="comment-info">
                  <div v-if="comment.status === 'pending' || comment.status === 'processing'" class="comment-queue-status">
                    {{ comment.status === 'pending' ? 'Queued' : comment.status === 'processing' ? 'Processing' : '' }}
                  </div>
                  <div class="comment-text">{{ comment.commentText || '(no text)' }}</div>
                  <div class="comment-anchor">On: "{{ comment.anchoredText?.substring(0, 40) }}{{ comment.anchoredText?.length > 40 ? '...' : '' }}"</div>
                  <div v-if="comment.error" class="comment-error">{{ comment.error }}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- Complete State -->
          <div v-else-if="reviewStatus === 'complete'" class="review-complete">
            <div class="complete-header">
              <svg class="complete-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
              <span>Review Complete</span>
            </div>

            <div v-if="reviewResult" class="complete-stats">
              <div class="stat">
                <span class="stat-value">{{ reviewResult.commentsProcessed }}</span>
                <span class="stat-label">Comments processed</span>
              </div>
            </div>

            <div v-if="reviewResult?.comments?.length" class="comment-list">
              <div
                v-for="comment in reviewResult.comments"
                :key="comment.commentId"
                class="comment-item"
                :class="comment.status"
              >
                <div class="comment-status-icon">
                  <span v-if="comment.status === 'done'" class="status-done">&#10003;</span>
                  <span v-else-if="comment.status === 'error'" class="status-error">&#10007;</span>
                </div>
                <div class="comment-info">
                  <div class="comment-text">{{ comment.commentText || '(no text)' }}</div>
                  <div v-if="comment.revisedText" class="comment-revised">
                    Changed to: "{{ comment.revisedText.substring(0, 50) }}{{ comment.revisedText.length > 50 ? '...' : '' }}"
                  </div>
                  <div v-if="comment.error" class="comment-error">{{ comment.error }}</div>
                </div>
              </div>
            </div>

            <button class="reset-btn" @click="resetReview">Review More Comments</button>
          </div>

          <!-- Error State -->
          <div v-else-if="reviewStatus === 'error'" class="review-error">
            <div class="error-header">
              <svg class="error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="15" y1="9" x2="9" y2="15"/>
                <line x1="9" y1="9" x2="15" y2="15"/>
              </svg>
              <span>Review Failed</span>
            </div>
            <p class="error-message">{{ reviewResult?.error || 'An unknown error occurred' }}</p>
            <button class="reset-btn" @click="resetReview">Try Again</button>
          </div>
        </div>

        <!-- Action Button -->
        <div class="review-action">
          <button
            class="review-btn"
            @click="requestReview()"
            :disabled="!documentReady || reviewStatus === 'reviewing'"
          >
            <svg v-if="reviewStatus !== 'reviewing'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
            <span v-if="reviewStatus === 'reviewing'">Reviewing...</span>
            <span v-else>Request Review</span>
          </button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #f5f5f5;
}

.app-wrapper {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #fff;
  overflow: hidden;
  position: relative;
}

.loading-overlay {
  position: absolute;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(248, 250, 252, 0.88);
  backdrop-filter: blur(2px);
}

.loading-card {
  display: flex;
  align-items: center;
  gap: 14px;
  max-width: 480px;
  padding: 20px 24px;
  border: 1px solid #dbeafe;
  border-radius: 12px;
  background: #fff;
  color: #1e293b;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.12);
}

/* Top Header */
.top-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 24px;
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.header-btn {
  width: 36px;
  height: 36px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f1f5f9;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  color: #64748b;
  cursor: pointer;
  transition: all 0.15s;
}

.header-btn svg {
  width: 18px;
  height: 18px;
}

.header-btn:hover {
  background: #e2e8f0;
  color: #1e293b;
}

.header-btn.with-text {
  width: auto;
  padding: 0 12px;
  gap: 6px;
  font-size: 0.875rem;
  font-weight: 500;
}

.logo {
  display: flex;
  align-items: center;
  gap: 8px;
}

.logo-img {
  width: 28px;
  height: 28px;
}

.logo-text {
  font-size: 1.25rem;
  font-weight: 600;
  color: #1e293b;
}

/* Main Content */
.main-content {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
}

/* Editor Area */
.editor-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: linear-gradient(135deg, #fdf2f8 0%, #ede9fe 50%, #dbeafe 100%);
  min-width: 0;
  overflow: hidden;
}

.editor-toolbar {
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
  padding: 8px 16px;
  flex-shrink: 0;
}

.editor-container {
  flex: 1;
  display: flex;
  justify-content: center;
  padding: 24px;
  overflow-y: auto;
  min-height: 0;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.editor-container::-webkit-scrollbar {
  display: none;
}

.main-editor {
  width: 100%;
  max-width: 850px;
}

#superdoc .superdoc {
  padding-bottom: 120px;
}

/* Review Sidebar */
.review-sidebar {
  width: 360px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-left: 1px solid #e5e7eb;
  overflow: hidden;
}

.review-header {
  padding: 16px 20px;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}

.review-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 1rem;
  font-weight: 600;
  color: #1e293b;
  margin-bottom: 8px;
}

.review-icon {
  width: 20px;
  height: 20px;
  color: #3b82f6;
}

.review-description {
  font-size: 0.85rem;
  color: #64748b;
  margin: 0;
  line-height: 1.5;
}

.version-pill {
  font-size: 0.75rem;
  color: #64748b;
  padding: 2px 8px;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  text-decoration: none;
  transition: all 0.15s;
}

.version-pill:hover {
  background: #f1f5f9;
  color: #3b82f6;
  border-color: #3b82f6;
}

/* Review Content */
.review-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  min-height: 0;
}

.queue-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 16px;
  color: #2563eb;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: 8px;
  font-size: 0.82rem;
  font-weight: 600;
}

.queue-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #3b82f6;
}

.review-idle .review-instructions {
  background: #f8fafc;
  border-radius: 8px;
  padding: 16px;
}

.review-instructions h3 {
  font-size: 0.9rem;
  font-weight: 600;
  color: #1e293b;
  margin: 0 0 12px 0;
}

.review-instructions ol {
  margin: 0;
  padding-left: 20px;
  font-size: 0.85rem;
  color: #64748b;
  line-height: 1.8;
}

/* Progress State */
.review-progress .progress-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  font-weight: 500;
  color: #3b82f6;
}

.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid #e5e7eb;
  border-top-color: #3b82f6;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.progress-stats, .complete-stats {
  display: flex;
  gap: 24px;
  margin-bottom: 16px;
}

.stat {
  display: flex;
  flex-direction: column;
}

.stat-value {
  font-size: 1.5rem;
  font-weight: 600;
  color: #1e293b;
}

.stat-label {
  font-size: 0.75rem;
  color: #64748b;
}

/* Comment List */
.comment-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.comment-item {
  display: flex;
  gap: 12px;
  padding: 12px;
  background: #f8fafc;
  border-radius: 8px;
  border-left: 3px solid #e5e7eb;
}

.comment-item.done {
  border-left-color: #22c55e;
}

.comment-item.error {
  border-left-color: #ef4444;
}

.comment-item.processing {
  border-left-color: #3b82f6;
}

.comment-queue-status {
  min-height: 1rem;
  margin-bottom: 2px;
  color: #3b82f6;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.comment-status-icon {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.status-pending {
  color: #9ca3af;
}

.status-processing {
  color: #3b82f6;
}

.status-done {
  color: #22c55e;
  font-weight: bold;
}

.status-error {
  color: #ef4444;
  font-weight: bold;
}

.comment-info {
  flex: 1;
  min-width: 0;
}

.comment-text {
  font-size: 0.875rem;
  font-weight: 500;
  color: #1e293b;
  margin-bottom: 4px;
}

.comment-anchor {
  font-size: 0.75rem;
  color: #64748b;
  font-style: italic;
}

.comment-revised {
  font-size: 0.75rem;
  color: #22c55e;
  margin-top: 4px;
}

.comment-error {
  font-size: 0.75rem;
  color: #ef4444;
  margin-top: 4px;
}

/* Complete State */
.complete-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  font-weight: 600;
  color: #22c55e;
}

.complete-icon {
  width: 24px;
  height: 24px;
}

/* Error State */
.review-error .error-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  font-weight: 600;
  color: #ef4444;
}

.error-icon {
  width: 24px;
  height: 24px;
}

.error-message {
  font-size: 0.875rem;
  color: #64748b;
  margin: 0 0 16px 0;
}

.reset-btn {
  width: 100%;
  padding: 10px;
  background: #f1f5f9;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  font-size: 0.875rem;
  color: #64748b;
  cursor: pointer;
  transition: all 0.15s;
  margin-top: 16px;
}

.reset-btn:hover {
  background: #e2e8f0;
  color: #1e293b;
}

/* Action Button */
.review-action {
  padding: 16px 20px;
  border-top: 1px solid #e5e7eb;
  flex-shrink: 0;
}

.review-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 20px;
  background: #3b82f6;
  border: none;
  border-radius: 8px;
  font-size: 0.95rem;
  font-weight: 500;
  color: white;
  cursor: pointer;
  transition: all 0.15s;
}

.review-btn svg {
  width: 20px;
  height: 20px;
}

.review-btn:hover:not(:disabled) {
  background: #2563eb;
}

.review-btn:disabled {
  background: #94a3b8;
  cursor: not-allowed;
}

/* Responsive */
@media (max-width: 900px) {
  .main-content {
    flex-direction: column;
  }

  .review-sidebar {
    width: 100%;
    max-height: 50vh;
    border-left: none;
    border-top: 1px solid #e5e7eb;
  }
}
</style>
