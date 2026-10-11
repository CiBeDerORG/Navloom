<script setup lang="ts">
import { RouterLink } from "vue-router";
</script>

<template>
  <div class="min-h-screen bg-slate-950 text-slate-100">
    <header class="border-b border-white/10">
      <div class="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-5 py-5">
        <RouterLink class="text-xl font-semibold tracking-tight" to="/">Navloom</RouterLink>
        <nav class="flex flex-wrap gap-2 text-sm">
          <RouterLink class="rounded-lg px-3 py-2 hover:bg-white/10" to="/admin/navigation">
            导航页管理
          </RouterLink>
          <RouterLink class="rounded-lg px-3 py-2 hover:bg-white/10" to="/admin/instances">
            应用实例管理
          </RouterLink>
        </nav>
      </div>
    </header>
    <main class="mx-auto max-w-5xl space-y-5 px-5 py-10">
      <p class="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">
        M0 开发占位界面：管理员认证和管理 API 尚未实现，禁止部署到公网。
      </p>
      <slot />
    </main>
  </div>
</template>
