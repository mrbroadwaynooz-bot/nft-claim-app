import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// simple health check
app.get("/", (req, res) => {
  res.send("NFT Claim App is running");
});

// check env vars (for debugging)
app.get("/env-check", (req, res) => {
  res.json({
    RPC_URL: !!process.env.RPC_URL,
    NFT_CONTRACT_ADDRESS: !!process.env.NFT_CONTRACT_ADDRESS,
    PRIVATE_KEY: !!process.env.PRIVATE_KEY
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

