<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { ApiError, getHomeStatus, getPublicNavigation, iconIsUrl, unlockHome, type PublicNavigation } from "../lib/api";

const loading = ref(true);
const unlocking = ref(false);
const authorized = ref(false);
const configured = ref(true);
const passphrase = ref("");
const search = ref("");
const error = ref("");
const data = ref<PublicNavigation>({ groups: [], ungrouped: [] });
const theme = ref<"dark" | "light">("dark");

const match = (card: { title: string; description: string | null }) =>
  (card.title + " " + (card.description ?? "")).toLowerCase().includes(search.value.trim().toLowerCase());
const groups = computed(() => data.value.groups.map((group) => ({ ...group, cards: group.cards.filter(match) })).filter((group) => !search.value || group.cards.length > 0));
const ungrouped = computed(() => data.value.ungrouped.filter(match));
const totalCards = computed(() => data.value.groups.reduce((sum, group) => sum + group.cards.length, data.value.ungrouped.length));
const visibleCards = computed(() => groups.value.reduce((sum, group) => sum + group.cards.length, ungrouped.value.length));

async function loadNavigation() {
  try {
    data.value = await getPublicNavigation();
    authorized.value = true;
    error.value = "";
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) authorized.value = false;
    else error.value = cause instanceof Error ? cause.message : "无法读取导航";
  }
}
async function checkAccess() {
  loading.value = true;
  try {
    const status = await getHomeStatus();
    configured.value = status.configured;
    authorized.value = status.authenticated;
    if (authorized.value) await loadNavigation();
  } catch {
    error.value = "无法连接 Navloom Server，请检查服务是否已启动。";
  } finally {
    loading.value = false;
  }
}
async function unlock() {
  if (unlocking.value) return;
  unlocking.value = true;
  error.value = "";
  try {
    await unlockHome(passphrase.value);
    passphrase.value = "";
    await loadNavigation();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "验证失败";
  } finally {
    unlocking.value = false;
  }
}
function toggleTheme() {
  theme.value = theme.value === "dark" ? "light" : "dark";
  localStorage.setItem("navloom-theme", theme.value);
}
onMounted(() => {
  theme.value = localStorage.getItem("navloom-theme") === "light" ? "light" : "dark";
  void checkAccess();
});
</script>

<template>
  <div :class="theme === 'dark' ? 'min-h-screen bg-slate-950 text-slate-100' : 'min-h-screen bg-slate-50 text-slate-900'">
    <div class="mx-auto max-w-6xl px-5 py-7 sm:px-8">
      <header class="flex flex-wrap items-center justify-between gap-3">
        <RouterLink to="/" class="text-2xl font-bold tracking-tight">Navloom<span class="text-sky-400">.</span></RouterLink>
        <nav class="flex items-center gap-3 text-sm">
          <button type="button" class="rounded-lg border border-slate-500/30 px-3 py-2 hover:bg-sky-500/10" @click="toggleTheme">
            {{ theme === "dark" ? "☀ 浅色" : "☾ 深色" }}
          </button>
          <RouterLink to="/admin/navigation" class="rounded-lg border border-slate-500/30 px-4 py-2 hover:bg-sky-500/10">管理后台 →</RouterLink>
        </nav>
      </header>

      <main v-if="loading" class="py-24 text-center opacity-70" role="status">正在验证访问权限…</main>

      <main v-else-if="!authorized" class="mx-auto mt-20 max-w-md">
        <section class="rounded-2xl border border-slate-500/20 bg-sky-500/5 p-7 shadow-lg">
          <p class="text-xs font-semibold tracking-[0.25em] text-sky-400">PRIVATE NAVIGATION</p>
          <h1 class="mt-4 text-3xl font-semibold">欢迎回到 Navloom</h1>
          <p class="mt-3 text-sm opacity-70">首次访问此浏览器需要输入首页口令。验证后会记住此浏览器，无须重复输入。</p>
          <form v-if="configured" class="mt-7 space-y-4" @submit.prevent="unlock">
            <label class="block text-sm font-medium" for="home-passphrase">首页访问口令</label>
            <input id="home-passphrase" v-model="passphrase" type="password" autocomplete="current-password" required maxlength="128" autofocus
              class="w-full rounded-xl border border-slate-500/40 bg-transparent px-4 py-3 outline-none focus:border-sky-400" placeholder="请输入口令" />
            <p v-if="error" role="alert" class="text-sm text-rose-400">{{ error }}</p>
            <button :disabled="unlocking" class="w-full rounded-xl bg-sky-500 px-4 py-3 font-semibold text-white hover:bg-sky-600 disabled:opacity-60">
              {{ unlocking ? "验证中…" : "进入导航首页" }}
            </button>
          </form>
          <p v-else class="mt-6 text-sm text-amber-400">管理员尚未设置首页口令，请先在本机完成初始化。</p>
          <p v-if="error && !configured" role="alert" class="mt-4 text-sm text-rose-400">{{ error }}</p>
          <RouterLink to="/admin/login" class="mt-6 inline-block text-sm text-sky-400 hover:underline">管理员登录</RouterLink>
        </section>
      </main>

      <main v-else class="py-14">
        <p class="text-xs font-semibold tracking-[0.28em] text-sky-400">YOUR SPACE · YOUR LINKS</p>
        <h1 class="mt-4 text-3xl font-bold tracking-tight sm:text-5xl">你的应用，都在这里。</h1>
        <p class="mt-4 text-sm opacity-60">只展示你添加的导航入口，不会自动列出 Docker 容器。</p>
        <div class="mt-10 max-w-lg">
          <label for="nav-search" class="sr-only">搜索导航卡片</label>
          <input id="nav-search" v-model="search" type="search" placeholder="⌕ 搜索应用或链接…"
            class="w-full rounded-xl border border-slate-500/30 bg-slate-500/10 px-5 py-3.5 outline-none focus:border-sky-400" />
        </div>
        <p v-if="error" role="alert" class="mt-5 text-sm text-rose-400">{{ error }}</p>
        <section v-if="totalCards === 0" class="mt-10 rounded-2xl border border-dashed border-slate-500/30 p-12 text-center">
          <h2 class="text-xl font-semibold">还没有导航卡片</h2>
          <p class="mt-3 text-sm opacity-60">进入导航页管理，添加第一个常用网站或服务。</p>
          <RouterLink to="/admin/navigation" class="mt-5 inline-block text-sky-400 hover:underline">去添加导航 →</RouterLink>
        </section>
        <p v-else-if="visibleCards === 0" class="mt-12 text-sm opacity-60">没有匹配的导航卡片。</p>

        <section v-for="group in groups" :key="group.id" class="mt-12">
          <h2 class="mb-5 text-lg font-semibold">{{ group.name }}</h2>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <a v-for="card in group.cards" :key="card.id" :href="card.url" :target="card.openTarget" :rel="card.openTarget === '_blank' ? 'noopener noreferrer' : undefined"
              class="group flex min-h-28 items-start gap-4 rounded-2xl border border-slate-500/20 bg-slate-500/5 p-5 transition hover:-translate-y-0.5 hover:border-sky-400/60 hover:bg-sky-500/10 focus-visible:outline-2 focus-visible:outline-sky-400">
              <span class="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-sky-500/10 text-2xl">
                <img v-if="iconIsUrl(card.icon)" :src="card.icon!" :alt="card.title + ' 图标'" class="h-10 w-10 object-contain" />
                <span v-else>{{ card.icon || "↗" }}</span>
              </span>
              <span class="min-w-0"><span class="block truncate font-semibold">{{ card.title }}</span><span v-if="card.description" class="mt-1 line-clamp-2 block text-sm opacity-60">{{ card.description }}</span></span>
            </a>
          </div>
        </section>

        <section v-if="ungrouped.length" class="mt-12">
          <h2 class="mb-5 text-lg font-semibold">未分组</h2>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            <a v-for="card in ungrouped" :key="card.id" :href="card.url" :target="card.openTarget" :rel="card.openTarget === '_blank' ? 'noopener noreferrer' : undefined"
              class="flex min-h-28 items-start gap-4 rounded-2xl border border-slate-500/20 bg-slate-500/5 p-5 transition hover:-translate-y-0.5 hover:border-sky-400/60 hover:bg-sky-500/10 focus-visible:outline-2 focus-visible:outline-sky-400">
              <span class="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-sky-500/10 text-2xl">
                <img v-if="iconIsUrl(card.icon)" :src="card.icon!" :alt="card.title + ' 图标'" class="h-10 w-10 object-contain" />
                <span v-else>{{ card.icon || "↗" }}</span>
              </span>
              <span class="min-w-0"><span class="block truncate font-semibold">{{ card.title }}</span><span v-if="card.description" class="mt-1 line-clamp-2 block text-sm opacity-60">{{ card.description }}</span></span>
            </a>
          </div>
        </section>
      </main>
    </div>
  </div>
</template>
