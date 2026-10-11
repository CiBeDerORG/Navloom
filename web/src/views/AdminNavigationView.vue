<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import AdminShell from "../components/AdminShell.vue";
import {
  createCard, createGroup, deleteCard, deleteGroup, getAdminNavigation, iconIsUrl,
  renameGroup, saveNavigationOrder, updateCard, type AdminNavigation, type NavigationCard, type NavigationDraft,
} from "../lib/api";

const data = ref<AdminNavigation>({ groups: [], cards: [] });
const loading = ref(true);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const editingCardId = ref<string | null>(null);
const cardEditorOpen = ref(false);
const cardDraft = ref<NavigationDraft>(blankDraft());
const newGroupName = ref("");
const editingGroupId = ref<string | null>(null);
const editingGroupName = ref("");
const draggingCard = ref<string | null>(null);
const draggingGroup = ref<string | null>(null);

function blankDraft(): NavigationDraft {
  return { title: "", url: "", icon: "", description: "", groupId: null, openTarget: "_blank" };
}
const sortedGroups = computed(() => [...data.value.groups].sort((a, b) => a.sortOrder - b.sortOrder));
const cardsIn = (groupId: string | null) => data.value.cards.filter((card) => card.groupId === groupId).sort((a, b) => a.sortOrder - b.sortOrder);
async function refresh() {
  data.value = await getAdminNavigation();
}
async function load() {
  loading.value = true;
  try {
    await refresh();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法读取导航";
  } finally {
    loading.value = false;
  }
}
async function perform(action: () => Promise<unknown>, message: string) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await action();
    await refresh();
    notice.value = message;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "操作失败";
    try { await refresh(); } catch { /* keep existing local state */ }
  } finally {
    busy.value = false;
  }
}
function newCard(groupId: string | null = null) {
  editingCardId.value = null;
  cardDraft.value = { ...blankDraft(), groupId };
  cardEditorOpen.value = true;
}
function editCard(card: NavigationCard) {
  editingCardId.value = card.id;
  cardDraft.value = {
    title: card.title, url: card.url, icon: card.icon, description: card.description,
    groupId: card.groupId, openTarget: card.openTarget,
  };
  cardEditorOpen.value = true;
}
async function saveCard() {
  const id = editingCardId.value;
  await perform(
    () => id ? updateCard(id, cardDraft.value) : createCard(cardDraft.value),
    id ? "卡片已更新" : "卡片已添加",
  );
  if (!error.value) cardEditorOpen.value = false;
}
async function removeCard(card: NavigationCard) {
  if (!window.confirm(`删除导航卡片「${card.title}」？此操作不会删除容器或应用。`)) return;
  await perform(() => deleteCard(card.id), "卡片已删除，Docker 资源不受影响");
}
async function addGroup() {
  if (!newGroupName.value.trim()) return;
  await perform(() => createGroup(newGroupName.value), "分组已创建");
  if (!error.value) newGroupName.value = "";
}
function startRename(id: string, name: string) {
  editingGroupId.value = id;
  editingGroupName.value = name;
}
async function saveGroupName() {
  if (!editingGroupId.value) return;
  await perform(() => renameGroup(editingGroupId.value!, editingGroupName.value), "分组已重命名");
  if (!error.value) editingGroupId.value = null;
}
async function removeGroup(id: string, name: string) {
  const count = cardsIn(id).length;
  if (!window.confirm(`删除分组「${name}」？其中 ${count} 张卡片将移到「未分组」，不会被删除。`)) return;
  await perform(() => deleteGroup(id), "分组已删除，卡片保留在未分组");
}
async function persistOrder(next: AdminNavigation) {
  const previous = data.value;
  data.value = next;
  busy.value = true;
  error.value = "";
  try {
    await saveNavigationOrder(next.groups.map((group) => group.id), next.cards.map((card) => ({ id: card.id, groupId: card.groupId })));
    await refresh();
    notice.value = "排序已保存";
  } catch (cause) {
    data.value = previous;
    error.value = cause instanceof Error ? cause.message : "排序保存失败，已恢复原顺序";
  } finally {
    busy.value = false;
  }
}
async function moveGroup(id: string, beforeId: string | null) {
  if (busy.value || id === beforeId) return;
  const groups = sortedGroups.value.filter((group) => group.id !== id);
  const moved = sortedGroups.value.find((group) => group.id === id);
  if (!moved) return;
  const position = beforeId ? groups.findIndex((group) => group.id === beforeId) : groups.length;
  groups.splice(position < 0 ? groups.length : position, 0, moved);
  await persistOrder({ groups: groups.map((group, index) => ({ ...group, sortOrder: index })), cards: [...data.value.cards] });
}
async function moveCard(id: string, groupId: string | null, beforeId: string | null) {
  if (busy.value || id === beforeId) return;
  const moved = data.value.cards.find((card) => card.id === id);
  if (!moved) return;
  const cards = data.value.cards.filter((card) => card.id !== id).map((card) => ({ ...card }));
  const target = cards.filter((card) => card.groupId === groupId).sort((a, b) => a.sortOrder - b.sortOrder);
  const insert = beforeId ? target.findIndex((card) => card.id === beforeId) : target.length;
  target.splice(insert < 0 ? target.length : insert, 0, { ...moved, groupId });
  const ordered = [...cards.filter((card) => card.groupId !== groupId), ...target.map((card, index) => ({ ...card, sortOrder: index }))];
  await persistOrder({ groups: [...data.value.groups], cards: ordered });
}
function cardDragStart(event: DragEvent, id: string) {
  draggingCard.value = id;
  draggingGroup.value = null;
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}
function groupDragStart(event: DragEvent, id: string) {
  draggingGroup.value = id;
  draggingCard.value = null;
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}
function dropCard(groupId: string | null, beforeId: string | null) {
  if (draggingCard.value) void moveCard(draggingCard.value, groupId, beforeId);
  draggingCard.value = null;
}
function dropGroup(beforeId: string) {
  if (draggingGroup.value) void moveGroup(draggingGroup.value, beforeId);
  draggingGroup.value = null;
}
onMounted(() => { void load(); });
</script>

<template>
  <AdminShell>
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="text-xs font-semibold tracking-[0.22em] text-sky-400">NAVIGATION EDITOR</p>
        <h1 class="mt-2 text-3xl font-semibold">导航页管理</h1>
        <p class="mt-3 text-sm text-slate-400">卡片独立于 Docker。拖拽卡片可以排序或跨组移动；也可使用移动按钮。</p>
      </div>
      <button class="rounded-xl bg-sky-500 px-5 py-3 font-semibold hover:bg-sky-600" type="button" @click="newCard()">+ 添加卡片</button>
    </header>
    <p v-if="error" role="alert" class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">{{ error }}</p>
    <p v-if="notice" role="status" class="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">{{ notice }}</p>
    <p v-if="loading" role="status" class="py-12 text-slate-400">正在读取导航…</p>

    <template v-else>
      <form class="flex flex-wrap gap-3 rounded-xl border border-white/10 bg-white/5 p-4" @submit.prevent="addGroup">
        <label for="group-new" class="w-full text-sm font-semibold">新建导航分组</label>
        <input id="group-new" v-model="newGroupName" required maxlength="80" placeholder="例如：常用工具"
          class="min-w-0 flex-1 rounded-lg border border-white/20 bg-slate-900 px-3 py-2 outline-none focus:border-sky-400" />
        <button :disabled="busy" class="rounded-lg bg-white/10 px-4 py-2 hover:bg-white/20 disabled:opacity-50">创建分组</button>
      </form>

      <section v-for="(group, groupIndex) in sortedGroups" :key="group.id" class="rounded-2xl border border-white/10 bg-white/5 p-5"
        @dragover.prevent @drop.prevent="dropGroup(group.id)">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <form v-if="editingGroupId === group.id" class="flex flex-1 flex-wrap gap-2" @submit.prevent="saveGroupName">
            <input v-model="editingGroupName" required maxlength="80" class="min-w-0 flex-1 rounded-lg border border-sky-400 bg-slate-900 px-3 py-2" />
            <button class="rounded-lg bg-sky-500 px-3 py-2">保存</button>
            <button type="button" class="rounded-lg bg-white/10 px-3 py-2" @click="editingGroupId = null">取消</button>
          </form>
          <h2 v-else class="text-lg font-semibold" draggable="true" title="拖动分组标题排序" @dragstart.stop="groupDragStart($event, group.id)">
            <span class="mr-2 cursor-grab text-slate-500">⠿</span>{{ group.name }}
            <span class="ml-2 text-sm font-normal text-slate-500">{{ cardsIn(group.id).length }} 张</span>
          </h2>
          <div class="flex flex-wrap gap-2 text-xs">
            <button type="button" :disabled="busy || groupIndex === 0" class="rounded-lg border border-white/20 px-3 py-2 disabled:opacity-30" @click="moveGroup(group.id, sortedGroups[groupIndex - 1]!.id)">上移</button>
            <button type="button" :disabled="busy || groupIndex === sortedGroups.length - 1" class="rounded-lg border border-white/20 px-3 py-2 disabled:opacity-30" @click="moveGroup(group.id, sortedGroups[groupIndex + 2]?.id ?? null)">下移</button>
            <button type="button" class="rounded-lg border border-white/20 px-3 py-2" @click="startRename(group.id, group.name)">重命名</button>
            <button type="button" class="rounded-lg border border-rose-500/30 px-3 py-2 text-rose-300" @click="removeGroup(group.id, group.name)">删除</button>
            <button type="button" class="rounded-lg bg-sky-500/20 px-3 py-2 text-sky-300" @click="newCard(group.id)">+ 卡片</button>
          </div>
        </div>
        <div class="mt-4 space-y-2" @dragover.prevent @drop.stop.prevent="dropCard(group.id, null)">
          <div v-for="(card, index) in cardsIn(group.id)" :key="card.id" draggable="true"
            class="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-slate-900/80 p-3"
            @dragstart.stop="cardDragStart($event, card.id)" @dragover.prevent @drop.stop.prevent="dropCard(group.id, card.id)">
            <span class="cursor-grab text-slate-500" aria-hidden="true">⠿</span>
            <span class="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg bg-sky-500/10 text-xl">
              <img v-if="iconIsUrl(card.icon)" :src="card.icon!" :alt="card.title" class="h-8 w-8 object-contain" />
              <span v-else>{{ card.icon || "↗" }}</span>
            </span>
            <div class="min-w-0 flex-1">
              <p class="font-medium">{{ card.title }}</p>
              <p class="truncate text-xs text-slate-500">{{ card.url }}</p>
            </div>
            <div class="flex gap-2 text-xs">
              <button type="button" :disabled="busy || index === 0" class="rounded-lg border border-white/20 px-2 py-2 disabled:opacity-30" @click="moveCard(card.id, group.id, cardsIn(group.id)[index - 1]!.id)">↑</button>
              <button type="button" :disabled="busy || index === cardsIn(group.id).length - 1" class="rounded-lg border border-white/20 px-2 py-2 disabled:opacity-30" @click="moveCard(card.id, group.id, cardsIn(group.id)[index + 2]?.id ?? null)">↓</button>
              <button type="button" class="rounded-lg border border-white/20 px-3 py-2" @click="editCard(card)">编辑</button>
              <button type="button" class="rounded-lg border border-rose-500/30 px-3 py-2 text-rose-300" @click="removeCard(card)">删除</button>
            </div>
          </div>
          <p v-if="!cardsIn(group.id).length" class="rounded-lg border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">空分组，可拖入卡片或点击「+ 卡片」</p>
        </div>
      </section>

      <section class="rounded-2xl border border-dashed border-white/20 p-5">
        <div class="flex items-center justify-between gap-4">
          <h2 class="text-lg font-semibold">未分组 <span class="text-sm font-normal text-slate-500">{{ cardsIn(null).length }} 张</span></h2>
          <button type="button" class="rounded-lg bg-sky-500/20 px-3 py-2 text-sm text-sky-300" @click="newCard(null)">+ 卡片</button>
        </div>
        <div class="mt-4 space-y-2" @dragover.prevent @drop.stop.prevent="dropCard(null, null)">
          <div v-for="(card, index) in cardsIn(null)" :key="card.id" draggable="true"
            class="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-slate-900/80 p-3"
            @dragstart.stop="cardDragStart($event, card.id)" @dragover.prevent @drop.stop.prevent="dropCard(null, card.id)">
            <span class="cursor-grab text-slate-500">⠿</span>
            <span class="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/10 text-xl">{{ card.icon && !iconIsUrl(card.icon) ? card.icon : "↗" }}</span>
            <div class="min-w-0 flex-1"><p class="font-medium">{{ card.title }}</p><p class="truncate text-xs text-slate-500">{{ card.url }}</p></div>
            <div class="flex gap-2 text-xs">
              <button type="button" :disabled="busy || index === 0" class="rounded-lg border border-white/20 px-2 py-2 disabled:opacity-30" @click="moveCard(card.id, null, cardsIn(null)[index - 1]!.id)">↑</button>
              <button type="button" :disabled="busy || index === cardsIn(null).length - 1" class="rounded-lg border border-white/20 px-2 py-2 disabled:opacity-30" @click="moveCard(card.id, null, cardsIn(null)[index + 2]?.id ?? null)">↓</button>
              <button type="button" class="rounded-lg border border-white/20 px-3 py-2" @click="editCard(card)">编辑</button>
              <button type="button" class="rounded-lg border border-rose-500/30 px-3 py-2 text-rose-300" @click="removeCard(card)">删除</button>
            </div>
          </div>
          <p v-if="!cardsIn(null).length" class="rounded-lg p-5 text-center text-sm text-slate-500">暂无未分组卡片，可拖到这里</p>
        </div>
      </section>
    </template>

    <div v-if="cardEditorOpen" class="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/75 p-4" @click.self="cardEditorOpen = false">
      <section role="dialog" aria-modal="true" aria-labelledby="card-dialog-title" class="w-full max-w-lg rounded-2xl border border-white/15 bg-slate-900 p-6 shadow-2xl">
        <h2 id="card-dialog-title" class="text-xl font-semibold">{{ editingCardId ? "编辑导航卡片" : "添加导航卡片" }}</h2>
        <p class="mt-2 text-xs text-slate-400">导航 URL 可使用外部域名、局域网地址或 EasyTier 地址；不会自动推断浏览器网络。</p>
        <form class="mt-6 space-y-4" @submit.prevent="saveCard">
          <div><label for="card-title" class="mb-1 block text-sm">名称 *</label><input id="card-title" v-model="cardDraft.title" required maxlength="100" autofocus class="w-full rounded-lg border border-white/20 bg-slate-950 px-3 py-2.5 focus:border-sky-400" /></div>
          <div><label for="card-url" class="mb-1 block text-sm">链接 URL *</label><input id="card-url" v-model="cardDraft.url" type="url" required maxlength="2048" placeholder="https://example.com" class="w-full rounded-lg border border-white/20 bg-slate-950 px-3 py-2.5 focus:border-sky-400" /></div>
          <div><label for="card-icon" class="mb-1 block text-sm">图标（Emoji 或 HTTPS 图片地址）</label><input id="card-icon" v-model="cardDraft.icon" maxlength="512" placeholder="🧭" class="w-full rounded-lg border border-white/20 bg-slate-950 px-3 py-2.5 focus:border-sky-400" /></div>
          <div><label for="card-desc" class="mb-1 block text-sm">描述</label><textarea id="card-desc" v-model="cardDraft.description" rows="2" maxlength="500" class="w-full rounded-lg border border-white/20 bg-slate-950 px-3 py-2.5 focus:border-sky-400" /></div>
          <div class="grid gap-4 sm:grid-cols-2">
            <div><label for="card-group" class="mb-1 block text-sm">分组</label><select id="card-group" v-model="cardDraft.groupId" class="w-full rounded-lg border border-white/20 bg-slate-950 px-3 py-2.5"><option :value="null">未分组</option><option v-for="group in sortedGroups" :key="group.id" :value="group.id">{{ group.name }}</option></select></div>
            <div><label for="card-target" class="mb-1 block text-sm">打开方式</label><select id="card-target" v-model="cardDraft.openTarget" class="w-full rounded-lg border border-white/20 bg-slate-950 px-3 py-2.5"><option value="_blank">新标签页</option><option value="_self">当前标签页</option></select></div>
          </div>
          <p class="text-xs text-slate-500">容器池/实例关联将在 M2 接入，此阶段所有卡片均为独立链接。</p>
          <div class="flex justify-end gap-3 pt-2">
            <button type="button" class="rounded-lg border border-white/20 px-4 py-2" @click="cardEditorOpen = false">取消</button>
            <button :disabled="busy" class="rounded-lg bg-sky-500 px-5 py-2 font-semibold hover:bg-sky-600 disabled:opacity-50">{{ busy ? "保存中…" : "保存卡片" }}</button>
          </div>
        </form>
      </section>
    </div>
  </AdminShell>
</template>
