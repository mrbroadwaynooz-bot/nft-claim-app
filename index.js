import express from "express";
import helmet from "helmet";
import Database from "better-sqlite3";
import QRCode from "qrcode";

import {
  createThirdwebClient,
  Engine,
  getContract,
  prepareContractCall
} from "thirdweb";

import { base } from "thirdweb/chains";

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));

// CORS
app.use((req,res,next)=>{
  res.header("Access-Control-Allow-Origin","*");
  res.header("Access-Control-Allow-Headers","Content-Type");
  res.header("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  if(req.method==="OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({limit:"200kb"}));

/* ---------------- ENV ---------------- */

const PORT = Number(process.env.PORT || 10000);

const THIRDWEB_SECRET_KEY = process.env.THIRDWEB_SECRET_KEY || "";
const THIRDWEB_VAULT_ACCESS_TOKEN = process.env.THIRDWEB_VAULT_ACCESS_TOKEN || "";
const SERVER_WALLET_ADDRESS = process.env.SERVER_WALLET_ADDRESS || "";
const NFT_CONTRACT_ADDRESS = process.env.NFT_CONTRACT_ADDRESS || "";

const WIX_CLAIM_URL = process.env.WIX_CLAIM_URL || "";

function envOk(){
  return !!(
    THIRDWEB_SECRET_KEY &&
    THIRDWEB_VAULT_ACCESS_TOKEN &&
    SERVER_WALLET_ADDRESS &&
    NFT_CONTRACT_ADDRESS &&
    WIX_CLAIM_URL
  );
}

function buildClaimUrl(code){
  return `${WIX_CLAIM_URL}${encodeURIComponent(code)}`;
}

function isWallet(address){
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/* ---------------- DATABASE ---------------- */

const db = new Database("data.sqlite");

db.exec(`
CREATE TABLE IF NOT EXISTS qrs(
 id TEXT PRIMARY KEY,
 created_at INTEGER,
 status TEXT,
 reserved_email TEXT,
 reserved_phone TEXT,
 wallet TEXT,
 tx TEXT,
 minted_at INTEGER
);
`);

const insertQR = db.prepare(`
INSERT OR IGNORE INTO qrs(id,created_at,status)
VALUES(?,?,?)
`);

const getQR = db.prepare(`
SELECT * FROM qrs WHERE id=?
`);

const reserveQR = db.prepare(`
UPDATE qrs
SET reserved_email=?, reserved_phone=?, status='reserved'
WHERE id=? AND status='new'
`);

const mintQR = db.prepare(`
UPDATE qrs
SET wallet=?, tx=?, minted_at=?, status='minted'
WHERE id=? AND status='reserved'
`);

function newId(){
 return Math.random().toString(36).slice(2,10)+Math.random().toString(36).slice(2,10);
}

/* ---------------- THIRDWEB ---------------- */

const client = createThirdwebClient({
  secretKey:THIRDWEB_SECRET_KEY
});

const serverWallet = Engine.serverWallet({
  client,
  address:SERVER_WALLET_ADDRESS,
  vaultAccessToken:THIRDWEB_VAULT_ACCESS_TOKEN
});

const contract = getContract({
  client,
  chain:base,
  address:NFT_CONTRACT_ADDRESS
});

function buildMintTx(wallet){
 return prepareContractCall({
  contract,
  method:"function claimTo(address _receiver,uint256 _quantity)",
  params:[wallet,1n]
 });
}

/* ---------------- ROUTES ---------------- */

app.get("/",(req,res)=>{
 res.send("NFT claim backend running");
});

app.get("/env-check",(req,res)=>{
 res.json({
  ok:true,
  envOk:envOk()
 });
});

/* create qr */

app.post("/api/qrs/create",(req,res)=>{

 const count = Math.max(1,Math.min(200,Number(req.body?.count||1)));

 const ids=[];
 const now = Date.now();

 for(let i=0;i<count;i++){
  const id=newId();
  insertQR.run(id,now,"new");
  ids.push(id);
 }

 res.json({
  ok:true,
  claimUrl:buildClaimUrl(ids[0]),
  code:ids[0],
  ids
 });

});

/* reserve */

app.post("/api/reserve-claim",(req,res)=>{

 const code=String(req.body?.code||"");
 const email=String(req.body?.email||"").trim().toLowerCase();
 const phone=String(req.body?.phone||"").trim();

 if(!code) return res.status(400).json({ok:false,error:"missing code"});

 if(!email && !phone)
  return res.status(400).json({ok:false,error:"enter email or phone"});

 const row=getQR.get(code);

 if(!row)
  return res.status(404).json({ok:false,error:"QR not found"});

 if(row.status==="minted")
  return res.status(409).json({ok:false,error:"already minted"});

 if(row.status==="reserved")
  return res.json({ok:true,reserved:true});

 const changed = reserveQR.run(email||null,phone||null,code).changes;

 if(!changed)
  return res.status(409).json({ok:false,error:"could not reserve"});

 res.json({ok:true,reserved:true});

});

/* mint */

app.post("/api/finalize-claim",async(req,res)=>{

 const code=String(req.body?.code||"");
 const wallet=String(req.body?.walletAddress||"").trim();

 if(!envOk())
  return res.status(500).json({ok:false,error:"missing env vars"});

 if(!isWallet(wallet))
  return res.status(400).json({ok:false,error:"invalid wallet"});

 const row=getQR.get(code);

 if(!row)
  return res.status(404).json({ok:false,error:"QR not found"});

 if(row.status!=="reserved")
  return res.status(409).json({ok:false,error:"reserve first"});

 try{

  const tx=buildMintTx(wallet);

  const {transactionId}=await serverWallet.enqueueTransaction({transaction:tx});

  mintQR.run(wallet,transactionId,Date.now(),code);

  res.json({
   ok:true,
   transactionId,
   wallet
  });

 }catch(e){

  res.status(500).json({
   ok:false,
   error:e?.message||String(e)
  });

 }

});

/* QR image */

app.get("/qr/:id.png",async(req,res)=>{

 const id=req.params.id;

 const row=getQR.get(id);

 if(!row) return res.status(404).send("not found");

 const png=await QRCode.toBuffer(buildClaimUrl(id),{
  width:700,
  margin:1
 });

 res.setHeader("Content-Type","image/png");
 res.send(png);

});

/* start server */

app.listen(PORT,()=>{
 console.log("Server running on port",PORT);
});
