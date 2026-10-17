#!/usr/bin/env node
// Uploads ../firestore.rules to the Firebase project of the service account.
// Usage: node deploy-rules.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, cert } from "firebase-admin/app";
import { getSecurityRules } from "firebase-admin/security-rules";

const here = path.dirname(fileURLToPath(import.meta.url));
const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(here, "service-account.json");
const serviceAccount = JSON.parse(fs.readFileSync(credPath, "utf8"));
initializeApp({ credential: cert(serviceAccount) });

const source = fs.readFileSync(path.join(here, "..", "firestore.rules"), "utf8");
const ruleset = await getSecurityRules().releaseFirestoreRulesetFromSource(source);
console.log(`✔ Firestore rules deployed to ${serviceAccount.project_id} (ruleset ${ruleset.name})`);
