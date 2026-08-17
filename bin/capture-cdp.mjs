export class TargetSessions {
  constructor(cdp) {
    this.cdp = cdp;
    this.sessions = new Map();
    this.detachDestroyed = cdp.on("Target.targetDestroyed", ({ targetId }) => {
      this.sessions.delete(targetId);
      for (const handler of this.destroyedHandlers || []) handler(targetId);
    });
    this.destroyedHandlers = new Set();
  }

  async ensure(targetId) {
    if (this.sessions.has(targetId)) return this.sessions.get(targetId);
    const result = await this.cdp.call("Target.attachToTarget", { targetId, flatten: true });
    if (!result.sessionId) throw new Error(`CDP did not return a session for ${targetId}`);
    const session = { targetId, sessionId: result.sessionId, viewportW: null, viewportH: null };
    this.sessions.set(targetId, session);
    await Promise.allSettled([
      this.cdp.call("Page.enable", {}, session.sessionId),
      this.cdp.call("Runtime.enable", {}, session.sessionId),
    ]);
    await this.updateViewport(targetId);
    return session;
  }

  get(targetId) {
    return this.sessions.get(targetId) || null;
  }

  onDestroyed(handler) {
    this.destroyedHandlers.add(handler);
    return () => this.destroyedHandlers.delete(handler);
  }

  async updateViewport(targetId) {
    const session = await this.ensure(targetId);
    try {
      const result = await this.cdp.call("Page.getLayoutMetrics", {}, session.sessionId);
      const viewport = result.cssLayoutViewport || result.cssViewport || {};
      if (Number.isFinite(viewport.clientWidth ?? viewport.width)) session.viewportW = viewport.clientWidth ?? viewport.width;
      if (Number.isFinite(viewport.clientHeight ?? viewport.height)) session.viewportH = viewport.clientHeight ?? viewport.height;
    } catch {}
    return session;
  }

  async call(targetId, method, params = {}, timeoutMs = 6000) {
    const session = await this.ensure(targetId);
    return this.cdp.call(method, params, session.sessionId, timeoutMs);
  }

  async sendInput(targetId, payload) {
    const { type, x, y, button = "left", buttons = 0, deltaX = 0, deltaY = 0, clickCount = 0, modifiers = 0 } = payload || {};
    if (type === "mouseMoved") {
      await this.call(targetId, "Input.dispatchMouseEvent", { type, x, y, buttons });
    } else if (type === "mousePressed" || type === "mouseReleased") {
      await this.call(targetId, "Input.dispatchMouseEvent", { type, x, y, button, buttons, clickCount, modifiers });
    } else if (type === "mouseWheel") {
      await this.call(targetId, "Input.dispatchMouseEvent", { type, x, y, deltaX, deltaY });
    } else {
      return { ok: false, error: `unsupported input type: ${type}` };
    }
    return { ok: true };
  }

  async dispose() {
    this.detachDestroyed?.();
    const current = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(current.map((session) =>
      this.cdp.call("Target.detachFromTarget", { sessionId: session.sessionId }),
    ));
  }
}

export class CdpCaptureBackend {
  constructor({ cdp, sessions, getConfig, onStatus, onJpegFrame, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.cdp = cdp;
    this.sessions = sessions;
    this.getConfig = getConfig;
    this.onStatus = onStatus;
    this.onJpegFrame = onJpegFrame;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.current = null;
    this.pendingFrame = null;
    this.sendTimer = null;
    this.backstopTimer = null;
    this.metrics = { sourceFrames: 0, sentFrames: 0, droppedFrames: 0, ackErrors: 0 };
    this.offFrame = cdp.on("Page.screencastFrame", (params, targetSessionId) => this.#onFrame(params, targetSessionId));
    this.offDestroyed = sessions.onDestroyed?.((targetId) => {
      if (this.current?.targetId !== targetId) return;
      this.stop("target-destroyed").then(() => this.onStatus({ backend: "cdp", state: "failed", targetId, code: "capture-target-destroyed", message: "The watched target was closed" })).catch(() => {});
    });
  }

  async start({ targetId }) {
    await this.stop("restart");
    const session = await this.sessions.ensure(targetId);
    const config = this.getConfig();
    this.current = { targetId, sessionId: session.sessionId, lastFrameAt: 0, startedAt: this.now() };
    this.onStatus({ backend: "cdp", state: "starting", targetId });
    try {
      await this.cdp.call("Page.startScreencast", {
        format: "jpeg",
        quality: config.cdpQuality,
        maxWidth: config.cdpMaxWidth,
        everyNthFrame: 1,
      }, session.sessionId);
      this.onStatus({ backend: "cdp", state: "streaming", targetId, metrics: this.metrics });
      this.#scheduleBackstop();
    } catch (error) {
      this.current = null;
      this.onStatus({ backend: "cdp", state: "failed", targetId, code: "cdp-start-failed", message: error.message });
      throw error;
    }
  }

  async switchTarget({ targetId }) {
    this.onStatus({ backend: "cdp", state: "switching", targetId });
    await this.start({ targetId });
  }

  async updateConfig() {
    if (this.current) await this.start({ targetId: this.current.targetId });
  }

  async stop(reason = "stopped") {
    this.clearTimer(this.sendTimer);
    this.clearTimer(this.backstopTimer);
    this.sendTimer = null;
    this.backstopTimer = null;
    this.pendingFrame = null;
    const current = this.current;
    this.current = null;
    if (current) {
      await this.cdp.call("Page.stopScreencast", {}, current.sessionId).catch(() => {});
      this.onStatus({ backend: "cdp", state: "idle", targetId: null, message: reason, metrics: this.metrics });
    }
  }

  status() {
    return { backend: "cdp", state: this.current ? "streaming" : "idle", targetId: this.current?.targetId || null, metrics: { ...this.metrics } };
  }

  dispose() {
    this.offFrame?.();
    this.offFrame = null;
    this.offDestroyed?.();
    this.offDestroyed = null;
  }

  async #onFrame(params, targetSessionId) {
    const current = this.current;
    if (!current || current.sessionId !== targetSessionId) return;
    this.metrics.sourceFrames += 1;
    if (params.sessionId === undefined || params.sessionId === null) {
      this.metrics.ackErrors += 1;
    } else {
      this.cdp.call("Page.screencastFrameAck", { sessionId: params.sessionId }, targetSessionId).catch((error) => {
        this.metrics.ackErrors += 1;
        this.onStatus({ backend: "cdp", state: "streaming", targetId: current.targetId, code: "cdp-ack-failed", message: error.message, metrics: this.metrics });
      });
    }
    if (!params.data) return;
    const metadata = params.metadata || {};
    const session = this.sessions.get(current.targetId);
    if (session) {
      if (Number.isFinite(metadata.visibleViewportWidth)) session.viewportW = metadata.visibleViewportWidth;
      if (Number.isFinite(metadata.visibleViewportHeight)) session.viewportH = metadata.visibleViewportHeight;
    }
    this.pendingFrame = {
      targetId: current.targetId,
      data: params.data,
      vw: session?.viewportW || null,
      vh: session?.viewportH || null,
      ts: this.now(),
    };
    current.lastFrameAt = this.now();
    const minGap = 1000 / this.getConfig().cdpFps;
    const delay = Math.max(0, minGap - (this.now() - (this.lastSentAt || 0)));
    if (delay === 0) this.#flushLatest();
    else if (!this.sendTimer) this.sendTimer = this.setTimer(() => this.#flushLatest(), delay);
    if (delay > 0) this.metrics.droppedFrames += 1;
  }

  #flushLatest() {
    this.sendTimer = null;
    const frame = this.pendingFrame;
    this.pendingFrame = null;
    if (!frame || !this.current || frame.targetId !== this.current.targetId) return;
    this.lastSentAt = this.now();
    this.metrics.sentFrames += 1;
    this.onJpegFrame(frame);
  }

  #scheduleBackstop() {
    this.clearTimer(this.backstopTimer);
    const interval = this.getConfig().cdpBackstopIntervalMs;
    this.backstopTimer = this.setTimer(async () => {
      const current = this.current;
      if (!current) return;
      if (this.now() - current.lastFrameAt >= interval) {
        try {
          const session = await this.sessions.updateViewport(current.targetId);
          const scale = session.viewportW > this.getConfig().cdpMaxWidth ? this.getConfig().cdpMaxWidth / session.viewportW : 1;
          const result = await this.cdp.call("Page.captureScreenshot", {
            format: "jpeg",
            quality: this.getConfig().cdpQuality,
            captureBeyondViewport: false,
            ...(session.viewportW && session.viewportH ? { clip: { x: 0, y: 0, width: session.viewportW, height: session.viewportH, scale } } : {}),
          }, current.sessionId);
          if (result.data) this.onJpegFrame({ targetId: current.targetId, data: result.data, vw: session.viewportW, vh: session.viewportH, ts: this.now(), backstop: true });
        } catch {}
      }
      this.#scheduleBackstop();
    }, interval);
  }
}
