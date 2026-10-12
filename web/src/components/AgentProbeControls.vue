<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { checkAgentConnections, getAgentProbeSettings, updateAgentProbeSettings } from "../lib/api";

type SettingsEvent = { mode: "auto" | "manual"; intervalMs: number };

const mode = ref<"auto" | "manual">("manual");
const intervalMs = ref(30_000);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const notice = ref("");

function syncSettings(event: Event): void {
  const settings = (event as CustomEvent<SettingsEvent>).detail;
  if (settings && (settings.mode === "auto" || settings.mode === "manual") &&
      Number.isInteger(settings.intervalMs)) {
    mode.value = settings.mode;
    intervalMs.value = settings.intervalMs;
  }
}

async function load(): Promise<void> {
  try {
    const settings = await getAgentProbeSettings();
    mode.value = settings.mode;
    intervalMs.value = settings.intervalMs;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "读取全局连接设置失败";
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const settings = await updateAgentProbeSettings(mode.value, intervalMs.value);
    mode.value = settings.mode;
    intervalMs.value = settings.intervalMs;
    notice.value = "已同步到所有在线管理员页面。";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "保存设置失败";
  } finally {
    busy.value = false;
  }
}

async function probe(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const result = await checkAgentConnections();
    notice.value = "已向 " + result.sent + " 台 Agent 发送 WSS Ping。";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "连接检测失败";
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  window.addEventListener("navloom-probe-settings", syncSettings);
  void load();
});
onUnmounted(() => window.removeEventListener("navloom-probe-settings", syncSettings));
</script>

<template>
  <details class="rounded-xl border border-sky-400/30 bg-sky-400/5 px-4 py-3" aria-label="全局 Agent 连接检测">
    <summary class="cursor-pointer select-none text-sm font-medium text-sky-200">
      Agent 连接检测 <span class="ml-2 text-xs font-normal text-slate-400">全局共享 · {{ mode === "auto" ? "自动" : "手动" }}</span>
    </summary>
    <div class="mt-4 flex flex-wrap items-end gap-3 text-sm">
      <label>检测模式
        <select v-model="mode" :disabled="loading || busy" class="mt-1 block rounded-lg border border-white/20 bg-slate-900 px-3 py-2">
          <option value="manual">手动</option>
          <option value="auto">自动</option>
        </select>
      </label>
      <label>自动检测间隔
        <select v-model.number="intervalMs" :disabled="loading || busy || mode !== 'auto'" class="mt-1 block rounded-lg border border-white/20 bg-slate-900 px-3 py-2 disabled:opacity-50">
          <option :value="5000">5 秒</option>
          <option :value="10000">10 秒</option>
          <option :value="15000">15 秒</option>
          <option :value="30000">30 秒</option>
          <option :value="60000">60 秒</option>
          <option :value="120000">120 秒</option>
        </select>
      </label>
      <button type="button" :disabled="loading || busy" class="rounded-lg border border-white/20 px-3 py-2 disabled:opacity-50" @click="save">保存设置</button>
      <button type="button" :disabled="loading || busy" class="rounded-lg bg-sky-500 px-3 py-2 font-semibold text-slate-950 disabled:opacity-50" @click="probe">检测连接</button>
    </div>
    <p class="mt-3 text-xs text-slate-400">所有已登录页面（含导航页）共同维持一套 Server→Agent WSS。手动模式不自动 Ping；此按钮不执行 Docker 任务。</p>
    <p v-if="error" role="alert" class="mt-2 text-sm text-rose-300">{{ error }}</p>
    <p v-if="notice" role="status" class="mt-2 text-sm text-emerald-300">{{ notice }}</p>
  </details>
</template>
