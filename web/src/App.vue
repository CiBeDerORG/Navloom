<script setup lang="ts">
import { onMounted, onUnmounted, watch } from "vue";
import { RouterView, useRoute } from "vue-router";
import { getAdminSession, getHomeStatus } from "./lib/api";
import { setPresenceWanted } from "./lib/presence";

const route = useRoute();
let sequence = 0;

async function syncPresence() {
  const current = ++sequence;
  const path = route.path;
  if (path === "/admin/login" || (path !== "/" && !path.startsWith("/admin/"))) {
    setPresenceWanted(false);
    return;
  }
  try {
    const authorized = path.startsWith("/admin/")
      ? (await getAdminSession()).authenticated
      : (await getHomeStatus()).authenticated;
    if (current === sequence) setPresenceWanted(authorized);
  } catch {
    if (current === sequence) setPresenceWanted(false);
  }
}

watch(() => route.path, () => { void syncPresence(); }, { immediate: true });
onMounted(() => {
  window.addEventListener("navloom-auth-changed", syncPresence);
  window.addEventListener("navloom-presence-recheck", syncPresence);
});
onUnmounted(() => {
  sequence++;
  window.removeEventListener("navloom-auth-changed", syncPresence);
  window.removeEventListener("navloom-presence-recheck", syncPresence);
  setPresenceWanted(false);
});
</script>

<template>
  <RouterView />
</template>
