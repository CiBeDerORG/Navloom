<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  getApplicationCatalog, getApplicationTemplate, previewApplicationTemplate, preflightApplicationInstall, getAdminNavigation,
  type AgentDevice, type CatalogPreview, type CatalogTemplateDetail, type CatalogTemplateSummary,
  type NavigationDraft, type NavigationGroup, type InstallationPreflight,
} from "../lib/api";

const props = defineProps<{ agents: AgentDevice[] }>();
const catalog = ref<CatalogTemplateSummary[]>([]);
const query = ref("");
const selected = ref<CatalogTemplateDetail | null>(null);
const agentId = ref("");
const parameters = ref<Record<string, string | number | boolean>>({});
const preview = ref<CatalogPreview | null>(null);
const installPreflight = ref<InstallationPreflight | null>(null);
const navigation = ref<NavigationDraft>({ title: "", url: "", icon: null, description: null, groupId: null, openTarget: "_blank" });
const groups = ref<NavigationGroup[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const approved = ref(false);
const compatibleAgents = computed(() => props.agents.filter((agent) =>
  agent.status === "online" && !!agent.capabilities?.docker.available &&
  !!agent.capabilities?.compose.available &&
  !!selected.value?.architectures.includes(agent.architecture as "amd64" | "arm64")));
const parametersList = computed(() => Object.entries(selected.value?.parameters.properties ?? {}));
const required = (key: string) => !!selected.value?.parameters.required.includes(key);

async function loadCatalog() {
  loading.value = true;
  error.value = "";
  try {
    catalog.value = (await getApplicationCatalog()).templates;
    groups.value = (await getAdminNavigation()).groups;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法读取应用模板目录";
  } finally {
    loading.value = false;
  }
}
const shown = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return catalog.value.filter((entry) =>
    !needle || [entry.title, entry.id, entry.description, entry.category]
      .some((value) => value.toLocaleLowerCase().includes(needle)));
});

async function selectTemplate(id: string) {
  busy.value = true;
  error.value = "";
  preview.value = null;
  installPreflight.value = null;
  approved.value = false;
  parameters.value = {};
  try {
    const response = await getApplicationTemplate(id);
    selected.value = response.template;
    navigation.value = {
      title: response.template.navigation.title,
      url: response.template.navigation.url ?? "",
      icon: response.template.navigation.icon ?? response.template.icon ?? null,
      description: response.template.description.slice(0, 500) || null,
      groupId: null, openTarget: "_blank",
    };
    for (const [key, field] of Object.entries(response.template.parameters.properties)) {
      if (field.default !== undefined) parameters.value[key] = field.default;
      else if (field.type === "boolean") parameters.value[key] = false;
    }
    agentId.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "模板详情加载失败";
  } finally {
    busy.value = false;
  }
}
watch(parameters, () => {
  installPreflight.value = null;
  preview.value = null;
  approved.value = false;
}, { deep: true });
watch(agentId, () => { preview.value = null; installPreflight.value = null; approved.value = false; });
watch(navigation, () => { installPreflight.value = null; approved.value = false; }, { deep: true });

onMounted(() => { void loadCatalog(); });

function setValue(key: string, value: string | boolean, type: string) {
  if (type === "integer") {
    // Keep invalid numeric text out of the preview request. The form still
    // displays it so the user can correct the entry.
    const num = Number(value);
    parameters.value[key] = Number.isFinite(num) && String(value).trim() !== "" ? num : String(value);
  } else {
    parameters.value[key] = value;
  }
}

async function validatePreview() {
  if (!selected.value || busy.value) return;
  preview.value = null;
  error.value = "";
  if (!agentId.value) {
    error.value = "请选择在线且 Docker/Compose 可用的目标设备";
    return;
  }
  if (!compatibleAgents.value.some((agent) => agent.id === agentId.value)) {
    error.value = "设备已离线或不支持该模板的架构/能力";
    return;
  }
  busy.value = true;
  try {
    preview.value = await previewApplicationTemplate(selected.value.id, parameters.value);
    installPreflight.value = await preflightApplicationInstall({
      agentId: agentId.value, templateId: selected.value.id,
      templateVersion: selected.value.version, parameters: parameters.value,
      navigation: navigation.value,
    });
    approved.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "参数验证失败";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="rounded-2xl border border-white/10 bg-white/5 p-6" aria-labelledby="catalog-heading">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p class="text-xs font-semibold uppercase tracking-widest text-sky-400">M3 · BUILT-IN TEMPLATES</p>
        <h2 id="catalog-heading" class="mt-2 text-xl font-semibold">应用模板目录</h2>
        <p class="mt-2 text-sm text-slate-400">当前仅展示随 Navloom 发布、经过校验的内置 YAML 模板。暂不接收远端脚本或任意 Compose 输入。</p>
      </div>
      <button type="button" :disabled="loading" class="rounded-lg border border-white/20 px-3 py-2 text-sm disabled:opacity-50" @click="loadCatalog">刷新模板</button>
    </div>

    <p v-if="error" role="alert" class="mt-4 rounded-lg border border-rose-500/30 p-3 text-sm text-rose-300">{{ error }}</p>
    <p v-if="loading" role="status" class="mt-5 text-sm text-slate-400">正在读取模板…</p>
    <template v-else>
      <label for="catalog-search" class="mt-5 block text-sm text-slate-300">搜索应用模板</label>
      <input id="catalog-search" v-model="query" type="search" placeholder="名称、分类或描述"
        class="mt-2 w-full rounded-lg border border-white/20 bg-slate-950 px-3 py-2 text-sm" />
      <p v-if="shown.length === 0" class="mt-5 rounded-xl border border-dashed border-white/20 p-5 text-sm text-slate-400">没有匹配的可信模板。</p>
      <div v-else class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <button v-for="entry in shown" :key="entry.id" type="button" :disabled="busy"
          :aria-pressed="selected?.id === entry.id" @click="selectTemplate(entry.id)"
          class="rounded-xl border p-4 text-left transition disabled:opacity-50"
          :class="selected?.id === entry.id ? 'border-sky-400 bg-sky-500/10' : 'border-white/10 hover:border-white/30'">
          <span class="text-2xl">{{ entry.icon || "📦" }}</span>
          <span class="mt-2 block font-semibold">{{ entry.title }}</span>
          <span class="mt-1 block text-xs text-slate-400">{{ entry.category }} · v{{ entry.version }}</span>
          <span class="mt-2 block text-sm text-slate-400">{{ entry.description }}</span>
        </button>
      </div>
    </template>

    <section v-if="selected" class="mt-6 space-y-5 rounded-xl border border-white/15 p-5" aria-labelledby="catalog-detail">
      <div>
        <h3 id="catalog-detail" class="text-lg font-semibold">{{ selected.title }} · 配置检查</h3>
        <p class="mt-1 text-sm text-slate-400">支持 {{ selected.architectures.join(" / ") }}；涉及 {{ selected.compose.services.length }} 个 Compose 服务。</p>
      </div>
      <form class="space-y-4" @submit.prevent="validatePreview">
        <div>
          <label for="catalog-agent" class="block text-sm font-medium">目标 Agent</label>
          <select id="catalog-agent" v-model="agentId" required class="mt-2 w-full rounded-lg border border-white/20 bg-slate-950 p-2 text-sm">
            <option value="">请选择在线且支持该模板的设备</option>
            <option v-for="agent in compatibleAgents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
          </select>
          <p v-if="compatibleAgents.length === 0" class="mt-2 text-xs text-amber-300">
            当前没有具备完整 Docker/Compose 能力的在线 Agent。仍可浏览模板，但无法完成配置检查。
          </p>
        </div>
        <div v-for="[key, field] in parametersList" :key="key">
          <label :for="'catalog-field-' + key" class="block text-sm font-medium">
            {{ field.title }} <span v-if="required(key)" class="text-amber-300">*</span>
          </label>
          <p v-if="field.description" class="mt-1 text-xs text-slate-400">{{ field.description }}</p>
          <select v-if="field.enum" :id="'catalog-field-' + key"
            :value="String(parameters[key] ?? '')"
            class="mt-2 w-full rounded-lg border border-white/20 bg-slate-950 p-2 text-sm"
            @change="setValue(key, ($event.target as HTMLSelectElement).value, field.type)">
            <option v-if="!required(key)" value="">未设置</option>
            <option v-for="value in field.enum" :key="String(value)" :value="String(value)">{{ value }}</option>
          </select>
          <input v-else-if="field.type === 'boolean'" :id="'catalog-field-' + key" type="checkbox"
            :checked="Boolean(parameters[key])" class="mt-2 size-4"
            @change="setValue(key, ($event.target as HTMLInputElement).checked, field.type)" />
          <input v-else :id="'catalog-field-' + key"
            :type="field.secret ? 'password' : field.type === 'integer' ? 'number' : 'text'"
            :value="parameters[key] ?? ''" :required="required(key)"
            :min="field.type === 'integer' ? field.minimum : undefined"
            :max="field.type === 'integer' ? field.maximum : undefined"
            :minlength="field.type === 'string' ? field.minLength : undefined"
            :maxlength="field.type === 'string' ? field.maxLength : undefined"
            :autocomplete="field.secret ? 'new-password' : 'off'"
            class="mt-2 w-full rounded-lg border border-white/20 bg-slate-950 px-3 py-2 text-sm"
            @input="setValue(key, ($event.target as HTMLInputElement).value, field.type)" />
        </div>
        <fieldset class="space-y-3 rounded-lg border border-white/10 p-4">
          <legend class="px-1 text-sm font-semibold">部署成功后自动创建的导航卡片（可编辑草稿）</legend>
          <p class="text-xs text-slate-400">不会根据 EasyTier IP 或本机端口推断你的浏览器访问地址。此处仅编辑草稿，尚未保存导航卡片。</p>
          <div>
            <label for="catalog-nav-title" class="block text-sm">卡片名称</label>
            <input id="catalog-nav-title" v-model="navigation.title" maxlength="100" required
              class="mt-1 w-full rounded-lg border border-white/20 bg-slate-950 px-3 py-2 text-sm" />
          </div>
          <div>
            <label for="catalog-nav-url" class="block text-sm">实际访问 URL</label>
            <input id="catalog-nav-url" v-model="navigation.url" type="url" placeholder="https://你的实际访问域名或地址"
              maxlength="2048" class="mt-1 w-full rounded-lg border border-white/20 bg-slate-950 px-3 py-2 text-sm" />
          </div>
          <div>
            <label for="catalog-nav-icon" class="block text-sm">图标</label>
            <input id="catalog-nav-icon" v-model="navigation.icon" maxlength="512" placeholder="图标 Emoji 或 https:// 图片地址"
              class="mt-1 w-full rounded-lg border border-white/20 bg-slate-950 px-3 py-2 text-sm" />
          </div>
          <div>
            <label for="catalog-nav-description" class="block text-sm">卡片说明</label>
            <input id="catalog-nav-description" v-model="navigation.description" maxlength="500"
              class="mt-1 w-full rounded-lg border border-white/20 bg-slate-950 px-3 py-2 text-sm" />
          </div>
          <div>
            <label for="catalog-nav-group" class="block text-sm">导航分组</label>
            <select id="catalog-nav-group" v-model="navigation.groupId"
              class="mt-1 w-full rounded-lg border border-white/20 bg-slate-950 px-3 py-2 text-sm">
              <option :value="null">未分组</option>
              <option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option>
            </select>
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="navigation.openTarget" type="radio" value="_blank" /> 新标签页打开
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="navigation.openTarget" type="radio" value="_self" /> 当前标签页打开
          </label>
        </fieldset>
        <button type="submit" :disabled="busy || !agentId"
          class="rounded-lg bg-sky-500 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          {{ busy ? "验证中…" : "验证参数并预览" }}
        </button>
      </form>
      <div v-if="preview && approved" class="rounded-xl border border-sky-500/30 bg-sky-500/5 p-4 text-sm">
        <p class="font-medium text-emerald-300">模板参数与 Compose 结构校验通过</p>
        <p class="mt-2 break-all text-slate-300">示例项目名：{{ preview.project }}</p>
        <ul class="mt-3 list-inside list-disc space-y-1 text-slate-300">
          <li v-for="service in preview.services" :key="service.name">
            {{ service.name }} · {{ service.image }} · {{ service.ports.join(", ") || "无发布端口" }}
          </li>
        </ul>
        <p v-if="installPreflight" class="mt-3" :class="installPreflight.ready ? 'text-emerald-300' : 'text-amber-300'">
          {{ installPreflight.ready ? "目标 Agent 与参数初步预检通过；尚未创建安装任务。" : "仍有安装前事项需要处理：" }}
        </p>
        <ul v-if="installPreflight" class="mt-2 list-inside list-disc text-amber-300">
          <li v-for="warning in installPreflight.warnings" :key="warning">{{ warning }}</li>
        </ul>
        <p class="mt-3 text-amber-300">当前只是安全预览，尚未创建安装任务、写入服务器或启动任何 Docker 容器。正式安装功能将在 M3 后续任务开放。</p>
      </div>
    </section>
  </section>
</template>
