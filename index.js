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

// --- 1. CONFIGURAÇÕES ---
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
    secret: 'fluxpro_segredo', resave: false, saveUninitialized: false,
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

// --- 3. SOCKET.IO (COM SALAS PRIVADAS) ---
const io = new Server(server, { cors: { origin: "*" } });

io.on('connection', (socket) => {
    // O usuário entra na sala com o próprio ID do Firebase
    socket.on('entrar_sala_privada', (uid) => {
        if(uid) {
            socket.join(uid);
            console.log(`🔒 Socket ${socket.id} entrou na sala privada: ${uid}`);
        }
    });
});

// --- 4. ESTRATÉGIAS DE LOGIN ---
let GLOBAL_PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN; 

passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((u, d) => d(null, u));

// Facebook
if (process.env.FACEBOOK_APP_ID) {
    passport.use(new FacebookStrategy({
        clientID: process.env.FACEBOOK_APP_ID,
        clientSecret: process.env.FACEBOOK_APP_SECRET,
        callbackURL: 'https://fluxcontrolcrm.onrender.com/auth/facebook/callback',
        profileFields: ['id', 'displayName', 'photos', 'email'],
        passReqToCallback: true
    }, (req, token, r, profile, done) => done(null, { profile, accessToken: token })));
}

// Google
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

// --- 5. ROTAS FACEBOOK (COM VÍNCULO DE USUÁRIO) ---

// Iniciar Login (Captura o UID do usuário para vincular a página a ele)
app.get('/auth/facebook', (req, res, next) => {
    if (req.query.uid) req.session.uid = req.query.uid; 
    passport.authenticate('facebook', { scope: ['public_profile', 'pages_show_list', 'pages_messaging', 'instagram_basic', 'instagram_manage_messages'] })(req, res, next);
});

// Callback (Salva o Token e o Dono no Banco)
app.get('/auth/facebook/callback', 
  passport.authenticate('facebook', { failureRedirect: '/login-falhou' }),
  async (req, res) => {
    const userUid = req.session.uid; // Quem clicou no botão?

    try {
        const pagesUrl = `https://graph.facebook.com/me/accounts?access_token=${req.user.accessToken}`;
        const response = await fetch(pagesUrl);
        const data = await response.json();

        if (data.data && data.data.length > 0) {
            const pagina = data.data[0];
            
            // 1. Atualiza memória global (Fallback)
            GLOBAL_PAGE_TOKEN = pagina.access_token;

            // 2. Salva no Firebase com o DONO (Isso resolve o vazamento)
            const db = admin.firestore();
            
            // Salva na lista de páginas integradas (para o Webhook saber quem é o dono)
            await db.collection('integrated_pages').doc(pagina.id).set({
                ownerUid: userUid || 'admin_fallback', // Se não tiver UID, assume admin
                pageAccessToken: pagina.access_token,
                pageName: pagina.name,
                pageId: pagina.id,
                updatedAt: new Date().toISOString()
            });

            // Salva também no config global como backup
            await db.collection('config').doc('facebook_global').set({
                token: pagina.access_token,
                pageId: pagina.id
            });

            console.log(`✅ Página ${pagina.name} vinculada ao usuário ${userUid}`);
        }
    } catch (error) { console.error("Erro Login FB:", error); }
    
    res.send('<script>window.close()</script>');
  }
);

app.get('/api/facebook/status', (req, res) => {
    res.json({ connected: !!GLOBAL_PAGE_TOKEN });
});

// --- 6. WEBHOOK FACEBOOK (ROTEAMENTO INTELIGENTE) ---
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else { res.sendStatus(403); }
});

// Função para descobrir quem é o dono da página que recebeu a mensagem
async function getPageOwnerAndToken(pageId) {
    try {
        const doc = await admin.firestore().collection('integrated_pages').doc(pageId).get();
        if (doc.exists) return doc.data(); // Retorna { ownerUid, pageAccessToken }
    } catch(e) { console.error("Erro ao buscar dono da página:", e); }
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

app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (body.object === 'page' || body.object === 'instagram') {
        for (const entry of body.entry) {
            
            // 🔥 AQUI ESTÁ A MÁGICA: Descobre o dono da página
            const pageId = entry.id;
            const pageConfig = await getPageOwnerAndToken(pageId);
            
            // Se não achou dono, tenta usar o global (Modo Resgate/Admin)
            const tokenParaUsar = pageConfig ? pageConfig.pageAccessToken : GLOBAL_PAGE_TOKEN;
            const uidParaEnviar = pageConfig ? pageConfig.ownerUid : null;

            const evt = entry.messaging ? entry.messaging[0] : null;
            if (evt && evt.message) {
                let txt = evt.message.text || (evt.message.attachments ? evt.message.attachments[0].payload.url : '');
                let type = evt.message.attachments ? evt.message.attachments[0].type : 'text';
                
                if (txt && !evt.message.is_echo) { 
                    const perfil = await getUserProfile(evt.sender.id, tokenParaUsar);
                    
                    const msgData = {
                        id: evt.sender.id, name: perfil.first_name, avatar: perfil.profile_pic,
                        text: txt, type: type, timestamp: new Date().toISOString(), ehMinha: false
                    };

                    if (uidParaEnviar) {
                        // 🔒 Envia SÓ para o dono (Privacidade)
                        io.to(uidParaEnviar).emit('nova_mensagem', msgData);
                        console.log(`📨 Msg entregue para sala privada: ${uidParaEnviar}`);
                    } else {
                        // 📢 Fallback: Se não tem dono cadastrado, manda pra todos (Admin vê tudo)
                        io.emit('nova_mensagem', msgData);
                        console.log(`📨 Msg sem dono específico, enviada no global.`);
                    }
                }
            }
        }
        res.status(200).send('EVENT_RECEIVED');
    } else { res.sendStatus(404); }
});

// --- 7. API ENVIAR (Busca token no banco) ---
app.post('/api/enviar-instagram', async (req, res) => {
    const { recipientId, texto } = req.body;
    
    // Tenta achar token no banco (Prioridade) ou usa global
    let token = GLOBAL_PAGE_TOKEN;
    
    // Tenta recuperar do banco se a memória falhar
    if (!token) {
        try {
            const db = admin.firestore();
            // Pega o primeiro token válido que achar (Simplificação para envio rápido)
            const snapshot = await db.collection('integrated_pages').limit(1).get();
            if (!snapshot.empty) token = snapshot.docs[0].data().pageAccessToken;
            
            // Se ainda não achou, tenta o config global
            if (!token) {
                const doc = await db.collection('config').doc('facebook_global').get();
                if (doc.exists) token = doc.data().token;
            }
            
            if (token) GLOBAL_PAGE_TOKEN = token; // Recupera memória
        } catch(e) { console.error(e); }
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

// --- 8. ROTAS GOOGLE (Mantidas) ---
app.get('/auth/google', (req, res, next) => {
    passport.authenticate('google', { scope: ['profile', 'email', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'], accessType: 'offline', prompt: 'consent' })(req, res, next);
});
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login-falhou' }), (req, res) => { res.send(`<html><body><script>if(window.opener){window.opener.postMessage("login_google_sucesso","*");}window.close();</script></body></html>`); });
const checkGoogleAuth = (req, res, next) => { if (req.user && req.user.accessToken) return next(); res.status(401).json({ error: 'Não conectado' }); };
app.get('/api/google/status', (req, res) => { res.json({ connected: !!(req.user && req.user.accessToken) }); });
app.get('/api/google/events', checkGoogleAuth, async (req, res) => {
    try { const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${req.query.timeMin}&timeMax=${req.query.timeMax}&singleEvents=true&orderBy=startTime`, { headers: { Authorization: `Bearer ${req.user.accessToken}` } }); const d = await r.json(); res.json(d.items || []); } catch (e) { res.status(500).json(e); }
});
app.post('/api/google/create-event', checkGoogleAuth, async (req, res) => {
    try { const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`, { method: 'POST', headers: { 'Authorization': `Bearer ${req.user.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) }); const d = await r.json(); res.json(d); } catch (e) { res.status(500).json(e); }
});
app.delete('/api/google/delete-event/:id', checkGoogleAuth, async (req, res) => {
    try { await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${req.params.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${req.user.accessToken}` } }); res.json({ success: true }); } catch (e) { res.status(500).json(e); }
});

// --- START ---
server.listen(PORT, () => console.log(`✅ Server Blindado na porta ${PORT}`));