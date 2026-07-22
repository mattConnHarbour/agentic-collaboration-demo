export class CommentReviewQueueController {
  // Configure comment detection, queue state callbacks, and debounce timing.
  constructor({
    getComments,
    isReviewing,
    onQueueCountChange,
    onReviewRequested,
    debounceMs = 500,
  }) {
    this.getComments = getComments;
    this.isReviewing = isReviewing;
    this.onQueueCountChange = onQueueCountChange;
    this.onReviewRequested = onReviewRequested;
    this.debounceMs = debounceMs;
    this.pendingCommentSignals = new Set();
    this.seenCommentKeys = new Set();
    this.armed = false;
    this.flushTimer = null;
    this.armTimer = null;
  }

  // Seed existing comments as seen and begin reacting to newly added comments.
  arm() {
    this.seenCommentKeys.clear();
    for (const comment of this.getComments() || []) {
      const commentKey = this.getCommentKey(comment);
      if (commentKey) this.seenCommentKeys.add(commentKey);
    }
    this.armed = true;
    console.log(`[Review] Real-time review armed with ${this.seenCommentKeys.size} existing comments ignored`);
  }

  // Return the stable identity used to deduplicate a comment event.
  getCommentKey(comment) {
    const values = typeof comment.getValues === 'function' ? comment.getValues() : comment;
    return values.commentId || values.id;
  }

  // Arm real-time review after an import or collaboration update settles.
  armAfterDelay(delayMs = this.debounceMs) {
    clearTimeout(this.armTimer);
    this.armTimer = setTimeout(() => this.arm(), delayMs);
  }

  // Temporarily ignore comment events while document state is being replaced.
  pause() {
    this.armed = false;
    clearTimeout(this.armTimer);
  }

  // Convert a new root-comment event into a deduplicated pending review signal.
  handleCommentsUpdate(payload) {
    const comment = payload?.comment;
    const commentKey = comment?.commentId || comment?.id;
    const wasSeen = commentKey && this.seenCommentKeys.has(commentKey);
    if (commentKey) this.seenCommentKeys.add(commentKey);

    if (
      !this.armed ||
      wasSeen ||
      payload?.type !== 'add' ||
      !commentKey ||
      comment.parentCommentId ||
      comment.creatorName === 'Agent'
    ) return;

    this.pendingCommentSignals.add(commentKey);
    this.onQueueCountChange(this.pendingCommentSignals.size);
    this.scheduleFlush();
  }

  // Debounce pending signals into a single server review request.
  scheduleFlush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), this.debounceMs);
  }

  // Consume pending signals and notify the server that review work may exist.
  async flush() {
    if (this.isReviewing() || this.pendingCommentSignals.size === 0) return;
    this.pendingCommentSignals.clear();
    this.onQueueCountChange(0);
    await this.onReviewRequested();
  }

  // Schedule another review when signals arrived during active processing.
  reviewSettled() {
    if (this.pendingCommentSignals.size) this.scheduleFlush();
  }

  // Cancel timers and release all controller-owned queue state.
  destroy() {
    clearTimeout(this.flushTimer);
    clearTimeout(this.armTimer);
    this.pendingCommentSignals.clear();
    this.seenCommentKeys.clear();
    this.onQueueCountChange(0);
  }
}
