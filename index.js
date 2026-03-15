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

app.use(helmet({ contentSecurityPolicy:false }));

app.use((req,res,next)=>{
 res.header("Access-Control-Allow-Origin","*");
 res.header("Access-Control-Allow-Headers","Content-Type");
 res.header("Access-Control-Allow-Methods","GET,POST,OPTIONS");
 if(req.method==="OPTIONS") return res.sendStatus(200);
 next();
});

app.use(express.json());

const PORT = process.env.PORT || 10000;

const THIRDWEB_SECRET_KEY = process.env.THIRDWEB_SECRET_KEY;
const THIRDWEB_VAULT_ACCESS_TOKEN = process.env.THIRDWEB_VAULT_ACCESS_TOKEN;
const SERVER_WALLET_ADDRESS = process.env.SERVER_WALLET_ADDRESS;
const NFT_CONTRACT_ADDRESS = process.env.NFT_CONTRACT_ADDRESS;
const WIX_CLAIM_URL = process.env.WIX_CLAIM_URL;

/* THIRDWEB */

const client = createThirdwebClient({
 secretKey: THIRDWEB_SECRET_KEY
});

const serverWallet = Engine.serverWallet({
 client,
 address: SERVER_WALLET_ADDRESS,
 vaultAccessToken: THIRDWEB_VAULT_ACCESS_TOKEN
});

const contract = getContract({
 client,
 chain: base,
 address: NFT_CONTRACT_ADDRESS
});

/* CORRECT MINT FUNCTION */

function buildMintTx(wallet){
 return prepareContractCall({
  contract,
  method: "function claim(address _receiver, uint256 _quantity)",
  params: [wallet, 1n]
 });
}

/* DATABASE */

const db = new Database("data.sqlite");

db.exec(`
CREATE TABLE IF NOT EXISTS claims(
 id TEXT PRIMARY KEY,
 email TEXT,
 wallet TEXT,
 tx TEXT,
 created INTEGER
)
`);

function newId(){
 return Math.random().toString(36).slice(2,10) +
        Math.random().toString(36).slice(2,10);
}

/* ROOT */

app.get("/",(req,res)=>{
 res.send("NFT Claim backend running");
});

/* CREATE QR */

app.post("/api/qrs/create",(req,res)=>{

 const id = newId();

 db.prepare(`
 INSERT INTO claims(id,created)
 VALUES(?,?)
 `).run(id,Date.now());

 const claimUrl = `${WIX_CLAIM_URL}${id}`;

 res.json({
  ok:true,
  code:id,
  claimUrl
 });

});

/* CLAIM NFT */

app.post("/api/claim", async (req,res)=>{

 const code = req.body.code;
 const email = req.body.email;
 const walletAddress = req.body.walletAddress;

 if(!code || !email || !walletAddress){
  return res.status(400).json({
   ok:false,
   error:"missing data"
  });
 }

 if(!walletAddress.startsWith("0x") || walletAddress.length !== 42){
  return res.status(400).json({
   ok:false,
   error:"invalid wallet address"
  });
 }

 const row = db.prepare(`
 SELECT * FROM claims WHERE id=?
 `).get(code);

 if(!row){
  return res.status(404).json({
   ok:false,
   error:"invalid code"
  });
 }

 if(row.tx){
  return res.status(409).json({
   ok:false,
   error:"already claimed"
  });
 }

 try{

  const transaction = buildMintTx(walletAddress);

  const { transactionId } =
   await serverWallet.enqueueTransaction({
    transaction
   });

  db.prepare(`
  UPDATE claims
  SET email=?,wallet=?,tx=?
  WHERE id=?
  `).run(email,walletAddress,transactionId,code);

  res.json({
   ok:true,
   wallet:walletAddress,
   transactionId
  });

 }catch(e){

  res.status(500).json({
   ok:false,
   error:e.message
  });

 }

});

/* USER NFT LOGIN */

app.post("/api/user-nfts",(req,res)=>{

 const email = req.body.email;

 if(!email){
  return res.status(400).json({
   ok:false
  });
 }

 const rows = db.prepare(`
 SELECT wallet FROM claims
 WHERE email=?
 `).all(email);

 res.json({
  ok:true,
  wallets:rows
 });

});

/* QR IMAGE */

app.get("/qr/:id.png", async (req,res)=>{

 const url = `${WIX_CLAIM_URL}${req.params.id}`;

 const png = await QRCode.toBuffer(url,{width:700});

 res.setHeader("Content-Type","image/png");
 res.send(png);

});

app.listen(PORT,()=>{
 console.log("Server running on port",PORT);
});
