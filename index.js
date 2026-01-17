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

// --- 1. CONFIGURAÇÕES BÁSICAS ---
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = 'fluxpro_token_seguro';

app.set('trust proxy', 1);
app.use(cors({
    origin: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}));
app.use(bodyParser.json());
app.use(session({
    secret: 'fluxpro_segredo',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true, sameSite: 'none', maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

// --- 2. FIREBASE ---
if (process.env.FIREBASE_CREDENTIALS) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log("🔥 Firebase Conectado!");
    } catch (e) { console.error("Erro Firebase:", e); }
}

// --- 3. SOCKET.IO ---
const io = new Server(server, { cors: { origin: "*" } });
io.on('connection', (socket) => {
    // Entra na sala privada com o UID do usuário
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

// Iniciar Login Facebook (Salva UID na sessão)
app.get('/auth/facebook', (req, res, next) => {
    if (req.query.uid) req.session.uid = req.query.uid; 
    passport.authenticate('facebook', { scope: ['public_profile', 'pages_show_list', 'pages_messaging', 'instagram_basic', 'instagram_manage_messages'] })(req, res, next);
});

// Callback Facebook
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
            GLOBAL_PAGE_TOKEN = pagina.access_token; // Atualiza memória

            // Salva vínculo (Página -> Usuário) no Banco
            const db = admin.firestore();
            await db.collection('integrated_pages').doc(pagina.id).set({
                ownerUid: userUid || 'admin_fallback',
                pageAccessToken: pagina.access_token,
                pageName: pagina.name,
                pageId: pagina.id,
                updatedAt: new Date().toISOString()
            });
            
            // Backup Global
            await db.collection('config').doc('facebook_global').set({
                token: pagina.access_token,
                pageId: pagina.id
            });
        }
    } catch (error) { console.error("Erro Login FB:", error); }
    res.send('<script>window.close()</script>');
  }
);

app.get('/api/facebook/status', (req, res) => {
    res.json({ connected: !!GLOBAL_PAGE_TOKEN });
});

// WEBHOOK VERIFICAÇÃO
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else { res.sendStatus(403); }
});

// Helpers
async function getPageOwnerAndToken(pageId) {
    try {
        const doc = await admin.firestore().collection('integrated_pages').doc(pageId).get();
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

// WEBHOOK RECEBIMENTO
app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'page' || body.object === 'instagram') {
        for (const entry of body.entry) {
            
            // Descobre o dono da página para enviar só pra ele
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
                        messageId: evt.message.mid // <--- ID para evitar duplicidade
                    };

                    if (uidParaEnviar) {
                        io.to(uidParaEnviar).emit('nova_mensagem', msgData); // Envia Privado
                    } else {
                        io.emit('nova_mensagem', msgData); // Envia Global (Fallback)
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

    // Tenta recuperar token do banco se a memória falhar
    if (!token) {
        try {
            const db = admin.firestore();
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
        
        // Retorna o ID da mensagem para o front salvar igual e não duplicar
        res.json({ success: true, id: data.message_id });

    } catch (error) { res.status(500).json({ error: error.message }); }
});

// =================================================================
// --- 6. ROTAS GOOGLE CALENDAR (AGORA ESTÃO TODAS AQUI) ---
// =================================================================

// Login Google
app.get('/auth/google', (req, res, next) => {
    passport.authenticate('google', { 
        scope: ['profile', 'email', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'],
        accessType: 'offline', 
        prompt: 'consent'
    })(req, res, next);
});

// Callback Google
app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login-falhou' }),
  function(req, res) {
    res.send(`<html><body><script>if(window.opener){window.opener.postMessage("login_google_sucesso","*");}window.close();</script></body></html>`);
  }
);

// Middleware
const checkGoogleAuth = (req, res, next) => {
    if (req.user && req.user.accessToken) return next();
    res.status(401).json({ error: 'Não conectado ao Google' });
};

// Status
app.get('/api/google/status', (req, res) => {
    res.json({ connected: !!(req.user && req.user.accessToken) });
});

// Listar Eventos
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

// Criar Evento
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

// Deletar Evento
app.delete('/api/google/delete-event/:id', checkGoogleAuth, async (req, res) => {
    try {
        await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${req.params.id}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${req.user.accessToken}` }
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// Você precisa baixar a chave privada do Firebase (arquivo .json)
// Vá em: Configurações do Projeto > Contas de Serviço > Gerar nova chave privada
const serviceAccount = require('/etc/secrets/serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// --- 2. A Rota do Webhook (Onde o Asaas vai bater) ---
app.post('/webhook/asaas', async (req, res) => {
    try {
        // Log para você ver o que está chegando (útil para debug)
        console.log('🔔 Webhook Asaas Recebido:', JSON.stringify(req.body, null, 2));

        const { event, payment } = req.body;

        // O Asaas manda vários eventos (criado, vencido, etc).
        // Só nos interessa quando o dinheiro cai na conta.
        if (event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED') {
            
            // O "externalReference" é onde guardamos o UID do usuário quando criamos a cobrança
            const firebaseUid = payment.externalReference;

            if (!firebaseUid) {
                console.warn('⚠️ Pagamento recebido sem UID (externalReference). Ignorando automação.');
                // Retornamos 200 pro Asaas parar de tentar, mesmo que não tenha servido pra nós
                return res.status(200).json({ received: true });
            }

            console.log(`✅ Pagamento Aprovado! Liberando acesso para UID: ${firebaseUid}`);

            // ATUALIZAÇÃO NO FIREBASE (A Mágica Acontece Aqui)
            await db.collection('users').doc(firebaseUid).update({
                subscriptionStatus: 'active', // Isso libera o React imediatamente
                trialEndsAt: null,            // Remove a trava de data
                planType: payment.value > 100 ? 'anual' : 'mensal', // Detecta plano pelo valor
                lastPaymentId: payment.id,
                lastPaymentDate: new Date().toISOString(),
                status: 'paid'
            });

            console.log(`🔓 Usuário ${firebaseUid} desbloqueado com sucesso.`);
        } 
        
        else if (event === 'PAYMENT_OVERDUE') {
            // Opcional: Se o pagamento atrasar ou vencer, você pode bloquear de novo
            const firebaseUid = payment.externalReference;
            if (firebaseUid) {
                await db.collection('users').doc(firebaseUid).update({
                    subscriptionStatus: 'expired' // Isso vai travar o React de novo
                });
                console.log(`🔒 Usuário ${firebaseUid} bloqueado por falta de pagamento.`);
            }
        }

        // Sempre responda 200 OK para o Asaas saber que você recebeu
        res.status(200).json({ received: true });

    } catch (error) {
        console.error('❌ Erro crítico no Webhook:', error);
        // Se der erro no SEU servidor, mande 500 para o Asaas tentar de novo mais tarde
        res.status(500).send('Erro interno no servidor');
    }
});

const axios = require('axios');

// --- CONFIGURAÇÃO ASAAS ---
// Para testes use: 'https://sandbox.asaas.com/api/v3'
// Para produção use: 'https://www.asaas.com/api/v3'
const ASAAS_URL = 'https://www.asaas.com/api/v3'; 
const ASAAS_API_KEY = process.env.ASAAS_API_KEY; // <--- COLE SUA CHAVE API DO ASAAS AQUI (Começa com $aact)

// Configuração padrão do Axios para não repetir cabeçalhos
const asaasApi = axios.create({
    baseURL: ASAAS_URL,
    headers: {
        'access_token': ASAAS_API_KEY,
        'Content-Type': 'application/json'
    }
});

// --- ROTA: CRIAR ASSINATURA ---
app.post('/api/create-subscription', async (req, res) => {
    try {
        const { uid, email, name, cpfCnpj, planType } = req.body;

        if (!uid || !email || !cpfCnpj || !planType) {
            return res.status(400).json({ error: 'Dados incompletos (uid, email, cpf, planType).' });
        }

        // Definir valores conforme seu plano
        // Mensal: R$ 32,00 | Anual: R$ 345,60
        const isAnual = planType === 'anual';
        const value = isAnual ? 345.60 : 1.00;
        const cycle = isAnual ? 'YEARLY' : 'MONTHLY';

        // 1. Verificar se o cliente já existe no Asaas (para não duplicar)
        let customerId;
        try {
            const { data: searchData } = await asaasApi.get(`/customers?email=${email}`);
            if (searchData.data && searchData.data.length > 0) {
                customerId = searchData.data[0].id;
                console.log(`Cliente Asaas encontrado: ${customerId}`);
            }
        } catch (e) {
            console.log('Cliente não encontrado, criando novo...');
        }

        // 2. Se não existir, cria o cliente no Asaas
        if (!customerId) {
            const { data: newCustomer } = await asaasApi.post('/customers', {
                name: name || 'Usuário FluxPro',
                email: email,
                cpfCnpj: cpfCnpj, // Asaas exige CPF/CNPJ para emitir boleto/pix
                externalReference: uid // Vincula o Cliente ao UID também
            });
            customerId = newCustomer.id;
            console.log(`Novo cliente criado: ${customerId}`);
        }

        // 3. Criar a Assinatura
        const { data: subscription } = await asaasApi.post('/subscriptions', {
            customer: customerId,
            billingType: 'UNDEFINED', // Deixa o usuário escolher (PIX, Boleto ou Cartão) na tela de pagamento
            value: value,
            nextDueDate: new Date().toISOString().split('T')[0], // Cobra hoje
            cycle: cycle, // MONTHLY ou YEARLY
            description: `Assinatura FluxPro CRM (${isAnual ? 'Anual' : 'Mensal'})`,
            externalReference: uid // <--- O SEGREDO: Aqui vai o ID do Firebase para o Webhook ler depois
        });

        console.log(`Assinatura criada: ${subscription.id} para UID: ${uid}`);

        // Retorna o link de pagamento para o Frontend
        // O Asaas geralmente retorna 'invoiceUrl' na criação da assinatura ou da primeira cobrança gerada
        // Para simplificar, vamos pegar a URL da fatura gerada automaticamente
        
        // Pequeno delay para garantir que a cobrança foi gerada
        // (Às vezes a assinatura cria a cobrança milissegundos depois)
        
        // Opção robusta: Buscar a cobrança pendente dessa assinatura
        const { data: payments } = await asaasApi.get(`/payments?subscription=${subscription.id}`);
        const paymentLink = payments.data[0].invoiceUrl;

        res.json({ 
            success: true, 
            paymentUrl: paymentLink 
        });

    } catch (error) {
        console.error('Erro ao criar assinatura:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Erro ao gerar pagamento no Asaas.' });
    }
});

// --- 7. START ---
server.listen(PORT, () => console.log(`✅ Servidor Completo e Corrigido na porta ${PORT}`));