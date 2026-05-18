'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const axios = require('axios');
const express = require('express');
const { execSync } = require('child_process');

const AGENT_URL = process.env.AGENT_URL || 'http://agent:8000';
const HOST_WHATSAPP = process.env.HOST_WHATSAPP || '';
const QR_TOKEN = process.env.QR_TOKEN || '';
const PORT = process.env.QR_PORT || 3001;
const AUTH_PATH = '/app/.wwebjs_auth';

// ── QR HTTP server ────────────────────────────────────────────────────────────
const app = express();
let latestQR = null;

app.get('/qr', async (req, res) => {
    if (QR_TOKEN && req.query.token !== QR_TOKEN) {
        return res.status(401).send('Token inválido');
    }
    if (!latestQR) {
        return res.status(200).send('<html><body style="background:#000;color:#fff;font-family:sans-serif;text-align:center;padding:50px"><h2>QR no disponible aún</h2><p>Espera unos segundos y recarga la página</p><script>setTimeout(()=>location.reload(),4000)</script></body></html>');
    }
    try {
        const png = await QRCode.toBuffer(latestQR);
        res.setHeader('Content-Type', 'image/png');
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
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
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
        if (msg.type === 'ptt' || msg.type === 'audio') {
            await msg.reply('Por el momento solo puedo leer mensajes de texto. Por favor escríbeme tu consulta. ✍️');
            return;
        }
        if (!msg.body || msg.type !== 'chat') return;

        const phoneNumber = msg.from;
        const text = msg.body;
        console.log(`[bridge] Mensaje de ${phoneNumber}: ${text.substring(0, 60)}`);

        let reply;
        try {
            const response = await axios.post(`${AGENT_URL}/chat`, {
                phone_number: phoneNumber,
                message: text,
            });
            reply = response.data.reply;
        } catch (err) {
            console.error('[bridge] Error llamando al agente:', err.message);
            reply = 'Lo sentimos, en este momento no podemos procesar tu consulta. Por favor intenta en unos minutos o visita www.edificioexplore.com';
        }

        await msg.reply(reply);

        if (HOST_WHATSAPP) {
            try {
                const contact = await client.getContactById(phoneNumber);
                const name = contact.pushname || phoneNumber;
                const waLink = `https://wa.me/${phoneNumber.replace('@c.us', '')}`;
                await client.sendMessage(
                    HOST_WHATSAPP,
                    `📩 *Nuevo mensaje — Agente Explore*\n*Cliente:* ${name}\n*Número:* ${waLink}\n*Mensaje:* ${text.substring(0, 200)}`
                );
            } catch (err) {
                console.error('[bridge] Error notificando al host:', err.message);
            }
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
