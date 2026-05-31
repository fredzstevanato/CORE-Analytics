import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const packagesDir = path.resolve("packages");
const workspaceDirs = [path.resolve("packages"), path.resolve("apps")];

function listFilesRecursive(dir, predicate) {
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir);
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...listFilesRecursive(fullPath, predicate));
      continue;
    }

    if (!predicate || predicate(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function hasRuntimeExtension(specifier) {
  return path.posix.extname(specifier) !== "";
}

function normalizeRelativeSpecifier(filePath, specifier) {
  if (!specifier.startsWith(".") || hasRuntimeExtension(specifier)) {
    return specifier;
  }

  const resolved = path.resolve(path.dirname(filePath), specifier);
  if (existsSync(`${resolved}.js`)) {
    return `${specifier}.js`;
  }
  if (existsSync(path.join(resolved, "index.js"))) {
    return `${specifier.replace(/\/$/, "")}/index.js`;
  }

  return specifier;
}

function patchRelativeEsmSpecifiers(filePath) {
  const source = readFileSync(filePath, "utf8");
  let output = source;

  const replaceSpecifier = (match, prefix, quote, specifier) => {
    const normalized = normalizeRelativeSpecifier(filePath, specifier);
    return `${prefix}${quote}${normalized}${quote}`;
  };

  output = output.replace(
    /(\b(?:import|export)\s+[^'";]*?\s+from\s*)(["'])(\.{1,2}\/[^"']+)\2/g,
    replaceSpecifier,
  );
  output = output.replace(/(\bimport\s*)(["'])(\.{1,2}\/[^"']+)\2/g, replaceSpecifier);
  output = output.replace(/(\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\2/g, replaceSpecifier);

  if (output !== source) {
    writeFileSync(filePath, output);
  }
}

for (const name of readdirSync(packagesDir)) {
  const packageJsonPath = path.join(packagesDir, name, "package.json");
  const distIndexCandidates = ["dist/index.js", "dist/src/index.js"];
  const distIndex = distIndexCandidates.find((candidate) => existsSync(path.join(packagesDir, name, candidate)));
  const distTypes = distIndex ? distIndex.replace(/\.js$/, ".d.ts") : null;

  if (!existsSync(packageJsonPath) || !distIndex) continue;

  const json = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  json.main = distIndex;
  if (distTypes && existsSync(path.join(packagesDir, name, distTypes))) {
    json.types = distTypes;
  }
  writeFileSync(packageJsonPath, `${JSON.stringify(json, null, 2)}\n`);
}

for (const workspaceDir of workspaceDirs) {
  for (const name of readdirSync(workspaceDir)) {
    const distDir = path.join(workspaceDir, name, "dist");
    const distFiles = listFilesRecursive(distDir, (filePath) => filePath.endsWith(".js"));
    for (const filePath of distFiles) {
      patchRelativeEsmSpecifiers(filePath);
    }
  }
}
