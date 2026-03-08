import express from "express";
import helmet from "helmet";
import Database from "better-sqlite3";
import QRCode from "qrcode";

import {
  createThirdwebClient,
  Engine,
  getContract,
  prepareContractCall,
} from "thirdweb";
import { base } from "thirdweb/chains";

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "200kb" }));

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 10000);

const THIRDWEB_SECRET_KEY = process.env.THIRDWEB_SECRET_KEY || "";
const THIRDWEB_VAULT_ACCESS_TOKEN = process.env.THIRDWEB_VAULT_ACCESS_TOKEN || "";
const SERVER_WALLET_ADDRESS = process.env.SERVER_WALLET_ADDRESS || "";
const NFT_CONTRACT_ADDRESS = process.env.NFT_CONTRACT_ADDRESS || "";

// MUST end with ?id=   (example: https://www.suavecards9.com/claim?id= )
const WIX_CLAIM_URL = process.env.WIX_CLAIM_URL || "";

function envOk() {
  return !!(
    THIRDWEB_SECRET_KEY &&
    THIRDWEB_VAULT_ACCESS_TOKEN &&
    SERVER_WALLET_ADDRESS &&
    NFT_CONTRACT_ADDRESS &&
    WIX_CLAIM_URL
  );
}

function buildClaimUrl(code) {
  // If you set WIX_CLAIM_URL to ".../claim?id=" then we just append the code
  return `${WIX_CLAIM_URL}${encodeURIComponent(code)}`;
}

// ---------- DB (QR one-time use) ----------
const db = new Database("data.sqlite");
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS qrs (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT,
    transaction_id TEXT
  );
`);

const insertQR = db.prepare("INSERT OR IGNORE INTO qrs (id, created_at) VALUES (?, ?)");
const getQR = db.prepare("SELECT * FROM qrs WHERE id = ?");
const listQR = db.prepare("SELECT * FROM qrs ORDER BY created_at DESC LIMIT ?");
const markUsed = db.prepare(
  "UPDATE qrs SET used_at=?, used_by=?, transaction_id=? WHERE id=? AND used_at IS NULL"
);

function newId() {
  // only alphanumeric so Wix won't complain
  return (
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

// ---------- THIRDWEB ENGINE ----------
const client = createThirdwebClient({ secretKey: THIRDWEB_SECRET_KEY });

const serverWallet = Engine.serverWallet({
  client,
  address: SERVER_WALLET_ADDRESS,
  vaultAccessToken: THIRDWEB_VAULT_ACCESS_TOKEN,
});

const contract = getContract({
  client,
  chain: base,
  address: NFT_CONTRACT_ADDRESS,
});

// NFT Drop mint: claimTo(address,uint256)
function buildMintTx(toAddress) {
  return prepareContractCall({
    contract,
    method: "function claimTo(address _receiver, uint256 _quantity)",
    params: [toAddress, 1n],
  });
}

// ---------- ROUTES ----------
app.get("/", (req, res) => res.send("Engine Claim backend running ✅"));

app.get("/env-check", (req, res) => {
  res.json({
    ok: true,
    envOk: envOk(),
    hasSecretKey: !!THIRDWEB_SECRET_KEY,
    hasVaultToken: !!THIRDWEB_VAULT_ACCESS_TOKEN,
    hasServerWallet: !!SERVER_WALLET_ADDRESS,
    hasContract: !!NFT_CONTRACT_ADDRESS,
    hasWixClaimUrl: !!WIX_CLAIM_URL,
    wixClaimUrlPreview: WIX_CLAIM_URL ? WIX_CLAIM_URL.slice(0, 60) + "..." : "",
  });
});

// Quick sanity: shows what claim URL will look like
app.get("/test-claimurl", (req, res) => {
  res.json({ ok: true, claimUrl: buildClaimUrl("ABC123") });
});

// ADMIN: create QRs (Wix automation calls this)
app.post("/api/qrs/create", (req, res) => {
  const count = Math.max(1, Math.min(200, Number(req.body?.count || 1)));
  const now = Date.now();
  const ids = [];

  for (let i = 0; i < count; i++) {
    const id = newId();
    insertQR.run(id, now);
    ids.push(id);
  }

  const claimUrl = buildClaimUrl(ids[0]);

  res.json({
    ok: true,
    claimUrl,          // <-- Wix email should use this
    code: ids[0],
    created: ids.length,
    ids,
  });
});

// ADMIN: list QRs
app.get("/api/qrs", (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query?.limit || 50)));
  const items = listQR.all(limit).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    used_at: r.used_at,
    used_by: r.used_by,
    transaction_id: r.transaction_id,
  }));
  res.json({ ok: true, items });
});

// QR PNG for printing (optional)
app.get("/qr/:id.png", async (req, res) => {
  const id = String(req.params.id || "");
  const row = getQR.get(id);
  if (!row) return res.status(404).send("Not found");

  const url = buildClaimUrl(id);
  const png = await QRCode.toBuffer(url, { width: 700, margin: 1 });

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store");
  res.send(png);
});

// CLAIM endpoint
// POST /api/claim { code, walletAddress }
const API_URL = "https://nft-claim-app.onrender.com/api/claim";

$w.onReady(function () {
  const code = wixLocation.query.code || wixLocation.query.id || "";

  if (!code) {
    $w("#statusText").text = "Invalid claim link.";
    $w("#claimBtn").disable();
    return;
  }

  $w("#statusText").text = "Enter email or phone to claim your NFT.";
  $w("#claimBtn").enable();

  $w("#claimBtn").onClick(async () => {
    const email = String($w("#emailInput").value || "").trim();
    const phone = String($w("#phoneInput").value || "").trim();

    if (!email && !phone) {
      $w("#statusText").text = "Enter email or phone.";
      return;
    }

    try {
      $w("#claimBtn").disable();
      $w("#statusText").text = "Minting your NFT...";

      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, email, phone })
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok) {
        $w("#statusText").text =
          "Claim failed: " + (data.error || "unknown error");
        $w("#claimBtn").enable();
        return;
      }

      $w("#statusText").text =
        "Success ✅ NFT minted. Tx: " + data.transactionId;

    } catch (e) {
      $w("#statusText").text = "Network error. Try again.";
      $w("#claimBtn").enable();
    }
  });
});
