import express from "express";
import helmet from "helmet";
import Database from "better-sqlite3";
import QRCode from "qrcode";

app.get("/", (req, res) => {
  res.json({ ok: true, server: "running" });
});

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
// POST /api/claim { code, email?, phone? }
// POST /api/claim { code, email, phone }
app.post("/api/claim", async (req, res) => {

  const code = String(req.body?.code || "");
  const email = String(req.body?.email || "").trim().toLowerCase();
  const phone = String(req.body?.phone || "").trim();

  if (!envOk())
    return res.status(500).json({ ok: false, error: "Missing env vars" });

  if (!code)
    return res.status(400).json({ ok: false, error: "Missing code" });

  if (!email && !phone)
    return res.status(400).json({ ok: false, error: "Provide email or phone" });

  const identifier = email || phone;

  const row = getQR.get(code);

  if (!row)
    return res.status(404).json({ ok: false, error: "QR not found" });

  if (row.used_at)
    return res.status(409).json({ ok: false, error: "Already claimed" });

  try {

    // create wallet linked to email or phone
    const userWallet = await serverWallet.createWallet({
      identifier
    });

    const walletAddress = userWallet.address;

    const transaction = buildMintTx(walletAddress);

    const { transactionId } =
      await serverWallet.enqueueTransaction({ transaction });

    const changed = markUsed.run(
      Date.now(),
      walletAddress,
      transactionId,
      code
    ).changes;

    if (!changed)
      return res.status(409).json({ ok: false, error: "QR just got used" });

    res.json({
      ok: true,
      transactionId,
      walletAddress
    });

  } catch (e) {

    res.status(500).json({
      ok: false,
      error: e?.message || String(e)
    });

  }

});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
