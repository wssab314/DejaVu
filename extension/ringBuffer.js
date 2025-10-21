const DEFAULT_MIME_TYPE = "video/webm;codecs=vp9";

export class BlobRingBuffer {
  constructor({ chunkDurationMs, maxDurationMs, mimeType } = {}) {
    this.chunkDurationMs = chunkDurationMs ?? 1000;
    const duration = maxDurationMs ?? 5 * 60 * 1000;
    const maxChunks = Math.ceil(duration / this.chunkDurationMs);
    this.maxChunks = Math.max(maxChunks, 1);
    this.defaultMimeType = mimeType ?? DEFAULT_MIME_TYPE;
    this.mimeType = this.defaultMimeType;
    this.chunks = [];
    this.bytes = 0;
  }

  push(blob) {
    if (!(blob instanceof Blob) || blob.size === 0) {
      return;
    }

    this.chunks.push(blob);
    this.bytes += blob.size;

    if (blob.type) {
      this.mimeType = blob.type;
    }

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
    this.mimeType = this.defaultMimeType;
  }

  setMimeType(mimeType) {
    if (typeof mimeType === "string" && mimeType.trim().length > 0) {
      this.mimeType = mimeType;
    }
  }

  toBlob() {
    const type = this.mimeType ?? this.defaultMimeType;
    const options = type ? { type } : undefined;
    return new Blob(this.chunks, options);
  }

  get length() {
    return this.chunks.length;
  }

  get estimatedDurationMs() {
    return this.length * this.chunkDurationMs;
  }
}
