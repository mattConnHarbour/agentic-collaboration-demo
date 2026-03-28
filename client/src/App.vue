<script setup>
import 'superdoc/style.css';
import { onMounted, onBeforeUnmount, shallowRef, ref, nextTick } from 'vue';
import { SuperDoc } from 'superdoc';

import sampleDocument from '/sample-document.docx?url';

// Backend URL: use VITE_BACKEND_URL env var, or fall back to localhost for dev
const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3050';
const wsUrl = backendUrl.replace(/^http/, 'ws');
const COLLAB_URL = `${wsUrl}/collaboration`;

// Room ID generation
const ADJECTIVES = ['swift', 'brave', 'clever', 'mighty', 'gentle', 'fierce', 'calm', 'bold', 'wise', 'quick'];
const ANIMALS = ['fox', 'owl', 'bear', 'wolf', 'eagle', 'tiger', 'otter', 'raven', 'falcon', 'panda'];

const generateRoomId = () => {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const num = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  return `${adj}-${animal}-${num}`;
};

const getOrCreateRoomId = () => {
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');

  if (roomParam) {
    return roomParam;
  }

  // Generate a random room ID
  const newRoomId = generateRoomId();

  // Update URL without reload
  const url = new URL(window.location.href);
  url.searchParams.set('room', newRoomId);
  window.history.replaceState({}, '', url.toString());

  return newRoomId;
};

const roomId = ref(getOrCreateRoomId());
const roomCopied = ref(false);

// Generate a unique session ID for this browser session
const SESSION_ID = crypto.randomUUID();

const superdoc = shallowRef(null);

// Chat state
const chatMessages = ref([]);
const chatInput = ref('');
const agentStatus = ref('ready');
const currentToolCalls = ref([]);
const chatContainer = ref(null);

const USER_COLORS = ['#a11134', '#2a7e34', '#b29d11', '#2f4597', '#ab5b22'];

// Truncate text for logging
const truncate = (text, max = 60) => text?.length > max ? text.slice(0, max) + '...' : text;

// Hash string to consistent color
const hashToColor = (str) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 90%)`;
};

const toolColor = (name) => ({ backgroundColor: hashToColor(name) });

const initSuperDoc = () => {
  console.log('[Client] Initializing SuperDoc for room:', roomId.value);

  superdoc.value = new SuperDoc({
    selector: '#superdoc',
    toolbar: '#superdoc-toolbar',
    toolbarGroups: ['center'],
    document: {
      id: roomId.value,
      type: 'docx',
      url: sampleDocument,
    },
    layoutEngineOptions: {
      flowMode: 'semantic',
    },
    colors: USER_COLORS,
    user: generateUserInfo(),
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

// Poll for job completion
const pollForResult = async (jobId) => {
  const pollInterval = 1000; // 1 second
  const maxAttempts = 120; // 2 minutes max

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${backendUrl}/chat/jobs/${jobId}`);
      const job = await response.json();

      console.log(`[Chat] Poll #${i + 1}: ${job.status}${job.toolCalls?.length ? ` (${job.toolCalls.length} tools)` : ''}`);

      // Update status based on job state
      if (job.status === 'pending') {
        agentStatus.value = 'thinking';
      } else if (job.status === 'processing') {
        agentStatus.value = 'working';
      }

      // Update tool calls
      if (job.toolCalls?.length) {
        currentToolCalls.value = job.toolCalls;
        scrollToBottom();
      }

      if (job.status === 'complete') {
        console.log(`[Chat] Result: ${truncate(job.result)}`);
        return { result: job.result, toolCalls: job.toolCalls || [] };
      } else if (job.status === 'error') {
        console.log(`[Chat] Error: ${truncate(job.error)}`);
        throw new Error(job.error || 'Unknown error');
      }

      // Still processing, wait and try again
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } catch (e) {
      console.error('[Chat] Poll failed:', e);
      throw e;
    }
  }

  throw new Error('Request timed out');
};

const sendMessage = async (content) => {
  const text = content || chatInput.value.trim();
  if (!text || agentStatus.value === 'thinking') return;

  // Add user message to chat
  const userMessage = {
    id: `user-${Date.now()}`,
    role: 'user',
    content: text,
    timestamp: Date.now(),
  };
  chatMessages.value.push(userMessage);
  chatInput.value = '';
  scrollToBottom();

  // Set status to thinking and clear tool calls
  agentStatus.value = 'thinking';
  currentToolCalls.value = [];

  try {
    console.log(`[Chat] Sending: ${truncate(text)}`);

    // Submit chat job
    const response = await fetch(`${backendUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        documentId: roomId.value,
        prompt: text,
      }),
    });

    const { jobId, error } = await response.json();
    if (error) throw new Error(error);

    console.log(`[Chat] Job created: ${jobId}`);

    // Poll for result
    const { result, toolCalls } = await pollForResult(jobId);

    // Add assistant message to chat
    const assistantMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: result,
      toolCalls: toolCalls,
      timestamp: Date.now(),
    };
    chatMessages.value.push(assistantMessage);
    scrollToBottom();
  } catch (e) {
    console.error('[Client] Chat error:', e);
    // Add error message to chat
    chatMessages.value.push({
      id: `error-${Date.now()}`,
      role: 'assistant',
      content: `Error: ${e.message}`,
      timestamp: Date.now(),
    });
    scrollToBottom();
  } finally {
    agentStatus.value = 'ready';
    currentToolCalls.value = [];
  }
};

const handleKeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
};

const scrollToBottom = () => {
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
    }
  });
};

const generateUserInfo = () => {
  const randomUser = Math.random().toString(36).substring(2, 8);
  return {
    name: `User-${randomUser}`,
    email: `${randomUser}@superdoc.dev`,
    color: getRandomUserColor(),
  };
};

const getRandomUserColor = () => {
  const index = Math.floor(Math.random() * USER_COLORS.length);
  return USER_COLORS[index];
};

const formatTime = (timestamp) => {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

// File input ref for import
const fileInput = ref(null);

const handleImport = () => {
  fileInput.value?.click();
};

const onFileSelected = async (event) => {
  const file = event.target.files?.[0];
  if (!file || !superdoc.value) return;

  try {
    await superdoc.value.activeEditor.replaceFile(file);
    console.log('[Client] Document imported:', file.name);
  } catch (e) {
    console.error('[Client] Import failed:', e);
  }

  // Reset input so same file can be selected again
  event.target.value = '';
};

const handleExport = async () => {
  if (!superdoc.value) return;

  try {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const filename = `SuperDoc-${pad(now.getMonth() + 1)}:${pad(now.getDate())}:${String(now.getFullYear()).slice(-2)}-${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
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

onMounted(() => {
  initSuperDoc();
});

onBeforeUnmount(() => {
  superdoc.value?.destroy();
  superdoc.value = null;
});
</script>

<template>
  <div class="app-wrapper">
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

      <!-- Agent Sidebar -->
      <aside class="agent-sidebar">
        <div class="agent-header">
          <div class="agent-title">
            <svg class="agent-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
            <span>Document Agent</span>
          </div>
          <div class="agent-status" :class="agentStatus">
            <span class="status-dot"></span>
            <span>{{ agentStatus === 'thinking' ? 'Thinking...' : agentStatus === 'working' ? 'Working...' : agentStatus === 'ready' ? 'Ready' : 'Offline' }}</span>
          </div>
        </div>

        <!-- Chat Messages -->
        <div class="chat-messages" ref="chatContainer">
          <div
            v-for="msg in chatMessages"
            :key="msg.id"
            class="chat-message"
            :class="msg.role"
          >
            <div class="message-avatar">
              <div v-if="msg.role === 'user'" class="avatar user-avatar">
                <svg viewBox="0 0 640 640" fill="currentColor">
                  <path d="M320 312C386.3 312 440 258.3 440 192C440 125.7 386.3 72 320 72C253.7 72 200 125.7 200 192C200 258.3 253.7 312 320 312zM290.3 368C191.8 368 112 447.8 112 546.3C112 562.7 125.3 576 141.7 576L498.3 576C514.7 576 528 562.7 528 546.3C528 447.8 448.2 368 349.7 368L290.3 368z"/>
                </svg>
              </div>
              <div v-else class="avatar agent-avatar">
                <svg viewBox="0 0 640 640" fill="currentColor">
                  <path d="M320 312C386.3 312 440 258.3 440 192C440 125.7 386.3 72 320 72C253.7 72 200 125.7 200 192C200 258.3 253.7 312 320 312zM290.3 368C191.8 368 112 447.8 112 546.3C112 562.7 125.3 576 141.7 576L498.3 576C514.7 576 528 562.7 528 546.3C528 447.8 448.2 368 349.7 368L290.3 368z"/>
                </svg>
              </div>
            </div>
            <div class="message-body">
              <div class="message-header">
                <span class="message-name">{{ msg.role === 'user' ? 'You' : 'Agent' }}</span>
                <span class="message-time">{{ formatTime(msg.timestamp) }}</span>
              </div>
              <div v-if="msg.toolCalls?.length" class="tool-calls">
                <div v-for="(tool, idx) in msg.toolCalls" :key="idx" class="tool-call" :style="toolColor(tool.name)">
                  {{ tool.name }}
                </div>
              </div>
              <div class="message-content">{{ msg.content }}</div>
            </div>
          </div>

          <!-- Status indicator -->
          <div v-if="agentStatus === 'thinking' || agentStatus === 'working'" class="chat-message assistant typing">
            <div class="message-avatar">
              <div class="avatar agent-avatar">
                <svg viewBox="0 0 640 640" fill="currentColor">
                  <path d="M320 312C386.3 312 440 258.3 440 192C440 125.7 386.3 72 320 72C253.7 72 200 125.7 200 192C200 258.3 253.7 312 320 312zM290.3 368C191.8 368 112 447.8 112 546.3C112 562.7 125.3 576 141.7 576L498.3 576C514.7 576 528 562.7 528 546.3C528 447.8 448.2 368 349.7 368L290.3 368z"/>
                </svg>
              </div>
            </div>
            <div class="message-body">
              <div class="message-header">
                <span class="message-name">Agent</span>
                <span class="typing-indicator">{{ agentStatus === 'thinking' ? 'thinking...' : 'working...' }}</span>
              </div>
              <!-- Tool calls -->
              <div v-if="currentToolCalls.length" class="tool-calls">
                <div v-for="(tool, idx) in currentToolCalls" :key="idx" class="tool-call" :style="toolColor(tool.name)">
                  {{ tool.name }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Chat Input -->
        <div class="chat-input-area">
          <input
            type="text"
            v-model="chatInput"
            @keydown="handleKeydown"
            placeholder="Ask the agent..."
            :disabled="agentStatus !== 'ready'"
          />
          <button
            class="send-btn"
            @click="sendMessage()"
            :disabled="!chatInput.trim() || agentStatus !== 'ready'"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
            </svg>
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

.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8rem;
  font-weight: 600;
  color: white;
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

/* Agent Sidebar */
.agent-sidebar {
  width: 360px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-left: 1px solid #e5e7eb;
  overflow: hidden;
}

.agent-header {
  padding: 16px 20px;
  border-bottom: 1px solid #e5e7eb;
  flex-shrink: 0;
}

.agent-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 1rem;
  font-weight: 600;
  color: #1e293b;
  margin-bottom: 6px;
}

.agent-icon {
  width: 20px;
  height: 20px;
  color: #3b82f6;
}

.agent-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
  color: #64748b;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #9ca3af;
}

.agent-status.ready .status-dot {
  background: #22c55e;
}

.agent-status.thinking .status-dot {
  background: #f59e0b;
  animation: pulse 1.5s ease-in-out infinite;
}

.agent-status.working .status-dot {
  background: #3b82f6;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* Chat Messages */
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  min-height: 0;
}

.chat-message {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.message-avatar .avatar {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
}

.user-avatar {
  background: #3b82f6;
  color: white;
}

.user-avatar svg {
  width: 18px;
  height: 18px;
}

.agent-avatar {
  background: #f1f5f9;
  color: #3b82f6;
}

.agent-avatar svg {
  width: 18px;
  height: 18px;
}

.message-body {
  flex: 1;
  min-width: 0;
}

.message-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.message-name {
  font-size: 0.875rem;
  font-weight: 600;
  color: #1e293b;
}

.message-time {
  font-size: 0.75rem;
  color: #9ca3af;
}

.typing-indicator {
  font-size: 0.8rem;
  color: #3b82f6;
  font-style: italic;
}

.tool-calls {
  margin: 8px 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tool-call {
  font-size: 0.75rem;
  color: #374151;
  padding: 2px 8px;
  border-radius: 4px;
  font-family: monospace;
}


.message-content {
  font-size: 0.9rem;
  color: #374151;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-message.user .message-content {
  background: #eff6ff;
  padding: 10px 14px;
  border-radius: 12px;
  border-top-left-radius: 4px;
}

.chat-message.assistant .message-content {
  background: #f8fafc;
  padding: 10px 14px;
  border-radius: 12px;
  border-top-left-radius: 4px;
}

/* Chat Input */
.chat-input-area {
  display: flex;
  gap: 8px;
  padding: 16px;
  border-top: 1px solid #e5e7eb;
  background: #fff;
  flex-shrink: 0;
}

.chat-input-area input {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  font-size: 0.9rem;
  color: #1e293b;
  background: #f9fafb;
  transition: all 0.15s;
}

.chat-input-area input::placeholder {
  color: #9ca3af;
}

.chat-input-area input:focus {
  outline: none;
  border-color: #3b82f6;
  background: #fff;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.chat-input-area input:disabled {
  background: #f1f5f9;
  color: #9ca3af;
}

.send-btn {
  width: 40px;
  height: 40px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #3b82f6;
  border: none;
  border-radius: 8px;
  color: white;
  cursor: pointer;
  transition: all 0.15s;
}

.send-btn svg {
  width: 18px;
  height: 18px;
}

.send-btn:hover:not(:disabled) {
  background: #2563eb;
}

.send-btn:disabled {
  background: #cbd5e1;
  cursor: not-allowed;
}

/* Responsive */
@media (max-width: 900px) {
  .main-content {
    flex-direction: column;
  }

  .agent-sidebar {
    width: 100%;
    max-height: 50vh;
    border-left: none;
    border-top: 1px solid #e5e7eb;
  }
}
</style>
