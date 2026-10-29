#!/usr/bin/env node
// Uploads ../firestore.rules to the Firebase project of the service account.
// Usage: node deploy-rules.mjs  (service-account.json, or GOOGLE_CLOUD_PROJECT with a signed-in Google account)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getSecurityRules } from "firebase-admin/security-rules";

const here = path.dirname(fileURLToPath(import.meta.url));
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(here, "service-account.json");
let projectId = process.env.GOOGLE_CLOUD_PROJECT;
if (fs.existsSync(credPath)) {
  const serviceAccount = JSON.parse(fs.readFileSync(credPath, "utf8"));
  projectId = serviceAccount.project_id;
  initializeApp({ credential: cert(serviceAccount) });
} else {
  initializeApp({ credential: applicationDefault(), projectId });
}

let source = fs.readFileSync(path.join(here, "..", "firestore.rules"), "utf8");
// The Oneg Shabat write key is kept out of git; fill it in when this machine has it.
const onegWriter = path.join(here, "..", "projects", "oneg-shabat", "firebase-writer.json");
if (fs.existsSync(onegWriter)) {
  source = source.replaceAll("ONEG_SHABAT_WRITE_KEY", JSON.parse(fs.readFileSync(onegWriter, "utf8")).writeKey);
} else if (source.includes("ONEG_SHABAT_WRITE_KEY")) {
  console.warn("⚠ projects/oneg-shabat/firebase-writer.json missing: the Oneg Shabat public page will stop updating until setup-firebase.mjs runs again.");
}
const ruleset = await getSecurityRules().releaseFirestoreRulesetFromSource(source);
console.log(`✔ Firestore rules deployed to ${projectId} (ruleset ${ruleset.name})`);
