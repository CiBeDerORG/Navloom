import { createRouter, createWebHistory } from "vue-router";
import { getAdminSession } from "../lib/api";
import HomeView from "../views/HomeView.vue";
import AdminLoginView from "../views/AdminLoginView.vue";
import AdminNavigationView from "../views/AdminNavigationView.vue";
import AdminInstancesView from "../views/AdminInstancesView.vue";
import AdminSettingsView from "../views/AdminSettingsView.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: HomeView },
    { path: "/admin", redirect: "/admin/navigation" },
    { path: "/admin/login", name: "admin-login", component: AdminLoginView },
    { path: "/admin/navigation", name: "admin-navigation", component: AdminNavigationView },
    { path: "/admin/instances", name: "admin-instances", component: AdminInstancesView },
    { path: "/admin/settings", name: "admin-settings", component: AdminSettingsView },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

router.beforeEach(async (to) => {
  if (!to.path.startsWith("/admin/") || to.path === "/admin/login") return true;
  try {
    const session = await getAdminSession();
    if (session.authenticated) return true;
  } catch {
    // Backend remains the authority; redirecting to login also handles expired sessions.
  }
  return { path: "/admin/login", query: { redirect: to.fullPath } };
});

export default router;
