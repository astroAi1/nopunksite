// scripts/build_token_map.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CONTRACT = '0x4ed83635e2309a7c067d0f98efca47b920bf79b1';
const CHAIN = 'base';
const KEY = process.env.OPENSEA_API_KEY || '';
const OUT = path.join(__dirname, '..', 'token_map.json');

(async ()=>{
  const headers = KEY ? { 'x-api-key': KEY } : {};
  const map = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT,'utf8')) : {};
  let ok = 0;

  for (let tokenId = 1; tokenId <= 10000; tokenId++){
    if (tokenId % 50 === 0) process.stdout.write(`\rScanned ${tokenId}/10000`);
    try{
      const { data } = await axios.get(
        `https://api.opensea.io/api/v2/chain/${CHAIN}/contract/${CONTRACT}/nfts/${tokenId}`,
        { headers, timeout: 15000 }
      );
      const name = (data && data.nft && data.nft.name) || '';
      const m = name.match(/No-?Punk\s*#\s*(\d+)/i);
      if (m){
        const edition = parseInt(m[1], 10);
        if (!Number.isNaN(edition)) {
          map[edition] = tokenId;
          ok++;
        }
      }
    }catch(e){
      // ignore and continue (rate-limit safe if you run it leisurely)
    }
    await new Promise(r=>setTimeout(r, 120)); // be gentle to API
  }

  fs.writeFileSync(OUT, JSON.stringify(map, null, 2));
  console.log(`\nDone. Mapped ${ok} editions → token_ids. Saved to token_map.json`);
})();