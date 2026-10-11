<script setup lang="ts">
import { RouterLink, useRouter } from "vue-router";
import { logoutAdmin } from "../lib/api";

const router = useRouter();
async function logout() {
  try {
    await logoutAdmin();
  } finally {
    await router.replace("/admin/login");
  }
}
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-slate-100">
    <header class="border-b border-white/10">
      <div class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-5">
        <RouterLink class="text-xl font-bold tracking-tight" to="/">Navloom<span class="text-sky-400">.</span></RouterLink>
        <nav aria-label="管理模块" class="flex flex-wrap gap-2 text-sm">
          <RouterLink class="rounded-lg px-3 py-2 hover:bg-white/10" to="/admin/navigation">导航页管理</RouterLink>
          <RouterLink class="rounded-lg px-3 py-2 hover:bg-white/10" to="/admin/instances">应用实例管理</RouterLink>
        </nav>
        <div class="flex items-center gap-3 text-sm">
          <RouterLink class="text-slate-400 hover:text-sky-300" to="/admin/settings">设置</RouterLink>
          <button type="button" class="rounded-lg border border-white/20 px-3 py-2 hover:bg-white/10" @click="logout">退出登录</button>
        </div>
      </div>
    </header>
    <main class="mx-auto max-w-6xl space-y-6 px-5 py-10">
      <slot />
    </main>
  </div>
</template>
