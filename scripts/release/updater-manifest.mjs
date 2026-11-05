#!/usr/bin/env node
// Writes the in-app updater manifest (latest.json) for one release.
//
// Every updater package must have a minisign signature (`<file>.sig`) that
// verifies against the public key the shipped app trusts (tauri.conf.json),
// and whose trusted comment binds it to this release's version. A package
// signed with another key, or for another version, stops the release: shipping
// it would leave every installed copy unable to update.
//
// Usage: node scripts/release/updater-manifest.mjs <dist-dir> <tag> <owner/repo>
//   UPDATER_PUBKEY overrides the key read from tauri.conf.json. It is set only
//   for the transitional release of a key rotation (docs/release/packaging.md).
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Updater targets and the release file that serves each one. Only explicit
 *  `{os}-{arch}-{bundle}` keys are written: a generic `linux-x86_64` entry
 *  would hand an AppImage to a .deb installation. */
export function targets(version) {
  return {
    "windows-x86_64-nsis": `Selai_${version}_x64-setup.exe`,
    "windows-x86_64-msi": `Selai_${version}_x64_en-US.msi`,
    "linux-x86_64-appimage": `Selai_${version}_amd64.AppImage`,
    "darwin-aarch64-app": "Selai_aarch64.app.tar.gz",
    "darwin-x86_64-app": "Selai_x64.app.tar.gz",
  };
}

function lines(base64, what) {
  const text = Buffer.from(base64.trim(), "base64").toString("utf8");
  const result = text.split(/\r?\n/);
  if (result.length < 2) throw new Error(`${what} is not a minisign file`);
  return result;
}

/** Parses a Tauri public key (base64 of a minisign .pub file). */
export function parsePublicKey(pubkey) {
  const raw = Buffer.from(lines(pubkey, "public key")[1], "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== "Ed") throw new Error("unsupported public key");
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.subarray(10).toString("base64url") },
    format: "jwk",
  });
  return { keyId: raw.subarray(2, 10), key };
}

/** Verifies a Tauri signature (base64 of a minisign .sig file) over `data`
 *  and returns the signed version from its trusted comment. */
export function verifySignature(data, signature, publicKey) {
  const [, sigLine, commentLine, globalLine] = lines(signature, "signature");
  const sig = Buffer.from(sigLine ?? "", "base64");
  if (sig.length !== 74) throw new Error("malformed signature");
  const algorithm = sig.subarray(0, 2).toString();
  if (!sig.subarray(2, 10).equals(publicKey.keyId)) {
    throw new Error("signed with a different key than tauri.conf.json trusts");
  }
  const message = algorithm === "ED"
    ? createHash("blake2b512").update(data).digest()
    : algorithm === "Ed" ? data : null;
  if (!message) throw new Error(`unsupported signature algorithm ${algorithm}`);
  if (!verify(null, message, publicKey.key, sig.subarray(10))) throw new Error("signature does not match the file");
  if (!commentLine?.startsWith("trusted comment: ")) throw new Error("missing trusted comment");
  const comment = commentLine.slice("trusted comment: ".length);
  const global = Buffer.from(globalLine ?? "", "base64");
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(comment)]), publicKey.key, global)) {
    throw new Error("trusted comment signature does not match");
  }
  return comment.split("\t").find((field) => field.startsWith("version:"))?.slice("version:".length) ?? null;
}

export function buildManifest({ dist, tag, repository, pubkey, now = new Date() }) {
  const version = tag.replace(/^v/, "");
  const publicKey = parsePublicKey(pubkey);
  const files = new Set(readdirSync(dist));
  const platforms = {};
  const errors = [];
  for (const [target, name] of Object.entries(targets(version))) {
    if (!files.has(name) || !files.has(`${name}.sig`)) {
      errors.push(`${target}: missing ${files.has(name) ? `${name}.sig` : name}`);
      continue;
    }
    const signature = readFileSync(join(dist, `${name}.sig`), "utf8").trim();
    try {
      const signed = verifySignature(readFileSync(join(dist, name)), signature, publicKey);
      if (signed !== version) throw new Error(`signed for version ${signed ?? "(none)"}, expected ${version}`);
    } catch (err) {
      errors.push(`${target}: ${name}: ${err.message}`);
      continue;
    }
    platforms[target] = {
      signature,
      url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
    };
  }
  if (errors.length) throw new Error(`updater manifest not written:\n  ${errors.join("\n  ")}`);
  return {
    version,
    notes: `Selai ${version}`,
    pub_date: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [dist, tag, repository] = process.argv.slice(2);
  if (!dist || !/^v\d+\.\d+\.\d+$/.test(tag ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) {
    console.error("usage: updater-manifest.mjs <dist-dir> <vX.Y.Z> <owner/repo>");
    process.exit(2);
  }
  const conf = new URL("../../apps/desktop/src-tauri/tauri.conf.json", import.meta.url);
  const pubkey = process.env.UPDATER_PUBKEY || JSON.parse(readFileSync(conf, "utf8")).plugins.updater.pubkey;
  try {
    const manifest = buildManifest({ dist, tag, repository, pubkey });
    writeFileSync(join(dist, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`latest.json: ${Object.keys(manifest.platforms).join(", ")}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
