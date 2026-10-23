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
});
export const rollbackRevisionInput = z.object({
  targetRevisionId: z.string().uuid(),
  newRevisionId: z.string().uuid(),
});

export function validationMessage(result: z.ZodSafeParseResult<unknown>): string {
  if (result.success) return "";
  return result.error.issues[0]?.message ?? "请求参数无效。";
}
