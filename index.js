const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const mongoose = require('mongoose');
const { Boom } = require('@hapi/boom');

// ===== CONFIG =====
const OWNER_NUMBERS = ["51972097238@s.whatsapp.net", "51973244296@s.whatsapp.net"];
const isOwner = (jid, selfChat = false) => OWNER_NUMBERS.includes(jid) || selfChat;
const INITIAL_BOT_NUMBER = '51973244296';
const MONGO_URL = process.env.MONGO_URL;
const TOKEN_CODART = process.env.TOKEN_CODART;
const PORT = process.env.PORT || 10000;

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

app.listen(PORT, () => {
  console.log(`🌐 Servidor en ${PORT}`);
});

// ===== INICIAR BOT =====
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
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

  // ===== CÓDIGO INICIAL =====
  if (!sock.authState.creds.registered) {
    console.log('⏳ Esperando para generar codigo inicial...');

    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(INITIAL_BOT_NUMBER);

        console.log('\n========================================');
        console.log(`TU CODIGO INICIAL ES: ${code}`);
        console.log(`Numero: ${INITIAL_BOT_NUMBER}`);
        console.log('WhatsApp > Dispositivos vinculados > Vincular con numero');
        console.log('========================================\n');

      } catch (e) {
        console.log('Error generando codigo inicial:', e.message);
      }
    }, 8000);
  }

  sock.ev.on('creds.update', saveCreds);

  // ===== CONEXIÓN =====
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const shouldReconnect =
        (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
          : true;

      if (shouldReconnect) {
        console.log('🔄 Reconectando WhatsApp...');

        setTimeout(() => {
          startBot().catch(err =>
            console.error('Error al reconectar:', err)
          );
        }, 3000);
      }

    } else if (connection === 'open') {
      console.log('✅ Bot conectado a WhatsApp!');
    }
  });

  // ===== MENSAJES =====
  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const m = messages[0];

      if (!m || !m.message) return;

      const from = m.key.remoteJid;
      if (!from || from.endsWith('@g.us')) return;

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

      // Leer texto y respuestas de botones
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

      // ===== COMANDO /CODE =====
      if (command === '/code' || command === '.code') {
        const requester = from.split('@')[0];

        if (isOwner(from, isSelfChat)) {
          const number = (args[1] || INITIAL_BOT_NUMBER)
            .replace(/[^0-9]/g, '');

          if (!number) {
            return sock.sendMessage(from, {
              text: 'Uso: /code 51912345678'
            });
          }

          if (sock.authState.creds.registered) {
            return sock.sendMessage(from, {
              text: 'ℹ️ Esta sesión ya está vinculada. No se puede generar otro código desde una sesión activa. No borres la carpeta auth.'
            });
          }

          try {
            const code = await sock.requestPairingCode(number);

            const pretty =
              String(code).match(/.{1,4}/g)?.join('-') ||
              String(code);

            return sock.sendMessage(from, {
              text: `🔐 *CÓDIGO DE VINCULACIÓN*

📱 Número: +${number}
🔑 Código: *${pretty}*

WhatsApp → Dispositivos vinculados → Vincular con número de teléfono.`
            });

          } catch (e) {
            console.error('Error generando pairing code:', e);

            return sock.sendMessage(from, {
              text: '❌ No se pudo generar el código. Revisa que la sesión aún no esté vinculada y que el número sea correcto.'
            });
          }
        }

        // Notificar solicitud al propietario
        const ownerJid = OWNER_NUMBERS[0];

        try {
          await sock.sendMessage(ownerJid, {
            text: `📩 *SOLICITUD DE CÓDIGO*

Usuario: +${requester}
Nombre: ${m.pushName || 'Usuario'}

Pidió /code.

La generación está reservada al propietario de esta sesión.`
          });

        } catch (e) {
          console.error('No se pudo notificar al owner:', e);
        }

        return sock.sendMessage(from, {
          text: '📩 Tu solicitud de código fue enviada al propietario.\n\nPor seguridad, esta instancia usa una sola cuenta de WhatsApp y no puede entregar códigos de vinculación a todos los usuarios.'
        });
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

      // ===== COMANDO START =====
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

        const texto =
          `👋 *BIENVENIDO @${numero}*\n\n` +
          `👤 *Usuario:* ${nombre}\n` +
          `📱 *Número:* +${numero}\n` +
          `💳 *Créditos:* ${user.creditos}\n\n` +
          `📋 *MENÚ PRINCIPAL*\n` +
          `Selecciona una opción en el menú o escribe el comando.`;

        // MENÚ INTERACTIVO
        return sock.sendMessage(from, {
          text: texto,
          footer: 'SPECTER DOX • Bot activo',
          title: 'Menú de comandos',
          buttonText: 'ABRIR MENÚ',

          sections: [
            {
              title: 'Opciones disponibles',

              rows: [
                {
                  title: '👤 Mi perfil',
                  rowId: '/me',
                  description: 'Ver nombre, número y créditos'
                },
                {
                  title: '📋 Comandos',
                  rowId: '/cmds',
                  description: 'Ver la lista de comandos'
                },
                {
                  title: '📝 Registrarme',
                  rowId: '/register',
                  description: 'Crear tu cuenta'
                },
                {
                  title: '💳 Comprar créditos',
                  rowId: '/buy',
                  description: 'Información de recargas'
                },
                {
                  title: '❓ Ayuda',
                  rowId: '/help',
                  description: 'Cómo usar el bot'
                },
                {
                  title: '🤖 Bot de Telegram',
                  rowId: 'https://t.me/specter_dox434bot',
                  description: 'Abrir el bot de Telegram'
                }
              ]
            }
          ]
        });
      }

      // ===== LISTA DE COMANDOS =====
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

🤖 *Bot Telegram:*
https://t.me/specter_dox434bot`;

        return sock.sendMessage(from, {
          text: texto
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

        if (!target || !cantidad || cantidad < 1) {
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
/code - Solicitar código al propietario
.crear - Gasta 1 crédito (ejemplo)

*OWNER:*

/code 519... - Generar código si la sesión no está vinculada
.addcreditos 519... 10 - Dar créditos`
        });
      }

    } catch (error) {
      console.error('❌ Error procesando mensaje:', error);

      try {
        await sock.sendMessage(
          messages[0]?.key?.remoteJid,
          { text: '❌ Ocurrió un error procesando el comando. Intenta nuevamente.' }
        );
      } catch (sendError) {
        console.error('Error enviando respuesta:', sendError);
      }
    }
  });
}

// ===== INICIAR =====
startBot().catch(err => {
  console.error('❌ Error iniciando el bot:', err);
});
