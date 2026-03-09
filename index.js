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

// simple CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "200kb" }));

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 10000);

const THIRDWEB_SECRET_KEY = process.env.THIRDWEB_SECRET_KEY || "";
const THIRDWEB_VAULT_ACCESS_TOKEN = process.env.THIRDWEB_VAULT_ACCESS_TOKEN || "";
const SERVER_WALLET_ADDRESS = process.env.SERVER_WALLET_ADDRESS || "";
const NFT_CONTRACT_ADDRESS = process.env.NFT_CONTRACT_ADDRESS || "";
const WIX_CLAIM_URL = process.env.WIX_CLAIM_URL || ""; // should end with ?code=

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
  return `${WIX_CLAIM_URL}${encodeURIComponent(code)}`;
}

function isValidWallet(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// ---------- DB ----------
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

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn("qrs", "reserved_email", "TEXT");
ensureColumn("qrs", "reserved_phone", "TEXT");
ensureColumn("qrs", "claimed_wallet", "TEXT");
ensureColumn("qrs", "minted_at", "INTEGER");
ensureColumn("qrs", "status", "TEXT DEFAULT 'new'");

const insertQR = db.prepare(
  "INSERT OR IGNORE INTO qrs (id, created_at, status) VALUES (?, ?, 'new')"
);
const getQR = db.prepare("SELECT * FROM qrs WHERE id = ?");
const listQR = db.prepare("SELECT * FROM qrs ORDER BY created_at DESC LIMIT ?");

const reserveQR = db.prepare(`
  UPDATE qrs
  SET reserved_email = ?, reserved_phone = ?, status = 'reserved'
  WHERE id = ? AND (status = 'new' OR status IS NULL)
`);

const mintQR = db.prepare(`
  UPDATE qrs
  SET used_at = ?, used_by = ?, transaction_id = ?, claimed_wallet = ?, minted_at = ?, status = 'minted'
  WHERE id = ? AND status = 'reserved' AND minted_at IS NULL
`);

function newId() {
  return (
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

// ---------- THIRDWEB ----------
const client = createThirdwebClient({
  secretKey: THIRDWEB_SECRET_KEY,
});

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

function buildMintTx(toAddress) {
  return prepareContractCall({
    contract,
    method: "function claimTo(address _receiver, uint256 _quantity)",
    params: [toAddress, 1n],
  });
}

// ---------- ROUTES ----------
app.get("/", (req, res) => {
  res.send("Engine Claim backend running ✅");
});

app.get("/env-check", (req, res) => {
  res.json({
    ok: true,
    envOk: envOk(),
    hasSecretKey: !!THIRDWEB_SECRET_KEY,
    hasVaultToken: !!THIRDWEB_VAULT_ACCESS_TOKEN,
    hasServerWallet: !!SERVER_WALLET_ADDRESS,
    hasContract: !!NFT_CONTRACT_ADDRESS,
    hasWixClaimUrl: !!WIX_CLAIM_URL,
  });
});

app.get("/test-claimurl", (req, res) => {
  res.json({
    ok: true,
    claimUrl: buildClaimUrl("ABC123"),
  });
});

// create QR
app.post("/api/qrs/create", (req, res) => {
  const count = Math.max(1, Math.min(200, Number(req.body?.count || 1)));
  const now = Date.now();
  const ids = [];

  for (let i = 0; i < count; i++) {
    const id = newId();
    insertQR.run(id, now);
    ids.push(id);
  }

  res.json({
    ok: true,
    claimUrl: buildClaimUrl(ids[0]),
    code: ids[0],
    created: ids.length,
    ids,
  });
});

// list QRs
app.get("/api/qrs", (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query?.limit || 50)));
  const items = listQR.all(limit).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    status: r.status,
    reserved_email: r.reserved_email,
    reserved_phone: r.reserved_phone,
    claimed_wallet: r.claimed_wallet,
    minted_at: r.minted_at,
    transaction_id: r.transaction_id,
  }));
  res.json({ ok: true, items });
});

// QR PNG
app.get("/qr/:id.png", async (req, res) => {
  const id = String(req.params.id || "");
  const row = getQR.get(id);
  if (!row) return res.status(404).send("Not found");

  const png = await QRCode.toBuffer(buildClaimUrl(id), {
    width: 700,
    margin: 1,
  });

  res.setHeader("Content-Type", "image/png");
  res.send(png);
});

// reserve NFT
app.post("/api/reserve-claim", (req, res) => {
  const code = String(req.body?.code || "");
  const email = String(req.body?.email || "").trim().toLowerCase();
  const phone = String(req.body?.phone || "").trim();

  if (!code) {
    return res.status(400).json({ ok: false, error: "Missing code" });
  }

  if (!email && !phone) {
    return res.status(400).json({ ok: false, error: "Provide email or phone" });
  }

  const row = getQR.get(code);

  if (!row) {
    return res.status(404).json({ ok: false, error: "QR not found" });
  }

  if (row.status === "minted") {
    return res.status(409).json({ ok: false, error: "Already minted" });
  }

  if (row.status === "reserved") {
    const sameReservation =
      (row.reserved_email && row.reserved_email === email) ||
      (row.reserved_phone && row.reserved_phone === phone);

    if (!sameReservation) {
      return res.status(409).json({ ok: false, error: "Already reserved" });
    }

    return res.json({
      ok: true,
      reserved: true,
      message: "Already reserved. Continue to wallet step.",
    });
  }

  const changed = reserveQR.run(email || null, phone || null, code).changes;

  if (!changed) {
    return res.status(409).json({ ok: false, error: "Could not reserve" });
  }

  res.json({
    ok: true,
    reserved: true,
    message: "NFT reserved. Continue to wallet step.",
  });
});

// finalize and mint
app.post("/api/finalize-claim", async (req, res) => {
  const code = String(req.body?.code || "");
  const walletAddress = String(req.body?.walletAddress || "").trim();

  if (!envOk()) {
    return res.status(500).json({ ok: false, error: "Missing env vars" });
  }

  if (!code) {
    return res.status(400).json({ ok: false, error: "Missing code" });
  }

  if (!isValidWallet(walletAddress)) {
    return res.status(400).json({ ok: false, error: "Invalid wallet address" });
  }

  const row = getQR.get(code);

  if (!row) {
    return res.status(404).json({ ok: false, error: "QR not found" });
  }

  if (row.status !== "reserved") {
    return res.status(409).json({ ok: false, error: "Reserve with email or phone first" });
  }

  if (row.minted_at) {
    return res.status(409).json({ ok: false, error: "Already minted" });
  }

  try {
    const transaction = buildMintTx(walletAddress);
    const { transactionId } = await serverWallet.enqueueTransaction({ transaction });

    const usedBy = row.reserved_email || row.reserved_phone || "";
    const now = Date.now();

    const changed = mintQR.run(
      now,
      usedBy,
      transactionId,
      walletAddress,
      now,
      code
    ).changes;

    if (!changed) {
      return res.status(409).json({ ok: false, error: "Could not finalize claim" });
    }

    res.json({
      ok: true,
      transactionId,
      walletAddress,
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
});

// ---------- START ----------
app.listen(PORT, () => console.log("Server running on port", PORT));
