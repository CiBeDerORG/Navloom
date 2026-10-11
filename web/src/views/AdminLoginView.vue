<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { getAdminSession, loginAdmin } from "../lib/api";

const router = useRouter();
const route = useRoute();
const username = ref("");
const password = ref("");
const submitting = ref(false);
const error = ref("");
const configured = ref(true);

function destination() {
  const value = route.query.redirect;
  return typeof value === "string" && value.startsWith("/admin/") && !value.startsWith("//") && !value.startsWith("/admin/login")
    ? value : "/admin/navigation";
}
async function login() {
  submitting.value = true;
  error.value = "";
  try {
    await loginAdmin(username.value, password.value);
    password.value = "";
    await router.replace(destination());
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "登录失败";
  } finally {
    submitting.value = false;
  }
}
onMounted(async () => {
  try {
    const session = await getAdminSession();
    configured.value = session.configured;
    if (session.authenticated) await router.replace(destination());
  } catch {
    error.value = "无法连接 Server";
  }
});
</script>

<template>
  <main class="flex min-h-screen items-center justify-center bg-slate-950 px-5 text-slate-100">
    <section class="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-8 shadow-xl">
      <RouterLink to="/" class="text-sm text-sky-300 hover:underline">← 返回导航首页</RouterLink>
      <p class="mt-7 text-xs font-semibold tracking-[0.25em] text-sky-400">NAVLOOM ADMIN</p>
      <h1 class="mt-3 text-3xl font-semibold">管理员登录</h1>
      <p class="mt-3 text-sm leading-6 text-slate-400">管理员凭据与首页访问口令相互独立。</p>
      <form v-if="configured" class="mt-8 space-y-5" @submit.prevent="login">
        <div>
          <label for="admin-user" class="mb-2 block text-sm">用户名</label>
          <input id="admin-user" v-model="username" autocomplete="username" required maxlength="64" autofocus
            class="w-full rounded-xl border border-white/20 bg-white/5 px-4 py-3 outline-none focus:border-sky-400" />
        </div>
        <div>
          <label for="admin-password" class="mb-2 block text-sm">管理员密码</label>
          <input id="admin-password" v-model="password" type="password" autocomplete="current-password" required
            class="w-full rounded-xl border border-white/20 bg-white/5 px-4 py-3 outline-none focus:border-sky-400" />
        </div>
        <p v-if="error" role="alert" class="text-sm text-rose-400">{{ error }}</p>
        <button :disabled="submitting" class="w-full rounded-xl bg-sky-500 px-4 py-3 font-semibold hover:bg-sky-600 disabled:opacity-60">
          {{ submitting ? "登录中…" : "登录管理后台" }}
        </button>
      </form>
      <p v-else class="mt-7 text-sm text-amber-300">尚未初始化管理员。请在 Server 主机上执行 `npm run admin:init -w @navloom/server`。</p>
    </section>
  </main>
</template>
