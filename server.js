// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve EVERYTHING from the project root (HTML, assets, team, collection, etc.)
app.use(express.static(path.join(__dirname), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.json')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
  }
}));

// health check
app.get('/_health', (_req, res) => res.send('ok'));

// Fallback to index.html for any unknown path (keeps tabs routing simple)
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`No-Punks is running:  http://localhost:${PORT}`);
});