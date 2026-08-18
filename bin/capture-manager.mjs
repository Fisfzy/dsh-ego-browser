export class CaptureManager {
  constructor({ backendFactories, getConfig, onStatus, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, leaseTtlMs = 120000, idleGraceMs = 1500 }) {
    this.backendFactories = backendFactories;
    this.getConfig = getConfig;
    this.onStatus = onStatus;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.leaseTtlMs = leaseTtlMs;
    this.idleGraceMs = idleGraceMs;
    this.leases = new Map();
    this.backend = null;
    this.backendName = null;
    this.targetId = null;
    this.generation = 0;
    const fallbackReason = this.getConfig().ffmpegFallbackReason;
    this.statusValue = { backend: this.#resolvedBackend(), state: "idle", targetId: null, generation: 0, ...(fallbackReason ? { code: "ffmpeg-fallback-cdp", message: fallbackReason } : {}) };
    this.transition = Promise.resolve();
    this.stopTimer = null;
    this.sweepTimer = this.setTimer(() => this.#sweep(), Math.min(5000, leaseTtlMs));
  }

  #resolvedBackend(requested) {
    const value = requested || this.getConfig().captureBackend;
    return value === "auto" ? "cdp" : value;
  }

  async startWatch({ clientId, backend, targetId }) {
    if (!clientId || !targetId) throw new Error("clientId and targetId are required");
    this.clearTimer(this.stopTimer);
    this.stopTimer = null;
    const requestedBackend = backend || this.getConfig().captureBackend;
    const existing = this.leases.get(clientId);
    this.leases.set(clientId, { clientId, backend: requestedBackend, targetId, expiresAt: this.now() + this.leaseTtlMs });
    if (existing && existing.backend === requestedBackend && existing.targetId === targetId) {
      const resolved = this.#resolvedBackend(requestedBackend);
      if (this.targetId !== targetId || (this.backendName && this.backendName !== resolved)) return this.status();
      if (this.backend && this.backendName === resolved) return this.status();
    }
    return this.#enqueue(async () => { await this.#activate(this.#resolvedBackend(backend), targetId); return this.status(); });
  }

  async switchWatch({ clientId, targetId }) {
    const lease = this.leases.get(clientId);
    if (!lease) throw new Error("watch lease not found");
    lease.targetId = targetId;
    lease.expiresAt = this.now() + this.leaseTtlMs;
    return this.#enqueue(async () => { await this.#activate(this.#resolvedBackend(lease.backend), targetId); return this.status(); });
  }

  async stopWatch({ clientId }) {
    this.leases.delete(clientId);
    if (this.leases.size === 0 && !this.stopTimer) {
      this.stopTimer = this.setTimer(() => {
        this.stopTimer = null;
        if (this.leases.size === 0) this.stop("no-watchers").catch(() => {});
      }, this.idleGraceMs);
    }
    return this.status();
  }

  async updateConfig() {
    const desired = this.#resolvedBackend();
    if (!this.backend) {
      const lease = [...this.leases.values()].sort((a, b) => b.expiresAt - a.expiresAt)[0];
      if (lease) return this.#enqueue(() => this.#activate(this.#resolvedBackend(lease.backend), lease.targetId, true));
      const fallbackReason = this.getConfig().ffmpegFallbackReason;
      this.#setStatus({ backend: desired, state: "idle", targetId: null, code: fallbackReason ? "ffmpeg-fallback-cdp" : null, message: fallbackReason || "config-updated" });
      return;
    }
    return this.#enqueue(() => this.#activate(desired, this.targetId, true));
  }

  async browserDisconnected() {
    return this.#enqueue(async () => {
      await this.#stopBackend("browser-disconnected");
      this.#setStatus({ backend: this.#resolvedBackend(), state: "failed", targetId: null, code: "browser-disconnected", message: "Browser disconnected" });
    });
  }

  async browserConnected() {
    const lease = [...this.leases.values()].sort((a, b) => b.expiresAt - a.expiresAt)[0];
    if (lease) return this.#enqueue(() => this.#activate(this.#resolvedBackend(lease.backend), lease.targetId));
  }

  async #activate(backendName, targetId, force = false) {
    if (!force && this.backend && this.backendName === backendName && this.targetId === targetId) return;
    await this.#stopBackend("backend-change");
    const factory = this.backendFactories[backendName];
    if (!factory) {
      const message = `${backendName} backend is unavailable`;
      this.#setStatus({ backend: backendName, state: "failed", targetId, code: "capture-backend-unavailable", message });
      if (backendName === "ffmpeg" && this.backendFactories.cdp) {
        await this.#activate("cdp", targetId, true);
        if (this.backend && this.backendName === "cdp") this.#setStatus({ backend: "cdp", code: "ffmpeg-fallback-cdp", message: `FFmpeg unavailable; using CDP: ${message}` });
      }
      return;
    }
    try {
      this.backendName = backendName;
      this.targetId = targetId;
      this.generation += 1;
      const generation = this.generation;
      const fallbackReason = backendName === "cdp" ? this.getConfig().ffmpegFallbackReason : null;
      this.#setStatus({ backend: backendName, state: "starting", targetId, generation, code: fallbackReason ? "ffmpeg-fallback-cdp" : null, message: fallbackReason || null });
      let candidate;
      candidate = factory({ generation, onStatus: (status) => {
        if (this.backend !== candidate || this.generation !== generation) return;
        this.#setStatus({ ...status, generation });
      } });
      this.backend = candidate;
      await candidate.start({ targetId, generation });
    } catch (error) {
      const failed = this.backend;
      this.backend = null;
      if (failed) {
        await failed.stop?.("start-failed").catch(() => {});
        await failed.dispose?.().catch(() => {});
      }
      this.#setStatus({ backend: backendName, state: "failed", targetId, generation: this.generation, code: error.code, message: error.message });
      if (backendName === "ffmpeg" && this.backendFactories.cdp) {
        await this.#activate("cdp", targetId, true);
        if (this.backend && this.backendName === "cdp") this.#setStatus({ backend: "cdp", code: "ffmpeg-fallback-cdp", message: `FFmpeg unavailable; using CDP: ${error.message}` });
      }
    }
  }

  async #stopBackend(reason = "stopped") {
    const backend = this.backend;
    this.backend = null;
    this.backendName = null;
    this.targetId = null;
    if (backend) {
      await backend.stop(reason);
      await backend.dispose?.();
    }
    this.#setStatus({ backend: this.#resolvedBackend(), state: "idle", targetId: null, generation: this.generation, message: reason });
  }

  stop(reason = "stopped") {
    return this.#enqueue(() => this.#stopBackend(reason));
  }

  #enqueue(work) {
    const run = this.transition.then(work, work);
    this.transition = run.catch(() => {});
    return run;
  }

  status() {
    return { ...this.statusValue, watchers: this.leases.size };
  }

  #setStatus(status) {
    this.statusValue = { ...this.statusValue, ...status };
    this.onStatus(this.status());
  }

  #sweep() {
    const now = this.now();
    for (const [clientId, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(clientId);
    if (this.leases.size === 0 && this.backend) this.stop("lease-expired").catch(() => {});
    this.sweepTimer = this.setTimer(() => this.#sweep(), Math.min(5000, this.leaseTtlMs));
  }

  async dispose() {
    this.clearTimer(this.stopTimer);
    this.clearTimer(this.sweepTimer);
    this.leases.clear();
    await this.stop("disposed");
  }
}
