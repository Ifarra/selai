import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "selai-packaging-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = {};
  for (const name of ["collect-bundles", "assemble-release"]) {
    const script = join(root, `${name}.sh`);
    // Windows checkouts may use CRLF; runners execute these scripts with LF.
    writeFileSync(script, readFileSync(new URL(`./${name}.sh`, import.meta.url), "utf8").replaceAll("\r\n", "\n"));
    scripts[name] = script;
  }
  function file(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  const artifacts = join(root, "artifacts");
  function platform(name, files) {
    const dir = join(artifacts, `installers-${name}`);
    const sums = [];
    for (const [name, content] of Object.entries(files)) {
      file(join(dir, name), content);
      sums.push(`${createHash("sha256").update(content).digest("hex")}  ${name}\n`);
    }
    file(join(dir, "SHA256SUMS"), sums.join(""));
    return dir;
  }
  function run(name, args, env = {}) {
    return spawnSync("bash", [scripts[name], ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }
  return { root, artifacts, file, platform, run };
}

const unixOnly = { skip: process.platform === "win32" };

test("both macOS architectures stage and assemble with distinct app archives", unixOnly, (t) => {
  const f = fixture(t);
  const bin = join(f.root, "bin");
  // Linux has no ditto. Stand in for its copy to exercise archive naming and
  // release assembly; native archive fidelity still needs macOS validation.
  f.file(join(bin, "ditto"), `#!/usr/bin/env node
const fs = require('node:fs');
const [app, archive] = process.argv.slice(-2);
fs.copyFileSync(app + '/Contents/MacOS/selai-desktop', archive);
`);
  chmodSync(join(bin, "ditto"), 0o755);
  for (const [platform, arch] of [["macos", "aarch64"], ["macos-intel", "x64"]]) {
    const bundle = join(f.root, `bundle-${arch}`);
    f.file(join(bundle, "dmg", `Selai_0.4.0_${arch}.dmg`), `${arch} disk image`);
    f.file(join(bundle, "macos", "Selai.app", "Contents", "MacOS", "selai-desktop"), `${arch} executable`);
    const result = f.run("collect-bundles", [bundle, join(f.artifacts, `installers-${platform}`), arch], {
      PATH: `${bin}:${process.env.PATH}`,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  f.platform("linux", { "selai.deb": "linux installer" });
  f.platform("windows", { "Selai.exe": "windows installer" });
  f.file(join(f.artifacts, "sbom", "selai.cdx.json"), "{}");
  const dist = join(f.root, "dist");
  const result = f.run("assemble-release", [f.artifacts, dist]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const arch of ["aarch64", "x64"]) {
    assert.equal(readFileSync(join(dist, `Selai_${arch}.app.zip`), "utf8"), `${arch} executable`);
    assert.equal(readFileSync(join(dist, `Selai_0.4.0_${arch}.dmg`), "utf8"), `${arch} disk image`);
  }
  const checksum = spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: dist, encoding: "utf8" });
  assert.equal(checksum.status, 0, checksum.stdout + checksum.stderr);
  assert.ok(readFileSync(join(dist, "SHA256SUMS"), "utf8").includes("sbom-cyclonedx.tar.gz"));
});

test("release assembly rejects a missing Intel artifact", unixOnly, (t) => {
  const f = fixture(t);
  for (const platform of ["linux", "windows", "macos"]) {
    f.platform(platform, { [`${platform}.installer`]: platform });
  }
  const result = f.run("assemble-release", [f.artifacts, join(f.root, "dist")]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing .*installers-macos-intel\/SHA256SUMS/);
});

test("release assembly checks Intel checksums before publishing its files", unixOnly, (t) => {
  const f = fixture(t);
  for (const platform of ["linux", "windows", "macos", "macos-intel"]) {
    f.platform(platform, { [`${platform}.installer`]: platform });
  }
  f.file(join(f.artifacts, "installers-macos-intel", "macos-intel.installer"), "corrupted");
  const result = f.run("assemble-release", [f.artifacts, join(f.root, "dist")]);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /macos-intel\.installer: FAILED/);
});

// Minisign signatures as the Tauri CLI writes them: prehashed (BLAKE2b) Ed25519,
// with a global signature over the trusted comment that carries the version.
function minisignKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const pub = `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`;
  return {
    pubkey: Buffer.from(pub).toString("base64"),
    sign(data, comment) {
      const signature = sign(null, createHash("blake2b512").update(data).digest(), privateKey);
      const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
      const text = `untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`;
      return Buffer.from(text).toString("base64");
    },
  };
}

const updater = await import("./updater-manifest.mjs");

function updaterRelease(t, { key = minisignKey(), signer = key, version = "0.4.5", signedVersion = version } = {}) {
  const dist = mkdtempSync(join(tmpdir(), "selai-updater-"));
  t.after(() => rmSync(dist, { recursive: true, force: true }));
  for (const name of Object.values(updater.targets(version))) {
    const data = Buffer.from(`${name} package`);
    writeFileSync(join(dist, name), data);
    writeFileSync(join(dist, `${name}.sig`), signer.sign(data, `timestamp:1\tfile:${name}\tversion:${signedVersion}`));
  }
  return { dist, key, version };
}

test("updater manifest lists every target with its verified signature and tag URL", (t) => {
  const { dist, key } = updaterRelease(t);
  const manifest = updater.buildManifest({ dist, tag: "v0.4.5", repository: "f3ci/selai", pubkey: key.pubkey, now: new Date("2026-11-05T00:00:00.123Z") });
  assert.equal(manifest.version, "0.4.5");
  assert.equal(manifest.pub_date, "2026-11-05T00:00:00Z");
  assert.deepEqual(Object.keys(manifest.platforms).sort(), [
    "darwin-aarch64-app", "darwin-x86_64-app", "linux-x86_64-appimage", "windows-x86_64-msi", "windows-x86_64-nsis",
  ]);
  assert.equal(manifest.platforms["windows-x86_64-nsis"].url,
    "https://github.com/f3ci/selai/releases/download/v0.4.5/Selai_0.4.5_x64-setup.exe");
  assert.equal(manifest.platforms["darwin-x86_64-app"].signature,
    readFileSync(join(dist, "Selai_x64.app.tar.gz.sig"), "utf8").trim());
  assert.ok(!("linux-x86_64" in manifest.platforms), "no generic target that a .deb install could match");
});

test("updater manifest rejects a key the app does not trust", (t) => {
  const { dist } = updaterRelease(t, { signer: minisignKey(), key: minisignKey() });
  assert.throws(() => updater.buildManifest({ dist, tag: "v0.4.5", repository: "f3ci/selai", pubkey: minisignKey().pubkey }),
    /different key than tauri.conf.json trusts/);
});

test("updater manifest rejects tampered packages and signatures for another version", (t) => {
  const tampered = updaterRelease(t);
  writeFileSync(join(tampered.dist, "Selai_aarch64.app.tar.gz"), "replaced");
  assert.throws(() => updater.buildManifest({ dist: tampered.dist, tag: "v0.4.5", repository: "f3ci/selai", pubkey: tampered.key.pubkey }),
    /darwin-aarch64-app: .*signature does not match the file/);
  const replayed = updaterRelease(t, { signedVersion: "0.4.4" });
  assert.throws(() => updater.buildManifest({ dist: replayed.dist, tag: "v0.4.5", repository: "f3ci/selai", pubkey: replayed.key.pubkey }),
    /signed for version 0\.4\.4, expected 0\.4\.5/);
});

test("updater manifest requires every platform's package and signature", (t) => {
  const { dist, key } = updaterRelease(t);
  rmSync(join(dist, "Selai_0.4.5_amd64.AppImage.sig"));
  assert.throws(() => updater.buildManifest({ dist, tag: "v0.4.5", repository: "f3ci/selai", pubkey: key.pubkey }),
    /linux-x86_64-appimage: missing Selai_0\.4\.5_amd64\.AppImage\.sig/);
});

test("macOS updater packages are staged per architecture with their signatures", unixOnly, (t) => {
  const f = fixture(t);
  const bundle = join(f.root, "bundle");
  f.file(join(bundle, "dmg", "Selai_0.4.5_x64.dmg"), "disk image");
  f.file(join(bundle, "macos", "Selai.app.tar.gz"), "updater package");
  f.file(join(bundle, "macos", "Selai.app.tar.gz.sig"), "signature");
  f.file(join(bundle, "appimage", "Selai_0.4.5_amd64.AppImage.sig"), "appimage signature");
  const stage = join(f.root, "stage");
  const result = f.run("collect-bundles", [bundle, stage, "x64"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(stage, "Selai_x64.app.tar.gz"), "utf8"), "updater package");
  assert.equal(readFileSync(join(stage, "Selai_x64.app.tar.gz.sig"), "utf8"), "signature");
  assert.equal(readFileSync(join(stage, "Selai_0.4.5_amd64.AppImage.sig"), "utf8"), "appimage signature");
  assert.match(readFileSync(join(stage, "SHA256SUMS"), "utf8"), /Selai_x64\.app\.tar\.gz\.sig/);
});
