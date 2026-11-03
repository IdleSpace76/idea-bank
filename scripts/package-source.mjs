import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceDirectories = ["app", "components", "lib", "public", "scripts", "tests", "test-models", "docs", ".github"];
const rootFiles = [".gitattributes", ".gitignore", ".npmrc", ".env.example", ".nvmrc", "LICENSE", "README.md", "AGENTS.md", "auth.ts", "package.json", "package-lock.json", "tsconfig.json", "playwright.config.ts", "runIdeaBank.cmd"];
const skippedDirectories = new Set(["node_modules", ".next", ".git", ".npm-cache", "test-results", "playwright-report", "dist", "coverage", "backups", "exports", "private", "uploads", "data"]);
const privateFilename = /(?:^\.env(?!\.example$)|\.(?:zip|7z|rar|tar|tgz|gz|pem|key|p12|pfx)$|^(?:library\.json|credentials.*\.json|service-account.*\.json|idea-bank-.*\.json)$)/i;
const textExtension = /\.(?:[cm]?js|tsx?|css|json|md|txt|cmd|gltf)$/i;
const credentialPatterns = [
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["registry credentials", /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
  ["npm token", /^\s*(?:\/\/[^\r\n]+:)?_authToken\s*=\s*[^$\s][^\r\n]+/m],
];

/** Enumerates only source directories, never following symlinks out of the checkout. */
async function collectSources() {
  const files = [];
  async function walk(relative) {
    let entries;
    try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink excluded from public sources: ${name}`);
      if (entry.isDirectory()) { if (!skippedDirectories.has(entry.name)) await walk(name); }
      else if (entry.isFile()) {
        if (privateFilename.test(entry.name)) throw new Error(`Private data or archive found inside source directory: ${name}`);
        files.push(name);
      }
    }
  }
  for (const directory of sourceDirectories) await walk(directory);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!rootFiles.includes(entry.name) && !/^next\.config\.(?:[cm]?js|ts)$/.test(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Expected a regular source file: ${entry.name}`);
    files.push(entry.name);
  }
  for (const required of rootFiles) if (!files.includes(required)) throw new Error(`Missing source file: ${required}`);
  return files.sort();
}

/** Reports filenames and pattern names only; credential values are never printed. */
async function inspectSource(relative) {
  const bytes = await readFile(path.join(root, relative));
  if (textExtension.test(relative) || relative.startsWith(".")) {
    const text = bytes.toString("utf8");
    for (const [name, pattern] of credentialPatterns) if (pattern.test(text)) throw new Error(`Possible ${name} in ${relative}. Source archive was not created.`);
    if (relative.endsWith(".json")) {
      const data = JSON.parse(text);
      if (data && Array.isArray(data.sections) && Array.isArray(data.projects)) throw new Error(`Saved library JSON is not a public source file: ${relative}`);
    }
    if (relative === ".env.example" && text.split(/\r?\n/).some(line => {
      const value = line.trim();
      return value && !value.startsWith("#") && value !== "IDEA_BANK_AUTH_MODE=local" && !/^(?:AUTH_URL|AUTH_SECRET|AUTH_GITHUB_ID|AUTH_GITHUB_SECRET|IDEA_BANK_OWNER_ID|B2_S3_ENDPOINT|B2_REGION|B2_BUCKET_NAME|B2_KEY_ID|B2_APPLICATION_KEY)=$/.test(value);
    })) throw new Error(".env.example may contain only local mode and empty credential placeholders.");
  }
  return bytes;
}

async function main() {
  const files = await collectSources(), entries = {};
  for (const relative of files) entries[relative] = [await inspectSource(relative), { level: /\.(?:png|glb|bin)$/i.test(relative) ? 0 : 6 }];
  if (process.argv.includes("--list")) { console.log(JSON.stringify(files)); return; }
  console.log(`Checked ${files.length} public source files. No credential patterns or saved library JSON found.`);
  if (process.argv.includes("--check")) return;
  const destination = path.join(root, "dist", "idea-bank-source.zip");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, zipSync(entries, { level: 6 }));
  console.log(`Created ${destination}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
