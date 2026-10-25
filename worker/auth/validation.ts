import { z } from "zod";

const username = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/u, "用户名格式无效。");
const password = z.string().min(12, "密码至少 12 个字符。").max(128, "密码最长 128 个字符。");
const genealogyName = z.string().trim().min(1, "请填写族谱姓名。").max(80, "族谱姓名最长 80 个字符。");
const optionalHint = z.string().trim().min(1).max(120).optional();

export const registrationInput = z.object({
  username,
  password,
  genealogyName,
  branchName: optionalHint,
  ancestorName: optionalHint,
});

export const loginInput = z.object({ username, password });

export const bootstrapInput = registrationInput.pick({ username: true, password: true, genealogyName: true });

export const personAnchorInput = z.object({
  displayName: genealogyName,
  visibility: z.enum(["PUBLIC", "MEMBER", "ADMIN"]).default("MEMBER"),
});

export const approvalInput = z.object({
  personId: z.string().uuid(),
  role: z.enum(["member", "editor", "admin"]).default("member"),
  version: z.number().int().positive(),
});
export const accountScopesInput = z.object({
  version: z.number().int().positive(),
  scopes: z.array(z.discriminatedUnion("scopeType", [
    z.object({ scopeType: z.literal("global") }),
    z.object({ scopeType: z.literal("branch"), scopeId: z.string().uuid() }),
    z.object({ scopeType: z.literal("person"), scopeId: z.string().uuid() }),
  ])).max(200),
}).superRefine((value, context) => {
  const keys = value.scopes.map((scope) => `${scope.scopeType}:${"scopeId" in scope ? scope.scopeId : ""}`);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "授权范围不能重复。" });
  if (value.scopes.filter((scope) => scope.scopeType === "global").length > 1) context.addIssue({ code: "custom", message: "全局范围最多一项。" });
});
const reviewerAssignmentBase = z.object({
  reviewerAccountId: z.string().uuid(),
  validFrom: z.string().datetime({ offset: true }),
  validUntil: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(1, "请说明指派理由。").max(1_000, "指派理由过长。"),
});
export const reviewerAssignmentInput = reviewerAssignmentBase.superRefine((value, context) => {
  const validFrom = Date.parse(value.validFrom); const validUntil = Date.parse(value.validUntil);
  if (validUntil <= validFrom) context.addIssue({ code: "custom", message: "失效时间必须晚于生效时间。" });
  if (validUntil - validFrom > 90 * 24 * 60 * 60 * 1000) context.addIssue({ code: "custom", message: "审核人指派最长 90 天。" });
});
export const revokeReviewerAssignmentInput = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().min(1, "请说明撤销理由。").max(1_000, "撤销理由过长。"),
});

export const rejectionInput = z.object({ version: z.number().int().positive() });
export const resetPasswordInput = z.object({ password });
export const successionEdgesInput = z.object({
  edges: z.array(z.object({ parentPersonId: z.string().uuid(), childPersonId: z.string().uuid() })).max(2000),
});
export const publishRevisionInput = successionEdgesInput.extend({
  revisionId: z.string().uuid(),
  basedOnRevisionId: z.string().uuid().optional(),
  expectedPointerVersion: z.number().int().nonnegative(),
  relations: z.array(z.object({ subjectPersonId: z.string().uuid(), relatedPersonId: z.string().uuid(), relationKind: z.enum(["biological_parent", "adoptive_parent", "successor_parent", "spouse"]) }).refine((value) => value.subjectPersonId !== value.relatedPersonId, "亲属关系两端不能是同一人物。")).max(2000).default([]),
});
export const rollbackRevisionInput = z.object({
  targetRevisionId: z.string().uuid(),
  newRevisionId: z.string().uuid(),
  expectedPointerVersion: z.number().int().positive(),
});
const changeOperation = z.enum(["succession_add", "succession_remove", "relation_add", "relation_remove"]);
const membershipOperation = z.enum(["add", "remove"]);
const branchKind = z.enum(["agnatic", "migration", "administrative"]);
export const createChangeRequestInput = z.object({
  reason: z.string().trim().min(1, "请说明变更理由。").max(1_000, "变更理由过长。"),
  items: z.array(z.object({
    operation: changeOperation,
    subjectPersonId: z.string().uuid(),
    relatedPersonId: z.string().uuid(),
    relationKind: z.enum(["biological_parent", "adoptive_parent", "successor_parent", "spouse"]).optional(),
  }).superRefine((item, context) => {
    if (item.subjectPersonId === item.relatedPersonId) context.addIssue({ code: "custom", message: "关系两端不能是同一人物。" });
    const needsRelation = item.operation === "relation_add" || item.operation === "relation_remove";
    if (needsRelation !== Boolean(item.relationKind)) context.addIssue({ code: "custom", message: needsRelation ? "亲属关系变更必须指定关系类型。" : "承谱变更不能指定亲属关系类型。" });
  })).max(2_000).default([]),
  membershipItems: z.array(z.object({
    operation: membershipOperation,
    branchId: z.string().uuid(),
    personId: z.string().uuid(),
    membershipKind: z.enum(["blood_primary", "migration", "administrative"]),
  })).max(2_000).default([]),
  structureItems: z.array(z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("create"), branchId: z.string().uuid(), parentBranchId: z.string().uuid().nullable(), name: z.string().trim().min(1).max(80), branchKind }),
    z.object({ operation: z.literal("rename"), branchId: z.string().uuid(), name: z.string().trim().min(1).max(80) }),
    z.object({ operation: z.literal("retire"), branchId: z.string().uuid() }),
  ])).max(200).default([]),
}).superRefine((value, context) => {
  if (value.items.length + value.membershipItems.length + value.structureItems.length === 0) context.addIssue({ code: "custom", message: "至少需要一条变更条目。" });
  const keys = value.items.map((item) => `${item.operation}\u0000${item.subjectPersonId}\u0000${item.relatedPersonId}\u0000${item.relationKind ?? ""}`);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "变更条目不能重复。" });
  const membershipKeys = value.membershipItems.map((item) => `${item.operation}\u0000${item.branchId}\u0000${item.personId}\u0000${item.membershipKind}`);
  if (new Set(membershipKeys).size !== membershipKeys.length) context.addIssue({ code: "custom", message: "房支成员变更条目不能重复。" });
  const structureKeys = value.structureItems.map((item) => `${item.operation}\u0000${item.branchId}`);
  if (new Set(structureKeys).size !== structureKeys.length) context.addIssue({ code: "custom", message: "房支结构变更条目不能重复。" });
});
export const changeRequestVersionInput = z.object({ version: z.number().int().positive() });
export const rejectChangeRequestInput = changeRequestVersionInput.extend({ reviewNote: z.string().trim().min(1, "请说明驳回理由。").max(1_000, "驳回理由过长。") });
export const publishChangeRequestInput = changeRequestVersionInput.extend({ revisionId: z.string().uuid() });
export const rollbackChangeRequestInput = z.object({ reason: z.string().trim().min(1, "请说明回退理由。").max(1_000, "回退理由过长。") });
const sourceTitle = z.string().trim().min(1, "标题不能为空。").max(160, "标题最长 160 个字符。");
export const lineageInput = z.object({ name: sourceTitle });
export const genealogyInput = z.object({ title: sourceTitle });
export const genealogyEditionInput = z.object({
  title: sourceTitle,
  editionLabel: z.string().trim().min(1).max(80).optional(),
  supersedesEditionId: z.string().uuid().optional(),
});
export const sourcePersonRecordInput = z.object({
  sourceKey: z.string().trim().min(1).max(120).optional(),
  nameText: z.string().trim().min(1).max(80).optional(),
  rawText: z.string().trim().min(1, "原始记载不能为空。").max(10_000, "原始记载过长。"),
});
export const sourcePersonLinkInput = z.object({ personId: z.string().uuid() });
export const sourceFactClaimInput = z.object({
  subjectRecordId: z.string().uuid().optional(),
  supersedesClaimId: z.string().uuid().optional(),
  factKind: z.string().trim().min(1, "事实类型不能为空。").max(80, "事实类型最长 80 个字符。"),
  rawText: z.string().trim().min(1, "原文不能为空。").max(10_000, "原文过长。"),
});
export const sourceRelationClaimInput = z.object({
  subjectRecordId: z.string().uuid(),
  relatedRecordId: z.string().uuid().optional(),
  supersedesClaimId: z.string().uuid().optional(),
  relationKind: z.string().trim().min(1, "关系类型不能为空。").max(80, "关系类型最长 80 个字符。"),
  rawText: z.string().trim().min(1, "原文不能为空。").max(10_000, "原文过长。"),
});
export const sourceRelationSemanticRuleInput = z.object({
  relationKind: z.string().trim().min(1, "原始关系词不能为空。").max(80, "原始关系词最长 80 个字符。"),
  graphKind: z.enum(["parent_to_child", "child_to_parent", "spouse", "non_graph"]),
  parentKind: z.enum(["biological_parent", "adoptive_parent", "successor_parent"]).optional(),
}).superRefine((value, context) => {
  const needsParentKind = value.graphKind === "parent_to_child" || value.graphKind === "child_to_parent";
  if (needsParentKind !== Boolean(value.parentKind)) {
    context.addIssue({ code: "custom", message: needsParentKind ? "父子关系必须指定父系类型。" : "非父子关系不能指定父系类型。" });
  }
});
const visibility = z.enum(["PUBLIC", "MEMBER", "ADMIN"]);
export const mediaUploadIntentInput = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/u, "SHA-256 必须为小写十六进制摘要。"),
  byteSize: z.number().int().min(1).max(10 * 1024 * 1024),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  originalFilename: z.string().trim().min(1).max(255).refine((value) => ![...value].some((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127; }), "文件名不能包含控制字符。"),
  visibility,
});
export const personMediaInput = z.object({
  mediaAssetId: z.string().uuid(),
  role: z.enum(["portrait", "document", "other"]),
  displayOrder: z.number().int().min(0).max(10_000).default(0),
  caption: z.string().trim().min(1).max(1_000).refine((value) => ![...value].some((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127; }), "说明不能包含控制字符。").optional(),
});
export const personMediaOrderInput = z.object({ displayOrder: z.number().int().min(0).max(10_000) });
export const mediaCleanupRunInput = z.object({
  backupRecoveryPoint: z.string().trim().min(1).max(255),
  backupPackageSha256: z.string().regex(/^[0-9a-f]{64}$/u, "备份包 SHA-256 必须为小写十六进制摘要。"),
});
export const personNameInput = z.object({
  nameText: z.string().trim().min(1, "姓名不能为空。").max(80, "姓名最长 80 个字符。"),
  nameKind: z.enum(["genealogy", "courtesy", "art_name", "alias", "source_text"]),
  isPrimary: z.boolean().default(false),
  visibility: visibility.default("MEMBER"),
});
export const personFactInput = z.object({
  factKind: z.string().trim().min(1, "事实类型不能为空。").max(80, "事实类型最长 80 个字符。"),
  valueText: z.string().trim().min(1).max(500).optional(),
  dateText: z.string().trim().min(1).max(64).optional(),
  datePrecision: z.enum(["exact", "year_month", "year", "approximate", "unknown"]).default("unknown"),
  placeId: z.string().uuid().optional(),
  placeName: z.string().trim().min(1).max(160).optional(),
  placeKind: z.string().trim().min(1).max(40).optional(),
  visibility: visibility.default("MEMBER"),
}).refine((value) => !(value.placeId && value.placeName), { message: "地点只能选择已有地点或填写新地点。" });

export function validationMessage(result: z.ZodSafeParseResult<unknown>): string {
  if (result.success) return "";
  return result.error.issues[0]?.message ?? "请求参数无效。";
}
