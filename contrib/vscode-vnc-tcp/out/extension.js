"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const promises_1 = require("node:fs/promises");
const tcpSession_1 = require("./tcpSession");
const SAVED_ENDPOINTS_KEY = "tigervncVscode.savedEndpoints";
const LAST_SESSION_KEY = "tigervncVscode.lastSession";
const LEGACY_SAVED_ENDPOINTS_KEY = "vncTcp.savedEndpoints";
const SECRET_PREFIX = "tigervncVscode.password.";
const LEGACY_SECRET_PREFIX = "vncTcp.password.";
const SIDEBAR_STATS_REFRESH_MS = 250;
class SavedEndpointItem extends vscode.TreeItem {
    endpoint;
    snapshot;
    constructor(endpoint, snapshot) {
        super(endpoint.name, snapshot?.connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        this.endpoint = endpoint;
        this.id = `endpoint:${endpoint.id}`;
        this.contextValue = "tigervncVscodeSavedEndpoint";
        this.command = {
            command: "tigervncVscode.connectSavedEndpoint",
            title: "Connect",
            arguments: [endpoint],
        };
        this.update(snapshot);
    }
    update(snapshot) {
        this.snapshot = snapshot;
        this.collapsibleState = snapshot?.connected
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed;
        this.description = snapshot?.connected
            ? `${endpointAddress(this.endpoint)}  live`
            : `${endpointAddress(this.endpoint)}${this.endpoint.hasPassword ? "  saved" : ""}`;
        this.tooltip = [
            this.endpoint.name,
            endpointAddress(this.endpoint),
            endpointOverrideSummary(this.endpoint),
            snapshot?.status ? `Status: ${snapshot.status}` : undefined,
        ].filter(Boolean).join("\n");
        this.iconPath = new vscode.ThemeIcon(snapshot?.connected ? "vm-active" : "vm");
    }
}
class SettingsItem extends vscode.TreeItem {
    constructor() {
        super("Settings", vscode.TreeItemCollapsibleState.None);
        this.id = "settings";
        this.description = "Defaults and adaptation";
        this.tooltip = "Open TigerVNC VS Code extension settings";
        this.iconPath = new vscode.ThemeIcon("gear");
        this.command = {
            command: "tigervncVscode.openSettings",
            title: "Open Settings",
        };
        this.contextValue = "tigervncVscodeSettings";
    }
}
class StatItem extends vscode.TreeItem {
    endpointId;
    key;
    constructor(endpointId, key, label, value) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.endpointId = endpointId;
        this.key = key;
        this.id = `stat:${endpointId}:${key}`;
        this.description = value;
        this.contextValue = "tigervncVscodeStat";
        this.iconPath = new vscode.ThemeIcon(iconForStat(key));
        if (key === "protocol" || key === "autoProtocol") {
            this.command = {
                command: "tigervncVscode.overrideEndpointProtocol",
                title: "Override Protocol",
                arguments: [this],
            };
        }
        else if (key === "overrideProtocol") {
            this.command = {
                command: "tigervncVscode.overrideEndpointProtocol",
                title: "Override Protocol",
                arguments: [this],
            };
        }
        else if (key === "colorDepth" || key === "autoColorDepth") {
            this.command = {
                command: "tigervncVscode.overrideEndpointColorDepth",
                title: "Override Color Depth",
                arguments: [this],
            };
        }
        else if (key === "overrideColorDepth") {
            this.command = {
                command: "tigervncVscode.overrideEndpointColorDepth",
                title: "Override Color Depth",
                arguments: [this],
            };
        }
        else if (key === "overrideClipboard") {
            this.command = {
                command: "tigervncVscode.overrideEndpointClipboard",
                title: "Override Clipboard Sharing",
                arguments: [this],
            };
        }
    }
}
class SavedEndpointsProvider {
    getEndpoints;
    getSnapshot;
    emitter = new vscode.EventEmitter();
    settingsItem = new SettingsItem();
    endpointItems = new Map();
    onDidChangeTreeData = this.emitter.event;
    constructor(getEndpoints, getSnapshot) {
        this.getEndpoints = getEndpoints;
        this.getSnapshot = getSnapshot;
    }
    refresh(item) {
        this.emitter.fire(item);
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
        if (!element) {
            return [
                this.settingsItem,
                ...this.getEndpoints().map((endpoint) => this.getOrCreateEndpointItem(endpoint)),
            ];
        }
        if (element instanceof SavedEndpointItem) {
            const snap = this.getSnapshot(element.endpoint.id);
            element.update(snap);
            const overrideItems = [
                new StatItem(element.endpoint.id, "overrideProtocol", "Protocol override", element.endpoint.protocolOverride ?? "settings"),
                new StatItem(element.endpoint.id, "overrideColorDepth", "Depth override", element.endpoint.colorDepthOverride ?? "settings"),
                new StatItem(element.endpoint.id, "overrideClipboard", "Clipboard override", element.endpoint.clipboardOverride === undefined ? "settings" : element.endpoint.clipboardOverride ? "enabled" : "disabled"),
            ];
            if (!snap?.connected)
                return overrideItems;
            const statsItems = [
                ...overrideItems,
                new StatItem(element.endpoint.id, "protocol", "Protocol", snap.protocol),
                new StatItem(element.endpoint.id, "autoProtocol", "Auto", snap.autoProtocol),
                new StatItem(element.endpoint.id, "colorDepth", "Depth", snap.colorDepth),
                new StatItem(element.endpoint.id, "autoColorDepth", "Auto depth", snap.autoColorDepth),
                new StatItem(element.endpoint.id, "bandwidth", "Bandwidth", formatDataRate(snap.bandwidthBps)),
                new StatItem(element.endpoint.id, "updatesPerSecond", "Updates", `${snap.updatesPerSecond.toFixed(1)} upd/s`),
                new StatItem(element.endpoint.id, "fps", "FPS", snap.fps.toFixed(1)),
                new StatItem(element.endpoint.id, "latency", "Latency", `${snap.latencyMs.toFixed(1)} ms`),
                new StatItem(element.endpoint.id, "avgFrameMs", "Frame", `${snap.avgFrameMs.toFixed(1)} ms`),
                new StatItem(element.endpoint.id, "avgWorkerDecodeMs", "Worker", `${snap.avgWorkerDecodeMs.toFixed(1)} ms`),
                new StatItem(element.endpoint.id, "avgBlitMs", "Blit", `${snap.avgBlitMs.toFixed(1)} ms`),
                new StatItem(element.endpoint.id, "bottleneckHint", "Bottleneck", snap.bottleneckHint),
                new StatItem(element.endpoint.id, "status", "Status", snap.status),
            ];
            if (snap.inflateBackend === "fflate") {
                statsItems.push(new StatItem(element.endpoint.id, "fallback-inflate", "Zlib", "JavaScript fallback"));
            }
            if (snap.workerFallbackActive) {
                statsItems.push(new StatItem(element.endpoint.id, "fallback-worker", "Decode worker", "Main-thread fallback"));
            }
            return statsItems;
        }
        return [];
    }
    getEndpointItemById(endpointId) {
        const endpoint = this.getEndpoints().find((candidate) => candidate.id === endpointId);
        if (!endpoint)
            return undefined;
        return this.getOrCreateEndpointItem(endpoint);
    }
    getOrCreateEndpointItem(endpoint) {
        const existing = this.endpointItems.get(endpoint.id);
        if (existing) {
            existing.update(this.getSnapshot(endpoint.id));
            return existing;
        }
        const created = new SavedEndpointItem(endpoint, this.getSnapshot(endpoint.id));
        this.endpointItems.set(endpoint.id, created);
        return created;
    }
}
function formatDataRate(bytesPerSecond) {
    if (bytesPerSecond < 1024)
        return `${bytesPerSecond.toFixed(0)} B/s`;
    if (bytesPerSecond < 1024 * 1024)
        return `${(bytesPerSecond / 1024).toFixed(1)} KiB/s`;
    return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MiB/s`;
}
function endpointAddress(endpoint) {
    return `${endpoint.host}:${endpoint.port}`;
}
function endpointOverrideSummary(endpoint) {
    if (!endpoint.protocolOverride && !endpoint.colorDepthOverride && endpoint.clipboardOverride === undefined) {
        return undefined;
    }
    const clip = endpoint.clipboardOverride === undefined ? "settings" : endpoint.clipboardOverride ? "enabled" : "disabled";
    return `Override: ${endpoint.protocolOverride ?? "settings"} / ${endpoint.colorDepthOverride ?? "settings"} / clipboard ${clip}`;
}
async function promptEndpointProtocolOverride(current) {
    const pick = await vscode.window.showQuickPick([
        { label: "Use extension setting", value: undefined, description: "Follow the global default" },
        { label: "Auto", value: "auto" },
        { label: "H.264", value: "h264" },
        { label: "Tight", value: "tight" },
        { label: "ZRLE", value: "zrle" },
        { label: "Hextile", value: "hextile" },
        { label: "Raw", value: "raw" },
    ], {
        title: "Protocol override",
        placeHolder: current ? `Current: ${current}` : "Select protocol override",
    });
    if (!pick) {
        return { cancelled: true };
    }
    return { cancelled: false, value: pick.value };
}
async function promptEndpointColorDepthOverride(current) {
    const pick = await vscode.window.showQuickPick([
        { label: "Use extension setting", value: undefined, description: "Follow the global default" },
        { label: "8-bit", value: "8-bit" },
        { label: "16-bit", value: "16-bit" },
        { label: "24-bit", value: "24-bit" },
    ], {
        title: "Color depth override",
        placeHolder: current ? `Current: ${current}` : "Select color-depth override",
    });
    if (!pick) {
        return { cancelled: true };
    }
    return { cancelled: false, value: pick.value };
}
async function promptEndpointClipboardOverride(current) {
    const pick = await vscode.window.showQuickPick([
        { label: "Use extension setting", value: undefined, description: "Follow the global default" },
        { label: "Enabled", value: true },
        { label: "Disabled", value: false },
    ], {
        title: "Clipboard sharing override",
        placeHolder: current === undefined
            ? "Select clipboard-sharing override"
            : `Current: ${current ? "enabled" : "disabled"}`,
    });
    if (!pick) {
        return { cancelled: true };
    }
    return { cancelled: false, value: pick.value };
}
function iconForStat(key) {
    switch (key) {
        case "protocol":
        case "autoProtocol":
            return "server-process";
        case "colorDepth":
        case "autoColorDepth":
            return "symbol-color";
        case "overrideClipboard":
            return "clippy";
        case "bandwidth":
            return "arrow-swap";
        case "updatesPerSecond":
        case "fps":
            return "pulse";
        case "latency":
            return "watch";
        case "avgFrameMs":
        case "avgWorkerDecodeMs":
        case "avgBlitMs":
            return "dashboard";
        case "bottleneckHint":
            return "warning";
        case "status":
            return "info";
        case "fallback-inflate":
        case "fallback-worker":
            return "warning";
        default:
            return "circle-small-filled";
    }
}
function activate(context) {
    const output = vscode.window.createOutputChannel("VNC");
    context.subscriptions.push(output);
    output.show(true); // surface the channel; preserves user focus
    output.appendLine("[VNC] Extension activated");
    let endpoints = context.globalState.get(SAVED_ENDPOINTS_KEY, []);
    if (endpoints.length === 0) {
        const legacyEndpoints = context.globalState.get(LEGACY_SAVED_ENDPOINTS_KEY, []);
        if (legacyEndpoints.length > 0) {
            endpoints = legacyEndpoints;
        }
    }
    const connectionsByEndpointId = new Map();
    const pendingSidebarRefreshes = new Map();
    const claimedPanelsByEndpoint = new Map();
    const thumbnailsDir = vscode.Uri.joinPath(context.globalStorageUri, "thumbnails");
    const getDefaultClipboardSharing = () => {
        const cfg = vscode.workspace.getConfiguration("tigervncVscode");
        const legacyCfg = vscode.workspace.getConfiguration("vncTcp");
        return Boolean(cfg.get("enableClipboardSharing") ?? legacyCfg.get("enableClipboardSharing", true));
    };
    const getRestorePreviousSessionOnStartup = () => {
        const cfg = vscode.workspace.getConfiguration("tigervncVscode");
        const legacyCfg = vscode.workspace.getConfiguration("vncTcp");
        return Boolean(cfg.get("restorePreviousSessionOnStartup") ?? legacyCfg.get("restorePreviousSessionOnStartup", false));
    };
    const saveEndpoints = async () => {
        await context.globalState.update(SAVED_ENDPOINTS_KEY, endpoints);
    };
    const readPassword = async (endpointId) => {
        return (await context.secrets.get(`${SECRET_PREFIX}${endpointId}`))
            ?? (await context.secrets.get(`${LEGACY_SECRET_PREFIX}${endpointId}`));
    };
    const clearPassword = async (endpointId) => {
        await context.secrets.delete(`${SECRET_PREFIX}${endpointId}`);
        await context.secrets.delete(`${LEGACY_SECRET_PREFIX}${endpointId}`);
    };
    const provider = new SavedEndpointsProvider(() => endpoints, (endpointId) => connectionsByEndpointId.get(endpointId));
    context.subscriptions.push(vscode.window.registerTreeDataProvider("tigervncVscode.savedEndpoints", provider));
    const endpointKeyFor = (host, port) => `${host.trim().toLowerCase()}:${port}`;
    const getEndpointById = (endpointId) => endpoints.find((endpoint) => endpoint.id === endpointId);
    const postToPanel = (panel, message, contextLabel) => {
        try {
            void panel.webview.postMessage(message);
        }
        catch (err) {
            output.appendLine(`[VNC] Skipping webview post (${contextLabel}): ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    const revealClaimedPanel = (state, endpointKey) => {
        try {
            state.panel.reveal(vscode.ViewColumn.One, false);
            void vscode.window.showInformationMessage(`Already connected to ${endpointKey}. Surfacing the active session.`);
            return true;
        }
        catch (err) {
            // The panel reference is stale (disposed). Drop the claim and allow
            // the caller to create a fresh session panel.
            output.appendLine(`[VNC] Removing stale claimed panel for ${endpointKey}: ${err instanceof Error ? err.message : String(err)}`);
            if (claimedPanelsByEndpoint.get(endpointKey) === state) {
                claimedPanelsByEndpoint.delete(endpointKey);
            }
            state.claimedEndpointKey = null;
            return false;
        }
    };
    const releaseClaim = (state) => {
        if (!state.claimedEndpointKey)
            return;
        if (claimedPanelsByEndpoint.get(state.claimedEndpointKey) === state) {
            claimedPanelsByEndpoint.delete(state.claimedEndpointKey);
        }
        state.claimedEndpointKey = null;
    };
    const claimEndpoint = (state, endpointKey) => {
        const existing = claimedPanelsByEndpoint.get(endpointKey);
        if (existing && existing !== state) {
            revealClaimedPanel(existing, endpointKey);
            return false;
        }
        if (state.claimedEndpointKey === endpointKey) {
            return true;
        }
        releaseClaim(state);
        state.claimedEndpointKey = endpointKey;
        claimedPanelsByEndpoint.set(endpointKey, state);
        return true;
    };
    const updatePanelThumbnail = async (state, endpointKey, dataUrl) => {
        const match = /^data:image\/png;base64,(.+)$/u.exec(dataUrl);
        if (!match)
            return;
        await (0, promises_1.mkdir)(thumbnailsDir.fsPath, { recursive: true });
        const safeKey = endpointKey.replace(/[^a-z0-9.-]+/gi, "_");
        const nextVersion = state.thumbnailVersion + 1;
        const nextPath = vscode.Uri.joinPath(thumbnailsDir, `${safeKey}-${nextVersion}.png`).fsPath;
        await (0, promises_1.writeFile)(nextPath, Buffer.from(match[1], "base64"));
        state.thumbnailVersion = nextVersion;
        state.panel.iconPath = vscode.Uri.file(nextPath);
        if (state.activeThumbnailPath && state.activeThumbnailPath !== nextPath) {
            void (0, promises_1.rm)(state.activeThumbnailPath, { force: true });
        }
        state.activeThumbnailPath = nextPath;
    };
    const pushEndpointOverridesToActiveSession = (endpoint) => {
        const activePanel = claimedPanelsByEndpoint.get(endpointKeyFor(endpoint.host, endpoint.port));
        if (!activePanel)
            return;
        postToPanel(activePanel.panel, {
            type: "vnc:applyEndpointOverrides",
            protocolOverride: endpoint.protocolOverride,
            colorDepthOverride: endpoint.colorDepthOverride,
            clipboardEnabled: endpoint.clipboardOverride ?? getDefaultClipboardSharing(),
        }, "applyEndpointOverrides");
    };
    const saveLastSession = (snapshot) => {
        void context.globalState.update(LAST_SESSION_KEY, snapshot);
    };
    const persistEndpointUpdate = async (endpoint, logMessage) => {
        endpoints = endpoints.map((candidate) => (candidate.id === endpoint.id ? endpoint : candidate));
        await saveEndpoints();
        output.appendLine(logMessage);
        pushEndpointOverridesToActiveSession(endpoint);
        provider.refresh(provider.getEndpointItemById(endpoint.id));
    };
    context.subscriptions.push(vscode.commands.registerCommand("tigervncVscode.openSettings", async () => {
        output.appendLine("[VNC] Opening TigerVNC VS Code settings");
        await vscode.commands.executeCommand("workbench.action.openSettings", "tigervncVscode");
    }));
    context.subscriptions.push(vscode.commands.registerCommand("tigervncVscode.openSession", async (options) => {
        output.appendLine(`[VNC] Opening session panel for ${options?.host ?? "127.0.0.1"}:${options?.port ?? 5900}`);
        const cfg = vscode.workspace.getConfiguration("tigervncVscode");
        const legacyCfg = vscode.workspace.getConfiguration("vncTcp");
        const defaultHost = options?.host
            ?? String(cfg.get("defaultHost") ?? legacyCfg.get("defaultHost", "127.0.0.1"));
        const defaultPort = options?.port
            ?? Number(cfg.get("defaultPort") ?? legacyCfg.get("defaultPort", 5900));
        const defaultPassword = options?.password ?? "";
        const autoSelectProtocolDepth = Boolean(cfg.get("autoSelectProtocolDepth") ?? legacyCfg.get("autoSelectProtocolDepth", true));
        const defaultClipboardSharing = getDefaultClipboardSharing();
        const autoSelectMinSwitchIntervalMs = Number(cfg.get("autoSelectMinSwitchIntervalMs") ?? legacyCfg.get("autoSelectMinSwitchIntervalMs", 4000));
        const clientDistUri = vscode.Uri.joinPath(context.extensionUri, "media", "client-dist");
        const endpointId = options?.endpointId;
        const clipboardEnabled = options?.clipboardOverride ?? defaultClipboardSharing;
        const initialEndpointKey = endpointKeyFor(defaultHost, defaultPort);
        const existingPanel = claimedPanelsByEndpoint.get(initialEndpointKey);
        if (existingPanel) {
            if (revealClaimedPanel(existingPanel, initialEndpointKey)) {
                return;
            }
        }
        let rawHtml;
        try {
            rawHtml = await (0, promises_1.readFile)(vscode.Uri.joinPath(clientDistUri, "index.html").fsPath, "utf8");
        }
        catch {
            output.appendLine("[VNC] ERROR: client-dist/index.html is missing; sync-client-dist is required");
            vscode.window.showErrorMessage("web-vnc-client dist assets are missing. Run: npm run sync-client-dist in tigervnc-vscode.");
            return;
        }
        const panel = vscode.window.createWebviewPanel("tigervncVscodeSession", `VNC ${defaultHost}:${defaultPort}`, vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [clientDistUri],
        });
        const panelState = {
            panel,
            claimedEndpointKey: null,
            activeThumbnailPath: null,
            thumbnailVersion: 0,
        };
        void claimEndpoint(panelState, initialEndpointKey);
        // One active TCP session per panel (the webview owns connect/disconnect).
        let activeSession = null;
        let currentSnapshotKey = endpointId ?? initialEndpointKey;
        const scheduleSidebarRefresh = (snapshotKey, throttleMs) => {
            if (!endpointId)
                return;
            if (pendingSidebarRefreshes.has(snapshotKey))
                return;
            const timer = setTimeout(() => {
                pendingSidebarRefreshes.delete(snapshotKey);
                const item = provider.getEndpointItemById(snapshotKey);
                if (item) {
                    provider.refresh(item);
                }
            }, throttleMs);
            pendingSidebarRefreshes.set(snapshotKey, timer);
        };
        const updateSnapshot = (patch, throttleMs = 0) => {
            const previous = connectionsByEndpointId.get(currentSnapshotKey);
            const next = {
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
            connectionsByEndpointId.set(currentSnapshotKey, next);
            if (!endpointId)
                return;
            if (throttleMs > 0) {
                scheduleSidebarRefresh(currentSnapshotKey, throttleMs);
                return;
            }
            const item = provider.getEndpointItemById(currentSnapshotKey);
            provider.refresh(item);
        };
        panel.webview.onDidReceiveMessage((msg) => {
            if (msg.type === "connect") {
                output.appendLine(`[VNC] Connect requested for ${msg.host}:${msg.port}`);
                panel.title = `VNC ${msg.host}:${msg.port}`;
                const latestEndpoint = endpointId ? getEndpointById(endpointId) : undefined;
                saveLastSession({
                    host: msg.host,
                    port: msg.port,
                    endpointId,
                    protocolOverride: latestEndpoint?.protocolOverride ?? options?.protocolOverride,
                    colorDepthOverride: latestEndpoint?.colorDepthOverride ?? options?.colorDepthOverride,
                    clipboardOverride: latestEndpoint?.clipboardOverride ?? options?.clipboardOverride,
                });
                const requestedEndpointKey = endpointKeyFor(msg.host, msg.port);
                if (!claimEndpoint(panelState, requestedEndpointKey)) {
                    postToPanel(panel, {
                        type: "vnc:status",
                        message: `Already connected: ${requestedEndpointKey}`,
                    }, "alreadyConnectedStatus");
                    return;
                }
                if (!endpointId) {
                    currentSnapshotKey = requestedEndpointKey;
                }
                updateSnapshot({ status: `Connecting to ${msg.host}:${msg.port}` });
                // Tear down any pre-existing session first.
                activeSession?.disconnect();
                activeSession = new tcpSession_1.TcpSession(msg.host, msg.port, (event) => {
                    switch (event.type) {
                        case "connected":
                            output.appendLine(`[VNC] TCP connected ${msg.host}:${msg.port} (${event.sessionId})`);
                            postToPanel(panel, { type: "tcp:connected", sessionId: event.sessionId }, "tcpConnected");
                            updateSnapshot({ connected: true, status: "Connected" });
                            break;
                        case "data":
                            postToPanel(panel, {
                                type: "tcp:data",
                                sessionId: event.sessionId,
                                payloadBase64: event.payloadBase64,
                            }, "tcpData");
                            break;
                        case "closed":
                            output.appendLine(`[VNC] TCP closed ${msg.host}:${msg.port} (${event.sessionId}): ${event.reason ?? "Socket closed"}`);
                            postToPanel(panel, {
                                type: "tcp:closed",
                                sessionId: event.sessionId,
                                reason: event.reason ?? "Socket closed",
                            }, "tcpClosed");
                            activeSession = null;
                            releaseClaim(panelState);
                            updateSnapshot({ connected: false, status: event.reason ?? "Socket closed" });
                            break;
                        case "error":
                            output.appendLine(`[VNC] ERROR: TCP error ${msg.host}:${msg.port} (${event.sessionId}): ${event.message}`);
                            postToPanel(panel, {
                                type: "tcp:error",
                                sessionId: event.sessionId,
                                message: event.message,
                            }, "tcpError");
                            releaseClaim(panelState);
                            updateSnapshot({ connected: false, status: `Error: ${event.message}` });
                            break;
                    }
                });
                activeSession.connect();
            }
            else if (msg.type === "write") {
                if (activeSession?.sessionId === msg.sessionId) {
                    activeSession.writeBase64(msg.payloadBase64);
                }
            }
            else if (msg.type === "disconnect") {
                if (activeSession?.sessionId === msg.sessionId) {
                    output.appendLine(`[VNC] Disconnect requested for session ${msg.sessionId}`);
                    activeSession.disconnect();
                    activeSession = null;
                    releaseClaim(panelState);
                    updateSnapshot({ connected: false, status: "Disconnected" });
                }
            }
            else if (msg.type === "vnc:thumbnail") {
                if (!panelState.claimedEndpointKey)
                    return;
                void updatePanelThumbnail(panelState, panelState.claimedEndpointKey, msg.dataUrl).catch((err) => {
                    output.appendLine(`[VNC] Thumbnail update failed: ${err instanceof Error ? err.message : String(err)}`);
                });
            }
            else if (msg.type === "vnc:stats") {
                updateSnapshot({
                    protocol: msg.stats.encoding,
                    colorDepth: msg.stats.colorDepth,
                    autoProtocol: msg.stats.autoProtocol ?? "auto",
                    autoColorDepth: msg.stats.autoColorDepth ?? "24-bit",
                    bandwidthBps: msg.stats.receivedRate,
                    updatesPerSecond: msg.stats.updatesPerSecond,
                    avgFrameMs: msg.stats.avgFrameMs,
                    avgWorkerDecodeMs: msg.stats.avgWorkerDecodeMs,
                    avgBlitMs: msg.stats.avgBlitMs,
                    latencyMs: msg.stats.latencyMs,
                    fps: msg.stats.fps ?? 0,
                    bottleneckHint: msg.stats.bottleneckHint,
                    inflateBackend: msg.stats.inflateBackend,
                    workerFallbackActive: msg.stats.workerFallbackActive ?? false,
                }, SIDEBAR_STATS_REFRESH_MS);
            }
            else if (msg.type === "vnc:status") {
                output.appendLine(`[VNC] Webview status: ${msg.message}`);
                updateSnapshot({ status: msg.message });
            }
            else if (msg.type === "vnc:debug") {
                output.appendLine(`[VNC][DBG] ${msg.message}`);
            }
            else if (msg.type === "vnc:openSettings") {
                output.appendLine("[VNC] Webview requested settings");
                void vscode.commands.executeCommand("tigervncVscode.openSettings");
            }
            else if (msg.type === "vnc:connectedState") {
                output.appendLine(`[VNC] Webview connected state: ${msg.connected}`);
                updateSnapshot({ connected: msg.connected });
            }
        });
        panel.onDidDispose(() => {
            output.appendLine(`[VNC] Session panel disposed for ${panel.title}`);
            activeSession?.disconnect();
            activeSession = null;
            releaseClaim(panelState);
            const pending = pendingSidebarRefreshes.get(currentSnapshotKey);
            if (pending) {
                clearTimeout(pending);
                pendingSidebarRefreshes.delete(currentSnapshotKey);
            }
            if (panelState.activeThumbnailPath) {
                void (0, promises_1.rm)(panelState.activeThumbnailPath, { force: true });
            }
            updateSnapshot({ connected: false, status: "Panel closed" });
        });
        panel.onDidChangeViewState((event) => {
            if (event.webviewPanel.visible) {
                output.appendLine(`[VNC] Session panel exposed: ${event.webviewPanel.title}`);
                postToPanel(event.webviewPanel, { type: "vnc:exposed" }, "panelExposed");
            }
        });
        panel.webview.html = buildClientHtml(panel.webview, rawHtml, clientDistUri, defaultHost, defaultPort, defaultPassword, autoSelectProtocolDepth, autoSelectMinSwitchIntervalMs, options?.protocolOverride, options?.colorDepthOverride, clipboardEnabled);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("tigervncVscode.addSavedEndpoint", async () => {
        const name = await vscode.window.showInputBox({
            title: "New VNC endpoint",
            prompt: "Display name",
            placeHolder: "Office VM",
            validateInput: (value) => (value.trim() ? undefined : "Name is required"),
        });
        if (!name)
            return;
        const host = await vscode.window.showInputBox({
            title: "New VNC endpoint",
            prompt: "Hostname or IP",
            placeHolder: "127.0.0.1",
            validateInput: (value) => (value.trim() ? undefined : "Host is required"),
        });
        if (!host)
            return;
        const portInput = await vscode.window.showInputBox({
            title: "New VNC endpoint",
            prompt: "Port",
            value: "5900",
            validateInput: (value) => {
                const n = Number(value);
                return Number.isInteger(n) && n > 0 && n <= 65535 ? undefined : "Enter a valid TCP port (1-65535)";
            },
        });
        if (!portInput)
            return;
        const password = await vscode.window.showInputBox({
            title: "New VNC endpoint",
            prompt: "Password (optional)",
            password: true,
            placeHolder: "Leave empty to skip",
        });
        if (password === undefined)
            return;
        const protocolOverridePick = await promptEndpointProtocolOverride();
        if (protocolOverridePick.cancelled)
            return;
        const colorDepthOverridePick = await promptEndpointColorDepthOverride();
        if (colorDepthOverridePick.cancelled)
            return;
        const clipboardOverridePick = await promptEndpointClipboardOverride();
        if (clipboardOverridePick.cancelled)
            return;
        const endpoint = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: name.trim(),
            host: host.trim(),
            port: Number(portInput),
            hasPassword: Boolean(password),
            protocolOverride: protocolOverridePick.value,
            colorDepthOverride: colorDepthOverridePick.value,
            clipboardOverride: clipboardOverridePick.value,
        };
        endpoints = [...endpoints, endpoint];
        await saveEndpoints();
        output.appendLine(`[VNC] Saved endpoint added: ${endpoint.name} (${endpoint.host}:${endpoint.port})`);
        if (password) {
            await context.secrets.store(`${SECRET_PREFIX}${endpoint.id}`, password);
        }
        provider.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("tigervncVscode.editSavedEndpoint", async (item) => {
        const endpoint = item instanceof SavedEndpointItem ? item.endpoint : item;
        if (!endpoint)
            return;
        const name = await vscode.window.showInputBox({
            title: "Edit VNC endpoint",
            prompt: "Display name",
            value: endpoint.name,
            validateInput: (value) => (value.trim() ? undefined : "Name is required"),
        });
        if (!name)
            return;
        const host = await vscode.window.showInputBox({
            title: "Edit VNC endpoint",
            prompt: "Hostname or IP",
            value: endpoint.host,
            validateInput: (value) => (value.trim() ? undefined : "Host is required"),
        });
        if (!host)
            return;
        const portInput = await vscode.window.showInputBox({
            title: "Edit VNC endpoint",
            prompt: "Port",
            value: String(endpoint.port),
            validateInput: (value) => {
                const n = Number(value);
                return Number.isInteger(n) && n > 0 && n <= 65535 ? undefined : "Enter a valid TCP port (1-65535)";
            },
        });
        if (!portInput)
            return;
        const updatePassword = await vscode.window.showQuickPick(["Keep current", "Set new password", "Clear password"], { title: "Password", placeHolder: "Choose password action" });
        if (!updatePassword)
            return;
        const protocolOverridePick = await promptEndpointProtocolOverride(endpoint.protocolOverride);
        if (protocolOverridePick.cancelled)
            return;
        const colorDepthOverridePick = await promptEndpointColorDepthOverride(endpoint.colorDepthOverride);
        if (colorDepthOverridePick.cancelled)
            return;
        const clipboardOverridePick = await promptEndpointClipboardOverride(endpoint.clipboardOverride);
        if (clipboardOverridePick.cancelled)
            return;
        if (updatePassword === "Set new password") {
            const newPassword = await vscode.window.showInputBox({
                title: "Edit VNC endpoint",
                prompt: "Password",
                password: true,
            });
            if (newPassword === undefined)
                return;
            if (newPassword) {
                await context.secrets.store(`${SECRET_PREFIX}${endpoint.id}`, newPassword);
            }
            else {
                await clearPassword(endpoint.id);
            }
            endpoint.hasPassword = Boolean(newPassword);
        }
        else if (updatePassword === "Clear password") {
            await clearPassword(endpoint.id);
            endpoint.hasPassword = false;
        }
        endpoint.name = name.trim();
        endpoint.host = host.trim();
        endpoint.port = Number(portInput);
        endpoint.protocolOverride = protocolOverridePick.value;
        endpoint.colorDepthOverride = colorDepthOverridePick.value;
        endpoint.clipboardOverride = clipboardOverridePick.value;
        await persistEndpointUpdate(endpoint, `[VNC] Saved endpoint updated: ${endpoint.name} (${endpoint.host}:${endpoint.port})`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("tigervncVscode.overrideEndpointProtocol", async (item) => {
        if (!(item instanceof StatItem))
            return;
        const endpoint = getEndpointById(item.endpointId);
        if (!endpoint)
            return;
        const protocolOverridePick = await promptEndpointProtocolOverride(endpoint.protocolOverride);
        if (protocolOverridePick.cancelled)
            return;
        endpoint.protocolOverride = protocolOverridePick.value;
        await persistEndpointUpdate(endpoint, `[VNC] Endpoint protocol override updated: ${endpoint.name} -> ${endpoint.protocolOverride ?? "settings"}`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("tigervncVscode.overrideEndpointColorDepth", async (item) => {
        if (!(item instanceof StatItem))
            return;
        const endpoint = getEndpointById(item.endpointId);
        if (!endpoint)
            return;
        const colorDepthOverridePick = await promptEndpointColorDepthOverride(endpoint.colorDepthOverride);
        if (colorDepthOverridePick.cancelled)
            return;
        endpoint.colorDepthOverride = colorDepthOverridePick.value;
        await persistEndpointUpdate(endpoint, `[VNC] Endpoint color-depth override updated: ${endpoint.name} -> ${endpoint.colorDepthOverride ?? "settings"}`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("tigervncVscode.overrideEndpointClipboard", async (item) => {
        if (!(item instanceof StatItem))
            return;
        const endpoint = getEndpointById(item.endpointId);
        if (!endpoint)
            return;
        const clipboardOverridePick = await promptEndpointClipboardOverride(endpoint.clipboardOverride);
        if (clipboardOverridePick.cancelled)
            return;
        endpoint.clipboardOverride = clipboardOverridePick.value;
        await persistEndpointUpdate(endpoint, `[VNC] Endpoint clipboard override updated: ${endpoint.name} -> ${endpoint.clipboardOverride === undefined ? "settings" : endpoint.clipboardOverride ? "enabled" : "disabled"}`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("tigervncVscode.removeSavedEndpoint", async (item) => {
        const endpoint = item instanceof SavedEndpointItem ? item.endpoint : item;
        if (!endpoint)
            return;
        const pick = await vscode.window.showWarningMessage(`Remove endpoint '${endpoint.name}'?`, { modal: true }, "Remove");
        if (pick !== "Remove")
            return;
        endpoints = endpoints.filter((e) => e.id !== endpoint.id);
        await saveEndpoints();
        await clearPassword(endpoint.id);
        output.appendLine(`[VNC] Saved endpoint removed: ${endpoint.name} (${endpoint.host}:${endpoint.port})`);
        provider.refresh();
    }));
    context.subscriptions.push(vscode.commands.registerCommand("tigervncVscode.connectSavedEndpoint", async (item) => {
        const endpoint = item instanceof SavedEndpointItem ? item.endpoint : item;
        if (!endpoint)
            return;
        output.appendLine(`[VNC] Opening saved endpoint: ${endpoint.name} (${endpoint.host}:${endpoint.port})`);
        const password = await readPassword(endpoint.id);
        await vscode.commands.executeCommand("tigervncVscode.openSession", {
            host: endpoint.host,
            port: endpoint.port,
            password: password ?? "",
            endpointId: endpoint.id,
            protocolOverride: endpoint.protocolOverride,
            colorDepthOverride: endpoint.colorDepthOverride,
            clipboardOverride: endpoint.clipboardOverride,
        });
    }));
    if (getRestorePreviousSessionOnStartup()) {
        const lastSession = context.globalState.get(LAST_SESSION_KEY);
        if (lastSession?.host && Number.isInteger(lastSession.port) && lastSession.port > 0) {
            void (async () => {
                output.appendLine(`[VNC] Restoring previous session ${lastSession.host}:${lastSession.port}`);
                const endpoint = lastSession.endpointId ? getEndpointById(lastSession.endpointId) : undefined;
                const password = endpoint ? await readPassword(endpoint.id) : "";
                await vscode.commands.executeCommand("tigervncVscode.openSession", {
                    host: endpoint?.host ?? lastSession.host,
                    port: endpoint?.port ?? lastSession.port,
                    password,
                    endpointId: endpoint?.id,
                    protocolOverride: endpoint?.protocolOverride ?? lastSession.protocolOverride,
                    colorDepthOverride: endpoint?.colorDepthOverride ?? lastSession.colorDepthOverride,
                    clipboardOverride: endpoint?.clipboardOverride ?? lastSession.clipboardOverride,
                });
            })();
        }
    }
}
function deactivate() {
    // no-op
}
function buildClientHtml(webview, rawHtml, clientDistUri, defaultHost, defaultPort, defaultPassword, autoSelectProtocolDepth, autoSelectMinSwitchIntervalMs, protocolOverride, colorDepthOverride, clipboardEnabled) {
    const preset = {
        mode: "tcp",
        host: defaultHost,
        vncPort: defaultPort,
        password: defaultPassword,
        autoSelectProtocolDepth,
        autoSelectMinSwitchIntervalMs,
        protocolOverride,
        colorDepthOverride,
        clipboardEnabled,
    };
    const wasmUri = webview.asWebviewUri(vscode.Uri.joinPath(clientDistUri, "zlib-inflate.wasm")).toString();
    const bootstrap = `
<script>
  window.__VNC_TCP_PRESET__ = ${JSON.stringify(preset)};
  window.__TIGHT_ZLIB_WASM_URL__ = ${JSON.stringify(wasmUri)};
  window.addEventListener('DOMContentLoaded', () => {
    const preset = window.__VNC_TCP_PRESET__;
    const tcpBtn = document.querySelector('.mode-btn[data-mode="tcp"]');
    const host = document.getElementById('input-vnc-host');
    const vncPort = document.getElementById('input-vnc-port');
    const password = document.getElementById('input-password');
    const connect = document.getElementById('btn-connect');
    if (tcpBtn) tcpBtn.click();
    if (host) host.value = preset.host;
    if (vncPort) vncPort.value = String(preset.vncPort);
    if (password) password.value = preset.password || '';
    setTimeout(() => { if (connect) connect.click(); }, 0);
  });
</script>
`;
    const rewritten = rawHtml
        .replace(/(href|src)="\/assets\/([^\"]+)"/g, (_m, attr, file) => {
        const uri = webview.asWebviewUri(vscode.Uri.joinPath(clientDistUri, "assets", file)).toString();
        return `${attr}="${uri}"`;
    })
        // Stamp the class before first paint so the CSS hide-toolbar rule fires immediately.
        .replace(/(<body\b[^>]*)>/, (_m, open) => `${open} class="vscode-embed">`)
        .replace("</body>", `${bootstrap}</body>`);
    return rewritten;
}
function escapeHtml(input) {
    return input
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
//# sourceMappingURL=extension.js.map