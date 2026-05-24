import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const distDir = join(projectRoot, "dist");
const stagingDir = join(distDir, ".package-staging");

const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const outputName = `${packageJson.name}-v${packageJson.version}.zip`;
const outputPath = join(distDir, outputName);

const includedPaths = [
  "manifest.json",
  "src",
  "assets",
  "README.md",
  "LICENSE",
  "PRIVACY.md"
];

mkdirSync(distDir, { recursive: true });
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

for (const relativePath of includedPaths) {
  const sourcePath = join(projectRoot, relativePath);
  if (!existsSync(sourcePath)) {
    throw new Error(`Missing required package file: ${relativePath}`);
  }
  cpSync(sourcePath, join(stagingDir, relativePath), { recursive: true });
}

rmSync(outputPath, { force: true });
execFileSync("zip", ["-qr", outputPath, ...includedPaths.map((filePath) => basename(filePath))], {
  cwd: stagingDir,
  stdio: "inherit"
});

rmSync(stagingDir, { recursive: true, force: true });

console.log(`Created ${outputPath}`);
