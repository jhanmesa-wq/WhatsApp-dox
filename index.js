const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const mongoose = require('mongoose');
const { Boom } = require('@hapi/boom');

// ===== CONFIG =====
const OWNER_NUMBER = '51972098722@s.whatsapp.net';
const INITIAL_BOT_NUMBER = '51972098722'; // <--- TU MISMO NUMERO PARA LA PRIMERA VINCULACION
const MONGO_URL = process.env.MONGO_URL;
const PORT = process.env.PORT || 10000;

if(!MONGO_URL) console.log('❌ FALTA MONGO_URL EN RENDER > ENVIRONMENT');

// ===== MONGO DB =====
if(MONGO_URL){
  mongoose.connect(MONGO_URL).then(() => console.log('✅ MongoDB conectado')).catch(e => console.log('❌ Error Mongo', e));
}

const userSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  nombre: String,
  creditos: { type: Number, default: 10 },
  fecha: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// ===== SERVIDOR RENDER 24/7 =====
const app = express();
app.get('/', (req, res) => res.send('✅ Bot 24/7 con MongoDB Activo'));
app.listen(PORT, () => console.log(`🌐 Servidor en ${PORT}`));

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    markOnlineOnConnect: true,
  });

  // ===== ESTO ES LO QUE TE FALTABA - GENERA CODIGO LA PRIMERA VEZ =====
  if(!sock.authState.creds.registered){
    console.log('⏳ Esperando para generar codigo inicial...');
    setTimeout(async ()=>{
      try{
        const code = await sock.requestPairingCode(INITIAL_BOT_NUMBER);
        console.log('\n\n========================================');
        console.log(`  TU CODIGO INICIAL ES: ${code}`);
        console.log(`  Numero: ${INITIAL_BOT_NUMBER}`);
        console.log('  WhatsApp > Dispositivos vinculados > Vincular con numero');
        console.log('========================================\n\n');
      }catch(e){
        console.log('Error generando codigo inicial:', e.message);
      }
    }, 8000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot conectado a WhatsApp!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;
    const from = m.key.remoteJid;
    const text = (m.message.conversation || m.message.extendedTextMessage?.text || '').trim();
    if (!text) return;
    const args = text.split(/ +/);
    const command = args[0].toLowerCase();

    if (command === '.code') {
      if (from !== OWNER_NUMBER) return sock.sendMessage(from, { text: '❌ Solo el owner puede generar codes' });
      let number = args[1];
      if (!number) return sock.sendMessage(from, { text: 'Uso: .code 51912345678' });
      number = number.replace(/[^0-9]/g, '');
      try {
        await sock.sendMessage(from, { text: `⏳ Generando código para +${number}...` });
        const code = await sock.requestPairingCode(number);
        const pretty = code.match(/.{1,4}/g).join('-');
        return sock.sendMessage(from, { text: `✅ *CÓDIGO GENERADO*\n\n📱 Número: +${number}\n🔑 Código: ${pretty}\n\nPasos:\n1. WhatsApp > Dispositivos vinculados\n2. Vincular con número de teléfono\n3. Pega: ${code}` });
      } catch (e) {
        return sock.sendMessage(from, { text: '❌ Error generando. El número quizá ya está vinculado o no es válido.' });
      }
    }

    if (command === '/register') {
      let user = await User.findOne({ id: from });
      if (user) return sock.sendMessage(from, { text: `Ya estás registrado. Tienes ${user.creditos} créditos. Usa /me` });
      user = await User.create({ id: from, nombre: m.pushName || 'Usuario', creditos: 10 });
      return sock.sendMessage(from, { text: `✅ *REGISTRADO*\n\n👤 ${user.nombre}\n💳 10 créditos de regalo\nUsa /me para ver tu perfil` });
    }

    if (command === '/me') {
      const user = await User.findOne({ id: from });
      if (!user) return sock.sendMessage(from, { text: 'No estás registrado. Usa /register' });
      return sock.sendMessage(from, { text: `👤 *TU PERFIL*\n\n📛 Nombre: ${user.nombre}\n💳 Créditos: ${user.creditos}\n🆔 Número: ${from.split('@')[0]}\n📅 Desde: ${user.fecha.toLocaleDateString()}` });
    }

    if (command === '.crear' || command === '/crear') {
      const user = await User.findOne({ id: from });
      if (!user) return sock.sendMessage(from, { text: 'Registrate con /register' });
      if (user.creditos < 1) return sock.sendMessage(from, { text: '❌ Sin créditos. Recarga con el owner.' });
      user.creditos -= 1;
      await user.save();
      return sock.sendMessage(from, { text: `✅ Creado! -1 crédito\n💳 Te quedan: ${user.creditos}` });
    }

    if (command === '.addcreditos') {
      if (from !== OWNER_NUMBER) return;
      let target = args[1];
      let cantidad = parseInt(args[2]);
      if (!target || !cantidad) return sock.sendMessage(from, { text: 'Uso: .addcreditos 51912345678 10' });
      if (!target.includes('@')) target = target + '@s.whatsapp.net';
      let user = await User.findOne({ id: target });
      if (!user) return sock.sendMessage(from, { text: 'Usuario no registrado' });
      user.creditos += cantidad;
      await user.save();
      await sock.sendMessage(from, { text: `✅ Agregados ${cantidad} créditos a ${target}\nAhora tiene: ${user.creditos}` });
      await sock.sendMessage(target, { text: `💰 El owner te recargó ${cantidad} créditos. Ahora tienes: ${user.creditos}` });
    }

    if (command === '/help' || command === '.menu') {
      return sock.sendMessage(from, { text: `🤖 *BOT CREDITOS 24/7*\n\n/register - Registrarte\n/me - Ver créditos\n.crear - Gasta 1 crédito (ejemplo)\n\nOwner:\n.code 519... - Generar código vinculación\n.addcreditos 519... 10 - Dar créditos` });
    }
  });
}

startBot();
