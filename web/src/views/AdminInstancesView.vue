<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import AdminShell from "../components/AdminShell.vue";
import {
  getAgents, issueAgentPairToken, renameAgent, revokeAgent, type AgentDevice,
} from "../lib/api";

const agents = ref<AgentDevice[]>([]);
const selectedId = ref("");
const busy = ref(false);
const loading = ref(true);
const error = ref("");
const notice = ref("");
const pairToken = ref("");
const pairExpiresAt = ref("");
const editingId = ref<string | null>(null);
const editingName = ref("");

const selected = computed(() => agents.value.find((agent) => agent.id === selectedId.value) ?? null);

async function refresh() {
  const result = await getAgents();
  agents.value = result.agents;
  if (selectedId.value && !agents.value.some((agent) => agent.id === selectedId.value)) selectedId.value = "";
}

async function load() {
  loading.value = true;
  try {
    await refresh();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法加载设备列表";
  } finally {
    loading.value = false;
  }
}

async function perform(action: () => Promise<void>, success: string) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await action();
    await refresh();
    notice.value = success;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "操作失败";
  } finally {
    busy.value = false;
  }
}

async function issueToken() {
  pairToken.value = "";
  pairExpiresAt.value = "";
  await perform(async () => {
    const result = await issueAgentPairToken();
    pairToken.value = result.token;
    pairExpiresAt.value = result.expiresAt;
  }, "一次性接入令牌已生成；请立即在 Agent 设备上使用。");
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(pairToken.value);
    notice.value = "已复制接入令牌。粘贴到 Agent 的标准输入后请清除剪贴板。";
  } catch {
    error.value = "无法复制，请手动选择并复制令牌。";
  }
}

function beginRename(agent: AgentDevice) {
  editingId.value = agent.id;
  editingName.value = agent.name;
}

async function saveRename() {
  const id = editingId.value;
  if (!id) return;
  await perform(() => renameAgent(id, editingName.value), "设备名称已保存");
  if (!error.value) editingId.value = null;
}

async function revoke(agent: AgentDevice) {
  if (!window.confirm(`撤销设备「${agent.name}」的接入凭据？旧凭据将无法重新连接，操作不可撤销。`)) return;
  await perform(() => revokeAgent(agent.id), "设备凭据已撤销。");
}

function formatDate(value: number | null) {
  return value === null ? "—" : new Date(value).toLocaleString();
}

onMounted(() => { void load(); });
</script>

<template>
  <AdminShell>
    <header>
      <p class="text-xs font-semibold tracking-widest text-sky-400">DEVICES & APPLICATIONS</p>
      <h1 class="mt-2 text-3xl font-semibold">应用实例管理</h1>
      <p class="mt-2 text-sm text-slate-400">
        M2 首批已接入 Agent 安全配对与设备登记。WSS、在线心跳、容器池及 Docker 操作仍待实现。
      </p>
    </header>

    <p v-if="error" role="alert" class="rounded-lg border border-rose-500/30 p-3 text-rose-300">{{ error }}</p>
    <p v-if="notice" role="status" class="rounded-lg border border-emerald-500/30 p-3 text-emerald-300">{{ notice }}</p>

    <section class="rounded-2xl border border-white/10 bg-white/5 p-6">
      <h2 class="text-xl font-semibold">接入新 Agent</h2>
      <p class="mt-2 text-sm leading-6 text-slate-400">
        管理员签发 10 分钟有效、只能使用一次的接入令牌。Server 只存令牌摘要；令牌仅在本次页面中显示。
      </p>
      <button type="button" :disabled="busy" class="mt-5 rounded-lg bg-sky-500 px-4 py-2.5 font-semibold text-white hover:bg-sky-600 disabled:opacity-50" @click="issueToken">
        {{ busy ? "处理中…" : "生成一次性接入令牌" }}
      </button>
      <div v-if="pairToken" class="mt-5 space-y-3 rounded-xl border border-amber-400/30 bg-amber-400/5 p-4">
        <p class="text-sm font-medium text-amber-200">此令牌只显示一次，请勿发送到公开聊天或日志。</p>
        <label class="block text-xs text-slate-400" for="agent-pair-token">一次性接入令牌</label>
        <textarea id="agent-pair-token" :value="pairToken" readonly rows="2" spellcheck="false"
          class="w-full break-all rounded-lg border border-white/20 bg-slate-950 p-3 font-mono text-sm" />
        <div class="flex flex-wrap items-center justify-between gap-3">
          <span class="text-xs text-slate-400">到期：{{ pairExpiresAt ? new Date(pairExpiresAt).toLocaleString() : "—" }}</span>
          <div class="flex gap-3">
            <button type="button" class="rounded-lg border border-white/20 px-3 py-2 text-sm" @click="copyToken">复制</button>
            <button type="button" class="rounded-lg border border-white/20 px-3 py-2 text-sm" @click="pairToken = ''">关闭显示</button>
          </div>
        </div>
      </div>
      <p class="mt-5 text-sm text-slate-400">
        在设备上设置 <code>NAVLOOM_SERVER_URL=wss://你的域名/agent</code> 和
        <code>NAVLOOM_AGENT_TOKEN_FILE</code>，通过标准输入执行 <code>navloom-agent -pair</code>。
        完整命令与安全说明见仓库 <code>agent/README.md</code>。
      </p>
    </section>

    <section class="rounded-2xl border border-white/10 bg-white/5 p-6">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-xl font-semibold">已登记设备</h2>
        <button type="button" :disabled="busy || loading" class="rounded-lg border border-white/20 px-3 py-2 text-sm disabled:opacity-50" @click="load">刷新</button>
      </div>
      <p v-if="loading" class="mt-6 text-sm text-slate-400" role="status">正在加载设备…</p>
      <p v-else-if="agents.length === 0" class="mt-6 rounded-lg border border-dashed border-white/20 p-6 text-center text-slate-400">
        暂无已配对设备。先生成一次性令牌，在 NAS/Linux 设备上完成配对。
      </p>
      <div v-else class="mt-5 grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div class="space-y-2" aria-label="Agent 设备列表">
          <button v-for="agent in agents" :key="agent.id" type="button" @click="selectedId = agent.id"
            :aria-pressed="selectedId === agent.id"
            class="flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border p-4 text-left"
            :class="selectedId === agent.id ? 'border-sky-400 bg-sky-400/10' : 'border-white/10 hover:border-white/30'">
            <span class="min-w-0"><span class="block truncate font-semibold">{{ agent.name }}</span>
              <span class="block text-xs text-slate-400">{{ agent.platform || "未知系统" }} / {{ agent.architecture || "未知架构" }}</span></span>
            <span class="rounded-full border border-white/20 px-2 py-1 text-xs" :class="agent.status === 'revoked' ? 'text-rose-300' : 'text-amber-300'">
              {{ agent.status === "revoked" ? "已撤销" : "离线 · 待 WSS 接入" }}
            </span>
          </button>
        </div>
        <div v-if="selected" class="min-w-0 space-y-4 rounded-xl border border-white/10 p-5">
          <h3 class="text-lg font-semibold">{{ selected.name }}</h3>
          <dl class="space-y-2 text-sm">
            <div><dt class="text-slate-400">Agent ID</dt><dd class="break-all font-mono text-xs">{{ selected.id }}</dd></div>
            <div><dt class="text-slate-400">版本</dt><dd>{{ selected.version || "—" }}</dd></div>
            <div><dt class="text-slate-400">登记时间</dt><dd>{{ formatDate(selected.registeredAt) }}</dd></div>
            <div><dt class="text-slate-400">最后通信</dt><dd>{{ formatDate(selected.lastSeenAt) }}</dd></div>
          </dl>
          <form v-if="editingId === selected.id" class="flex flex-wrap gap-2" @submit.prevent="saveRename">
            <label class="sr-only" for="agent-name">设备名称</label>
            <input id="agent-name" v-model="editingName" required maxlength="80"
              class="min-w-0 flex-1 rounded-lg border border-white/20 bg-slate-950 px-3 py-2" />
            <button :disabled="busy" class="rounded-lg bg-sky-500 px-3 py-2 text-sm disabled:opacity-50">保存</button>
            <button type="button" class="rounded-lg border border-white/20 px-3 py-2 text-sm" @click="editingId = null">取消</button>
          </form>
          <div v-else-if="selected.status !== 'revoked'" class="flex flex-wrap gap-3">
            <button type="button" class="rounded-lg border border-white/20 px-3 py-2 text-sm" @click="beginRename(selected)">重命名</button>
            <button type="button" :disabled="busy" class="rounded-lg border border-rose-500/30 px-3 py-2 text-sm text-rose-300 disabled:opacity-50" @click="revoke(selected)">撤销凭据</button>
          </div>
        </div>
        <p v-else class="text-sm text-slate-400">选择左侧设备查看详情。</p>
      </div>
    </section>

    <section class="rounded-2xl border border-dashed border-white/20 p-5 text-sm text-slate-400">
      <h2 class="font-semibold text-slate-200">容器池与应用实例</h2>
      <p class="mt-2">等待后续 M2 WSS、Docker 发现和实例查询。配对设备不会自动创建导航卡片，也不代表 Docker 已可操作。</p>
    </section>
  </AdminShell>
</template>
