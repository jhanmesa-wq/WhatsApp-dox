const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const mongoose = require('mongoose');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');

// ===== CONFIG =====
const OWNER_NUMBERS = ["51972098722@s.whatsapp.net", "51973244296@s.whatsapp.net"];
const isOwner = (jid, selfChat = false) => OWNER_NUMBERS.includes(jid) || selfChat;
const INITIAL_BOT_NUMBER = '51973244296';
const MONGO_URL = process.env.MONGO_URL;
const TOKEN_CODART = process.env.TOKEN_CODART;
const PORT = process.env.PORT || 10000;
const AUTH_ROOT = process.env.AUTH_ROOT || './auth_sessions';
const MAX_USER_SESSIONS = Number(process.env.MAX_USER_SESSIONS || 20);

const sessions = new Map();
const pairingRequests = new Map();

if (!MONGO_URL) console.log('❌ FALTA MONGO_URL EN RENDER > ENVIRONMENT');

// ===== MONGO DB =====
if (MONGO_URL) {
  mongoose.connect(MONGO_URL)
    .then(() => console.log('✅ MongoDB conectado'))
    .catch(e => console.log('❌ Error Mongo', e));
}

const userSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  nombre: String,
  creditos: { type: Number, default: 10 },
  fecha: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// ===== SERVIDOR RENDER =====
const app = express();

app.get('/', (req, res) => {
  res.send('✅ Bot 24/7 con MongoDB Activo');
});

app.listen(PORT, () => console.log(`🌐 Servidor en ${PORT}`));

// ===== INICIAR SESIÓN INDEPENDIENTE =====
async function startSession(
  sessionKey = 'main',
  pairingNumber = INITIAL_BOT_NUMBER,
  notifySock = null,
  notifyJid = null
) {
  const authDir = sessionKey === 'main'
    ? './auth'
    : path.join(AUTH_ROOT, sessionKey);

  fs.mkdirSync(authDir, { recursive: true });

  if (sessions.has(sessionKey)) {
    return sessions.get(sessionKey).sock;
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        state.keys,
        pino({ level: 'silent' })
      )
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    markOnlineOnConnect: true
  });

  sessions.set(sessionKey, {
    sock,
    authDir,
    pairingNumber
  });

  // ===== GENERAR CÓDIGO =====
  if (!sock.authState.creds.registered && pairingNumber) {
    console.log(
      `⏳ Preparando emparejamiento para ${pairingNumber} (${sessionKey})...`
    );

    setTimeout(async () => {
      try {
        if (sock.authState.creds.registered) return;

        const code = await sock.requestPairingCode(pairingNumber);

        const pretty =
          String(code).match(/.{1,4}/g)?.join('-') ||
          String(code);

        console.log(
          `🔐 Código generado para ${pairingNumber}: ${pretty}`
        );

        if (notifySock && notifyJid) {
          await notifySock.sendMessage(notifyJid, {
            text: `🔐 *CÓDIGO PARA TU WHATSAPP*

📱 Número: +${pairingNumber}
🔑 Código: *${pretty}*

1. Abre WhatsApp en ese número.
2. Dispositivos vinculados.
3. Vincular con número de teléfono.
4. Introduce el código.

Tu sesión se guardará separada de las demás.`
          });
        }

      } catch (e) {
        console.error(
          `Error generando código para ${pairingNumber}:`,
          e.message
        );

        if (notifySock && notifyJid) {
          await notifySock.sendMessage(notifyJid, {
            text: `❌ No se pudo generar el código para +${pairingNumber}: ${e.message}`
          }).catch(() => {});
        }
      }
    }, 8000);
  }

  sock.ev.on('creds.update', saveCreds);

  // ===== ESTADO DE CONEXIÓN =====
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const shouldReconnect =
        (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
          : true;

      sessions.delete(sessionKey);

      if (shouldReconnect) {
        console.log(`🔄 Reconectando WhatsApp (${sessionKey})...`);

        setTimeout(() => {
          startSession(sessionKey, null).catch(err =>
            console.error(`Error reconectando ${sessionKey}:`, err)
          );
        }, 3000);

      } else {
        console.log(
          `⚠️ Sesión ${sessionKey} cerrada por logout. Se conserva la carpeta; no se borra automáticamente.`
        );
      }

    } else if (connection === 'open') {
      console.log(`✅ WhatsApp conectado (${sessionKey})`);
    }
  });

  // ===== MENSAJES =====
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m || !m.message) return;

    const from = m.key.remoteJid;
    const connectedId = sock.user?.id || '';
    const connectedNumber = connectedId.split(':')[0].split('@')[0];

    const selfJids = new Set([
      connectedId,
      connectedId.split(':')[0],
      connectedNumber
        ? `${connectedNumber}@s.whatsapp.net`
        : ''
    ].filter(Boolean));

    const isSelfChat = selfJids.has(from);

    if (m.key.fromMe && !isSelfChat) return;

    const text = (
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      m.message.listResponseMessage?.singleSelectReply?.selectedRowId ||
      m.message.buttonsResponseMessage?.selectedButtonId ||
      m.message.templateButtonReplyMessage?.selectedId ||
      ''
    ).trim();

    if (!text) return;

    const args = text.split(/ +/);
    const command = args[0].toLowerCase();

    // ===== /CODE MULTIUSUARIO =====
    if (command === '/code' || command === '.code') {
      const number = (args[1] || '').replace(/\D/g, '');

      if (!number || number.length < 10 || number.length > 15) {
        return sock.sendMessage(from, {
          text: 'Uso: /code 51912345678\nEscribe tu número con código de país, solo números.'
        });
      }

      const requester = from.split('@')[0].split(':')[0];

      if (!/^\d{10,15}$/.test(requester) || requester !== number) {
        return sock.sendMessage(from, {
          text: '🔒 Por seguridad, solo puedes conectar el número desde el que estás escribiendo. Envía /code seguido de TU propio número con código de país.'
        });
      }

      const mainNumber = (sock.user?.id || '')
        .split(':')[0].split('@')[0];

      if (number === mainNumber) {
        return sock.sendMessage(from, {
          text: 'ℹ️ Ese número ya es la cuenta principal del bot.'
        });
      }

      const lastRequest = pairingRequests.get(requester) || 0;

      if (Date.now() - lastRequest < 60000) {
        return sock.sendMessage(from, {
          text: '⏳ Espera 60 segundos antes de solicitar otro código.'
        });
      }

      if (sessions.has(number)) {
        return sock.sendMessage(from, {
          text: 'ℹ️ Ese número ya tiene una sesión iniciada o en proceso.'
        });
      }

      if (sessions.size - 1 >= MAX_USER_SESSIONS) {
        return sock.sendMessage(from, {
          text: `❌ Se alcanzó el límite de ${MAX_USER_SESSIONS} sesiones.`
        });
      }

      pairingRequests.set(requester, Date.now());

      await sock.sendMessage(from, {
        text: `⏳ Preparando una sesión independiente para +${number}. Te enviaré el código aquí en unos segundos.`
      });

      try {
        await startSession(number, number, sock, from);

      } catch (e) {
        sessions.delete(number);
        console.error('Error creando sesión multiusuario:', e);

        return sock.sendMessage(from, {
          text: '❌ No se pudo iniciar la sesión. Revisa los logs de Render.'
        });
      }

      return;
    }

    // ===== REGISTRO =====
    if (command === '/register') {
      let user = await User.findOne({ id: from });

      if (user) {
        return sock.sendMessage(from, {
          text: `Ya estás registrado. Tienes ${user.creditos} créditos. Usa /me`
        });
      }

      user = await User.create({
        id: from,
        nombre: m.pushName || 'Usuario',
        creditos: 2
      });

      return sock.sendMessage(from, {
        text: `✅ *REGISTRADO*

👤 ${user.nombre}
💳 2 créditos de regalo
Usa /me para ver tu perfil`
      });
    }
    // ===== START =====
    if (['/start', 'start'].includes(command)) {
      let user = await User.findOne({ id: from });

      if (!user) {
        user = await User.create({
          id: from,
          nombre: m.pushName || 'Usuario',
          creditos: 2
        });
      }

      const numero = from.split('@')[0];
      const nombre = m.pushName || user.nombre;

      let ppUrl;

      try {
        ppUrl = await sock.profilePictureUrl(from, 'image');
      } catch {
        ppUrl = null;
      }

      const texto = `👋 *BIENVENIDO @${numero}*

👤 *Usuario:* ${nombre}
📱 *Número:* +${numero}
💳 *Créditos:* ${user.creditos}

📋 *LISTA DE COMANDOS*

🔹 /me - Ver tu perfil y créditos
🔹 /cmds - Ver la lista de comandos
🔹 /code 519XXXXXXXX - Conectar tu WhatsApp
🔹 /register - Registrarte
🔹 /buy - Comprar créditos
🔹 /help - Ver ayuda

🤖 _Bot activo 24/7_

👇 *ÚNETE A NUESTRO BOT DE TELEGRAM*`;

      return sock.sendMessage(from, {
        text: texto,
        footer: "SPECTER DOX - El mejor bot de consultas",
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

    // ===== COMANDOS =====
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
└ /facial - Búsqueda facial

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

    // ===== PERFIL =====
    if (command === '/me') {
      const user = await User.findOne({ id: from });

      if (!user) {
        return sock.sendMessage(from, {
          text: 'No estás registrado. Usa /register'
        });
      }

      return sock.sendMessage(from, {
        text: `👤 *TU PERFIL*

📛 Nombre: ${user.nombre}
💳 Créditos: ${user.creditos}
🆔 Número: ${from.split('@')[0]}
📅 Desde: ${user.fecha.toLocaleDateString()}`
      });
    }

    // ===== CREAR =====
    if (command === '.crear' || command === '/crear') {
      const user = await User.findOne({ id: from });

      if (!user) {
        return sock.sendMessage(from, {
          text: 'PRIMERO REGÍSTRATE. USA /register'
        });
      }

      if (user.creditos < 1) {
        return sock.sendMessage(from, {
          text: '❌ Sin créditos. Recarga con el owner.'
        });
      }

      user.creditos -= 1;
      await user.save();

      return sock.sendMessage(from, {
        text: `✅ Creado! -1 crédito\n💳 Te quedan: ${user.creditos}`
      });
    }

    // ===== AGREGAR CRÉDITOS =====
    if (command === '.addcreditos') {
      if (!isOwner(from, isSelfChat)) return;

      let target = args[1];
      const cantidad = parseInt(args[2]);

      if (!target || !cantidad) {
        return sock.sendMessage(from, {
          text: 'Uso: .addcreditos 51912345678 10'
        });
      }

      if (!target.includes('@')) {
        target = target + '@s.whatsapp.net';
      }

      let user = await User.findOne({ id: target });

      if (!user) {
        return sock.sendMessage(from, {
          text: 'Usuario no registrado'
        });
      }

      user.creditos += cantidad;
      await user.save();

      await sock.sendMessage(from, {
        text: `✅ Agregados ${cantidad} créditos a ${target}\nAhora tiene: ${user.creditos}`
      });

      await sock.sendMessage(target, {
        text: `💰 El owner te recargó ${cantidad} créditos. Ahora tienes: ${user.creditos}`
      });
    }

    // ===== DNI =====
    if (command === '/dni' || command === '.dni') {
      return sock.sendMessage(from, {
        text: '🔒 La consulta de datos personales está desactivada para proteger la privacidad.'
      });
    }

    // ===== AYUDA =====
    if (command === '/help' || command === '.menu') {
      return sock.sendMessage(from, {
        text: `🤖 *BOT CRÉDITOS 24/7*

/start - Abrir menú
/register - Registrarte
/me - Ver créditos
/cmds - Lista de comandos
/code 519XXXXXXXX - Conectar tu WhatsApp

*OWNER:*
.addcreditos 519... 10 - Dar créditos`
      });
    }
  });
}

// ===== INICIAR BOT PRINCIPAL =====
startSession().catch(err => {
  console.error('❌ Error iniciando el bot:', err);
});
