#!/usr/bin/env node
/**
 * Amazon Product Advertising API v5 -> data/prices.json
 *
 * Signs GetItems requests with AWS SigV4 and writes live price / availability
 * for every ASIN referenced in index.html.
 *
 * Credentials come from .env (or the real environment). They are never written
 * to disk by this script and never reach the published page: only the price,
 * title, availability and URL land in data/prices.json.
 *
 *   node tools/paapi-fetch.mjs            # fetch + write
 *   node tools/paapi-fetch.mjs --dry-run  # sign + print, write nothing
 *
 * Zero dependencies: Node 18+ (built-in fetch + crypto).
 */
import { createHmac, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");

/* ---- .env (KEY=value, # comments) ------------------------------------ */
const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const ACCESS   = process.env.PAAPI_ACCESS_KEY;
const SECRET   = process.env.PAAPI_SECRET_KEY;
const PARTNER  = process.env.PAAPI_PARTNER_TAG || "amznbargain-20";
const HOST     = process.env.PAAPI_HOST   || "webservices.amazon.com";
const REGION   = process.env.PAAPI_REGION || "us-east-1";
const MARKET   = process.env.PAAPI_MARKETPLACE || "www.amazon.com";

if (!ACCESS || !SECRET) {
  console.error(`
Missing credentials. Create a .env file in the project root:

    PAAPI_ACCESS_KEY=your-access-key
    PAAPI_SECRET_KEY=your-secret-key
    PAAPI_PARTNER_TAG=${PARTNER}

Get keys at https://affiliate-program.amazon.com/assoc_credentials/home
(.env is already in .gitignore — never commit it.)
`);
  process.exit(1);
}

/* ---- pull the ASINs straight out of the page ------------------------- */
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const ASINS = [...new Set([...html.matchAll(/asin:"([A-Z0-9]{10})"/g)].map(m => m[1]))];
if (!ASINS.length) { console.error("No ASINs found in index.html"); process.exit(1); }
console.log(`Found ${ASINS.length} ASINs in index.html`);

/* ---- AWS SigV4 ------------------------------------------------------- */
const SERVICE = "ProductAdvertisingAPI";
const sha256 = s => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key, s) => createHmac("sha256", key).update(s, "utf8").digest();

function sign(payload) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");   // 20260831T120000Z
  const dateStamp = amzDate.slice(0, 8);
  const target = "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems";
  const path = "/paapi5/getitems";

  const headers = {
    "content-encoding": "amz-1.0",
    "content-type": "application/json; charset=utf-8",
    "host": HOST,
    "x-amz-date": amzDate,
    "x-amz-target": target
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort()
    .map(k => `${k}:${headers[k]}\n`).join("");

  const canonicalRequest = [
    "POST", path, "", canonicalHeaders, signedHeaders, sha256(payload)
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)
  ].join("\n");

  const kDate    = hmac("AWS4" + SECRET, dateStamp);
  const kRegion  = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  headers["Authorization"] =
    `AWS4-HMAC-SHA256 Credential=${ACCESS}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, url: `https://${HOST}${path}` };
}

/* ---- GetItems (max 10 ASINs per call) -------------------------------- */
async function getItems(batch) {
  const payload = JSON.stringify({
    ItemIds: batch,
    ItemIdType: "ASIN",
    PartnerTag: PARTNER,
    PartnerType: "Associates",
    Marketplace: MARKET,
    Resources: [
      "ItemInfo.Title",
      "Offers.Listings.Price",
      "Offers.Listings.Availability.Message",
      "Offers.Listings.MerchantInfo",
      "Images.Primary.Small"
    ]
  });
  const { headers, url } = sign(payload);
  if (DRY) { console.log("DRY RUN — would POST", url, "\n", payload); return null; }

  const res = await fetch(url, { method: "POST", headers, body: payload });
  const text = await res.text();
  if (!res.ok) {
    console.error(`  HTTP ${res.status}: ${text.slice(0, 400)}`);
    if (res.status === 429) console.error("  Rate limited — PA-API starts at 1 request/second.");
    if (res.status === 401 || res.status === 403)
      console.error("  Check keys, partner tag, and that your account has made 3 qualifying sales.");
    return null;
  }
  return JSON.parse(text);
}

/* ---- run ------------------------------------------------------------- */
const out = {};
const errors = [];
for (let i = 0; i < ASINS.length; i += 10) {
  const batch = ASINS.slice(i, i + 10);
  console.log(`Fetching ${batch.length} items (${i + 1}-${i + batch.length})…`);
  const json = await getItems(batch);
  if (!json) { errors.push(...batch); continue; }

  for (const item of json.ItemsResult?.Items || []) {
    const listing = item.Offers?.Listings?.[0];
    out[item.ASIN] = {
      title: item.ItemInfo?.Title?.DisplayValue || null,
      price: listing?.Price?.Amount ?? null,
      display: listing?.Price?.DisplayAmount || null,
      availability: listing?.Availability?.Message || null,
      merchant: listing?.MerchantInfo?.Name || null,
      url: item.DetailPageURL || null
    };
    console.log(`  ${item.ASIN}  ${out[item.ASIN].display || "no offer"}  ${(out[item.ASIN].title||"").slice(0,52)}`);
  }
  for (const e of json.Errors || []) {
    console.warn(`  ! ${e.Code}: ${e.Message}`);
    errors.push(e.Code);
  }
  if (i + 10 < ASINS.length) await new Promise(r => setTimeout(r, 1100)); // 1 TPS floor
}

if (DRY) process.exit(0);

const missing = ASINS.filter(a => !out[a]);
const doc = {
  fetchedAt: new Date().toISOString(),
  partnerTag: PARTNER,
  marketplace: MARKET,
  count: Object.keys(out).length,
  missing,
  items: out
};
writeFileSync(join(ROOT, "data", "prices.json"), JSON.stringify(doc, null, 2));
console.log(`\nWrote data/prices.json — ${doc.count}/${ASINS.length} priced` +
            (missing.length ? `, missing: ${missing.join(", ")}` : ""));
if (!doc.count) process.exit(2);
