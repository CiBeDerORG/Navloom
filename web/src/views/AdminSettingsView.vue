<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import AdminShell from "../components/AdminShell.vue";
import { changeAdminPassword, changeHomePassphrase, revokeHomeCredentials } from "../lib/api";

const router = useRouter();
const homePassphrase = ref("");
const currentPassword = ref("");
const newPassword = ref("");
const busy = ref(false);
const notice = ref("");
const error = ref("");

async function perform(action: () => Promise<unknown>, success: string) {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await action();
    notice.value = success;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "操作失败";
  } finally {
    busy.value = false;
  }
}
async function updateHome() {
  await perform(() => changeHomePassphrase(homePassphrase.value), "首页口令已更新，所有已记住的浏览器需要重新验证。");
  if (!error.value) homePassphrase.value = "";
}
async function revokeHome() {
  if (!window.confirm("确定撤销所有已记住浏览器的首页访问凭据？")) return;
  await perform(revokeHomeCredentials, "已撤销所有首页访问凭据。");
}
async function updatePassword() {
  await perform(() => changeAdminPassword(currentPassword.value, newPassword.value), "管理员密码已修改，请重新登录。");
  if (!error.value) {
    currentPassword.value = "";
    newPassword.value = "";
    await router.replace("/admin/login");
  }
}
</script>

<template>
  <AdminShell>
    <header>
      <p class="text-xs font-semibold tracking-widest text-sky-400">ACCOUNT & ACCESS</p>
      <h1 class="mt-2 text-3xl font-semibold">安全设置</h1>
      <p class="mt-2 text-sm text-slate-400">这里是辅助设置，不是第三个业务管理模块。</p>
    </header>
    <p v-if="notice" role="status" class="rounded-lg border border-emerald-500/30 p-3 text-emerald-300">{{ notice }}</p>
    <p v-if="error" role="alert" class="rounded-lg border border-rose-500/30 p-3 text-rose-300">{{ error }}</p>
    <div class="grid gap-6 md:grid-cols-2">
      <section class="rounded-2xl border border-white/10 bg-white/5 p-6">
        <h2 class="text-xl font-semibold">首页弱口令</h2>
        <p class="mt-2 text-sm leading-6 text-slate-400">修改后自动撤销所有浏览器的首页凭据。浏览器仅保存 HttpOnly 随机令牌，不保存口令明文。</p>
        <form class="mt-6 space-y-4" @submit.prevent="updateHome">
          <label class="block text-sm" for="new-home">新的首页口令（至少 4 位）</label>
          <input id="new-home" v-model="homePassphrase" type="password" autocomplete="new-password" required minlength="4" maxlength="128"
            class="w-full rounded-lg border border-white/20 bg-slate-900 px-3 py-3 outline-none focus:border-sky-400" />
          <button :disabled="busy" class="rounded-lg bg-sky-500 px-4 py-2 font-semibold hover:bg-sky-600 disabled:opacity-50">保存首页口令</button>
        </form>
        <button type="button" :disabled="busy" class="mt-5 text-sm text-amber-300 underline disabled:opacity-50" @click="revokeHome">撤销所有已记住浏览器</button>
      </section>
      <section class="rounded-2xl border border-white/10 bg-white/5 p-6">
        <h2 class="text-xl font-semibold">管理员密码</h2>
        <p class="mt-2 text-sm text-slate-400">修改管理员密码会使全部管理员会话失效。</p>
        <form class="mt-6 space-y-4" @submit.prevent="updatePassword">
          <label class="block text-sm" for="current-admin">当前密码</label>
          <input id="current-admin" v-model="currentPassword" type="password" autocomplete="current-password" required
            class="w-full rounded-lg border border-white/20 bg-slate-900 px-3 py-3 outline-none focus:border-sky-400" />
          <label class="block text-sm" for="new-admin">新密码（至少 12 位）</label>
          <input id="new-admin" v-model="newPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="256"
            class="w-full rounded-lg border border-white/20 bg-slate-900 px-3 py-3 outline-none focus:border-sky-400" />
          <button :disabled="busy" class="rounded-lg bg-sky-500 px-4 py-2 font-semibold hover:bg-sky-600 disabled:opacity-50">修改管理员密码</button>
        </form>
      </section>
    </div>
  </AdminShell>
</template>
