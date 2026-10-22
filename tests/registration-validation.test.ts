import { describe, expect, it } from "vitest";
import { registrationInput } from "../worker/auth/validation";

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
});
