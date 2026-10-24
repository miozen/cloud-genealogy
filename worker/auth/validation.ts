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
