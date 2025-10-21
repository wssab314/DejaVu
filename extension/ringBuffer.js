const DEFAULT_MIME_TYPE = "video/webm;codecs=vp9";

export class BlobRingBuffer {
  constructor({ chunkDurationMs, maxDurationMs, mimeType } = {}) {
    this.chunkDurationMs = chunkDurationMs ?? 1000;
    const duration = maxDurationMs ?? 5 * 60 * 1000;
    const maxChunks = Math.ceil(duration / this.chunkDurationMs);
    this.maxChunks = Math.max(maxChunks, 1);
    this.mimeType = mimeType ?? DEFAULT_MIME_TYPE;
    this.chunks = [];
    this.bytes = 0;
  }

  push(blob) {
    if (!(blob instanceof Blob) || blob.size === 0) {
      return;
    }

    this.chunks.push(blob);
    this.bytes += blob.size;

    while (this.chunks.length > this.maxChunks) {
      const removed = this.chunks.shift();
      if (removed) {
        this.bytes = Math.max(0, this.bytes - removed.size);
      }
    }
  }

  clear() {
    this.chunks = [];
    this.bytes = 0;
  }

  toBlob() {
    return new Blob(this.chunks, { type: this.mimeType });
  }

  get length() {
    return this.chunks.length;
  }

  get estimatedDurationMs() {
    return this.length * this.chunkDurationMs;
  }
}
