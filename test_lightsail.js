const WebSocket = require('ws');
require('dotenv').config();

// This reads the INTELLIGENCE_WS_URL from your new-chrome-extension/.env file
const WS_URL = process.env.INTELLIGENCE_WS_URL || 'ws://localhost:8000/ws';

console.log(`🔌 Attempting to connect to: ${WS_URL}`);

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('✅ SUCCESS! Connected to the WebSocket server!');
  
  // The AI server requires an authentication message as the very first thing
  const authMsg = {
    type: 'auth',
    token: 'test-invalid-token', // We are intentionally sending a fake token
    client_type: 'desktop'
  };
  
  console.log("📤 Sending test authentication message...");
  ws.send(JSON.stringify(authMsg));
});

ws.on('message', (data) => {
  console.log('📩 Received from server:', data.toString());
});

ws.on('close', (code, reason) => {
  console.log(`❌ Connection closed by server.`);
  console.log(`   Code: ${code}`);
  console.log(`   Reason: ${reason.toString() || 'No reason provided'}`);
  
  if (code === 1000 || code === 1006) {
    console.log("💡 Note: If the server rejected our 'test-invalid-token', this means the WebSocket is perfectly online and protecting itself!");
  }
});

ws.on('error', (err) => {
  console.error('⚠️ WebSocket Error:', err.message);
});
