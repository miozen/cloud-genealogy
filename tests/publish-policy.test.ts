import { expect, it } from "vitest";
import { allowsDirectRevisionWrite } from "../worker/lineage/publish-policy";

it("allows direct revision writes only for local development", () => {
  expect(allowsDirectRevisionWrite("development")).toBe(true);
  expect(allowsDirectRevisionWrite("preview")).toBe(false);
  expect(allowsDirectRevisionWrite("production")).toBe(false);
});
