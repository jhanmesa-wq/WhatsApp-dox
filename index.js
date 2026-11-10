const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const mongoose = require('mongoose');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
const webPairings = new Map();
const webRateLimits = new Map();
const WEB_PAIRING_TTL = 10 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const WEB_BASE_URL = (process.env.WEB_BASE_URL ||
  (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : '')
).replace(/\/$/, '');

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

// ===== SERVIDOR WEB Y API DE VINCULACIÓN =====
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'vincular.html'), (err) => {
    if (err && !res.headersSent) res.status(200).send('✅ Bot 24/7 con MongoDB Activo');
  });
});

function normalizePhone(value) {
  // Se aceptan números internacionales con o sin +, espacios o guiones.
  const number = String(value || '').replace(/[\\s()+.-]/g, '');
  if (!/^\\d{8,15}$/.test(number)) return null;
  return number;
}

function allowWebRequest(key) {
  const now = Date.now();
  const entry = webRateLimits.get(key);
  if (entry && now - entry.startedAt < 10 * 60 * 1000) {
    if (entry.count >= 4) return false;
    entry.count += 1;
    return true;
  }
  webRateLimits.set(key, { startedAt: now, count: 1 });
  return true;
}

app.post('/api/vincular', async (req, res) => {
  const number = normalizePhone(req.body?.numero);
  if (!number) {
    return res.status(400).json({
      ok: false,
      error: 'Introduce un número internacional válido, con código de país y entre 8 y 15 dígitos.'
    });
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!allowWebRequest(ip) || !allowWebRequest(`number:${number}`)) {
    return res.status(429).json({
      ok: false,
      error: 'Demasiadas solicitudes. Espera unos minutos antes de intentarlo nuevamente.'
    });
  }

  const mainNumber = (sessions.get('main')?.sock?.user?.id || '')
    .split(':')[0].split('@')[0];

  if (number === mainNumber) {
    return res.status(409).json({
      ok: false,
      error: 'Este número ya es la cuenta principal del bot.'
    });
  }

  const sessionKey = `web_${number}`;
  if (sessions.has(sessionKey) || sessions.has(number)) {
    return res.status(409).json({
      ok: false,
      error: 'Este número ya tiene una vinculación iniciada o activa.'
    });
  }

  if (sessions.size - 1 >= MAX_USER_SESSIONS) {
    return res.status(429).json({
      ok: false,
      error: `Se alcanzó el límite de ${MAX_USER_SESSIONS} sesiones.`
    });
  }

  const token = crypto.randomBytes(24).toString('hex');
  const pairing = {
    token,
    number,
    status: 'preparando',
    code: null,
    message: 'Preparando la vinculación con WhatsApp...',
    createdAt: Date.now()
  };
  webPairings.set(token, pairing);

  // Limpieza automática de solicitudes antiguas.
  setTimeout(() => {
    const current = webPairings.get(token);
    if (current && Date.now() - current.createdAt >= WEB_PAIRING_TTL) {
      webPairings.delete(token);
    }
  }, WEB_PAIRING_TTL + 1000).unref?.();

  res.status(202).json({
    ok: true,
    token,
    message: 'Solicitud creada. Espera a que se genere tu código.'
  });

  try {
    await startSession(
      sessionKey,
      number,
      null,
      null,
      (code) => {
        const current = webPairings.get(token);
        if (!current) return;
        if (!code) {
          current.status = 'error';
          current.code = null;
          current.message = 'WhatsApp no pudo generar el código. Inténtalo nuevamente más tarde.';
          return;
        }
        current.status = 'esperando';
        current.code = String(code).match(/.{1,4}/g)?.join('-') || String(code);
        current.message = 'Código generado. Introduce el código en tu WhatsApp.';
      },
      async () => {
        const current = webPairings.get(token);
        if (current) {
          current.status = 'conectado';
          current.code = null;
          current.message = 'Bot vinculado correctamente. Ya puedes usar el bot.';
        }
      }
    );
  } catch (error) {
    const current = webPairings.get(token);
    if (current) {
      current.status = 'error';
      current.code = null;
      current.message = 'No se pudo iniciar la vinculación. Inténtalo nuevamente más tarde.';
    }
    console.error('Error iniciando vinculación web:', error);
  }
});

app.get('/api/vincular/:token', (req, res) => {
  const pairing = webPairings.get(req.params.token);
  if (!pairing || Date.now() - pairing.createdAt > WEB_PAIRING_TTL) {
    return res.status(404).json({
      ok: false,
      error: 'La solicitud no existe o ha caducado. Inicia una nueva vinculación.'
    });
  }

  return res.json({
    ok: true,
    status: pairing.status,
    code: pairing.code,
    message: pairing.message
  });
});

app.listen(PORT, () => console.log(`🌐 Servidor web activo en el puerto ${PORT}`));

// ===== INICIAR SESIÓN INDEPENDIENTE =====
async function startSession(
  sessionKey = 'main',
  pairingNumber = INITIAL_BOT_NUMBER,
  notifySock = null,
  notifyJid = null,
  onPairingCode = null,
  onConnected = null
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

        if (typeof onPairingCode === 'function') {
          onPairingCode(code);
        }

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

        if (typeof onPairingCode === 'function') {
          onPairingCode(null);
        }

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

      if (typeof onConnected === 'function') {
        await onConnected();
      }

      // Confirmación enviada desde la sesión recién vinculada al mismo titular.
      if (sessionKey !== 'main' && pairingNumber) {
        const ownerJid = `${pairingNumber}@s.whatsapp.net`;
        const confirmation = {
          text: '✅ *BOT VINCULADO CORRECTAMENTE*\n\nTu WhatsApp se conectó al bot. Ya puedes usar el bot.\n\nSi no reconoces esta vinculación, cierra la sesión desde Dispositivos vinculados de WhatsApp.'
        };
        const mainSock = sessions.get('main')?.sock;
        const senderSock = mainSock?.user ? mainSock : sock;
        await senderSock.sendMessage(ownerJid, confirmation)
          .catch(err => console.error('No se pudo enviar la confirmación de vinculación:', err.message));
      }
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

      if (sessions.has(number) || sessions.has(`web_${number}`)) {
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

👇 *ÚNETE A NUESTRO BOT DE TELEGRAM*
https://t.me/specter_dox434bot

🌐 *VINCULAR WHATSAPP*
${WEB_BASE_URL || 'Configura WEB_BASE_URL en Render'}`;

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
          },
          {
            index: 2,
            urlButton: {
              displayText: '🌐 VINCULAR WHATSAPP',
              url: WEB_BASE_URL || `https://TU-DOMINIO.onrender.com`
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
🌐 Web de vinculación: ${WEB_BASE_URL || 'Configura WEB_BASE_URL en Render'}

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
