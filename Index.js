const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const fs = require('fs-extra');
const pino = require('pino');
const { Boom } = require('@hapi/boom');

// ===== CONFIG =====
const OWNER_NUMBER = '51999999999@s.whatsapp.net'; // <-- CAMBIA POR TU NUMERO CON @s.whatsapp.net
const PREFIX = '.';
const PORT = process.env.PORT || 3000;
const DB_FILE = './database.json';

// ===== SERVIDOR PARA RENDER (PARA QUE NO SE MUERA) =====
const app = express();
app.get('/', (req, res) => res.send('✅ Bot 24/7 Activo - Baileys'));
app.listen(PORT, () => console.log(`🌐 Servidor web en puerto ${PORT}`));

// ===== BASE DE DATOS SIMPLE =====
if (!fs.existsSync(DB_FILE)) fs.writeJsonSync(DB_FILE, { users: {} });
const getDB = () => fs.readJsonSync(DB_FILE);
const saveDB = (data) => fs.writeJsonSync(DB_FILE, data);

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"], // IMPORTANTE PARA .code
    markOnlineOnConnect: true,
  });

  sock.ev.on('creds.update', saveCreds);

  // RECONEXION AUTOMATICA
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
      if (shouldReconnect) {
        console.log('Reconectando...');
        startBot();
      }
    } else if (connection === 'open') {
      console.log('✅ Bot conectado!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const m = messages[0];
      if (!m.message || m.key.fromMe) return;
      const from = m.key.remoteJid;
      const isGroup = from.endsWith('@g.us');
      const text = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || '';
      if (!text) return;

      const args = text.trim().split(/ +/);
      const command = args[0].toLowerCase();
      const db = getDB();

      // ===== COMANDO .code =====
      if (command === `${PREFIX}code` || command === `.code`) {
        // Solo owner
        if (from !== OWNER_NUMBER) {
          return sock.sendMessage(from, { text: '❌ Solo mi creador puede usar este comando.' });
        }
        let number = args[1];
        if (!number) {
          return sock.sendMessage(from, { text: `Uso correcto:\n${PREFIX}code 51912345678\n\nEjemplo:\n.code 51987654321` });
        }
        number = number.replace(/[^0-9]/g, '');
        try {
          await sock.sendMessage(from, { text: `⏳ Generando código para +${number}... Espera 5 seg` });
          const code = await sock.requestPairingCode(number);
          const prettyCode = code?.match(/.{1,4}/g)?.join('-') || code;
          
          await sock.sendMessage(from, {
            text: `✅ *CÓDIGO GENERADO CON ÉXITO*\n\n📱 *Número:* +${number}\n🔑 *Código:* ${prettyCode}\n\n📖 *Como vincular:*\n1. Abre WhatsApp en el cel +${number}\n2. Ajustes > Dispositivos vinculados\n3. Vincular dispositivo > Vincular con número\n4. Pega este código: ${code}`,
          });
        } catch (e) {
          console.error(e);
          await sock.sendMessage(from, { text: `❌ Error al generar código.\nPosibles causas:\n- El número ya está vinculado\n- El número no existe en WhatsApp\n- Intenta de nuevo en 30 seg` });
        }
        return;
      }

      // ===== /register =====
      if (command === '/register' || command === `${PREFIX}register`) {
        if (db.users[from]) {
          return sock.sendMessage(from, { text: `Ya estás registrado.\nCréditos: ${db.users[from].creditos}\nUsa /me` });
        }
        db.users[from] = {
          nombre: m.pushName || 'Usuario',
          creditos: 10, // REGALO INICIAL
          id: from,
          fecha: new Date().toISOString()
        };
        saveDB(db);
        return sock.sendMessage(from, {
          text: `✅ *REGISTRO EXITOSO*\n\n👤 Nombre: ${m.pushName}\n💰 Créditos: 10 (regalo)\n\nUsa /me para ver tu perfil\nUsa /help para comandos`,
        });
      }

      // ===== /me =====
      if (command === '/me' || command === `${PREFIX}me`) {
        const user = db.users[from];
        if (!user) return sock.sendMessage(from, { text: `❌ No estás registrado.\nUsa /register para registrarte` });
        return sock.sendMessage(from, {
          text: `👤 *TU INFORMACIÓN*\n\n🆔 ID: ${from.split('@')[0]}\n📛 Nombre: ${user.nombre}\n💳 Créditos: ${user.creditos}\n📅 Registro: ${user.fecha.split('T')[0]}\n\nPara recargar contacta al owner.`,
        });
      }

      // ===== EJEMPLO COMANDO QUE DESCUENTA CREDITOS =====
      if (command === `${PREFIX}crear` || command === '/crear') {
        const user = db.users[from];
        if (!user) return sock.sendMessage(from, { text: 'Primero registrate con /register' });
        if (user.creditos < 1) return sock.sendMessage(from, { text: '❌ No tienes créditos. Recarga con el owner.' });
        
        user.creditos -= 1;
        saveDB(db);
        return sock.sendMessage(from, { text: `✅ Comando ejecutado!\nSe te descontó 1 crédito.\n💳 Te quedan: ${user.creditos}` });
      }

      // ===== /help =====
      if (command === '/help' || command === `${PREFIX}help` || command === `${PREFIX}menu`) {
        return sock.sendMessage(from, {
          text: `🤖 *MENU BOT 24/7*\n\n👤 *Usuario:*\n/register - Registrarte y ganar 10 crd\n/me - Ver tu perfil y créditos\n/crear - Ejemplo que descuenta 1 crd\n\n👑 *Owner:*\n.code 519xxxx - Generar código de vinculación\n\n💳 Sistema de créditos activo.`,
        });
      }

    } catch (err) {
      console.error(err);
    }
  });
}

startBot();
