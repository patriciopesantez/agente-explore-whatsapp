'use strict';

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const axios = require('axios');
const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FOTOS_PATH = process.env.FOTOS_PATH || '/app/fotos';
const FOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
function toWaId(n) {
    return n.trim().replace(/^\+/, '').replace(/@.*$/, '') + '@c.us';
}
const ASESORES_WHATSAPP = (process.env.ASESOR_WHATSAPP || '593995111815,593989587443,593984506432')
    .split(',').filter(Boolean).map(toWaId);
const HOST_WA = process.env.HOST_WHATSAPP ? toWaId(process.env.HOST_WHATSAPP) : '';

const handedOff = new Set();
const aiSending = new Set();

function normalizeId(id) {
    return id ? id.split('@')[0] : id;
}

function getFotos() {
    if (!fs.existsSync(FOTOS_PATH)) return [];
    return fs.readdirSync(FOTOS_PATH)
        .filter(f => FOTO_EXTENSIONS.has(path.extname(f).toLowerCase()))
        .sort()
        .map(f => path.join(FOTOS_PATH, f));
}

const AGENT_URL = process.env.AGENT_URL || 'http://agent:8000';
const HOST_WHATSAPP = process.env.HOST_WHATSAPP || '';
const QR_TOKEN = process.env.QR_TOKEN || '';
const PORT = process.env.QR_PORT || 3001;
const AUTH_PATH = '/app/.wwebjs_auth';

// ── QR HTTP server ────────────────────────────────────────────────────────────
const app = express();
let latestQR = null;

// Página HTML con auto-refresh cada 15s para que el QR nunca expire
app.get('/qr', (req, res) => {
    if (QR_TOKEN && req.query.token !== QR_TOKEN) {
        return res.status(401).send('Token inválido');
    }
    const token = QR_TOKEN ? `?token=${QR_TOKEN}` : '';
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>WhatsApp QR — Explore</title>
  <style>
    body { background:#111; color:#fff; font-family:sans-serif; text-align:center; padding:40px; }
    img { width:300px; height:300px; border:8px solid #fff; border-radius:12px; }
    p { color:#aaa; margin-top:12px; }
  </style>
</head>
<body>
  <h2>Escanea con WhatsApp</h2>
  <img id="qr" src="/qr.png${token}" alt="QR Code">
  <p id="msg">El QR se actualiza automáticamente cada 15 segundos</p>
  <script>
    function refresh() {
      var img = document.getElementById('qr');
      img.src = '/qr.png${token}&t=' + Date.now();
    }
    setInterval(refresh, 15000);
  </script>
</body>
</html>`);
});

// Endpoint que devuelve solo la imagen PNG del QR actual
app.get('/qr.png', async (req, res) => {
    if (QR_TOKEN && req.query.token !== QR_TOKEN) {
        return res.status(401).send('Token inválido');
    }
    if (!latestQR) {
        return res.status(404).send('QR no disponible aún');
    }
    try {
        const png = await QRCode.toBuffer(latestQR, { scale: 8 });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        res.send(png);
    } catch (err) {
        res.status(500).send('Error generando QR');
    }
});

app.listen(PORT, () => console.log(`[bridge] Servidor QR en http://localhost:${PORT}/qr`));

// ── Limpiar todos los locks de Chromium al iniciar ───────────────────────────
function cleanChromiumLocks() {
    try {
        execSync(`find ${AUTH_PATH} -name "SingletonLock" -delete 2>/dev/null; find ${AUTH_PATH} -name "SingletonCookie" -delete 2>/dev/null; find ${AUTH_PATH} -name "SingletonSocket" -delete 2>/dev/null; true`);
        console.log('[bridge] Locks de Chromium eliminados');
    } catch (e) {
        // ignorar si no hay locks
    }
}

// ── Inicializar cliente WhatsApp con reintentos ───────────────────────────────
function createClient() {
    const client = new Client({
        authStrategy: new LocalAuth({ dataPath: AUTH_PATH }),
        puppeteer: {
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            timeout: 60000,
            protocolTimeout: 120000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-translate',
                '--mute-audio',
                '--safebrowsing-disable-auto-update',
            ],
        },
    });

    client.on('qr', (qr) => {
        latestQR = qr;
        qrcode.generate(qr, { small: true });
        console.log('[bridge] QR listo — visita http://localhost:' + PORT + '/qr');
    });

    client.on('ready', () => {
        latestQR = null;
        console.log('[bridge] WhatsApp conectado y listo');
    });

    client.on('disconnected', (reason) => {
        console.log('[bridge] Desconectado:', reason, '— reconectando en 10s...');
        setTimeout(startBridge, 10000);
    });

    client.on('call', async (call) => {
        await call.reject();
        try {
            await client.sendMessage(
                call.from,
                'Por el momento solo atendemos por mensajes de texto. ¿En qué te podemos ayudar? 🏢'
            );
        } catch (e) {}
    });

    client.on('message', async (msg) => {
        if (msg.fromMe) return;
        if (msg.from === 'status@broadcast') return;
        if (msg.isGroupMsg) return;
        if (handedOff.has(normalizeId(msg.from))) return;
        if (msg.type === 'ptt' || msg.type === 'audio') {
            await client.sendMessage(msg.from, 'Por el momento solo puedo leer mensajes de texto. Por favor escríbeme tu consulta. ✍️');
            return;
        }
        if (!msg.body || msg.type !== 'chat') return;

        const phoneNumber = msg.from;
        const text = msg.body;
        console.log(`[bridge] Mensaje de ${phoneNumber}: ${text.substring(0, 60)}`);

        let reply;
        let sendPhotos = false;
        let transferMotivo = null;
        try {
            const response = await axios.post(`${AGENT_URL}/chat`, {
                phone_number: phoneNumber,
                message: text,
            });
            reply = response.data.reply;
            sendPhotos = response.data.send_photos === true;
            transferMotivo = response.data.transfer_motivo || null;
        } catch (err) {
            console.error('[bridge] Error llamando al agente:', err.message);
            reply = 'En breve un asesor especializado te contactará por este medio. Si tienes alguna otra consulta, con gusto te ayudo. 😊';
        }

        aiSending.add(normalizeId(phoneNumber));
        try {
            await client.sendMessage(phoneNumber, reply);
        } finally {
            aiSending.delete(normalizeId(phoneNumber));
        }

        if (sendPhotos) {
            const fotos = getFotos();
            if (fotos.length > 0) {
                console.log(`[bridge] Enviando ${fotos.length} foto(s) a ${phoneNumber}`);
                for (const fotoPath of fotos) {
                    try {
                        aiSending.add(normalizeId(phoneNumber));
                        const media = MessageMedia.fromFilePath(fotoPath);
                        await client.sendMessage(phoneNumber, media);
                    } catch (err) {
                        console.error('[bridge] Error enviando foto:', fotoPath, err.message);
                    } finally {
                        aiSending.delete(normalizeId(phoneNumber));
                    }
                }
            } else {
                console.warn('[bridge] send_photos=true pero no hay fotos en', FOTOS_PATH);
            }
        }

        if (transferMotivo) {
            console.log(`[bridge] Notificando a asesor: ${phoneNumber} — motivo: ${transferMotivo}`);
            try {
                const contact = await client.getContactById(phoneNumber);
                const name = contact.pushname || phoneNumber.replace('@c.us', '');
                const waLink = `https://wa.me/${phoneNumber.replace('@c.us', '')}`;
                const msg = `🔔 *Acción requerida — Agente Explore*\n\n*Cliente:* ${name}\n*Número:* ${waLink}\n*Motivo:* ${transferMotivo}\n\nRevisa WhatsApp para coordinar la cita o responder la consulta.`;
                for (const asesor of ASESORES_WHATSAPP) {
                    try {
                        await client.sendMessage(asesor, msg);
                    } catch (e) {
                        console.error(`[bridge] Error notificando a asesor ${asesor}:`, e.message);
                    }
                }
            } catch (err) {
                console.error('[bridge] Error notificando al asesor:', err.message);
            }
        }

        if (HOST_WA) {
            try {
                const contact = await client.getContactById(phoneNumber);
                const name = contact.pushname || phoneNumber;
                const waLink = `https://wa.me/${phoneNumber.replace('@c.us', '')}`;
                await client.sendMessage(
                    HOST_WA,
                    `📩 *Nuevo mensaje — Agente Explore*\n*Cliente:* ${name}\n*Número:* ${waLink}\n*Mensaje:* ${text.substring(0, 200)}`
                );
            } catch (err) {
                console.error('[bridge] Error notificando al host:', err.message);
            }
        }
    });

    client.on('message_create', async (msg) => {
        if (!msg.fromMe) return;
        const to = normalizeId(msg.to);

        if (msg.body === '!reactivar') {
            if (handedOff.has(to)) {
                handedOff.delete(to);
                console.log(`[bridge] IA reactivada para ${to}`);
            }
            return;
        }

        if (!aiSending.has(to) && !handedOff.has(to)) {
            handedOff.add(to);
            console.log(`[bridge] IA pausada por intervención humana en ${to}`);
        }
    });

    return client;
}

async function startBridge() {
    cleanChromiumLocks();
    const client = createClient();
    try {
        await client.initialize();
    } catch (err) {
        console.error('[bridge] Error iniciando Chromium:', err.message);
        console.log('[bridge] Reintentando en 10s...');
        setTimeout(startBridge, 10000);
    }
}

startBridge();
