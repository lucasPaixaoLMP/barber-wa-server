const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const cors = require('cors');
const cron = require('node-cron');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());
app.use(cors());

// ── Segurança: API Key simples ──
const API_KEY = process.env.API_KEY || 'barberapp2024';

function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apikey;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Firebase Admin ──
// Variável de ambiente: FIREBASE_SERVICE_ACCOUNT com o JSON da service account
// (cole o conteúdo do arquivo JSON como string no painel do Render)
let db = null;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (serviceAccount.project_id) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('[Firebase] ✅ Conectado ao Firestore — projeto:', serviceAccount.project_id);
  } else {
    console.warn('[Firebase] ⚠ FIREBASE_SERVICE_ACCOUNT não configurada — lembretes automáticos desativados.');
  }
} catch (e) {
  console.error('[Firebase] Erro ao inicializar:', e.message);
}

// ── WhatsApp ──
let sock = null;
let qrCodeData = null;
let isConnected = false;
let connectingNow = false;

async function connectToWhatsApp() {
  if (connectingNow) return;
  connectingNow = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      browser: ['Barber App', 'Chrome', '1.0'],
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('[WA] QR code gerado — acesse / para escanear');
        qrCodeData = await qrcode.toDataURL(qr);
        isConnected = false;
      }

      if (connection === 'close') {
        isConnected = false;
        connectingNow = false;
        const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          console.log('[WA] Desconectado — faça login novamente em /');
        } else {
          console.log('[WA] Reconectando em 5s... (código:', code, ')');
          setTimeout(connectToWhatsApp, 5000);
        }
      }

      if (connection === 'open') {
        console.log('[WA] ✅ Conectado com sucesso!');
        isConnected = true;
        qrCodeData = null;
        connectingNow = false;
      }
    });

    sock.ev.on('creds.update', saveCreds);

  } catch (e) {
    connectingNow = false;
    console.error('[WA] Erro ao conectar:', e);
    setTimeout(connectToWhatsApp, 10000);
  }
}

// ── Enviar mensagem WA ──
async function sendWA(phone, message) {
  if (!isConnected) throw new Error('WhatsApp não conectado');
  let number = phone.replace(/\D/g, '');
  if (!number.startsWith('55')) number = '55' + number;
  const jid = number + '@s.whatsapp.net';
  await sock.sendMessage(jid, { text: message });
  return number;
}

// ── Lembretes automáticos ──
async function sendDailyReminders() {
  if (!db) {
    console.warn('[Cron] Firestore não configurado — pulando lembretes.');
    return { sent: 0, failed: 0, skipped: 0 };
  }
  if (!isConnected) {
    console.warn('[Cron] WhatsApp desconectado — pulando lembretes.');
    return { sent: 0, failed: 0, skipped: 0 };
  }

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  console.log(`[Cron] Buscando agendamentos de hoje (${today})...`);

  let sent = 0, failed = 0, skipped = 0;
  try {
    const snap = await db.collection('bookings')
      .where('date', '==', today)
      .where('status', '==', 'confirmed')
      .get();

    if (snap.empty) {
      console.log('[Cron] Nenhum agendamento hoje.');
      return { sent, failed, skipped };
    }

    const pending = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(b => !b.reminderSent);

    console.log(`[Cron] ${pending.length} lembrete(s) pendente(s) de ${snap.size} agendamento(s).`);

    for (const b of pending) {
      if (!b.phone) { skipped++; continue; }
      const msg =
        `✦ *Barber App — Lembrete de hoje!* 💈\n\n` +
        `Olá *${b.name}*! Só passando para lembrar:\n\n` +
        `✂ *${b.svc}*\n` +
        `💈 Barbeiro: ${b.barber}\n` +
        `📅 Hoje às *${b.time}*\n\n` +
        `Chegue 5 minutos antes. Te esperamos! 🤝`;
      try {
        await sendWA(b.phone, msg);
        await db.collection('bookings').doc(b.id).update({ reminderSent: true });
        console.log(`[Cron] ✅ Lembrete enviado → ${b.phone} (${b.name})`);
        sent++;
        // Pausa entre mensagens para evitar bloqueio
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        console.error(`[Cron] ❌ Falha ao enviar para ${b.phone}:`, e.message);
        failed++;
      }
    }

    console.log(`[Cron] Concluído — ✅ ${sent} enviados, ❌ ${failed} falhas, ⏭ ${skipped} sem número.`);
  } catch (e) {
    console.error('[Cron] Erro ao buscar agendamentos:', e.message);
  }
  return { sent, failed, skipped };
}

// ── Cron: todo dia às 08:00 (horário do servidor) ──
// Para ajustar o fuso horário, defina TZ=America/Sao_Paulo no Render
cron.schedule('0 8 * * *', () => {
  console.log('[Cron] ⏰ Disparando lembretes automáticos do dia...');
  sendDailyReminders();
}, { timezone: 'America/Sao_Paulo' });

console.log('[Cron] ✅ Agendado para 08:00 (America/Sao_Paulo) todos os dias.');

// ── Página inicial: QR Code ──
app.get('/', (req, res) => {
  if (isConnected) {
    return res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Barber WA Server</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e6e6e6}
.box{text-align:center;padding:40px;background:#111;border-radius:16px;border:1px solid #25D366}
.icon{font-size:64px;margin-bottom:16px}.title{font-size:22px;color:#25D366;font-weight:600;margin-bottom:8px}
.sub{font-size:14px;color:#888}</style></head>
<body><div class="box"><div class="icon">✅</div>
<div class="title">WhatsApp Conectado!</div>
<div class="sub">Seu servidor Barber App está funcionando.<br>Pode fechar esta aba.</div>
</div></body></html>`);
  }

  if (qrCodeData) {
    return res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Conectar WhatsApp</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e6e6e6}
.box{text-align:center;padding:40px 30px;background:#111;border-radius:16px;max-width:380px}
h2{color:#25D366;margin-bottom:8px}p{font-size:13px;color:#888;margin-bottom:20px;line-height:1.7}
img{border-radius:12px;border:3px solid #25D366;max-width:260px}
.step{background:#1a1a1a;border-radius:10px;padding:10px 14px;margin-top:16px;font-size:12px;color:#aaa;text-align:left;line-height:2}
.refresh{margin-top:20px;font-size:12px;color:#555}</style></head>
<body><div class="box">
  <h2>📲 Escanear QR Code</h2>
  <p>Conecte seu WhatsApp ao servidor<br>do Barber App</p>
  <img src="${qrCodeData}" alt="QR Code"/>
  <div class="step">
    1️⃣ Abra o <b>WhatsApp</b> no celular<br>
    2️⃣ Toque em <b>Aparelhos conectados</b><br>
    3️⃣ Toque em <b>Conectar aparelho</b><br>
    4️⃣ Aponte a câmera para o QR Code
  </div>
  <div class="refresh">Página atualiza automaticamente a cada 30s</div>
</div></body></html>`);
  }

  return res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Aguardando...</title>
<meta http-equiv="refresh" content="5"></head>
<body style="font-family:sans-serif;background:#0a0a0a;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<div style="text-align:center"><p style="font-size:18px">⏳ Gerando QR code...</p>
<p style="color:#666;font-size:13px">Aguarde alguns segundos</p></div>
</body></html>`);
});

// ── Status ──
app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    hasQR: !!qrCodeData,
    firestore: !!db,
    server: 'Barber WA Server v1.1'
  });
});

// ── Enviar mensagem ──
app.post('/send', authMiddleware, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone e message são obrigatórios' });
  }
  if (!isConnected) {
    return res.status(503).json({ error: 'WhatsApp não conectado. Acesse / para reconectar.' });
  }
  try {
    const number = await sendWA(phone, message);
    console.log('[WA] Mensagem enviada para', number);
    res.json({ success: true, to: number });
  } catch (e) {
    console.error('[WA] Erro ao enviar:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Disparar lembretes manualmente (só hoje) ──
app.post('/reminders', authMiddleware, async (req, res) => {
  console.log('[Reminders] Disparo manual solicitado.');
  try {
    const result = await sendDailyReminders();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Disparar lembretes de TODOS os agendamentos confirmados (teste) ──
app.post('/reminders/all', authMiddleware, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Firestore nao configurado.' });
  if (!isConnected) return res.status(503).json({ error: 'WhatsApp nao conectado.' });
  console.log('[Reminders/All] Disparo de teste em todos os agendamentos...');
  let sent = 0, failed = 0, skipped = 0;
  try {
    const snap = await db.collection('bookings')
      .where('status', '==', 'confirmed')
      .get();
    if (snap.empty) return res.json({ success: true, sent, failed, skipped, total: 0 });
    const bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log('[Reminders/All] Total:', bookings.length);
    for (const b of bookings) {
      if (!b.phone) { skipped++; continue; }
      const msg =
        `[TESTE] ✦ *Barber App — Lembrete* 💈\n\n` +
        `Ola *${b.name}*! Este e um lembrete de teste:\n\n` +
        `✂ *${b.svc}*\n` +
        `💈 Barbeiro: ${b.barber}\n` +
        `📅 ${b.dateStr} as *${b.time}*\n\n` +
        `Chegue 5 minutos antes. Te esperamos! 🤝`;
      try {
        await sendWA(b.phone, msg);
        console.log('[Reminders/All] Enviado para', b.phone, '(' + b.name + ')');
        sent++;
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        console.error('[Reminders/All] Falha:', b.phone, e.message);
        failed++;
      }
    }
    console.log('[Reminders/All] Concluido:', sent, 'enviados,', failed, 'falhas,', skipped, 'sem numero.');
    res.json({ success: true, sent, failed, skipped, total: bookings.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Desconectar / resetar sessão ──
app.post('/logout', authMiddleware, async (req, res) => {
  try {
    if (sock) await sock.logout();
    isConnected = false;
    qrCodeData = null;
    res.json({ success: true, message: 'Desconectado. Acesse / para reconectar.' });
    setTimeout(connectToWhatsApp, 2000);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ──
connectToWhatsApp();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Barber WA Server rodando na porta ${PORT}`);
  console.log(`🔑 API Key: ${API_KEY}`);
  console.log(`📲 Acesse / para escanear o QR Code`);
});