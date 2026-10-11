<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { getSystemStatus } from "../lib/api";

const serverStatus = ref("正在检查 Server…");

onMounted(async () => {
  try {
    await getSystemStatus();
    serverStatus.value = "Server 已连接（M0）";
  } catch {
    serverStatus.value = "Server 未连接";
  }
});
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-slate-100">
    <div class="mx-auto max-w-5xl px-5 py-8">
      <header class="flex items-center justify-between">
        <span class="text-2xl font-semibold tracking-tight">Navloom</span>
        <RouterLink
          to="/admin/login"
          class="rounded-lg border border-white/20 px-4 py-2 text-sm transition hover:bg-white/10"
        >
          管理
        </RouterLink>
      </header>
      <main class="py-20">
        <p class="mb-4 text-xs font-medium tracking-[0.25em] text-sky-300">NAVIGATION FIRST</p>
        <h1 class="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
          你的应用导航，从这里开始。
        </h1>
        <p class="mt-5 max-w-2xl leading-7 text-slate-400">
          首页将只展示你亲自编排的导航卡片。现阶段是 M0 工程骨架，导航卡片、首页弱口令和管理功能将在 M1 实现。
        </p>
        <div class="mt-10 rounded-2xl border border-dashed border-white/20 bg-white/5 p-10 text-center">
          <p class="text-slate-300">尚无导航卡片</p>
          <p class="mt-2 text-sm text-slate-500">这里不会自动展示 Agent 发现的全部容器。</p>
        </div>
        <p class="mt-6 text-xs text-slate-500">{{ serverStatus }}</p>
      </main>
    </div>
  </div>
</template>
