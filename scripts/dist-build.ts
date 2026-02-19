import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const distRoot = path.resolve(process.cwd(), "dist");

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Command ${cmd} exited with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Command ${cmd} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

function patchExportAll(filePath: string): boolean {
  const raw = fs.readFileSync(filePath, "utf8");

  // Only patch files that use __exportAll or import it from the gateway-cli chunk.
  const usesExportAll = raw.includes("__exportAll(");
  const importsExportAllFromGateway =
    /import\s*\{[^}]*\bas\s+__exportAll\b[^}]*\}\s*from\s*"\.\/gateway-cli-[^"]+\.js";/.test(raw);

  if (!usesExportAll && !importsExportAllFromGateway) {
    return false;
  }

  // Remove broken helper import: tsdown sometimes maps it to a non-function export.
  // Example: import { t as __exportAll } from "./gateway-cli-xxxx.js";
  // If there are other named imports in the same statement, preserve them.
  const withoutBadImport = raw.replace(
    /(^\s*import\s*\{([^}]*)\}\s*from\s*"(\.\/gateway-cli-[^"]+\.js)";\s*$)/gm,
    (full, prefix, specListRaw, source) => {
      const specs = String(specListRaw)
        .split(",")
        .map((spec) => spec.trim())
        .filter(Boolean);

      const kept = specs.filter((spec) => {
        if (spec === "__exportAll") {
          return false;
        }
        // matches both `t as __exportAll` and `t as __exportAll /*...*/`.
        return !/\bas\s+__exportAll\b/.test(spec);
      });

      if (kept.length === specs.length) {
        return full;
      }

      if (kept.length === 0) {
        return "";
      }

      return `${prefix}{ ${kept.join(", ")} } from "${source}";`;
    },
  );

  // If __exportAll is already defined locally, we only needed to strip the bad import.
  const alreadyDefinesExportAll = /\b(var|const|function)\s+__exportAll\b/.test(withoutBadImport);
  if (alreadyDefinesExportAll) {
    if (withoutBadImport !== raw) {
      fs.writeFileSync(filePath, withoutBadImport);
      return true;
    }
    return false;
  }

  // If we got here, we need to define the helper locally.
  // ESM imports must come first, so we inject after the import block.
  const helper =
    "var __defProp = Object.defineProperty;\n" +
    "var __exportAll = (all, no_symbols) => {\n" +
    "  let target = {};\n" +
    "  for (var name in all) {\n" +
    "    __defProp(target, name, {\n" +
    "      get: all[name],\n" +
    "      enumerable: true\n" +
    "    });\n" +
    "  }\n" +
    "  if (!no_symbols) {\n" +
    '    __defProp(target, Symbol.toStringTag, { value: "Module" });\n' +
    "  }\n" +
    "  return target;\n" +
    "};\n";

  const lines = withoutBadImport.split(/(?<=\n)/);
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("import ") || line.startsWith("import\t")) {
      insertAt = i + 1;
      continue;
    }
    // once we're past the import block, stop
    if (insertAt > 0) {
      break;
    }
  }

  lines.splice(insertAt, 0, helper);
  const patched = lines.join("");

  if (patched === raw) {
    return false;
  }

  fs.writeFileSync(filePath, patched);
  return true;
}

async function main() {
  const args = process.argv.slice(2);

  // Run tsdown first.
  // When invoked via pnpm scripts, the binary should be on PATH.
  await run(
    process.platform === "win32" ? "cmd.exe" : "tsdown",
    process.platform === "win32" ? ["/d", "/s", "/c", "tsdown", ...args] : args,
  );

  // Patch dist output.
  const distFiles = fs.existsSync(distRoot)
    ? fs
        .readdirSync(distRoot)
        .filter((f) => f.endsWith(".js"))
        .map((f) => path.join(distRoot, f))
    : [];

  let changed = 0;
  for (const filePath of distFiles) {
    if (patchExportAll(filePath)) {
      changed++;
    }
  }

  if (changed > 0) {
    // eslint-disable-next-line no-console
    console.log(`[dist-build] patched __exportAll in ${changed} dist files`);
  }
}

await main();
