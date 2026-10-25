<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { chartViewBox, createChartViewport, panChartViewport } from "./chart-viewport";
import { canSubmitBranchChange, previewRetirements as getPreviewRetirements, projectComposerBranches, type LocalStructureItem, type WorkbenchBranch } from "./branch-workbench-composer";
import { layoutHistoricalRecords } from "./historical-record-layout";
import { layoutKinship } from "./kinship-layout";

type Account = { id: string; username: string; displayName: string; roles: string[] };
type PendingAccount = { id: string; username: string; display_name: string; registration_branch_name: string | null; registration_ancestor_name: string | null; version: number };
type Person = { id: string; display_name: string; visibility: "PUBLIC" | "MEMBER" | "ADMIN" };
type ChartNode = { personId: string; displayName: string; generation: number };
type ChartLayoutNode = { personId: string; generation: number; x: number; y: number };
type ChartConnector = { parentPersonId: string; childPersonId: string; points: Array<{ x: number; y: number }> };
type HangingChart = { revisionId: string; projection: { nodes: ChartNode[] }; layout: { nodes: ChartLayoutNode[]; connectors: ChartConnector[] } };
type PersonDetail = { person: { id: string; displayName: string; visibility: string }; names: Array<{ id: string; name_text: string; name_kind: string; is_primary: number }>; facts: Array<{ id: string; fact_kind: string; value_text: string | null; date_text: string | null; place_name: string | null }> };
type Lineage = { id: string; name: string; succession_rule: string; published_revision_id: string | null; pointer_version: number | null };
type Edition = { id: string; title: string; edition_label: string | null; genealogy_title: string };
type HistoricalComparison = { projection: { nodes: Array<{ sourceRecordId: string; displayName: string | null }>; parentChildEdges: Array<{ claimId: string; parentRecordId: string; childRecordId: string }>; annotations: Array<{ claimId: string; status: string; relationKind: string; rawText: string }> }; comparison: { canonicalEdges: Array<{ status: string }>; historicalEdges: Array<{ claimId: string; status: string }> } };
type Kinship = { centerPersonId: string; radius: 1 | 2; truncated: boolean; nodes: Array<{ id: string; displayName: string; distance: number }>; relations: Array<{ subjectPersonId: string; relatedPersonId: string; relationKind: string }> };
type ChangeRequest = { id: string; lineage_id: string; state: "draft" | "pending_review" | "approved" | "rejected" | "published" | "conflicted"; reason: string; created_by_account_id: string; reviewed_by_account_id: string | null; review_note: string | null; version: number; created_at: string; discarded_at: string | null; discarded_by_account_id: string | null };
type Reviewer = { id: string; username: string; display_name: string };
type ReviewerAssignment = { id: string; reviewer_account_id: string; valid_from: string; valid_until: string; reason: string; revoked_at: string | null; version: number };
type Branch = WorkbenchBranch;
type BranchWorkbench = { lineageId: string; revisionId: string; pointerVersion: number; branches: Branch[]; memberships: Array<{ branchId: string; personId: string; personDisplayName: string; membershipKind: string }> };
type StructureItem = LocalStructureItem;
type MembershipItem = { operation: "add" | "remove"; branchId: string; personId: string; membershipKind: "blood_primary" | "migration" | "administrative" };
type ChangePreview = { changeRequest: ChangeRequest; preview: { valid: boolean; issues: Array<{ code: string }>; edges: unknown[]; relations: unknown[]; memberships: unknown[]; branchStructure: { branches: Array<{ branchId: string; name: string; retiredAt: string | null }> }; retirementDependencies: Array<{ branchId: string; membershipCount: number; accountScopeCount: number; blockingCodes: string[] }> } };
const status = ref("正在检查 API…"), notice = ref(""), account = ref<Account | null>(null), csrfToken = ref("");
const registerForm = ref({ username: "", password: "", genealogyName: "", branchName: "", ancestorName: "" });
const loginForm = ref({ username: "", password: "" });
const pendingAccounts = ref<PendingAccount[]>([]), persons = ref<Person[]>([]);
const newPerson = ref({ displayName: "", visibility: "MEMBER" as Person["visibility"] });
const selectedPerson = ref<Record<string, string>>({}), selectedRole = ref<Record<string, "member" | "editor" | "admin">>({});
const lineageId = ref(""), rootPersonId = ref(""), chart = ref<HangingChart | null>(null), chartSearch = ref("");
const chartZoom = ref(1), centeredPersonId = ref<string | null>(null), chartPersonId = ref<string | null>(null), chartPerson = ref<PersonDetail | null>(null);
const lineages = ref<Lineage[]>([]), editions = ref<Edition[]>([]), editionId = ref(""), comparison = ref<HistoricalComparison | null>(null), newLineageName = ref("");
const kinshipPersonId = ref(""), kinshipRadius = ref<1 | 2>(1), kinship = ref<Kinship | null>(null);
const changeRequests = ref<ChangeRequest[]>([]), reviewers = ref<Reviewer[]>([]), reviewerAssignments = ref<ReviewerAssignment[]>([]);
const selectedChangeRequest = ref<ChangeRequest | null>(null), changePreview = ref<ChangePreview | null>(null), reviewNote = ref("");
const proposalForm = ref({ reason: "", operation: "relation_add", subjectPersonId: "", relatedPersonId: "", relationKind: "biological_parent" });
const assignmentForm = ref({ reviewerAccountId: "", validFrom: "", validUntil: "", reason: "" });
const branchWorkbench = ref<BranchWorkbench | null>(null);
const branchComposer = ref({ reason: "", structureItems: [] as StructureItem[], membershipItems: [] as MembershipItem[] });
const structureDraft = ref({ operation: "create" as StructureItem["operation"], branchId: "", parentBranchId: "", name: "", branchKind: "agnatic" as StructureItem["branchKind"] });
const membershipDraft = ref({ operation: "add" as MembershipItem["operation"], branchId: "", personId: "", membershipKind: "blood_primary" as MembershipItem["membershipKind"] });
const retirementConfirmations = ref<Record<string, string>>({});
const chartSvg = ref<SVGSVGElement | null>(null);
const chartPan = ref({ x: 0, y: 0 }), chartDrag = ref<{ pointerId: number; clientX: number; clientY: number } | null>(null);
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
const chartViewport = computed(() => {
  const centered = centeredPersonId.value ? chartPositionById.value.get(centeredPersonId.value) : undefined;
  const base = createChartViewport(chartBounds.value, chartZoom.value, centered);
  return panChartViewport(chartBounds.value, base, chartPan.value.x, chartPan.value.y);
});
const chartViewBoxValue = computed(() => chartViewBox(chartViewport.value));
const historicalLayout = computed(() => comparison.value ? layoutHistoricalRecords(comparison.value.projection.nodes, comparison.value.projection.parentChildEdges) : null);
const historicalStatus = computed(() => new Map(comparison.value?.comparison.historicalEdges.map((edge) => [edge.claimId, edge.status])));
const kinshipLayout = computed(() => kinship.value ? layoutKinship(kinship.value.centerPersonId, kinship.value.nodes, kinship.value.relations) : null);
const composerBranches = computed(() => projectComposerBranches(branchWorkbench.value?.branches ?? [], branchComposer.value.structureItems));
const previewRetirements = computed(() => getPreviewRetirements(changePreview.value?.preview.branchStructure.branches ?? []));
const retirementsConfirmed = computed(() => canSubmitBranchChange(true, previewRetirements.value, retirementConfirmations.value));

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
  const [pendingResponse, personsResponse, lineagesResponse, editionsResponse] = await Promise.all([request("/api/admin/accounts/pending"), request("/api/admin/persons"), request("/api/admin/lineages"), request("/api/admin/genealogy-editions")]);
  if (pendingResponse.ok) pendingAccounts.value = ((await pendingResponse.json()) as { accounts: PendingAccount[] }).accounts;
  if (personsResponse.ok) persons.value = ((await personsResponse.json()) as { persons: Person[] }).persons;
  if (lineagesResponse.ok) {
    lineages.value = ((await lineagesResponse.json()) as { lineages: Lineage[] }).lineages;
    if (!lineageId.value && lineages.value[0]) lineageId.value = lineages.value[0].id;
  }
  if (editionsResponse.ok) { editions.value = ((await editionsResponse.json()) as { editions: Edition[] }).editions; if (!editionId.value && editions.value[0]) editionId.value = editions.value[0].id; }
  await refreshWorkflowData();
}
async function refreshWorkflowData() {
  if (!lineageId.value) return;
  const [requestsResponse, reviewersResponse, assignmentsResponse] = await Promise.all([
    request(`/api/admin/change-requests?lineageId=${encodeURIComponent(lineageId.value)}`),
    request("/api/admin/accounts/reviewers"),
    request(`/api/admin/lineages/${encodeURIComponent(lineageId.value)}/reviewer-assignments`),
  ]);
  if (requestsResponse.ok) changeRequests.value = ((await requestsResponse.json()) as { changeRequests: ChangeRequest[] }).changeRequests;
  if (reviewersResponse.ok) reviewers.value = ((await reviewersResponse.json()) as { accounts: Reviewer[] }).accounts;
  if (assignmentsResponse.ok) reviewerAssignments.value = ((await assignmentsResponse.json()) as { assignments: ReviewerAssignment[] }).assignments;
  const workbenchResponse = await request(`/api/admin/lineages/${encodeURIComponent(lineageId.value)}/branch-workbench`);
  branchWorkbench.value = workbenchResponse.ok ? await workbenchResponse.json() as BranchWorkbench : null;
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
  chartZoom.value = 1; chartPan.value = { x: 0, y: 0 }; centeredPersonId.value = root || null; chartPersonId.value = null; chartPerson.value = null;
  notice.value = `已载入 ${chart.value.projection.nodes.length} 位人物的已发布世系。`;
}
async function loadHistoricalComparison() {
  if (!lineageId.value || !editionId.value) return void (notice.value = "请选择已发布世系和谱书版本。");
  const response = await request(`/api/admin/lineages/${encodeURIComponent(lineageId.value)}/historical-comparison?editionId=${encodeURIComponent(editionId.value)}`);
  if (!response.ok) return void (notice.value = await message(response));
  comparison.value = await response.json() as HistoricalComparison;
  notice.value = "已载入统一世系与历史谱书的只读差异。";
}
async function loadKinship() {
  if (!lineageId.value || !kinshipPersonId.value) return void (notice.value = "请选择世系并输入人物 ID。");
  const response = await request(`/api/admin/lineages/${encodeURIComponent(lineageId.value)}/kinship?personId=${encodeURIComponent(kinshipPersonId.value)}&radius=${kinshipRadius.value}`);
  if (!response.ok) return void (notice.value = await message(response));
  kinship.value = await response.json() as Kinship;
  notice.value = "已载入当前发布版本的亲属图。";
}
async function selectChartPerson(personId: string) {
  chartPersonId.value = personId; centeredPersonId.value = personId; chartPan.value = { x: 0, y: 0 };
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
async function createProposal() {
  if (!lineageId.value) return void (notice.value = "请先选择世系。");
  const form = proposalForm.value;
  const response = await request(`/api/admin/lineages/${encodeURIComponent(lineageId.value)}/change-requests`, { method: "POST", body: JSON.stringify({ reason: form.reason, items: [{ operation: form.operation, subjectPersonId: form.subjectPersonId, relatedPersonId: form.relatedPersonId, relationKind: form.relationKind }], membershipItems: [], structureItems: [] }) });
  if (!response.ok) return void (notice.value = await message(response));
  const result = await response.json() as { changeRequest: ChangeRequest };
  proposalForm.value = { reason: "", operation: "relation_add", subjectPersonId: "", relatedPersonId: "", relationKind: "biological_parent" };
  await refreshWorkflowData(); await previewChangeRequest(result.changeRequest.id); notice.value = "草稿已创建，请核对预览后再提交。";
}
async function addStructureItem() {
  const draft = structureDraft.value;
  if (draft.operation === "create" && !draft.name.trim()) return void (notice.value = "请填写新房支名称。");
  if (draft.operation !== "create" && !draft.branchId) return void (notice.value = "请选择目标房支。");
  if (draft.operation === "rename" && !draft.name.trim()) return void (notice.value = "请填写新名称。");
  const branchId = draft.operation === "create" ? crypto.randomUUID() : draft.branchId;
  branchComposer.value.structureItems.push({ operation: draft.operation, branchId, parentBranchId: draft.operation === "create" ? (draft.parentBranchId || null) : null, name: draft.operation === "retire" ? "" : draft.name.trim(), branchKind: draft.branchKind });
  structureDraft.value = { operation: "create", branchId: "", parentBranchId: "", name: "", branchKind: "agnatic" };
}
function addMembershipItem() {
  const draft = membershipDraft.value;
  if (!draft.branchId || !draft.personId) return void (notice.value = "请选择房支和人物。");
  if (branchComposer.value.membershipItems.some((item) => item.operation === draft.operation && item.branchId === draft.branchId && item.personId === draft.personId && item.membershipKind === draft.membershipKind)) return void (notice.value = "该成员条目已在本次编排中。");
  branchComposer.value.membershipItems.push({ ...draft });
  membershipDraft.value = { operation: "add", branchId: "", personId: "", membershipKind: "blood_primary" };
}
function removeStructureItem(index: number) { branchComposer.value.structureItems.splice(index, 1); }
function removeMembershipItem(index: number) { branchComposer.value.membershipItems.splice(index, 1); }
function clearBranchComposer() {
  branchComposer.value = { reason: "", structureItems: [], membershipItems: [] };
  structureDraft.value = { operation: "create", branchId: "", parentBranchId: "", name: "", branchKind: "agnatic" };
  membershipDraft.value = { operation: "add", branchId: "", personId: "", membershipKind: "blood_primary" };
}
async function createBranchProposal() {
  if (!lineageId.value) return void (notice.value = "请先选择世系。");
  const composer = branchComposer.value;
  if (!composer.reason.trim() || composer.structureItems.length + composer.membershipItems.length === 0) return void (notice.value = "请填写理由，并至少编排一项房支或成员变更。");
  const response = await request(`/api/admin/lineages/${encodeURIComponent(lineageId.value)}/change-requests`, { method: "POST", body: JSON.stringify({ reason: composer.reason, items: [], membershipItems: composer.membershipItems, structureItems: composer.structureItems }) });
  if (!response.ok) return void (notice.value = await message(response));
  const result = await response.json() as { changeRequest: ChangeRequest };
  clearBranchComposer(); await refreshWorkflowData(); await previewChangeRequest(result.changeRequest.id); notice.value = "房支变更草稿已创建。请核对服务端预览；草稿不可直接修改。";
}
async function previewChangeRequest(id: string) {
  const response = await request(`/api/admin/change-requests/${encodeURIComponent(id)}/preview`);
  if (!response.ok) return void (notice.value = await message(response));
  changePreview.value = await response.json() as ChangePreview;
  selectedChangeRequest.value = changeRequests.value.find((item) => item.id === id) ?? changePreview.value.changeRequest;
  retirementConfirmations.value = {};
}
async function submitChangeRequest() {
  const item = selectedChangeRequest.value; if (!item) return;
  if (!changePreview.value?.preview.valid) return void (notice.value = "预览未通过，不能提交审核。");
  if (!canSubmitBranchChange(changePreview.value.preview.valid, previewRetirements.value, retirementConfirmations.value)) return void (notice.value = "请逐项输入待退休房支名称以确认高风险操作。");
  const response = await request(`/api/admin/change-requests/${item.id}/submit`, { method: "POST", body: JSON.stringify({ version: item.version }) });
  notice.value = response.ok ? "提案已提交审核。" : await message(response); if (response.ok) { selectedChangeRequest.value = null; changePreview.value = null; await refreshWorkflowData(); }
}
async function discardChangeRequest() {
  const item = selectedChangeRequest.value; if (!item) return;
  const response = await request(`/api/admin/change-requests/${item.id}/discard`, { method: "POST", body: JSON.stringify({ version: item.version }) });
  notice.value = response.ok ? "草稿已废弃并保留审计记录。" : await message(response);
  if (response.ok) { selectedChangeRequest.value = null; changePreview.value = null; await refreshWorkflowData(); }
}
function changeRequestState(item: ChangeRequest): string { return item.discarded_at ? "discarded" : item.state; }
async function approveChangeRequest() {
  const item = selectedChangeRequest.value; if (!item) return;
  const response = await request(`/api/admin/change-requests/${item.id}/approve`, { method: "POST", body: JSON.stringify({ version: item.version }) });
  notice.value = response.ok ? "提案已批准，可由有效指派审核人发布。" : await message(response); if (response.ok) { selectedChangeRequest.value = null; changePreview.value = null; await refreshWorkflowData(); }
}
async function rejectChangeRequest() {
  const item = selectedChangeRequest.value; if (!item || !reviewNote.value.trim()) return void (notice.value = "请填写驳回理由。");
  const response = await request(`/api/admin/change-requests/${item.id}/reject`, { method: "POST", body: JSON.stringify({ version: item.version, reviewNote: reviewNote.value }) });
  notice.value = response.ok ? "提案已驳回。" : await message(response); if (response.ok) { reviewNote.value = ""; selectedChangeRequest.value = null; changePreview.value = null; await refreshWorkflowData(); }
}
async function publishChangeRequest() {
  const item = selectedChangeRequest.value; if (!item) return;
  const response = await request(`/api/admin/change-requests/${item.id}/publish`, { method: "POST", body: JSON.stringify({ version: item.version, revisionId: crypto.randomUUID() }) });
  notice.value = response.ok ? "提案已发布为新的不可变 revision。" : await message(response); if (response.ok) { selectedChangeRequest.value = null; changePreview.value = null; await refreshWorkflowData(); }
}
async function createReviewerAssignment() {
  if (!lineageId.value) return; const form = assignmentForm.value;
  const response = await request(`/api/admin/lineages/${lineageId.value}/reviewer-assignments`, { method: "POST", body: JSON.stringify({ ...form, validFrom: new Date(form.validFrom).toISOString(), validUntil: new Date(form.validUntil).toISOString() }) });
  if (!response.ok) return void (notice.value = await message(response));
  assignmentForm.value = { reviewerAccountId: "", validFrom: "", validUntil: "", reason: "" }; await refreshWorkflowData(); notice.value = "审核人指派已建立。";
}
async function revokeReviewerAssignment(item: ReviewerAssignment) {
  const response = await request(`/api/admin/reviewer-assignments/${item.id}/revoke`, { method: "POST", body: JSON.stringify({ version: item.version, reason: "管理员撤销审核人指派" }) });
  notice.value = response.ok ? "审核人指派已撤销。" : await message(response); if (response.ok) await refreshWorkflowData();
}
function zoomChart(direction: 1 | -1) {
  chartZoom.value = Math.min(3, Math.max(0.5, Number((chartZoom.value + direction * 0.25).toFixed(2))));
  chartPan.value = { x: 0, y: 0 };
}
function connectorPoints(connector: ChartConnector) { return connector.points.map((point) => `${point.x},${point.y}`).join(" "); }
function kinshipRelationLabel(relationKind: string) {
  return ({ biological_parent: "生父母", adoptive_parent: "养父母", successor_parent: "嗣父母", spouse: "配偶" } as Record<string, string>)[relationKind] ?? relationKind;
}
function resetChartViewport() {
  chartZoom.value = 1; chartPan.value = { x: 0, y: 0 }; centeredPersonId.value = null;
}
function startChartPan(event: PointerEvent) {
  if (!chartSvg.value || event.button !== 0) return;
  chartSvg.value.setPointerCapture(event.pointerId);
  chartDrag.value = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
}
function moveChartPan(event: PointerEvent) {
  const drag = chartDrag.value;
  if (!drag || drag.pointerId !== event.pointerId || !chartSvg.value) return;
  const rect = chartSvg.value.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const deltaX = (drag.clientX - event.clientX) * chartViewport.value.width / rect.width;
  const deltaY = (drag.clientY - event.clientY) * chartViewport.value.height / rect.height;
  const next = panChartViewport(chartBounds.value, chartViewport.value, deltaX, deltaY);
  const base = createChartViewport(chartBounds.value, chartZoom.value, centeredPersonId.value ? chartPositionById.value.get(centeredPersonId.value) : undefined);
  chartPan.value = { x: next.x - base.x, y: next.y - base.y };
  chartDrag.value = { ...drag, clientX: event.clientX, clientY: event.clientY };
}
function endChartPan(event: PointerEvent) {
  if (chartDrag.value?.pointerId !== event.pointerId || !chartSvg.value) return;
  chartSvg.value.releasePointerCapture(event.pointerId);
  chartDrag.value = null;
}
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
      <section class="workflow-admin">
        <h2>提案工作台</h2><p>关系提案与房支变更均须先创建不可直接修改的草稿，再阅读服务端预览并提交审核。</p>
        <form class="workflow-form" @submit.prevent="createProposal"><label>世系<select v-model="lineageId" required @change="refreshWorkflowData"><option value="" disabled>请选择世系</option><option v-for="lineage in lineages" :key="lineage.id" :value="lineage.id">{{ lineage.name }}</option></select></label><label>理由<input v-model.trim="proposalForm.reason" maxlength="1000" required /></label><label>操作<select v-model="proposalForm.operation"><option value="relation_add">新增亲属关系</option><option value="relation_remove">移除亲属关系</option></select></label><label>{{ proposalForm.relationKind === "spouse" ? "一方人物 ID" : "子女人物 ID" }}<input v-model.trim="proposalForm.subjectPersonId" required /></label><label>{{ proposalForm.relationKind === "spouse" ? "另一方人物 ID" : "父母人物 ID" }}<input v-model.trim="proposalForm.relatedPersonId" required /></label><label>关系类型<select v-model="proposalForm.relationKind"><option value="biological_parent">生父母</option><option value="adoptive_parent">养父母</option><option value="successor_parent">嗣父母</option><option value="spouse">配偶</option></select></label><button>创建草稿并预览</button></form>
        <section class="branch-composer"><h3>房支变更编排器</h3><p v-if="!branchWorkbench">请选择一个已有 published revision 的世系以编排房支变更。</p><template v-else><p>基准 revision：{{ branchWorkbench.revisionId }}。下方编排仅保留在浏览器中，点击创建草稿前不会写入权威数据。</p><label>变更理由<input v-model.trim="branchComposer.reason" maxlength="1000" placeholder="说明本次房支或成员调整原因" /></label><form class="workflow-form" @submit.prevent="addStructureItem"><label>结构操作<select v-model="structureDraft.operation"><option value="create">创建房支</option><option value="rename">改名</option><option value="retire">退休</option></select></label><label v-if="structureDraft.operation !== 'create'">目标房支<select v-model="structureDraft.branchId"><option value="" disabled>请选择房支</option><option v-for="branch in composerBranches.filter((item) => !item.retiredAt)" :key="branch.branchId" :value="branch.branchId">{{ branch.name }}</option></select></label><label v-if="structureDraft.operation === 'create'">父房（可选）<select v-model="structureDraft.parentBranchId"><option value="">无（顶层房支）</option><option v-for="branch in composerBranches.filter((item) => !item.retiredAt)" :key="branch.branchId" :value="branch.branchId">{{ branch.name }}</option></select></label><label v-if="structureDraft.operation !== 'retire'">名称<input v-model.trim="structureDraft.name" maxlength="80" /></label><label v-if="structureDraft.operation === 'create'">类型<select v-model="structureDraft.branchKind"><option value="agnatic">父系</option><option value="migration">迁入支</option><option value="administrative">行政支</option></select></label><button type="submit">加入结构变更</button></form><form class="workflow-form" @submit.prevent="addMembershipItem"><label>成员操作<select v-model="membershipDraft.operation"><option value="add">加入成员</option><option value="remove">移除成员</option></select></label><label>目标房支<select v-model="membershipDraft.branchId"><option value="" disabled>请选择房支</option><option v-for="branch in composerBranches.filter((item) => !item.retiredAt)" :key="branch.branchId" :value="branch.branchId">{{ branch.name }}</option></select></label><label>人物<select v-model="membershipDraft.personId"><option value="" disabled>请选择人物</option><option v-for="person in persons" :key="person.id" :value="person.id">{{ person.display_name }}</option></select></label><label>归属类型<select v-model="membershipDraft.membershipKind"><option value="blood_primary">血缘主归属</option><option value="migration">迁入</option><option value="administrative">行政归属</option></select></label><button type="submit">加入成员变更</button></form><div class="composer-items"><p v-if="branchComposer.structureItems.length + branchComposer.membershipItems.length === 0">尚未编排任何房支变更。</p><div v-for="(item, index) in branchComposer.structureItems" :key="`structure-${item.branchId}-${index}`"><span>结构：{{ item.operation }} · {{ item.name || composerBranches.find((branch) => branch.branchId === item.branchId)?.name || item.branchId }}</span><button type="button" class="secondary" @click="removeStructureItem(index)">移除</button></div><div v-for="(item, index) in branchComposer.membershipItems" :key="`membership-${item.branchId}-${item.personId}-${index}`"><span>成员：{{ item.operation }} · {{ composerBranches.find((branch) => branch.branchId === item.branchId)?.name || item.branchId }} · {{ persons.find((person) => person.id === item.personId)?.display_name || item.personId }}</span><button type="button" class="secondary" @click="removeMembershipItem(index)">移除</button></div></div><div class="actions"><button type="button" class="secondary" @click="clearBranchComposer">清空本地编排</button><button type="button" @click="createBranchProposal">创建房支草稿并预览</button></div></template></section>
        <section class="queue"><h3>审核队列</h3><p v-if="changeRequests.length === 0">当前世系暂无提案。</p><button v-for="item in changeRequests" :key="item.id" type="button" class="queue-item" @click="previewChangeRequest(item.id)"><strong>{{ changeRequestState(item) }}</strong> · {{ item.reason }}<small>{{ item.id }}</small></button></section>
        <article v-if="selectedChangeRequest" class="pending"><h3>提案预览：{{ changeRequestState(selectedChangeRequest) }}</h3><p>{{ selectedChangeRequest.reason }}</p><p v-if="selectedChangeRequest.discarded_at">该草稿已于 {{ selectedChangeRequest.discarded_at }} 废弃，仅保留供审计查看。</p><p v-if="changePreview">校验：{{ changePreview.preview.valid ? "通过" : "未通过" }}；关系 {{ changePreview.preview.relations.length }} 条，成员 {{ changePreview.preview.memberships.length }} 条，房支 {{ changePreview.preview.branchStructure.branches.length }} 个。</p><p v-if="changePreview && changePreview.preview.issues.length">问题：{{ changePreview.preview.issues.map((issue) => issue.code).join("、") }}</p><div v-if="changePreview && changePreview.preview.retirementDependencies.length" class="retirement-preview"><h4>退休依赖预览</h4><p v-for="dependency in changePreview.preview.retirementDependencies" :key="dependency.branchId">{{ changePreview.preview.branchStructure.branches.find((branch) => branch.branchId === dependency.branchId)?.name || dependency.branchId }}：成员 {{ dependency.membershipCount }} 人，账号范围引用 {{ dependency.accountScopeCount }} 项{{ dependency.blockingCodes.length ? `；阻塞：${dependency.blockingCodes.join("、")}` : "；可退休" }}</p></div><label v-for="branch in previewRetirements" :key="branch.branchId">为确认退休「{{ branch.name }}」，请输入完整房支名称<input v-model="retirementConfirmations[branch.branchId]" /></label><p v-if="previewRetirements.length">仅当预览通过且上述名称完全匹配时，才可提交审核。</p><div class="actions"><button v-if="selectedChangeRequest.state === 'draft' && !selectedChangeRequest.discarded_at" :disabled="!changePreview?.preview.valid || !retirementsConfirmed" @click="submitChangeRequest">提交审核</button><button v-if="selectedChangeRequest.state === 'draft' && !selectedChangeRequest.discarded_at" class="secondary" @click="discardChangeRequest">废弃草稿</button><button v-if="selectedChangeRequest.state === 'pending_review'" @click="approveChangeRequest">批准</button><button v-if="selectedChangeRequest.state === 'approved'" @click="publishChangeRequest">发布</button></div><label v-if="selectedChangeRequest.state === 'pending_review'">驳回理由<textarea v-model.trim="reviewNote" maxlength="1000" /></label><button v-if="selectedChangeRequest.state === 'pending_review'" class="secondary" @click="rejectChangeRequest">驳回</button></article>
      </section>
      <section class="workflow-admin"><h2>审核人指派</h2><p>指派独立于编辑范围；有效期最长 90 天，撤销后立即失效。</p><form class="workflow-form" @submit.prevent="createReviewerAssignment"><label>审核人<select v-model="assignmentForm.reviewerAccountId" required><option value="" disabled>请选择活跃管理员</option><option v-for="reviewer in reviewers" :key="reviewer.id" :value="reviewer.id">{{ reviewer.display_name }} · @{{ reviewer.username }}</option></select></label><label>生效时间<input v-model="assignmentForm.validFrom" type="datetime-local" required /></label><label>失效时间<input v-model="assignmentForm.validUntil" type="datetime-local" required /></label><label>指派理由<input v-model.trim="assignmentForm.reason" maxlength="1000" required /></label><button>建立指派</button></form><p v-if="reviewerAssignments.length === 0">当前世系没有审核人指派。</p><article v-for="item in reviewerAssignments" :key="item.id" class="pending"><p>{{ reviewers.find((reviewer) => reviewer.id === item.reviewer_account_id)?.display_name || item.reviewer_account_id }}</p><p>{{ item.valid_from }} 至 {{ item.valid_until }} · {{ item.revoked_at ? "已撤销" : "有效/待生效" }}</p><p>{{ item.reason }}</p><button v-if="!item.revoked_at" class="secondary" @click="revokeReviewerAssignment(item)">撤销</button></article></section>
      <section class="chart-admin">
        <h2>传统吊线图</h2><p>仅读取当前已发布世系；输入世系 ID 后载入，选择人物不会修改关系。</p>
        <form class="chart-controls" @submit.prevent="loadHangingChart"><label>世系<select v-model="lineageId" required @change="refreshWorkflowData"><option value="" disabled>请选择世系</option><option v-for="lineage in lineages" :key="lineage.id" :value="lineage.id">{{ lineage.name }}{{ lineage.published_revision_id ? "（已发布）" : "（未发布）" }}</option></select></label><label>根人物 ID（可选）<input v-model.trim="rootPersonId" placeholder="仅展示该支后代" /></label><button>载入吊线图</button></form>
        <form class="chart-controls" @submit.prevent="loadHistoricalComparison"><label>历史谱书版本<select v-model="editionId"><option value="" disabled>请选择谱书版本</option><option v-for="edition in editions" :key="edition.id" :value="edition.id">{{ edition.genealogy_title }} · {{ edition.title }}</option></select></label><p>仅比较已确认映射和已解释的关系。</p><button>读取历史差异</button></form>
        <form class="chart-controls" @submit.prevent="loadKinship"><label>亲属图人物 ID<input v-model.trim="kinshipPersonId" placeholder="当前发布世系中的人物" /></label><label>展开半径<select v-model.number="kinshipRadius"><option :value="1">1 跳</option><option :value="2">2 跳</option></select></label><p>仅管理员读取当前发布快照；最多 60 人、120 条关系。</p><button>载入亲属图</button></form>
        <div v-if="kinshipLayout" class="chart-canvas"><h3>人物中心亲属图（只读）</h3><p v-if="kinship?.truncated" class="notice">结果已达上限；请选择图内人物重新居中。</p><svg :viewBox="`0 0 ${kinshipLayout.width} ${kinshipLayout.height}`" aria-label="人物中心亲属图"><template v-for="edge in kinshipLayout.relations" :key="`${edge.subjectPersonId}:${edge.relatedPersonId}:${edge.relationKind}`"><line :x1="edge.from.x + 85" :y1="edge.from.y + 24" :x2="edge.to.x + 85" :y2="edge.to.y + 24" /><text class="kinship-relation-label" :x="(edge.from.x + edge.to.x) / 2 + 85" :y="(edge.from.y + edge.to.y) / 2 + 18">{{ kinshipRelationLabel(edge.relationKind) }}</text></template><g v-for="node in kinshipLayout.nodes" :key="node.id" :transform="`translate(${node.x} ${node.y})`"><rect width="170" height="48" rx="4" /><text x="12" y="29">{{ node.displayName }}</text></g></svg></div>
        <section v-if="comparison" class="pending"><h3>历史差异（只读）</h3><p>统一边：{{ comparison.comparison.canonicalEdges.filter((edge) => edge.status === "same").length }} 一致，{{ comparison.comparison.canonicalEdges.filter((edge) => edge.status === "canonical_only").length }} 仅统一。</p><p>历史边：{{ comparison.comparison.historicalEdges.filter((edge) => edge.status === "same").length }} 一致，{{ comparison.comparison.historicalEdges.filter((edge) => edge.status === "historical_only").length }} 仅历史，{{ comparison.comparison.historicalEdges.filter((edge) => edge.status === "uncomparable").length }} 无法比较。</p><div v-if="historicalLayout" class="chart-canvas"><svg :viewBox="`0 0 ${Math.max(640, historicalLayout.nodes.length * 110)} ${Math.max(240, Math.ceil(historicalLayout.nodes.length / Math.ceil(Math.sqrt(historicalLayout.nodes.length || 1))) * 104 + 70)}`" aria-label="历史谱书来源关系图"><line v-for="edge in historicalLayout.connectors" :key="edge.claimId" :class="`historical-${historicalStatus.get(edge.claimId)}`" :x1="edge.x1" :y1="edge.y1" :x2="edge.x2" :y2="edge.y2" /><g v-for="node in historicalLayout.nodes" :key="node.sourceRecordId" :transform="`translate(${node.x} ${node.y})`"><rect width="170" height="48" rx="4" /><text x="12" y="29">{{ node.displayName || node.sourceRecordId }}</text></g></svg></div><p v-for="item in comparison.projection.annotations" :key="item.claimId">{{ item.status }}：{{ item.relationKind }}（{{ item.rawText }}）</p></section>
        <form class="new-lineage" @submit.prevent="createLineage"><label>新建世系名称<input v-model.trim="newLineageName" maxlength="160" required /></label><button type="submit" class="secondary">建立空世系</button></form>
        <div v-if="chart" class="chart-tools"><label>姓名定位<input v-model.trim="chartSearch" placeholder="输入姓名" /></label><div class="actions"><button type="button" class="secondary" @click="zoomChart(-1)">缩小</button><button type="button" class="secondary" @click="resetChartViewport">重置视图</button><button type="button" class="secondary" @click="zoomChart(1)">放大</button><button type="button" @click="exportChartSvg">导出 SVG</button></div></div>
        <div v-if="chartMatches.length" class="chart-matches"><button v-for="node in chartMatches" :key="node.personId" type="button" @click="selectChartPerson(node.personId)">{{ node.displayName }}</button></div>
        <div v-if="chart" class="chart-workspace">
          <div class="chart-canvas"><svg ref="chartSvg" :class="{ dragging: chartDrag }" :viewBox="chartViewBoxValue" role="img" aria-label="传统吊线图，可拖拽平移" @pointerdown="startChartPan" @pointermove="moveChartPan" @pointerup="endChartPan" @pointercancel="endChartPan"><polyline v-for="connector in chart.layout.connectors" :key="`${connector.parentPersonId}:${connector.childPersonId}`" class="chart-connector" :points="connectorPoints(connector)" /><g v-for="node in chart.layout.nodes" :key="node.personId" class="chart-node" :class="{ selected: node.personId === chartPersonId }" :transform="`translate(${node.x} ${node.y})`" role="button" tabindex="0" :aria-label="`查看${chartNodeById.get(node.personId)?.displayName ?? node.personId}`" @pointerdown.stop @click="selectChartPerson(node.personId)" @keydown.enter="selectChartPerson(node.personId)" @keydown.space.prevent="selectChartPerson(node.personId)"><rect width="170" height="48" rx="4" /><text x="12" y="29">{{ chartNodeById.get(node.personId)?.displayName ?? node.personId }}</text></g></svg></div>
          <aside class="person-panel"><template v-if="chartPerson"><h3>{{ chartPerson.person.displayName }}</h3><p class="status">{{ chartPerson.person.visibility }} · {{ chartPerson.person.id }}</p><h4>姓名</h4><p v-if="chartPerson.names.length === 0">暂无附加姓名。</p><ul v-else><li v-for="name in chartPerson.names" :key="name.id">{{ name.name_text }}（{{ name.name_kind }}）</li></ul><h4>事实</h4><p v-if="chartPerson.facts.length === 0">暂无已录入事实。</p><ul v-else><li v-for="fact in chartPerson.facts" :key="fact.id">{{ fact.fact_kind }}：{{ fact.value_text || fact.date_text || fact.place_name || "未详" }}</li></ul></template><p v-else>点击节点查看人物资料。</p></aside>
        </div>
      </section>
    </section>
  </main>
</template>
