<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  getAgentInventories, getContainerPool, getDeployedAppInstances, refreshAgentInventory,
  getAgentTask, type AgentInventoryState, type PoolContainer, type DeployedAppInstance,
} from "../lib/api";

const devices = ref<AgentInventoryState[]>([]);
const containers = ref<PoolContainer[]>([]);
const instances = ref<DeployedAppInstance[]>([]);
const agentId = ref("");
const state = ref("");
const search = ref("");
const offset = ref(0);
const total = ref(0);
const loading = ref(false);
const busy = ref("");
const notice = ref("");
const error = ref("");
const selectedId = ref("");
const selected = computed(() => containers.value.find(c => c.id === selectedId.value));
const perPage = 50;

const stamp = (value: number | null) => value ? new Date(value).toLocaleString() : "尚无快照";
function ports(row: PoolContainer) {
  return row.ports.map(p => (p.ip || "*") + ":" + (p.public_port || "-") + " → " + p.private_port + "/" + p.protocol).join("、") || "未暴露端口";
}
async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [pool, inv, apps] = await Promise.all([
      getContainerPool({ agentId: agentId.value || undefined, state: state.value || undefined,
        search: search.value.trim() || undefined, offset: offset.value, limit: perPage }),
      getAgentInventories(), getDeployedAppInstances(),
    ]);
    containers.value = pool.containers;
    devices.value = inv.agents;
    instances.value = apps.instances;
    total.value = pool.total;
    if (!containers.value.some(row => row.id === selectedId.value)) selectedId.value = "";
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "容器池加载失败"; }
  finally { loading.value = false; }
}
async function refresh(device: AgentInventoryState) {
  if (busy.value || !device.online || device.revokedAt !== null) return;
  busy.value = device.agentId;
  notice.value = "";
  error.value = "";
  try {
    const { taskId } = await refreshAgentInventory(device.agentId);
    notice.value = "已提交只读容器扫描任务：" + taskId.slice(0, 8);
    // Refresh after a bounded observation; the page never initiates a
    // second inventory task or an Agent-side polling loop.
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setTimeout(resolve, 600));
      const result = await getAgentTask(taskId);
      if (result.task.status === "succeeded") { notice.value = device.name + " 容器快照已更新"; break; }
      if (result.task.status === "failed" || result.task.status === "unknown") {
        notice.value = "任务状态：" + result.task.status + "（旧快照保留）";
        break;
      }
    }
    await load();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : "扫描失败"; }
  finally { busy.value = ""; }
}
function query() { offset.value = 0; void load(); }
onMounted(() => { void load(); });
</script>

<template>
  <section class="space-y-4 rounded-2xl border border-white/15 bg-slate-900/40 p-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-semibold text-slate-100">Docker 容器池</h2>
        <p class="mt-1 text-xs text-slate-400">仅管理员可查看或手动扫描；断线时保留历史快照，不自动连接 Docker。</p>
      </div>
      <button class="rounded-lg border border-white/20 px-3 py-2 text-sm" :disabled="loading" @click="load">重新加载</button>
    </div>
    <div class="grid gap-2 md:grid-cols-3" v-if="devices.length">
      <div v-for="device in devices" :key="device.agentId" class="rounded-xl border border-white/15 p-3 text-sm">
        <div class="flex justify-between gap-2"><strong>{{ device.name }}</strong>
          <span :class="device.online ? 'text-emerald-300' : 'text-amber-300'">{{ device.online ? '已连接' : '历史状态' }}</span>
        </div>
        <div class="mt-2 text-slate-400">容器：{{ device.containerCount ?? '未扫描' }} · {{ device.stale ? '快照过期/未知' : '快照有效' }}</div>
        <div class="mt-1 text-xs text-slate-500">{{ stamp(device.updatedAt) }}</div>
        <button class="mt-3 rounded-lg border border-sky-500/40 px-3 py-1 text-sm disabled:opacity-40"
          :disabled="!device.online || !!busy || device.revokedAt !== null" @click="refresh(device)">
          {{ busy === device.agentId ? '正在扫描…' : '扫描全部容器（只读）' }}
        </button>
      </div>
    </div>
    <form class="flex flex-wrap items-center gap-2" @submit.prevent="query">
      <input v-model="search" maxlength="100" placeholder="搜索名称、镜像、设备"
        class="min-w-0 flex-1 rounded-lg border border-white/20 bg-slate-950 px-3 py-2 text-sm" />
      <select v-model="agentId" class="rounded-lg border border-white/20 bg-slate-950 px-3 py-2 text-sm" aria-label="设备">
        <option value="">全部设备</option><option v-for="device in devices" :key="device.agentId" :value="device.agentId">{{ device.name }}</option>
      </select>
      <select v-model="state" class="rounded-lg border border-white/20 bg-slate-950 px-3 py-2 text-sm" aria-label="容器状态">
        <option value="">全部状态</option>
        <option v-for="value in ['running','exited','paused','restarting','created','dead','unknown']" :key="value" :value="value">{{ value }}</option>
      </select>
      <button class="rounded-lg bg-sky-600 px-3 py-2 text-sm">筛选</button>
    </form>
    <p v-if="error" role="alert" class="text-sm text-rose-300">{{ error }}</p>
    <p v-if="notice" role="status" class="text-sm text-emerald-300">{{ notice }}</p>
    <p class="text-xs text-slate-400">匹配 {{ total }} 个容器；当前页 {{ containers.length }} 个</p>
    <div class="overflow-x-auto">
      <table class="w-full text-left text-sm">
        <thead class="border-b border-white/20 text-slate-400"><tr>
          <th class="p-2">容器 / 镜像</th><th class="p-2">设备 / Compose</th>
          <th class="p-2">状态</th><th class="p-2">端口</th><th class="p-2">快照</th>
        </tr></thead>
        <tbody>
          <tr v-for="row in containers" :key="row.id" class="border-b border-white/10">
            <td class="p-2"><button class="font-medium text-sky-300 underline" @click="selectedId = selectedId === row.id ? '' : row.id">{{ row.name }}</button>
              <div class="max-w-52 truncate text-xs text-slate-500" :title="row.image">{{ row.image }}</div></td>
            <td class="p-2">{{ row.agentName }}<div class="text-xs text-slate-500">{{ row.composeProject || '独立容器' }}{{ row.composeService ? ' / ' + row.composeService : '' }}</div></td>
            <td class="p-2">{{ row.state }}</td><td class="p-2 text-xs">{{ ports(row) }}</td>
            <td class="p-2 text-xs" :class="row.stale || row.historical ? 'text-amber-300' : 'text-emerald-300'">{{ row.historical ? '历史 · ' : '' }}{{ row.stale ? '过期' : '有效' }}</td>
          </tr>
          <tr v-if="!loading && !containers.length"><td colspan="5" class="p-5 text-center text-slate-400">没有快照或没有匹配的容器。</td></tr>
        </tbody>
      </table>
    </div>
    <div v-if="selected" class="rounded-xl border border-white/15 p-3 text-sm">
      <h3 class="font-semibold">容器详情 · {{ selected.name }}</h3>
      <p class="mt-2 break-all text-xs text-slate-400">ID：{{ selected.containerId }}</p>
      <p class="mt-1 text-xs">上次扫描：{{ stamp(selected.lastSeenAt) }} · 应用实例：{{ selected.instanceId || '未关联' }}</p>
      <pre class="mt-3 max-h-36 overflow-auto whitespace-pre-wrap break-all text-xs text-slate-400">{{ JSON.stringify(selected.labels, null, 2) }}</pre>
    </div>
    <div class="flex justify-between gap-2">
      <button class="rounded-lg border border-white/20 px-3 py-1 text-sm disabled:opacity-40" :disabled="loading || offset === 0" @click="offset = Math.max(0, offset - perPage); load()">上一页</button>
      <button class="rounded-lg border border-white/20 px-3 py-1 text-sm disabled:opacity-40" :disabled="loading || offset + perPage >= total" @click="offset += perPage; load()">下一页</button>
    </div>
    <h3 class="border-t border-white/10 pt-3 text-sm font-semibold">已部署应用实例（按 Agent + Compose 项目关联）</h3>
    <p v-if="!instances.length" class="text-xs text-slate-400">尚无已登记实例。容器发现不会自动创建部署记录。</p>
    <div v-for="app in instances" :key="app.id" class="flex justify-between gap-2 rounded-lg border border-white/10 p-2 text-xs">
      <span>{{ app.agentName }} / {{ app.composeProject }} · {{ app.templateId }}@{{ app.templateVersion }}</span>
      <span>关联容器 {{ app.containerCount }}</span>
    </div>
  </section>
</template>
