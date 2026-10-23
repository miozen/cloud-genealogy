<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

type Account = { id: string; username: string; displayName: string; roles: string[] };
type PendingAccount = { id: string; username: string; display_name: string; registration_branch_name: string | null; registration_ancestor_name: string | null; version: number };
type Person = { id: string; display_name: string; visibility: "PUBLIC" | "MEMBER" | "ADMIN" };
type ChartNode = { personId: string; displayName: string; generation: number };
type ChartLayoutNode = { personId: string; generation: number; x: number; y: number };
type ChartConnector = { parentPersonId: string; childPersonId: string; points: Array<{ x: number; y: number }> };
type HangingChart = { revisionId: string; projection: { nodes: ChartNode[] }; layout: { nodes: ChartLayoutNode[]; connectors: ChartConnector[] } };
type PersonDetail = { person: { id: string; displayName: string; visibility: string }; names: Array<{ id: string; name_text: string; name_kind: string; is_primary: number }>; facts: Array<{ id: string; fact_kind: string; value_text: string | null; date_text: string | null; place_name: string | null }> };
type Lineage = { id: string; name: string; succession_rule: string; published_revision_id: string | null; pointer_version: number | null };
const status = ref("正在检查 API…"), notice = ref(""), account = ref<Account | null>(null), csrfToken = ref("");
const registerForm = ref({ username: "", password: "", genealogyName: "", branchName: "", ancestorName: "" });
const loginForm = ref({ username: "", password: "" });
const pendingAccounts = ref<PendingAccount[]>([]), persons = ref<Person[]>([]);
const newPerson = ref({ displayName: "", visibility: "MEMBER" as Person["visibility"] });
const selectedPerson = ref<Record<string, string>>({}), selectedRole = ref<Record<string, "member" | "editor" | "admin">>({});
const lineageId = ref(""), rootPersonId = ref(""), chart = ref<HangingChart | null>(null), chartSearch = ref("");
const chartZoom = ref(1), centeredPersonId = ref<string | null>(null), chartPersonId = ref<string | null>(null), chartPerson = ref<PersonDetail | null>(null);
const lineages = ref<Lineage[]>([]), newLineageName = ref("");
const chartSvg = ref<SVGSVGElement | null>(null);
const isAdmin = computed(() => account.value?.roles.includes("admin") ?? false);
const chartNodeById = computed(() => new Map(chart.value?.projection.nodes.map((node) => [node.personId, node])));
const chartPositionById = computed(() => new Map(chart.value?.layout.nodes.map((node) => [node.personId, node])));
const chartMatches = computed(() => {
  const query = chartSearch.value.trim();
  return !query ? [] : (chart.value?.projection.nodes.filter((node) => node.displayName.includes(query)) ?? []);
});
const chartBounds = computed(() => {
  const nodes = chart.value?.layout.nodes ?? [];
  return { width: Math.max(640, ...nodes.map((node) => node.x + 220)), height: Math.max(320, ...nodes.map((node) => node.y + 96)) };
});
const chartViewBox = computed(() => {
  const { width, height } = chartBounds.value;
  const viewportWidth = width / chartZoom.value, viewportHeight = height / chartZoom.value;
  const centered = centeredPersonId.value ? chartPositionById.value.get(centeredPersonId.value) : undefined;
  const x = centered ? Math.min(Math.max(0, centered.x - viewportWidth / 2), Math.max(0, width - viewportWidth)) : 0;
  const y = centered ? Math.min(Math.max(0, centered.y - viewportHeight / 2), Math.max(0, height - viewportHeight)) : 0;
  return `${x} ${y} ${viewportWidth} ${viewportHeight}`;
});

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
  const [pendingResponse, personsResponse, lineagesResponse] = await Promise.all([request("/api/admin/accounts/pending"), request("/api/admin/persons"), request("/api/admin/lineages")]);
  if (pendingResponse.ok) pendingAccounts.value = ((await pendingResponse.json()) as { accounts: PendingAccount[] }).accounts;
  if (personsResponse.ok) persons.value = ((await personsResponse.json()) as { persons: Person[] }).persons;
  if (lineagesResponse.ok) {
    lineages.value = ((await lineagesResponse.json()) as { lineages: Lineage[] }).lineages;
    if (!lineageId.value && lineages.value[0]) lineageId.value = lineages.value[0].id;
  }
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
async function loadHangingChart() {
  const id = lineageId.value.trim();
  if (!id) return void (notice.value = "请输入已发布世系的 ID。");
  const root = rootPersonId.value.trim();
  const response = await request(`/api/admin/lineages/${encodeURIComponent(id)}/hanging-chart${root ? `?rootPersonId=${encodeURIComponent(root)}` : ""}`);
  if (!response.ok) return void (notice.value = await message(response));
  chart.value = await response.json() as HangingChart;
  chartZoom.value = 1; centeredPersonId.value = root || null; chartPersonId.value = null; chartPerson.value = null;
  notice.value = `已载入 ${chart.value.projection.nodes.length} 位人物的已发布世系。`;
}
async function selectChartPerson(personId: string) {
  chartPersonId.value = personId; centeredPersonId.value = personId;
  const response = await request(`/api/admin/persons/${encodeURIComponent(personId)}`);
  chartPerson.value = response.ok ? await response.json() as PersonDetail : null;
  if (!response.ok) notice.value = await message(response);
}
async function createLineage() {
  const response = await request("/api/admin/lineages", { method: "POST", body: JSON.stringify({ name: newLineageName.value }) });
  if (!response.ok) return void (notice.value = await message(response));
  const result = await response.json() as { lineage: { id: string } };
  newLineageName.value = ""; lineageId.value = result.lineage.id; chart.value = null;
  await refreshAdminData(); notice.value = "世系已建立；录入并发布承谱 revision 后即可载入吊线图。";
}
function zoomChart(direction: 1 | -1) {
  chartZoom.value = Math.min(3, Math.max(0.5, Number((chartZoom.value + direction * 0.25).toFixed(2))));
}
function connectorPoints(connector: ChartConnector) { return connector.points.map((point) => `${point.x},${point.y}`).join(" "); }
function exportChartSvg() {
  if (!chartSvg.value || !chart.value) return void (notice.value = "请先载入吊线图。");
  const copy = chartSvg.value.cloneNode(true) as SVGSVGElement;
  const { width, height } = chartBounds.value;
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", String(width));
  copy.setAttribute("height", String(height));
  copy.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const blob = new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = `cloud-genealogy-${chart.value.revisionId.slice(0, 8)}.svg`;
  document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  notice.value = "已导出当前已发布世系的 SVG。";
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
      <section class="chart-admin">
        <h2>传统吊线图</h2><p>仅读取当前已发布世系；输入世系 ID 后载入，选择人物不会修改关系。</p>
        <form class="chart-controls" @submit.prevent="loadHangingChart"><label>世系<select v-model="lineageId" required><option value="" disabled>请选择世系</option><option v-for="lineage in lineages" :key="lineage.id" :value="lineage.id">{{ lineage.name }}{{ lineage.published_revision_id ? "（已发布）" : "（未发布）" }}</option></select></label><label>根人物 ID（可选）<input v-model.trim="rootPersonId" placeholder="仅展示该支后代" /></label><button>载入吊线图</button></form>
        <form class="new-lineage" @submit.prevent="createLineage"><label>新建世系名称<input v-model.trim="newLineageName" maxlength="160" required /></label><button type="submit" class="secondary">建立空世系</button></form>
        <div v-if="chart" class="chart-tools"><label>姓名定位<input v-model.trim="chartSearch" placeholder="输入姓名" /></label><div class="actions"><button type="button" class="secondary" @click="zoomChart(-1)">缩小</button><button type="button" class="secondary" @click="chartZoom = 1">重置</button><button type="button" class="secondary" @click="zoomChart(1)">放大</button><button type="button" @click="exportChartSvg">导出 SVG</button></div></div>
        <div v-if="chartMatches.length" class="chart-matches"><button v-for="node in chartMatches" :key="node.personId" type="button" @click="selectChartPerson(node.personId)">{{ node.displayName }}</button></div>
        <div v-if="chart" class="chart-workspace">
          <div class="chart-canvas"><svg ref="chartSvg" :viewBox="chartViewBox" role="img" aria-label="传统吊线图"><polyline v-for="connector in chart.layout.connectors" :key="`${connector.parentPersonId}:${connector.childPersonId}`" class="chart-connector" :points="connectorPoints(connector)" /><g v-for="node in chart.layout.nodes" :key="node.personId" class="chart-node" :class="{ selected: node.personId === chartPersonId }" :transform="`translate(${node.x} ${node.y})`" @click="selectChartPerson(node.personId)"><rect width="170" height="48" rx="4" /><text x="12" y="29">{{ chartNodeById.get(node.personId)?.displayName ?? node.personId }}</text></g></svg></div>
          <aside class="person-panel"><template v-if="chartPerson"><h3>{{ chartPerson.person.displayName }}</h3><p class="status">{{ chartPerson.person.visibility }} · {{ chartPerson.person.id }}</p><h4>姓名</h4><p v-if="chartPerson.names.length === 0">暂无附加姓名。</p><ul v-else><li v-for="name in chartPerson.names" :key="name.id">{{ name.name_text }}（{{ name.name_kind }}）</li></ul><h4>事实</h4><p v-if="chartPerson.facts.length === 0">暂无已录入事实。</p><ul v-else><li v-for="fact in chartPerson.facts" :key="fact.id">{{ fact.fact_kind }}：{{ fact.value_text || fact.date_text || fact.place_name || "未详" }}</li></ul></template><p v-else>点击节点查看人物资料。</p></aside>
        </div>
      </section>
    </section>
  </main>
</template>
