const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const passport = require('passport');
const FacebookStrategy = require('passport-facebook').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const admin = require('firebase-admin');
const axios = require('axios'); // Movido para o topo para organização

// --- 1. CONFIGURAÇÕES E SEGREDOS ---
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Use variáveis de ambiente para segredos (Mais seguro que deixar hardcoded)
const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || 'fluxpro_token_seguro'; 
const SESSION_SECRET = process.env.SESSION_SECRET || 'fluxpro_segredo_super_secreto';
const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN || 'meu-token-secreto-asaas'; // <--- SEGURANÇA EXTRA

app.set('trust proxy', 1);
app.use(cors({
    origin: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}));
app.use(bodyParser.json());
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, sameSite: 'none', maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

// --- 2. FIREBASE (INICIALIZAÇÃO ÚNICA E ROBUSTA) ---
let db; // Variável global do banco

if (process.env.FIREBASE_CREDENTIALS) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        
        // Verifica se já não foi iniciado para evitar erro de duplicidade
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        
        db = admin.firestore(); // Inicializa o DB aqui
        console.log("🔥 Firebase e Firestore Conectados!");
    } catch (e) {
        console.error("❌ Erro Crítico no Firebase:", e);
    }
} else {
    console.warn("⚠️ Variável FIREBASE_CREDENTIALS não encontrada no Render!");
}

// --- 3. SOCKET.IO ---
const io = new Server(server, { cors: { origin: "*" } });
io.on('connection', (socket) => {
    socket.on('entrar_sala_privada', (uid) => { if(uid) socket.join(uid); });
});

// --- 4. ESTRATÉGIAS DE LOGIN ---
let GLOBAL_PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN; 

passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((u, d) => d(null, u));

// Facebook Strategy
if (process.env.FACEBOOK_APP_ID) {
    passport.use(new FacebookStrategy({
        clientID: process.env.FACEBOOK_APP_ID,
        clientSecret: process.env.FACEBOOK_APP_SECRET,
        callbackURL: 'https://fluxcontrolcrm.onrender.com/auth/facebook/callback',
        profileFields: ['id', 'displayName', 'photos', 'email'],
        passReqToCallback: true
    }, (req, token, r, profile, done) => done(null, { profile, accessToken: token })));
}

// Google Strategy
if (process.env.GOOGLE_CLIENT_ID) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: "https://fluxcontrolcrm.onrender.com/auth/google/callback",
        scope: ['profile', 'email', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events']
      },
      function(accessToken, refreshToken, profile, done) {
        return done(null, { profile, accessToken, refreshToken });
      }
    ));
}

// =================================================================
// --- 5. ROTAS FACEBOOK (LOGIN & WEBHOOK) ---
// =================================================================

app.get('/auth/facebook', (req, res, next) => {
    if (req.query.uid) req.session.uid = req.query.uid; 
    passport.authenticate('facebook', { scope: ['public_profile', 'pages_show_list', 'pages_messaging', 'instagram_basic', 'instagram_manage_messages'] })(req, res, next);
});

app.get('/auth/facebook/callback', 
  passport.authenticate('facebook', { failureRedirect: '/login-falhou' }),
  async (req, res) => {
    const userUid = req.session.uid; 
    try {
        const pagesUrl = `https://graph.facebook.com/me/accounts?access_token=${req.user.accessToken}`;
        const response = await fetch(pagesUrl);
        const data = await response.json();

        if (data.data && data.data.length > 0) {
            const pagina = data.data[0];
            GLOBAL_PAGE_TOKEN = pagina.access_token;

            if(db) {
                await db.collection('integrated_pages').doc(pagina.id).set({
                    ownerUid: userUid || 'admin_fallback',
                    pageAccessToken: pagina.access_token,
                    pageName: pagina.name,
                    pageId: pagina.id,
                    updatedAt: new Date().toISOString()
                });
                
                await db.collection('config').doc('facebook_global').set({
                    token: pagina.access_token,
                    pageId: pagina.id
                });
            }
        }
    } catch (error) { console.error("Erro Login FB:", error); }
    res.send('<script>window.close()</script>');
  }
);

app.get('/api/facebook/status', (req, res) => {
    res.json({ connected: !!GLOBAL_PAGE_TOKEN });
});

// WEBHOOK VERIFICAÇÃO (META)
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else { res.sendStatus(403); }
});

// Helpers
async function getPageOwnerAndToken(pageId) {
    try {
        if(!db) return null;
        const doc = await db.collection('integrated_pages').doc(pageId).get();
        if (doc.exists) return doc.data();
    } catch(e) {}
    return null;
}

async function getUserProfile(psid, token) {
    try {
        const url = `https://graph.facebook.com/v21.0/${psid}?fields=name,profile_pic&access_token=${token}`;
        const response = await fetch(url);
        const data = await response.json();
        if (data.error) return { first_name: "Cliente", profile_pic: "https://cdn-icons-png.flaticon.com/512/149/149071.png" };
        return { first_name: data.name || "Cliente", profile_pic: data.profile_pic };
    } catch (e) { return { first_name: "Cliente", profile_pic: "https://cdn-icons-png.flaticon.com/512/149/149071.png" }; }
}

// WEBHOOK RECEBIMENTO (MENSAGENS)
app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'page' || body.object === 'instagram') {
        for (const entry of body.entry) {
            const pageId = entry.id;
            const pageConfig = await getPageOwnerAndToken(pageId);
            const tokenParaUsar = pageConfig ? pageConfig.pageAccessToken : GLOBAL_PAGE_TOKEN;
            const uidParaEnviar = pageConfig ? pageConfig.ownerUid : null;

            const evt = entry.messaging ? entry.messaging[0] : null;
            if (evt && evt.message) {
                let txt = evt.message.text || (evt.message.attachments ? evt.message.attachments[0].payload.url : '');
                let type = evt.message.attachments ? evt.message.attachments[0].type : 'text';
                
                if (txt && !evt.message.is_echo) { 
                    const perfil = await getUserProfile(evt.sender.id, tokenParaUsar);
                    const msgData = {
                        id: evt.sender.id, 
                        name: perfil.first_name, 
                        avatar: perfil.profile_pic,
                        text: txt, 
                        type: type, 
                        timestamp: new Date().toISOString(), 
                        ehMinha: false,
                        messageId: evt.message.mid 
                    };

                    if (uidParaEnviar) {
                        io.to(uidParaEnviar).emit('nova_mensagem', msgData); 
                    } else {
                        io.emit('nova_mensagem', msgData); 
                    }
                }
            }
        }
        res.status(200).send('EVENT_RECEIVED');
    } else { res.sendStatus(404); }
});

// API ENVIAR MENSAGEM
app.post('/api/enviar-instagram', async (req, res) => {
    const { recipientId, texto } = req.body;
    let token = GLOBAL_PAGE_TOKEN;

    if (!token && db) {
        try {
            const snapshot = await db.collection('integrated_pages').limit(1).get();
            if (!snapshot.empty) token = snapshot.docs[0].data().pageAccessToken;
            
            if (!token) {
                const doc = await db.collection('config').doc('facebook_global').get();
                if (doc.exists) token = doc.data().token;
            }
            if (token) GLOBAL_PAGE_TOKEN = token;
        } catch(e) {}
    }

    if (!token) return res.status(500).json({ error: "Servidor sem token." });

    try {
        const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${token}`;
        const response = await fetch(url, { 
            method: 'POST', headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ recipient: { id: recipientId }, message: { text: texto } }) 
        });
        const data = await response.json();
        if (data.error) return res.status(500).json({ error: data.error.message });
        res.json({ success: true, id: data.message_id });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// =================================================================
// --- 6. ROTAS GOOGLE CALENDAR ---
// =================================================================

app.get('/auth/google', (req, res, next) => {
    passport.authenticate('google', { 
        scope: ['profile', 'email', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'],
        accessType: 'offline', 
        prompt: 'consent'
    })(req, res, next);
});

app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login-falhou' }),
  function(req, res) {
    res.send(`<html><body><script>if(window.opener){window.opener.postMessage("login_google_sucesso","*");}window.close();</script></body></html>`);
  }
);

const checkGoogleAuth = (req, res, next) => {
    if (req.user && req.user.accessToken) return next();
    res.status(401).json({ error: 'Não conectado ao Google' });
};

app.get('/api/google/status', (req, res) => {
    res.json({ connected: !!(req.user && req.user.accessToken) });
});

app.get('/api/google/events', checkGoogleAuth, async (req, res) => {
    const { timeMin, timeMax } = req.query;
    try {
        const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`;
        const response = await fetch(url, { headers: { Authorization: `Bearer ${req.user.accessToken}` } });
        const data = await response.json();
        if (data.error) return res.status(500).json(data.error);
        res.json(data.items || []);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/google/create-event', checkGoogleAuth, async (req, res) => {
    try {
        const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${req.user.accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body)
        });
        const data = await response.json();
        if (data.error) return res.status(500).json(data.error);
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/google/delete-event/:id', checkGoogleAuth, async (req, res) => {
    try {
        await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${req.params.id}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${req.user.accessToken}` }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// =================================================================
// --- 7. PAGAMENTOS ASAAS (WEBHOOK & ASSINATURAS) ---
// =================================================================

// CONFIGURAÇÃO API ASAAS
const ASAAS_URL = 'https://www.asaas.com/api/v3'; 
const ASAAS_API_KEY = process.env.ASAAS_API_KEY; 

const asaasApi = axios.create({
    baseURL: ASAAS_URL,
    headers: {
        'access_token': ASAAS_API_KEY,
        'Content-Type': 'application/json'
    }
});

// --- WEBHOOK (ONDE O DINHEIRO ENTRA) ---
app.post('/webhook/asaas', async (req, res) => {
    try {
        // 🔒 SEGURANÇA: Verifica se quem chamou foi o Asaas mesmo
        // O Asaas permite configurar um Header de autenticação no painel dele.
        // Se você configurou 'ASAAS_WEBHOOK_TOKEN' no Render, ele checa aqui.
        const receivedToken = req.headers['asaas-access-token'] || req.headers['access_token'];
        if (process.env.ASAAS_WEBHOOK_TOKEN && receivedToken !== process.env.ASAAS_WEBHOOK_TOKEN) {
            console.warn("⛔ Tentativa de Webhook falso bloqueada!");
            return res.status(401).json({ error: "Unauthorized" });
        }

        console.log('🔔 Webhook Asaas:', JSON.stringify(req.body, null, 2));
        const { event, payment } = req.body;

        if (event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED') {
            const firebaseUid = payment.externalReference;

            if (!firebaseUid) {
                console.warn('⚠️ Pagamento sem UID.');
                return res.status(200).json({ received: true });
            }

            if (db) {
                console.log(`✅ Pagamento Aprovado! Liberando: ${firebaseUid}`);
                await db.collection('users').doc(firebaseUid).update({
                    subscriptionStatus: 'active',
                    trialEndsAt: null,
                    planType: payment.value > 100 ? 'anual' : 'mensal',
                    lastPaymentId: payment.id,
                    lastPaymentDate: new Date().toISOString(),
                    status: 'paid'
                });
            }
        } 
        else if (event === 'PAYMENT_OVERDUE') {
            const firebaseUid = payment.externalReference;
            if (firebaseUid && db) {
                await db.collection('users').doc(firebaseUid).update({
                    subscriptionStatus: 'expired'
                });
                console.log(`🔒 Usuário ${firebaseUid} bloqueado por falta de pagamento.`);
            }
        }
        res.status(200).json({ received: true });
    } catch (error) {
        console.error('❌ Erro no Webhook:', error);
        res.status(500).send('Erro servidor');
    }
});

// --- CRIAR ASSINATURA ---
app.post('/api/create-subscription', async (req, res) => {
    try {
        const { uid, email, name, cpfCnpj, planType } = req.body;

        if (!uid || !email || !cpfCnpj || !planType) return res.status(400).json({ error: 'Dados incompletos.' });

        // CONFIGURAÇÃO DOS PLANOS (VALORES REAIS)
        const isAnual = planType === 'anual';
        const value = isAnual ? 345.60 : 32.00;
        const cycle = isAnual ? 'YEARLY' : 'MONTHLY';

        // 1. Busca ou Cria Cliente
        let customerId;
        try {
            const { data: searchData } = await asaasApi.get(`/customers?email=${email}`);
            if (searchData.data && searchData.data.length > 0) {
                customerId = searchData.data[0].id;
            }
        } catch (e) {}

        if (!customerId) {
            const { data: newCustomer } = await asaasApi.post('/customers', {
                name: name || 'Cliente FluxPro',
                email: email,
                cpfCnpj: cpfCnpj,
                externalReference: uid
            });
            customerId = newCustomer.id;
        }

        // 2. Cria Assinatura
        const { data: subscription } = await asaasApi.post('/subscriptions', {
            customer: customerId,
            billingType: 'UNDEFINED', 
            value: value,
            nextDueDate: new Date().toISOString().split('T')[0], 
            cycle: cycle, 
            description: `Assinatura FluxPro CRM (${isAnual ? 'Anual' : 'Mensal'})`,
            externalReference: uid 
        });

        // 3. Pega Link de Pagamento
        const { data: payments } = await asaasApi.get(`/payments?subscription=${subscription.id}`);
        const paymentLink = payments.data[0].invoiceUrl;

        res.json({ success: true, paymentUrl: paymentLink });

    } catch (error) {
        console.error('Erro criar assinatura:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Erro ao gerar pagamento.' });
    }
});

// --- CANCELAR ASSINATURA ---
app.post('/api/cancel-subscription', async (req, res) => {
    try {
        const { uid, email } = req.body;
        if (!uid || !email) return res.status(400).json({ error: 'Usuário inválido.' });

        const { data: searchData } = await asaasApi.get(`/customers?email=${email}`);
        if (!searchData.data.length) return res.status(404).json({ error: 'Cliente não encontrado.' });
        
        const customerId = searchData.data[0].id;
        const { data: subsData } = await asaasApi.get(`/subscriptions?customer=${customerId}&status=ACTIVE`);
        
        if (subsData.data.length > 0) {
            await asaasApi.delete(`/subscriptions/${subsData.data[0].id}`);
        }

        if (db) {
            await db.collection('users').doc(uid).update({
                subscriptionStatus: 'canceled',
                planType: 'free'
            });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao cancelar.' });
    }
});

// --- 8. START ---
server.listen(PORT, () => console.log(`✅ Servidor ON na porta ${PORT}`));