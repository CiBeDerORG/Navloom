import { SystemStatusSchema, type SystemStatus } from "@navloom/contracts";

export async function getSystemStatus(): Promise<SystemStatus> {
  const response = await fetch("/api/v1/system/status", { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error("Server 状态接口不可用");
  }
  return SystemStatusSchema.parse(await response.json());
}
