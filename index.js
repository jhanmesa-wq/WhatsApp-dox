const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const mongoose = require('mongoose');
const { Boom } = require('@hapi/boom');

// ===== CONFIG =====
const OWNER_NUMBERS = ["51972097238@s.whatsapp.net", "51973244296@s.whatsapp.net"];
const isOwner = (jid, selfChat = false) => OWNER_NUMBERS.includes(jid) || selfChat;
const INITIAL_BOT_NUMBER = '51973244296'; // <--- TU MISMO NUMERO PARA LA PRIMERA VINCULACION
const MONGO_URL = process.env.MONGO_URL;
const TOKEN_CODART = process.env.TOKEN_CODART;
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
      if (shouldReconnect) {
        console.log('🔄 Reconectando WhatsApp...');
        setTimeout(() => {
          startBot().catch(err => console.error('Error al reconectar:', err));
        }, 3000);
      }
    } else if (connection === 'open') {
      console.log('✅ Bot conectado a WhatsApp!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m || !m.message) return;

    const from = m.key.remoteJid;
    const connectedId = sock.user?.id || '';
    const connectedNumber = connectedId.split(':')[0].split('@')[0];
    const selfJids = new Set([
      connectedId,
      connectedId.split(':')[0],
      connectedNumber ? `${connectedNumber}@s.whatsapp.net` : ''
    ].filter(Boolean));
    const isSelfChat = selfJids.has(from);

    // El bot procesa mensajes enviados desde la cuenta conectada únicamente
    // cuando se escriben en el chat personal consigo misma.
    if (m.key.fromMe && !isSelfChat) return;
    const text = (m.message.conversation || m.message.extendedTextMessage?.text || '').trim();
    if (!text) return;
    const args = text.split(/ +/);
    const command = args[0].toLowerCase();

    if (command === '.code') {
      if (!isOwner(from, isSelfChat)) return sock.sendMessage(from, { text: '❌ Solo el owner puede generar codes' });
      let number = args[1];
      if (!number) return sock.sendMessage(from, { text: 'Uso: .code 51912345678' });
      number = number.replace(/[^0-9]/g, '');
      try {
        await sock.sendMessage(from, { text: `⏳ Generando código para +${number}...` });
        const code = await sock.requestPairingCode(number);
        const pretty = String(code).match(/.{1,4}/g)?.join('-') || String(code);
        return sock.sendMessage(from, { text: `✅ *CÓDIGO GENERADO*\n\n📱 Número: +${number}\n🔑 Código: ${pretty}\n\nPasos:\n1. WhatsApp > Dispositivos vinculados\n2. Vincular con número de teléfono\n3. Pega: ${code}` });
      } catch (e) {
        return sock.sendMessage(from, { text: '❌ Error generando. El número quizá ya está vinculado o no es válido.' });
      }
    }

    if (command === '/register') {
      let user = await User.findOne({ id: from });
      if (user) return sock.sendMessage(from, { text: `Ya estás registrado. Tienes ${user.creditos} créditos. Usa /me` });
      user = await User.create({ id: from, nombre: m.pushName || 'Usuario', creditos: 2 });
      return sock.sendMessage(from, { text: `✅ *REGISTRADO*\n\n👤 ${user.nombre}\n💳 2 créditos de regalo\nUsa /me para ver tu perfil` });
    }
    if (['/start', 'start'].includes(command)) {
  let user = await User.findOne({ id: from });
  if (!user) {
    user = await User.create({ id: from, nombre: m.pushName || 'Usuario', creditos: 2 });
  }

  const numero = from.split('@')[0];
  const nombre = m.pushName || user.nombre;

  // Intentar sacar foto de perfil
  let ppUrl;
  try { ppUrl = await sock.profilePictureUrl(from, 'image'); } 
  catch { ppUrl = null; }

  const texto = `👋 *BIENVENIDO @${numero}*

👤 *Usuario:* ${nombre}
📱 *Número:* +${numero}
💳 *Créditos:* ${user.creditos}

📋 *LISTA DE COMANDOS*

🔹 /me - Ver tu perfil y créditos
🔹 /cmds - ver la lista de comandos 
🔹 /buy - Comprar créditos
🔹 /help - Ver ayuda

🤖 _Bot activo 24/7_

👇 *ÚNETE A NUESTRO BOT DE TELEGRAM*`;

  const botonTelegram = {
    text: texto,
    footer: "SPECTER DOX - El mejor bot de consultas",
    mentions: [from],
    templateButtons: [
      {
        index: 1,
        urlButton: {
          displayText: '🤖 BOT DE TELEGRAM',
          url: 'https://t.me/specter_dox434bot'
        }
      }
    ]
  };

  return sock.sendMessage(from, botonTelegram);
    }

    if (['/cmds', '/comandos', 'cmds'].includes(command)) {
  const texto = `📋 *LISTA COMPLETA DE COMANDOS - SPECTER DOX*

*🪪 CONSULTAS DNI*
├ /dni - DNI Azul
├ /dnit - DNI Total
├ /dnivel - DNI Virtual
└ /dniv - DNI Virtual 2

*🏠 DIRECCIÓN / NOMBRES*
├ /dir - Dirección por DNI
├ /nm - Nombres por DNI

*💼 TRABAJO / SUELDO*
├ /suel - Sueldo / Trabajo

*🚨 DENUNCIAS*
├ /den - Denuncias
├ /denuncias - Denuncias completas
└ /denpla - Denuncias por Placa

*🚗 VEHICULAR*
├ /pla - Placa a DNI
├ /plat - Datos por Placa
├ /rqh - RQ de vehículo
├ /revtec - Revisión Técnica
└ /hsoat - Historial SOAT

*👨‍👩‍👧‍👦 FAMILIA*
├ /ag - Árbol Genealógico
└ /agv - Árbol Genealógico Virtual

*📱 TELEFONÍA / FACIAL*
├ /telcel - Número a DNI
└ /facial - Búsqueda facial (con foto)

*⚡ OTROS*
├ /reaccion - Reacciones
├ /ip - Info IP
└ /me - Tu perfil y créditos

💳 *Usa /buy para comprar créditos*
🤖 *Bot Telegram:* https://t.me/specter_dox434bot`;

  return sock.sendMessage(from, { 
    text: texto,
    templateButtons: [
      {
        index: 1,
        urlButton: {
          displayText: '🤖 BOT DE TELEGRAM',
          url: 'https://t.me/specter_dox434bot'
        }
      }
    ]
  });
    }
    if (command === '/me') {
      const user = await User.findOne({ id: from });
      if (!user) return sock.sendMessage(from, { text: 'No estás registrado. Usa /register' });
      return sock.sendMessage(from, { text: `👤 *TU PERFIL*\n\n📛 Nombre: ${user.nombre}\n💳 Créditos: ${user.creditos}\n🆔 Número: ${from.split('@')[0]}\n📅 Desde: ${user.fecha.toLocaleDateString()}` });
    }

    if (command === '.crear' || command === '/crear') {
      const user = await User.findOne({ id: from });
      if (!user) return sock.sendMessage(from, { text: 'PRIMERO TIENES Q REGISTRARTE BURRO FRACASADO USA /register' });
      if (user.creditos < 1) return sock.sendMessage(from, { text: '❌ Sin créditos. Recarga con el owner.' });
      user.creditos -= 1;
      await user.save();
      return sock.sendMessage(from, { text: `✅ Creado! -1 crédito\n💳 Te quedan: ${user.creditos}` });
    }

    if (command === '.addcreditos') {
      if (!isOwner(from, isSelfChat)) return;
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
    if (command === '/dni' || command === '.dni') {
      return sock.sendMessage(from, {
        text: '🔒 La consulta de datos personales está desactivada para proteger la privacidad.'
      });
    }

    if (command === '/help' || command === '.menu') {
      return sock.sendMessage(from, { text: `🤖 *BOT CREDITOS 24/7*\n\n/register - Registrarte\n/me - Ver créditos\n.crear - Gasta 1 crédito (ejemplo)\n\nOwner:\n.code 519... - Generar código vinculación\n.addcreditos 519... 10 - Dar créditos` });
    }
  });
}

startBot().catch(err => console.error('❌ Error iniciando el bot:', err));
