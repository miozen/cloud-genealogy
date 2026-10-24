import { describe, expect, it } from "vitest";
import { createChangeRequestInput, registrationInput } from "../worker/auth/validation";

describe("registration input", () => {
  it("keeps unique login identity separate from the repeatable genealogy name", () => {
    const parsed = registrationInput.safeParse({
      username: "family.member",
      password: "correct-horse-battery-staple",
      genealogyName: "张三",
      branchName: "长房",
      ancestorName: "张祖先",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.username).toBe("family.member");
      expect(parsed.data.genealogyName).toBe("张三");
    }
  });

  it("rejects a short password and malformed username", () => {
    expect(registrationInput.safeParse({ username: "a!", password: "short", genealogyName: "张三" }).success).toBe(false);
  });

  it("rejects duplicate change items before they reach the database", () => {
    const item = {
      operation: "relation_add" as const,
      subjectPersonId: "11111111-1111-4111-8111-111111111111",
      relatedPersonId: "22222222-2222-4222-8222-222222222222",
      relationKind: "adoptive_parent" as const,
    };
    expect(createChangeRequestInput.safeParse({ reason: "重复条目", items: [item, item] }).success).toBe(false);
  });
});
