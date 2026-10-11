<script setup lang="ts">
import { RouterLink } from "vue-router";
</script>

<template>
  <main class="flex min-h-screen items-center justify-center bg-slate-950 px-5 text-slate-100">
    <section class="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-8">
      <RouterLink to="/" class="text-sm text-sky-300 hover:underline">← 返回导航首页</RouterLink>
      <h1 class="mt-6 text-2xl font-semibold">管理员登录</h1>
      <p class="mt-4 leading-7 text-slate-400">
        M0 仅初始化路由。管理员账号密码登录将在 M1 实现；当前没有可用的登录表单或管理员会话。
      </p>
      <p class="mt-5 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">
        目前的管理子路由是空白占位页，尚未受认证保护，请勿公网部署。
      </p>
    </section>
  </main>
</template>
