<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

type Account = { id: string; username: string; displayName: string; roles: string[] };
type PendingAccount = { id: string; username: string; display_name: string; registration_branch_name: string | null; registration_ancestor_name: string | null; version: number };
type Person = { id: string; display_name: string; visibility: "PUBLIC" | "MEMBER" | "ADMIN" };
const status = ref("正在检查 API…"), notice = ref(""), account = ref<Account | null>(null), csrfToken = ref("");
const registerForm = ref({ username: "", password: "", genealogyName: "", branchName: "", ancestorName: "" });
const loginForm = ref({ username: "", password: "" });
const pendingAccounts = ref<PendingAccount[]>([]), persons = ref<Person[]>([]);
const newPerson = ref({ displayName: "", visibility: "MEMBER" as Person["visibility"] });
const selectedPerson = ref<Record<string, string>>({}), selectedRole = ref<Record<string, "member" | "editor" | "admin">>({});
const isAdmin = computed(() => account.value?.roles.includes("admin") ?? false);

async function request(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("content-type", "application/json");
  if (csrfToken.value) headers.set("x-csrf-token", csrfToken.value);
  return fetch(path, { ...options, headers, credentials: "same-origin" });
}
async function message(response: Response) {
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  return body.message ?? "请求未能完成。";
}
async function refreshAdminData() {
  const [pendingResponse, personsResponse] = await Promise.all([request("/api/admin/accounts/pending"), request("/api/admin/persons")]);
  if (pendingResponse.ok) pendingAccounts.value = ((await pendingResponse.json()) as { accounts: PendingAccount[] }).accounts;
  if (personsResponse.ok) persons.value = ((await personsResponse.json()) as { persons: Person[] }).persons;
}
async function refreshIdentity() {
  const response = await request("/api/me");
  if (!response.ok) return void (account.value = null);
  account.value = ((await response.json()) as { account: Account }).account;
  if (isAdmin.value) await refreshAdminData();
}
async function register() {
  const response = await request("/api/auth/register", { method: "POST", body: JSON.stringify(registerForm.value) });
  notice.value = response.ok ? "申请已提交，等待管理员审核。" : await message(response);
  if (response.ok) registerForm.value = { username: "", password: "", genealogyName: "", branchName: "", ancestorName: "" };
}
async function login() {
  const response = await request("/api/auth/login", { method: "POST", body: JSON.stringify(loginForm.value) });
  if (!response.ok) return void (notice.value = await message(response));
  csrfToken.value = ((await response.json()) as { csrfToken: string }).csrfToken;
  await refreshIdentity();
  notice.value = "登录成功。";
}
async function logout() {
  if ((await request("/api/auth/logout", { method: "POST" })).ok) { account.value = null; csrfToken.value = ""; pendingAccounts.value = []; notice.value = "已退出登录。"; }
}
async function createPerson() {
  const response = await request("/api/admin/persons", { method: "POST", body: JSON.stringify(newPerson.value) });
  if (!response.ok) return void (notice.value = await message(response));
  newPerson.value = { displayName: "", visibility: "MEMBER" }; await refreshAdminData(); notice.value = "已建立人物锚点，请再选择它审核账号。";
}
async function approve(item: PendingAccount) {
  const personId = selectedPerson.value[item.id];
  if (!personId) return void (notice.value = "请先人工选择对应的族谱人物。");
  const response = await request(`/api/admin/accounts/${item.id}/approve`, { method: "POST", body: JSON.stringify({ personId, role: selectedRole.value[item.id] ?? "member", version: item.version }) });
  notice.value = response.ok ? "账号已审核激活。" : await message(response);
  if (response.ok) await refreshAdminData();
}
async function reject(item: PendingAccount) {
  const response = await request(`/api/admin/accounts/${item.id}/reject`, { method: "POST", body: JSON.stringify({ version: item.version }) });
  notice.value = response.ok ? "申请已拒绝。" : await message(response);
  if (response.ok) await refreshAdminData();
}
onMounted(async () => { try { const response = await request("/api/health"); status.value = response.ok ? "API 可用" : "API 暂不可用"; await refreshIdentity(); } catch { status.value = "API 暂不可用"; } });
</script>

<template>
  <main>
    <header><p class="eyebrow">P0-1 · 项目基础</p><h1>云族谱</h1><p>公开资料无需登录；族人资料需经管理员审核后访问。</p><p class="status">{{ status }}</p></header>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <section v-if="!account" class="grid">
      <form @submit.prevent="login"><h2>登录</h2><label>用户名<input v-model.trim="loginForm.username" autocomplete="username" required /></label><label>密码<input v-model="loginForm.password" type="password" autocomplete="current-password" required /></label><button>登录</button></form>
      <form @submit.prevent="register"><h2>申请账号</h2><label>用户名<input v-model.trim="registerForm.username" autocomplete="username" required /></label><label>密码<input v-model="registerForm.password" type="password" minlength="12" autocomplete="new-password" required /></label><label>族谱姓名<input v-model.trim="registerForm.genealogyName" required /></label><label>所属房支（可选）<input v-model.trim="registerForm.branchName" /></label><label>父辈或祖辈姓名（可选）<input v-model.trim="registerForm.ancestorName" /></label><button>提交审核申请</button></form>
    </section>
    <section v-else><p>已登录：{{ account.displayName }}（{{ account.username }}）</p><button class="secondary" @click="logout">退出登录</button></section>
    <section v-if="isAdmin" class="admin">
      <h2>账号审核</h2><form class="person-form" @submit.prevent="createPerson"><h3>建立人物锚点</h3><label>族谱姓名<input v-model.trim="newPerson.displayName" required /></label><label>可见性<select v-model="newPerson.visibility"><option>PUBLIC</option><option>MEMBER</option><option>ADMIN</option></select></label><button>建立人物</button></form>
      <p v-if="pendingAccounts.length === 0">暂无待审核账号。</p>
      <article v-for="item in pendingAccounts" :key="item.id" class="pending"><h3>{{ item.display_name }} <small>@{{ item.username }}</small></h3><p>线索：{{ item.registration_branch_name || "未填房支" }}；{{ item.registration_ancestor_name || "未填父辈/祖辈" }}</p><label>人工关联人物<select v-model="selectedPerson[item.id]"><option value="">请选择，不自动匹配</option><option v-for="person in persons" :key="person.id" :value="person.id">{{ person.display_name }} · {{ person.id }}</option></select></label><label>额外角色<select v-model="selectedRole[item.id]"><option value="member">仅族人</option><option value="editor">编辑员</option><option value="admin">管理员</option></select></label><div class="actions"><button @click="approve(item)">通过</button><button class="secondary" @click="reject(item)">拒绝</button></div></article>
    </section>
  </main>
</template>
