'use strict';

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const axios = require('axios');
const express = require('express');
const fs = require('fs');
const path = require('path');

const AGENT_URL = process.env.AGENT_URL || 'http://agent:8000';
const HOST_WHATSAPP = process.env.HOST_WHATSAPP || '';
const QR_TOKEN = process.env.QR_TOKEN || '';
const PORT = 3001;

// ── QR HTTP server ────────────────────────────────────────────────────────────
const app = express();
let latestQR = null;

app.get('/qr', async (req, res) => {
    if (QR_TOKEN && req.query.token !== QR_TOKEN) {
        return res.status(401).send('Token inválido');
    }
    if (!latestQR) {
        return res.status(404).send('QR aún no disponible. Espera unos segundos y recarga.');
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

// ── Limpiar lock de Chromium al iniciar (evita crash en reinicios) ─────────────
const lockFile = path.join('/app/.wwebjs_auth', 'SingletonLock');
if (fs.existsSync(lockFile)) {
    fs.unlinkSync(lockFile);
    console.log('[bridge] Lock de Chromium eliminado');
}

// ── Cliente WhatsApp ──────────────────────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/app/.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ],
    },
});

client.on('qr', (qr) => {
    latestQR = qr;
    qrcode.generate(qr, { small: true });
    console.log('[bridge] QR disponible en http://localhost:' + PORT + '/qr');
});

client.on('ready', () => {
    latestQR = null;
    console.log('[bridge] WhatsApp conectado y listo');
});

client.on('disconnected', (reason) => {
    console.log('[bridge] Desconectado:', reason, '— reconectando en 5s...');
    setTimeout(() => client.initialize(), 5000);
});

// ── Manejo de llamadas entrantes ──────────────────────────────────────────────
client.on('call', async (call) => {
    await call.reject();
    const contact = await client.getContactById(call.from);
    await client.sendMessage(
        call.from,
        `Hola ${contact.pushname || ''}! Por el momento solo atendemos por mensajes de texto. ¿En qué te podemos ayudar? 🏢`
    );
});

// ── Manejo de mensajes ────────────────────────────────────────────────────────
client.on('message', async (msg) => {
    // Ignorar mensajes propios, grupos, estados y notas de voz
    if (msg.fromMe) return;
    if (msg.from === 'status@broadcast') return;
    if (msg.isGroupMsg) return;
    if (msg.type === 'ptt' || msg.type === 'audio') {
        await msg.reply(
            'Por el momento solo puedo leer mensajes de texto. Por favor escríbeme tu consulta. ✍️'
        );
        return;
    }
    if (!msg.body || msg.type !== 'chat') return;

    const phoneNumber = msg.from;
    const text = msg.body;

    console.log(`[bridge] Mensaje de ${phoneNumber}: ${text.substring(0, 60)}...`);

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

    // Notificar al host si hay número configurado
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

client.initialize();
