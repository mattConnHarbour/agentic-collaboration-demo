export class CommentReviewController {
  // Configure the backend endpoint and polling limits.
  constructor(backendUrl, { pollInterval = 1000, maxAttempts = 120 } = {}) {
    this.backendUrl = backendUrl;
    this.pollInterval = pollInterval;
    this.maxAttempts = maxAttempts;
    this.destroyed = false;
  }

  // Create a review job and wait for its final result.
  async review({ documentId, onProgress }) {
    if (this.destroyed) throw new Error('CommentReviewController has been destroyed');

    const { jobId } = await this.fetchJson('/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId }),
    });

    console.log(`[Review] Job created: ${jobId}`);
    return this.poll(jobId, onProgress);
  }

  // Fetch backend health and version information.
  health() {
    return this.fetchJson('/health');
  }

  // Poll a review job and publish each available progress update.
  async poll(jobId, onProgress) {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (this.destroyed) throw new Error('Comment review cancelled');

      const job = await this.fetchJson(`/review/jobs/${jobId}`);
      console.log(`[Review] Poll #${attempt}: ${job.status}`);

      if (job.result) onProgress?.(job.result);
      if (job.status === 'complete') return job.result;
      if (job.status === 'error') {
        throw new Error(job.result?.error || 'Review failed');
      }

      await new Promise(resolve => setTimeout(resolve, this.pollInterval));
    }

    throw new Error('Review timed out');
  }

  // Fetch and validate a JSON response from the configured backend.
  async fetchJson(path, options) {
    const response = await fetch(`${this.backendUrl}${path}`, options);
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || `Request failed: ${response.status}`);
    return data;
  }

  // Prevent new work and stop active polling at its next iteration.
  destroy() {
    this.destroyed = true;
  }
}
