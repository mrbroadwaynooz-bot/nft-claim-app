import express from "express";
import helmet from "helmet";
import Database from "better-sqlite3";
import QRCode from "qrcode";
import { ethers } from "ethers";

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "200kb" }));

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 3000);
const RPC_URL = process.env.RPC_URL || "";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const NFT_CONTRACT_ADDRESS = process.env.NFT_CONTRACT_ADDRESS || "";

// Pick ONE mint method for your contract:
// "claimTo" (common), "safeMint", or "mint"
const MINT_METHOD = process.env.MINT_METHOD || "claimTo";

// ---------- DB (QR one-time use) ----------
const db = new Database("data.sqlite");
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS qrs (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT,
    tx_hash TEXT
  );
`);

const insertQR = db.prepare("INSERT OR IGNORE INTO qrs (id, created_at) VALUES (?, ?)");
const getQR = db.prepare("SELECT * FROM qrs WHERE id = ?");
const listQR = db.prepare("SELECT * FROM qrs ORDER BY created_at DESC LIMIT ?");
const markUsed = db.prepare(
  "UPDATE qrs SET used_at=?, used_by=?, tx_hash=? WHERE id=? AND used_at IS NULL"
);

// ---------- CHAIN ----------
const ABI = [
  "function claimTo(address _receiver, uint256 _quantity) external payable",
  "function safeMint(address to) external",
  "function mint(address to) external",
];

let provider = null;
let signer = null;
let contract = null;

function chainReady() {
  return !!(RPC_URL && PRIVATE_KEY && NFT_CONTRACT_ADDRESS);
}

function initChain() {
  if (!chainReady()) return;
  provider = new ethers.JsonRpcProvider(RPC_URL);
  signer = new ethers.Wallet(PRIVATE_KEY, provider);
  contract = new ethers.Contract(NFT_CONTRACT_ADDRESS, ABI, signer);
}
initChain();

// ---------- HELPERS ----------
function newId() {
  return ethers.hexlify(ethers.randomBytes(10)).slice(2);
}

function siteBase(req) {
  return `${req.protocol}://${req.get("host")}`;
}

async function mintTo(walletAddress) {
  if (!chainReady()) throw new Error("Missing RPC_URL / PRIVATE_KEY / NFT_CONTRACT_ADDRESS");
  if (!ethers.isAddress(walletAddress)) throw new Error("Invalid wallet address");
  if (!contract) initChain();

  // IMPORTANT: you should use ONE method that matches your contract.
  let tx;
  if (MINT_METHOD === "claimTo") {
    tx = await contract.claimTo(walletAddress, 1n);
  } else if (MINT_METHOD === "safeMint") {
    tx = await contract.safeMint(walletAddress);
  } else if (MINT_METHOD === "mint") {
    tx = await contract.mint(walletAddress);
  } else {
    throw new Error(`Unknown MINT_METHOD: ${MINT_METHOD}`);
  }

  const receipt = await tx.wait();
  return receipt?.hash || tx.hash;
}

// ---------- ROUTES ----------
app.get("/", (req, res) => {
  res.send("Claim backend running ✅");
});

// Check if your env vars are set (does NOT reveal values)
app.get("/env-check", (req, res) => {
  res.json({
    ok: true,
    hasRPC_URL: !!RPC_URL,
    hasPRIVATE_KEY: !!PRIVATE_KEY,
    hasNFT_CONTRACT_ADDRESS: !!NFT_CONTRACT_ADDRESS,
    mintMethod: MINT_METHOD,
  });
});

// ADMIN: create QRs
// POST /api/qrs/create  body: { count: 25 }
app.post("/api/qrs/create", (req, res) => {
  const count = Math.max(1, Math.min(200, Number(req.body?.count || 12)));
  const now = Date.now();
  const ids = [];

  for (let i = 0; i < count; i++) {
    const id = newId();
    insertQR.run(id, now);
    ids.push(id);
  }

  res.json({ ok: true, created: ids.length, ids });
});

// ADMIN: list QRs
// GET /api/qrs?limit=50
app.get("/api/qrs", (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query?.limit || 50)));
  const items = listQR.all(limit).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    used_at: r.used_at,
    used_by: r.used_by,
    tx_hash: r.tx_hash,
  }));
  res.json({ ok: true, items });
});

// QR image for printing
app.get("/qr/:id.png", async (req, res) => {
  const id = String(req.params.id || "");
  const row = getQR.get(id);
  if (!row) return res.status(404).send("Not found");

  // QR points to your WIX claim page (recommended)
  // Replace this with your real Wix claim URL when ready:
  const WIX_CLAIM_URL = process.env.WIX_CLAIM_URL || `${siteBase(req)}/claim?code=`;
  const url = `${WIX_CLAIM_URL}${encodeURIComponent(id)}`;

  const png = await QRCode.toBuffer(url, { width: 700, margin: 1 });
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "no-store");
  res.send(png);
});

// CLAIM endpoint (your Wix-embedded UI will call this)
// POST /api/claim  body: { code: "abc123", walletAddress: "0x..." }
app.post("/api/claim", async (req, res) => {
  const code = String(req.body?.code || "");
  const walletAddress = String(req.body?.walletAddress || "");

  if (!code) return res.status(400).json({ ok: false, error: "Missing code" });
  if (!ethers.isAddress(walletAddress))
    return res.status(400).json({ ok: false, error: "Invalid walletAddress" });

  const row = getQR.get(code);
  if (!row) return res.status(404).json({ ok: false, error: "QR not found" });
  if (row.used_at) return res.status(409).json({ ok: false, error: "Already claimed" });

  try {
    // Mint (this will fail if server wallet has no gas — that's OK until you fund it)
    const txHash = await mintTo(walletAddress);

    // Mark used (prevents reuse)
    const changed = markUsed.run(Date.now(), walletAddress, txHash, code).changes;
    if (!changed) return res.status(409).json({ ok: false, error: "QR just got used" });

    res.json({ ok: true, txHash });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});
