import * as vscode from "vscode";
import { TcpSession, type TcpSessionEvent } from "./tcpSession";

export interface ConnectionSnapshot {
  connected: boolean;
  status: string;
  protocol: string;
  colorDepth: string;
  autoProtocol: string;
  autoColorDepth: string;
  bandwidthBps: number;
  updatesPerSecond: number;
  avgFrameMs: number;
  avgWorkerDecodeMs: number;
  avgBlitMs: number;
  latencyMs: number;
  fps: number;
  bottleneckHint: "server-limited" | "client-limited" | "balanced";
  inflateBackend?: "wasm" | "fflate";
  workerFallbackActive: boolean;
  lastUpdated: number;
}

export interface PanelSessionState {
  panel: vscode.WebviewPanel;
  claimedEndpointKey: string | null;
  activeThumbnailPath: string | null;
  thumbnailVersion: number;
}

interface ManagedPanelConnection {
  panelState: PanelSessionState;
  endpointId?: string;
  snapshotKey: string;
  activeSession: TcpSession | null;
}

interface ConnectionManagerOptions {
  refreshAll: () => void;
  updateBadge: (activeCount: number) => void;
  revealClaimedPanel: (state: PanelSessionState, endpointKey: string) => boolean;
  postToPanel: (panel: vscode.WebviewPanel, message: unknown, contextLabel: string) => void;
  logDebug: (msg: string) => void;
  logError: (msg: string) => void;
}

export class ConnectionManager {
  private readonly snapshots = new Map<string, ConnectionSnapshot>();
  private readonly pendingRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly claimedPanelsByEndpoint = new Map<string, PanelSessionState>();
  private readonly panels = new Map<PanelSessionState, ManagedPanelConnection>();

  constructor(private readonly options: ConnectionManagerOptions) {}

  getSnapshot(snapshotKey: string): ConnectionSnapshot | undefined {
    return this.snapshots.get(snapshotKey);
  }

  getActiveConnectionCount(): number {
    let activeCount = 0;
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.connected) activeCount += 1;
    }
    return activeCount;
  }

  getClaimedPanel(endpointKey: string): PanelSessionState | undefined {
    return this.claimedPanelsByEndpoint.get(endpointKey);
  }

  registerPanel(panelState: PanelSessionState, endpointId: string | undefined, snapshotKey: string): void {
    this.panels.set(panelState, {
      panelState,
      endpointId,
      snapshotKey,
      activeSession: null,
    });
  }

  setSnapshotKey(panelState: PanelSessionState, snapshotKey: string): void {
    const record = this.panels.get(panelState);
    if (!record || record.snapshotKey === snapshotKey) return;
    if (!record.endpointId) {
      const previous = this.snapshots.get(record.snapshotKey);
      this.snapshots.delete(record.snapshotKey);
      if (previous?.connected) {
        this.emitBadge();
      }
    }
    record.snapshotKey = snapshotKey;
  }

  claim(panelState: PanelSessionState, endpointKey: string): boolean {
    const existing = this.claimedPanelsByEndpoint.get(endpointKey);
    if (existing && existing !== panelState) {
      this.options.revealClaimedPanel(existing, endpointKey);
      return false;
    }
    if (panelState.claimedEndpointKey === endpointKey) {
      return true;
    }
    this.releaseClaim(panelState);
    panelState.claimedEndpointKey = endpointKey;
    this.claimedPanelsByEndpoint.set(endpointKey, panelState);
    return true;
  }

  releaseClaim(panelState: PanelSessionState): void {
    if (!panelState.claimedEndpointKey) return;
    if (this.claimedPanelsByEndpoint.get(panelState.claimedEndpointKey) === panelState) {
      this.claimedPanelsByEndpoint.delete(panelState.claimedEndpointKey);
    }
    panelState.claimedEndpointKey = null;
  }

  updateSnapshot(panelState: PanelSessionState, patch: Partial<ConnectionSnapshot>, throttleMs = 0): void {
    const record = this.panels.get(panelState);
    if (!record) return;

    const previous = this.snapshots.get(record.snapshotKey);
    const next: ConnectionSnapshot = {
      connected: false,
      status: "Idle",
      protocol: "None",
      colorDepth: "24-bit RGBX",
      autoProtocol: "auto",
      autoColorDepth: "24-bit",
      bandwidthBps: 0,
      updatesPerSecond: 0,
      avgFrameMs: 0,
      avgWorkerDecodeMs: 0,
      avgBlitMs: 0,
      latencyMs: 0,
      fps: 0,
      bottleneckHint: "balanced",
      workerFallbackActive: false,
      ...previous,
      ...patch,
      lastUpdated: Date.now(),
    };

    this.snapshots.set(record.snapshotKey, next);
    if (patch.connected !== undefined && patch.connected !== previous?.connected) {
      this.emitBadge();
    }

    if (!record.endpointId) return;
    if (throttleMs > 0) {
      this.scheduleSnapshotRefresh(record.snapshotKey, throttleMs);
      return;
    }
    this.options.refreshAll();
  }

  connect(panelState: PanelSessionState, host: string, port: number): void {
    const record = this.panels.get(panelState);
    if (!record) return;

    if (record.activeSession) {
      record.activeSession.disconnect();
      record.activeSession = null;
    }

    const session = new TcpSession(host, port, (event) => this.handleTcpEvent(record, host, port, event));
    record.activeSession = session;
    this.options.postToPanel(panelState.panel, {
      type: "tcp:connecting",
      sessionId: session.sessionId,
    }, "tcpConnecting");
    session.connect();
  }

  write(panelState: PanelSessionState, sessionId: string, payloadBase64: string): void {
    const record = this.panels.get(panelState);
    if (!record || record.activeSession?.sessionId !== sessionId) return;
    record.activeSession.writeBase64(payloadBase64);
  }

  disconnect(panelState: PanelSessionState, sessionId: string, status = "Disconnected"): void {
    const record = this.panels.get(panelState);
    if (!record || record.activeSession?.sessionId !== sessionId) return;
    this.options.logError(`[VNC] Disconnect requested for session ${sessionId}`);
    record.activeSession.disconnect();
    record.activeSession = null;
    this.releaseClaim(panelState);
    this.updateSnapshot(panelState, { connected: false, status });
  }

  disposePanel(panelState: PanelSessionState): void {
    const record = this.panels.get(panelState);
    if (!record) {
      console.error(`[VNC-MGR] disposePanel: no record found`);
      this.options.logError(`[VNC] disposePanel: no record found for panel`);
      return;
    }

    this.options.logError(`[VNC] disposePanel: key=${record.snapshotKey}, hadSession=${!!record.activeSession}, snapshotConnected=${this.snapshots.get(record.snapshotKey)?.connected}`);

    // Remove panel from map FIRST so no async TCP events can re-insert state
    this.panels.delete(panelState);

    if (record.activeSession) {
      try {
        record.activeSession.disconnect();
      } catch (err: unknown) {
        this.options.logError(`[VNC] Error during session disconnect in disposePanel: ${err instanceof Error ? err.message : String(err)}`);
      }
      record.activeSession = null;
    }

    const pending = this.pendingRefreshes.get(record.snapshotKey);
    if (pending) {
      clearTimeout(pending);
      this.pendingRefreshes.delete(record.snapshotKey);
    }

    this.releaseClaim(panelState);

    // Delete the snapshot entirely so the tree cannot show stale data
    this.snapshots.delete(record.snapshotKey);

    const count = this.getActiveConnectionCount();
    this.options.logError(`[VNC] disposePanel complete: activeCount=${count}, snapshots=${this.snapshots.size}, panels=${this.panels.size}`);

    this.emitBadge();
    this.options.refreshAll();
  }

  private handleTcpEvent(record: ManagedPanelConnection, host: string, port: number, event: TcpSessionEvent): void {
    // If the panel has been disposed, ignore all events
    if (!this.panels.has(record.panelState)) {
      return;
    }
    if (record.activeSession?.sessionId !== event.sessionId) {
      // Log stale errors but never let them mutate current connection state
      if (event.type === "error") {
        this.options.logError(`[VNC] Stale TCP error ${host}:${port} (${event.sessionId}): ${(event as { message: string }).message}`);
      }
      return;
    }

    switch (event.type) {
      case "connected":
        this.options.logError(`[VNC] TCP connected ${host}:${port} (${event.sessionId})`);
        this.options.postToPanel(record.panelState.panel, { type: "tcp:connected", sessionId: event.sessionId }, "tcpConnected");
        this.updateSnapshot(record.panelState, { connected: true, status: "Connected" });
        break;
      case "data":
        this.options.postToPanel(record.panelState.panel, {
          type: "tcp:data",
          sessionId: event.sessionId,
          payloadBase64: event.payloadBase64,
        }, "tcpData");
        break;
      case "closed":
        this.options.logError(`[VNC] TCP closed ${host}:${port} (${event.sessionId}): ${event.reason ?? "Socket closed"}`);
        this.options.postToPanel(record.panelState.panel, {
          type: "tcp:closed",
          sessionId: event.sessionId,
          reason: event.reason ?? "Socket closed",
        }, "tcpClosed");
        if (record.activeSession?.sessionId === event.sessionId) {
          record.activeSession = null;
        }
        this.releaseClaim(record.panelState);
        this.updateSnapshot(record.panelState, {
          connected: false,
          status: event.reason ?? "Socket closed",
          bandwidthBps: 0,
          updatesPerSecond: 0,
          avgFrameMs: 0,
          avgWorkerDecodeMs: 0,
          avgBlitMs: 0,
          latencyMs: 0,
          fps: 0,
        });
        break;
      case "error":
        this.options.logError(`[VNC] ERROR: TCP error ${host}:${port} (${event.sessionId}): ${event.message}`);
        this.options.postToPanel(record.panelState.panel, {
          type: "tcp:error",
          sessionId: event.sessionId,
          message: event.message,
        }, "tcpError");
        if (record.activeSession?.sessionId === event.sessionId) {
          record.activeSession = null;
        }
        this.releaseClaim(record.panelState);
        this.updateSnapshot(record.panelState, {
          connected: false,
          status: `Error: ${event.message}`,
          bandwidthBps: 0,
          updatesPerSecond: 0,
          avgFrameMs: 0,
          avgWorkerDecodeMs: 0,
          avgBlitMs: 0,
          latencyMs: 0,
          fps: 0,
        });
        break;
    }
  }

  private scheduleSnapshotRefresh(snapshotKey: string, throttleMs: number): void {
    if (this.pendingRefreshes.has(snapshotKey)) return;
    const timer = setTimeout(() => {
      this.pendingRefreshes.delete(snapshotKey);
      this.options.refreshAll();
    }, throttleMs);
    this.pendingRefreshes.set(snapshotKey, timer);
  }

  /** Detect panels that VS Code disposed without firing onDidDispose. */
  checkForOrphanedPanels(): void {
    const orphaned: PanelSessionState[] = [];
    for (const [panelState] of this.panels) {
      try {
        void panelState.panel.visible;
      } catch {
        orphaned.push(panelState);
      }
    }
    for (const panelState of orphaned) {
      this.options.logError(`[VNC] Detected orphaned panel (onDidDispose missed), cleaning up`);
      this.disposePanel(panelState);
    }
  }

  private emitBadge(): void {
    this.options.updateBadge(this.getActiveConnectionCount());
  }
}