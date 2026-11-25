import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..');
const extensionDir = path.join(repoRoot, 'extension');
const testsDir = path.join(repoRoot, 'tests');

const errors = [];
let checkedScripts = 0;

function recordError(message) {
  errors.push(message);
}

function checkFileExists(relativePath, context) {
  const fullPath = path.join(extensionDir, relativePath);
  if (!fs.existsSync(fullPath)) {
    recordError(`Missing file referenced by ${context}: extension/${relativePath}`);
    return false;
  }
  return true;
}

function checkNodeSyntax(filePath) {
  try {
    execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
    checkedScripts += 1;
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString('utf8').trim() : error.message;
    recordError(`Syntax check failed for ${path.relative(repoRoot, filePath)}:\n${stderr}`);
  }
}

function validateManifest() {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    recordError('Missing extension/manifest.json');
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    recordError(`Invalid JSON in extension/manifest.json: ${error.message}`);
    return;
  }

  if (manifest.manifest_version !== 3) {
    recordError(`Expected manifest_version 3, got ${manifest.manifest_version}`);
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    recordError(`Invalid semver version in manifest.json: ${manifest.version}`);
  }
  if (typeof manifest.background?.service_worker !== 'string') {
    recordError('Missing background.service_worker in manifest.json');
  } else {
    checkFileExists(manifest.background.service_worker, 'manifest.background.service_worker');
  }

  if (typeof manifest.action?.default_popup !== 'string') {
    recordError('Missing action.default_popup in manifest.json');
  } else {
    checkFileExists(manifest.action.default_popup, 'manifest.action.default_popup');
  }

  for (const [size, iconPath] of Object.entries(manifest.icons ?? {})) {
    checkFileExists(iconPath, `manifest.icons.${size}`);
  }
  for (const [size, iconPath] of Object.entries(manifest.action?.default_icon ?? {})) {
    checkFileExists(iconPath, `manifest.action.default_icon.${size}`);
  }
}

function validateExtensionScripts() {
  const jsFiles = fs.readdirSync(extensionDir)
    .filter((name) => name.endsWith('.js'))
    .sort();

  const forbiddenPatterns = [
    { label: 'innerHTML', regex: /\binnerHTML\b/ },
    { label: 'outerHTML', regex: /\bouterHTML\b/ },
    { label: 'insertAdjacentHTML', regex: /\binsertAdjacentHTML\b/ },
    { label: 'eval()', regex: /\beval\s*\(/ },
    { label: 'new Function()', regex: /\bnew\s+Function\s*\(/ },
    { label: 'document.write()', regex: /\bdocument\.write\s*\(/ }
  ];

  for (const fileName of jsFiles) {
    const filePath = path.join(extensionDir, fileName);
    checkNodeSyntax(filePath);
    const source = fs.readFileSync(filePath, 'utf8');

    for (const pattern of forbiddenPatterns) {
      if (pattern.regex.test(source)) {
        recordError(`Forbidden pattern ${pattern.label} found in extension/${fileName}`);
      }
    }
  }

  const iifeRequiredFiles = ['siteConfig.js', 'contentScript.js', 'popup.js'];
  for (const fileName of iifeRequiredFiles) {
    const source = fs.readFileSync(path.join(extensionDir, fileName), 'utf8').trim();
    if (!source.startsWith('(() => {') || !source.endsWith('})();')) {
      recordError(`extension/${fileName} must be wrapped in an IIFE for safe re-injection`);
    }
  }

  const backgroundSource = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');
  if (!/const\s+CONTENT_FILES\s*=\s*\[\s*'siteConfig\.js'\s*,\s*'contentScript\.js'\s*\]/.test(backgroundSource)) {
    recordError('extension/background.js must declare CONTENT_FILES = [\'siteConfig.js\', \'contentScript.js\']');
  }
  if (!/js:\s*CONTENT_FILES/.test(backgroundSource) || !/files:\s*CONTENT_FILES/.test(backgroundSource)) {
    recordError('extension/background.js must use CONTENT_FILES for both registerContentScripts and executeScript');
  }
}

function validatePopupHtml() {
  const popupPath = path.join(extensionDir, 'popup.html');
  const html = fs.readFileSync(popupPath, 'utf8');
  if (/\son[a-z]+\s*=/i.test(html)) {
    recordError('Inline event handler attribute detected in extension/popup.html');
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) {
    recordError('Inline <script> block detected in extension/popup.html');
  }
  for (const asset of ['popup.css', 'siteConfig.js', 'popup.js']) {
    if (!html.includes(asset)) {
      recordError(`extension/popup.html is missing reference to ${asset}`);
    }
  }
}

function validateTestScripts() {
  const testFiles = fs.readdirSync(testsDir)
    .filter((name) => name.endsWith('.mjs'))
    .sort();
  for (const fileName of testFiles) {
    checkNodeSyntax(path.join(testsDir, fileName));
  }
}

function validatePackageJson() {
  const pkgPath = path.join(repoRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = Object.keys(pkg.dependencies ?? {});
  const devDeps = Object.keys(pkg.devDependencies ?? {});
  if (deps.length > 0 || devDeps.length > 0) {
    recordError('package.json must keep zero external dependencies');
  }
}

validateManifest();
validateExtensionScripts();
validatePopupHtml();
validateTestScripts();
validatePackageJson();

if (errors.length > 0) {
  console.error(`Static check failed with ${errors.length} issue(s):`);
  for (const issue of errors) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log(`Static check passed (${checkedScripts} scripts verified, manifest & CSP/security rules clean).`);
