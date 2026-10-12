import { SystemStatusSchema, type SystemStatus, type AgentCapabilities } from "@navloom/contracts";

export type NavigationGroup = { id: string; name: string; sortOrder: number };
export type NavigationCard = {
  id: string; groupId: string | null; title: string; url: string; icon: string | null;
  description: string | null; sortOrder: number; openTarget: "_blank" | "_self";
};
export type NavigationDraft = Pick<NavigationCard, "title" | "url" | "icon" | "description" | "groupId" | "openTarget">;
export type AdminNavigation = { groups: NavigationGroup[]; cards: NavigationCard[] };
export type PublicCard = Pick<NavigationCard, "id" | "title" | "url" | "icon" | "description" | "openTarget">;
export type PublicNavigation = { groups: Array<{ id: string; name: string; cards: PublicCard[] }>; ungrouped: PublicCard[] };
export type HomeStatus = { configured: boolean; authenticated: boolean };
export type AdminSession = { configured: boolean; authenticated: boolean; username: string | null };

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? "GET";
  const response = await fetch("/api/v1" + path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(method !== "GET" ? { "x-navloom-csrf": "1" } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(response.status, body?.error?.code ?? "REQUEST_FAILED", body?.error?.message ?? "请求失败，请稍后重试");
  }
  return await response.json() as T;
}

const payload = (value: unknown): string => JSON.stringify(value);

export async function getSystemStatus(): Promise<SystemStatus> {
  return SystemStatusSchema.parse(await request("/system/status"));
}
export const getHomeStatus = () => request<HomeStatus>("/auth/home/status");
function authChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("navloom-auth-changed"));
}
export const unlockHome = async (passphrase: string) => {
  const result = await request<{ ok: boolean }>("/auth/home/unlock", { method: "POST", body: payload({ passphrase }) });
  authChanged();
  return result;
};
export const getPublicNavigation = () => request<PublicNavigation>("/home/navigation");
export const getAdminSession = () => request<AdminSession>("/auth/admin/session");
export const loginAdmin = async (username: string, password: string) => {
  const result = await request<{ ok: boolean }>("/auth/admin/login", { method: "POST", body: payload({ username, password }) });
  authChanged();
  return result;
};
export const logoutAdmin = async () => {
  const result = await request<{ ok: boolean }>("/auth/admin/logout", { method: "POST", body: "{}" });
  authChanged();
  return result;
};
export const changeAdminPassword = async (currentPassword: string, newPassword: string) => {
  const result = await request<{ ok: boolean }>("/admin/settings/password", { method: "PATCH", body: payload({ currentPassword, newPassword }) });
  authChanged();
  return result;
};
export const changeHomePassphrase = async (passphrase: string) => {
  const result = await request<{ ok: boolean }>("/admin/settings/home-passphrase", { method: "PATCH", body: payload({ passphrase }) });
  authChanged();
  return result;
};
export const revokeHomeCredentials = async () => {
  const result = await request<{ ok: boolean }>("/admin/settings/home/revoke", { method: "POST", body: "{}" });
  authChanged();
  return result;
};

export const getAdminNavigation = () => request<AdminNavigation>("/admin/navigation");
export const createGroup = (name: string) => request<{ id: string }>("/admin/navigation/groups", { method: "POST", body: payload({ name }) });
export const renameGroup = (id: string, name: string) => request<{ ok: boolean }>("/admin/navigation/groups/" + encodeURIComponent(id), { method: "PATCH", body: payload({ name }) });
export const deleteGroup = (id: string) => request<{ ok: boolean; movedCards: number }>("/admin/navigation/groups/" + encodeURIComponent(id), { method: "DELETE" });
export const createCard = (card: NavigationDraft) => request<{ id: string }>("/admin/navigation/cards", { method: "POST", body: payload(card) });
export const updateCard = (id: string, card: NavigationDraft) => request<{ ok: boolean }>("/admin/navigation/cards/" + encodeURIComponent(id), { method: "PATCH", body: payload(card) });
export const deleteCard = (id: string) => request<{ ok: boolean }>("/admin/navigation/cards/" + encodeURIComponent(id), { method: "DELETE" });
export const saveNavigationOrder = (groups: string[], cards: Array<{ id: string; groupId: string | null }>) =>
  request<{ ok: boolean }>("/admin/navigation/order", { method: "PUT", body: payload({ groups, cards }) });

export function iconIsUrl(icon: string | null): boolean {
  if (!icon) return false;
  try {
    const url = new URL(icon);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export type AgentDevice = {
  id: string; name: string; version: string | null; platform: string | null;
  architecture: string | null; registeredAt: number | null; lastSeenAt: number | null;
  revokedAt: number | null; status: "online" | "offline" | "paused" | "revoked";
  endpointHost: string | null; endpointPort: number | null; certificateConfigured: boolean;
  connectedAt: number | null; lastPongAt: number | null; handshakePending: boolean;
  capabilities: AgentCapabilities | null; checkedAt: number | null;
};
export const getAgents = () => request<{ agents: AgentDevice[] }>("/admin/agents");
export const issueAgentPairToken = () => request<{ token: string; expiresAt: string }>(
  "/admin/agents/pair-tokens", { method: "POST", body: "{}" },
);
export const renameAgent = (id: string, name: string) => request<{ ok: boolean }>(
  "/admin/agents/" + encodeURIComponent(id), { method: "PATCH", body: payload({ name }) },
);
export const revokeAgent = (id: string) => request<{ ok: boolean }>(
  "/admin/agents/" + encodeURIComponent(id) + "/revoke", { method: "POST", body: "{}" },
);

export const requestAgentCapabilityProbe = (id: string) => request<{ taskId: string }>(
  "/admin/agents/" + encodeURIComponent(id) + "/capability-probe", { method: "POST", body: "{}" },
);
export const getAgentTask = (id: string) => request<{ task: {
  id: string; agentId: string; operation: string; status: "sent" | "unknown" | "succeeded" | "failed";
  result: unknown; createdAt: number; dispatchedAt: number; deadlineAt: number; finishedAt: number | null;
} }>("/admin/agent-tasks/" + encodeURIComponent(id));

// Global connectivity checks (WSS Ping/Pong only; no Docker task or capability probe).
export type AgentProbeSettings = { mode: "auto" | "manual"; intervalMs: number; updatedAt: number; activePages: number };
export const getAgentProbeSettings = () => request<AgentProbeSettings>("/admin/agents/probe-settings");
export const updateAgentProbeSettings = (mode: "auto" | "manual", intervalMs: number) =>
  request<AgentProbeSettings>("/admin/agents/probe-settings", { method: "PATCH", body: payload({ mode, intervalMs }) });
export const checkAgentConnections = () =>
  request<{ sent: number }>("/admin/agents/probe", { method: "POST", body: "{}" });

export type ContainerPort = { private_port: number; public_port: number | null; protocol: "tcp" | "udp" | "sctp"; ip: string | null };
export type PoolContainer = {
  id: string; agentId: string; agentName: string; containerId: string; name: string;
  image: string; state: string; ports: ContainerPort[]; labels: Record<string, string>;
  composeProject: string | null; composeService: string | null; instanceId: string | null;
  lastSeenAt: number; snapshotAt: number | null; historical: boolean; stale: boolean;
  source: "managed" | "external";
};
export type AgentInventoryState = {
  agentId: string; name: string; revokedAt: number | null; updatedAt: number | null;
  containerCount: number | null; taskId: string | null; online: boolean;
  historical: boolean; stale: boolean;
};
export type DeployedAppInstance = {
  id: string; agentId: string; agentName: string; templateId: string;
  templateVersion: string; composeProject: string; createdAt: number; containerCount: number;
};
export const getContainerPool = (params: { agentId?: string; state?: string; source?: "managed" | "external"; search?: string; offset?: number; limit?: number } = {}) => {
  const query = new URLSearchParams();
  if (params.agentId) query.set("agentId", params.agentId);
  if (params.state) query.set("state", params.state);
  if (params.source) query.set("source", params.source);
  if (params.search) query.set("search", params.search);
  query.set("limit", String(params.limit ?? 100));
  query.set("offset", String(params.offset ?? 0));
  return request<{ total: number; containers: PoolContainer[] }>("/admin/containers?" + query.toString());
};
export const getContainerDetails = (id: string) =>
  request<{ container: PoolContainer }>("/admin/containers/" + encodeURIComponent(id));
export const getAgentInventories = () => request<{ agents: AgentInventoryState[] }>("/admin/agent-inventory");
export const refreshAgentInventory = (id: string) =>
  request<{ taskId: string }>("/admin/agents/" + encodeURIComponent(id) + "/inventory-refresh", { method: "POST", body: "{}" });
export const getDeployedAppInstances = () =>
  request<{ instances: DeployedAppInstance[] }>("/admin/app-instances");

export const claimComposeInstance = (agentId: string, composeProject: string) =>
  request<{ id: string }>("/admin/app-instances", {
    method: "POST", body: payload({ agentId, composeProject }),
  });
export const unclaimComposeInstance = (id: string) =>
  request<{ ok: boolean }>("/admin/app-instances/" + encodeURIComponent(id), { method: "DELETE" });

export const controlDockerContainer = (id: string, operation: "start" | "stop" | "restart", idempotencyKey: string) =>
  request<{ taskId: string }>("/admin/containers/" + encodeURIComponent(id) + "/action", {
    method: "POST", body: payload({ operation, idempotencyKey }),
  });
export const requestDockerLogs = (id: string) =>
  request<{ taskId: string }>("/admin/containers/" + encodeURIComponent(id) + "/logs", { method: "POST", body: "{}" });
export const getDockerTaskLogs = (taskId: string) =>
  request<{ taskId: string; status: string; lines: Array<{ sequence: number; line: string }> }>(
    "/admin/agent-tasks/" + encodeURIComponent(taskId) + "/logs",
  );

export type InventorySettings = { intervalMs: number; updatedAt: number };
export const getInventorySettings = () => request<InventorySettings>("/admin/inventory-settings");
export const updateInventorySettings = (intervalMs: number) =>
  request<InventorySettings>("/admin/inventory-settings", { method: "PATCH", body: payload({ intervalMs }) });
export const getAppInstanceDetails = (id: string) => request<{ instance: DeployedAppInstance & {
  installTaskId: string;
}; containers: PoolContainer[] }>("/admin/app-instances/" + encodeURIComponent(id));

// M3: built-in, audited template catalog. Preview validates data only;
// installation dispatch is intentionally NOT enabled until the durable task
// state machine and Agent Compose executor land in later M3 tasks.
export type CatalogParameterField = {
  type: "string" | "integer" | "boolean";
  title: string; description?: string; secret?: boolean;
  default?: string | number | boolean;
  enum?: Array<string | number>;
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
  format?: "plain" | "absolute-path" | "port";
};
export type CatalogTemplateSummary = {
  id: string; version: string; title: string; description: string;
  category: string; icon?: string; architectures: Array<"amd64" | "arm64">;
};
export type CatalogTemplateDetail = CatalogTemplateSummary & {
  parameters: {
    type: "object"; additionalProperties: false;
    required: string[]; properties: Record<string, CatalogParameterField>;
  };
  compose: { services: Array<{ name: string; image: string }> };
  navigation: { title: string; icon?: string; url?: string };
};
export type CatalogPreview = {
  valid: true; project: string;
  services: Array<{
    name: string; image: string; ports: string[];
    volumes: string[]; environmentKeys: string[];
  }>;
};
export const getApplicationCatalog = (search = "") =>
  request<{ templates: CatalogTemplateSummary[] }>(
    "/admin/catalog/templates" + (search ? "?search=" + encodeURIComponent(search) : ""),
  );
export const getApplicationTemplate = (id: string) =>
  request<{ template: CatalogTemplateDetail }>("/admin/catalog/templates/" + encodeURIComponent(id));
export const previewApplicationTemplate = (id: string, parameters: Record<string, string | number | boolean>) =>
  request<CatalogPreview>("/admin/catalog/templates/" + encodeURIComponent(id) + "/preview", {
    method: "POST", body: payload({ parameters }),
  });

export type InstallationPreflight = {
  ready: boolean; warnings: string[];
  templateId: string; templateVersion: string; agentId: string;
  navigation: NavigationDraft;
  services: Array<{ name: string; image: string; ports: string[] }>;
};
export const preflightApplicationInstall = (data: {
  agentId: string; templateId: string; templateVersion: string;
  parameters: Record<string, string | number | boolean>;
  navigation: NavigationDraft;
}) =>
  request<InstallationPreflight>("/admin/install/preflight", {
    method: "POST", body: payload(data),
  });

export const savePreparedInstallation = (data: {
  agentId: string; templateId: string; templateVersion: string;
  idempotencyKey: string;
  parameters: Record<string, string | number | boolean>;
  navigation: NavigationDraft;
}) =>
  request<{ taskId: string; status: "prepared"; created: boolean; dispatched: false; message: string }>(
    "/admin/install/prepared-tasks", { method: "POST", body: payload(data) },
  );

export type PreparedInstallTask = {
  id: string; agentId: string; agentName: string; templateId: string;
  templateVersion: string; navigationTitle: string; status: "prepared";
  createdAt: number; updatedAt: number;
};
export const getPreparedInstallations = () =>
  request<{ tasks: PreparedInstallTask[] }>("/admin/install/prepared-tasks");
