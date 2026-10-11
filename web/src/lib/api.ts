import { SystemStatusSchema, type SystemStatus } from "@navloom/contracts";

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
export const unlockHome = (passphrase: string) => request<{ ok: boolean }>("/auth/home/unlock", { method: "POST", body: payload({ passphrase }) });
export const getPublicNavigation = () => request<PublicNavigation>("/home/navigation");
export const getAdminSession = () => request<AdminSession>("/auth/admin/session");
export const loginAdmin = (username: string, password: string) => request<{ ok: boolean }>("/auth/admin/login", { method: "POST", body: payload({ username, password }) });
export const logoutAdmin = () => request<{ ok: boolean }>("/auth/admin/logout", { method: "POST", body: "{}" });
export const changeAdminPassword = (currentPassword: string, newPassword: string) => request<{ ok: boolean }>("/admin/settings/password", { method: "PATCH", body: payload({ currentPassword, newPassword }) });
export const changeHomePassphrase = (passphrase: string) => request<{ ok: boolean }>("/admin/settings/home-passphrase", { method: "PATCH", body: payload({ passphrase }) });
export const revokeHomeCredentials = () => request<{ ok: boolean }>("/admin/settings/home/revoke", { method: "POST", body: "{}" });

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
  revokedAt: number | null; status: "online" | "offline" | "revoked";
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
