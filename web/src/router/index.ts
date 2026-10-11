import { createRouter, createWebHistory } from "vue-router";
import HomeView from "../views/HomeView.vue";
import AdminLoginView from "../views/AdminLoginView.vue";
import AdminNavigationView from "../views/AdminNavigationView.vue";
import AdminInstancesView from "../views/AdminInstancesView.vue";

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: HomeView },
    { path: "/admin", redirect: "/admin/navigation" },
    { path: "/admin/login", name: "admin-login", component: AdminLoginView },
    { path: "/admin/navigation", name: "admin-navigation", component: AdminNavigationView },
    { path: "/admin/instances", name: "admin-instances", component: AdminInstancesView },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

// M0: all admin routes are placeholders. M1 adds server-verified admin auth guards.
