import ts from "typescript";

export type InventoryEntry = { method: string; path: string; kind: "guarded" | "read" | "control" | "preview"; marker?: string };
const methods = new Set(["get", "post", "put", "patch", "delete"]);
const control = new Set(["POST /api/admin/backup-write-freeze", "POST /api/admin/backup-write-freeze/release"]);
const preview = "POST /api/admin/lineages/:lineageId/revisions/preview";
const middleware = new Set(["securityHeaders", "sessionMiddleware", "csrfProtection", "backupWriteFreezeProtection"]);

/** Structural inventory only; cannot establish semantic correctness of a guard. */
export function auditEntryPoints(source: string, inventory: InventoryEntry[]) {
  const tree = ts.createSourceFile("app.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const expected = new Map(inventory.map((item) => [`${item.method} ${item.path}`, item]));
  const seen = new Set<string>(); const seenMiddleware = new Set<string>(); const errors: string[] = [];
  if (expected.size !== inventory.length) errors.push("duplicate inventory entry");
  function visit(node: ts.Node) {
    if (ts.isElementAccessExpression(node) && node.expression.getText(tree) === "app") errors.push("dynamic app access requires review");
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.initializer) && node.initializer.text === "app") errors.push("app alias requires review");
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(tree) === "app") {
      const method = node.expression.name.text;
      if (["on", "all", "route", "mount", "head", "options", "connect", "trace"].includes(method)) errors.push(`unsupported route registration: ${method}`);
      if (method === "onError" || method === "notFound") {
        let writes = false;
        function inspectFallback(child: ts.Node) {
          if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) && ["run", "exec", "put", "delete"].includes(child.expression.name.text)) writes = true;
          if ((ts.isStringLiteralLike(child) || ts.isTemplateHead(child)) && /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(child.text)) writes = true;
          ts.forEachChild(child, inspectFallback);
        }
        node.arguments.forEach(inspectFallback);
        if (writes) errors.push(`fallback handler contains a direct write: ${method}`);
      }
      if (method === "use") {
        const [path, handler] = node.arguments;
        if (!path || !ts.isStringLiteral(path) || path.text !== "/api/*" || !handler || !ts.isIdentifier(handler) || !middleware.has(handler.text)) errors.push("unreviewed middleware registration");
        else if (seenMiddleware.has(handler.text)) errors.push(`duplicate middleware: ${handler.text}`);
        else seenMiddleware.add(handler.text);
      }
      if (methods.has(method)) {
        const path = node.arguments[0];
        if (!path || !ts.isStringLiteral(path)) errors.push(`dynamic ${method} path requires review`);
        else {
          const key = `${method.toUpperCase()} ${path.text}`; const entry = expected.get(key);
          if (!entry) errors.push(`unregistered route: ${key}`);
          else {
            if (seen.has(key)) errors.push(`duplicate route: ${key}`);
            seen.add(key);
            const kind = method === "get" ? "read" : control.has(key) ? "control" : key === preview ? "preview" : "guarded";
            if (entry.kind !== kind) errors.push(`wrong classification: ${key}`);
            let hasMarker = false; let unsafeRead = false;
            function inspect(child: ts.Node) {
              if (entry?.marker && ts.isIdentifier(child) && child.text === entry.marker) hasMarker = true;
              if (entry?.marker === "backup_write_admission" && (ts.isStringLiteralLike(child) || ts.isTemplateHead(child) || ts.isTemplateMiddle(child) || ts.isTemplateTail(child)) && child.text.includes("backup_write_admission")) hasMarker = true;
              if ((kind === "read" || kind === "preview") && ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) && ["run", "exec", "put", "delete"].includes(child.expression.name.text)) unsafeRead = true;
              if ((kind === "read" || kind === "preview") && (ts.isStringLiteralLike(child) || ts.isTemplateHead(child)) && /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(child.text)) unsafeRead = true;
              ts.forEachChild(child, inspect);
            }
            node.arguments.slice(1).forEach(inspect);
            if (kind === "guarded" && (!entry.marker || !hasMarker)) errors.push(`guard marker missing: ${key}`);
            if (unsafeRead) errors.push(`read route contains a direct write: ${key}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  for (const key of expected.keys()) if (!seen.has(key)) errors.push(`inventory route missing: ${key}`);
  for (const name of middleware) if (!seenMiddleware.has(name)) errors.push(`middleware missing: ${name}`);
  return errors;
}
