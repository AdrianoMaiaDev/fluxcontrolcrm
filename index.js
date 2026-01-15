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
app.use(cors({ origin: true, methods: ["GET", "POST", "DELETE", "OPTIONS"], credentials: true }));
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
    } catch (e) { console.error("Erro Firebase:", e); }
}

// --- 3. SOCKET.IO (MODO HÍBRIDO) ---
const io = new Server(server, { cors: { origin: "*" } });

io.on('connection', (socket) => {
    console.log("⚡ Socket conectado:", socket.id);
    // Aceita entrar na sala, mas também vamos mandar no global
    socket.on('entrar_sala_privada', (uid) => { if(uid) socket.join(uid); });
});

// --- 4. LOGIN FACEBOOK (SIMPLIFICADO) ---
let GLOBAL_PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN; // Começa com o da variável de ambiente

passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((u, d) => d(null, u));

if (process.env.FACEBOOK_APP_ID) {
    passport.use(new FacebookStrategy({
        clientID: process.env.FACEBOOK_APP_ID,
        clientSecret: process.env.FACEBOOK_APP_SECRET,
        callbackURL: 'https://fluxcontrolcrm.onrender.com/auth/facebook/callback',
        profileFields: ['id', 'displayName', 'photos', 'email'],
        passReqToCallback: true
    }, (req, token, r, profile, done) => done(null, { profile, accessToken: token })));
}

// Rota de Login
app.get('/auth/facebook', passport.authenticate('facebook', { scope: ['public_profile', 'pages_show_list', 'pages_messaging', 'instagram_basic', 'instagram_manage_messages'] }));

// Callback (Restaura o Token Global)
app.get('/auth/facebook/callback', 
  passport.authenticate('facebook', { failureRedirect: '/login-falhou' }),
  async (req, res) => {
    try {
        const pagesUrl = `https://graph.facebook.com/me/accounts?access_token=${req.user.accessToken}`;
        const response = await fetch(pagesUrl);
        const data = await response.json();

        if (data.data && data.data.length > 0) {
            const pagina = data.data[0];
            
            // 1. Atualiza a variável GLOBAL (para funcionar o envio IMEDIATO)
            GLOBAL_PAGE_TOKEN = pagina.access_token;
            console.log("✅ Token Global Atualizado via Login:", pagina.name);

            // 2. Tenta salvar no Firebase para garantir (Backup)
            try {
                await admin.firestore().collection('config').doc('facebook_global').set({
                    token: pagina.access_token,
                    pageId: pagina.id,
                    updatedAt: new Date().toISOString()
                });
            } catch(e) {}
        }
    } catch (error) { console.error("Erro Login FB:", error); }
    
    // Manda fechar a janela (o polling do front vai pegar o status depois)
    res.send('<script>window.close()</script>');
  }
);

// Rota de Status (Diz SIM se tiver qualquer token global)
app.get('/api/facebook/status', (req, res) => {
    res.json({ connected: !!GLOBAL_PAGE_TOKEN });
});

// --- 5. WEBHOOK (MODO MEGAFONE - VOLTA A FUNCIONAR COMO ANTES) ---
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else { res.sendStatus(403); }
});

// Função Auxiliar de Perfil
async function getUserProfile(psid) {
    try {
        // Usa o token global
        const url = `https://graph.facebook.com/v21.0/${psid}?fields=name,profile_pic&access_token=${GLOBAL_PAGE_TOKEN}`;
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
            const evt = entry.messaging ? entry.messaging[0] : null;
            if (evt && evt.message) {
                let txt = evt.message.text || (evt.message.attachments ? evt.message.attachments[0].payload.url : '');
                let type = evt.message.attachments ? evt.message.attachments[0].type : 'text';
                
                if (txt && !evt.message.is_echo) { // Ignora msg enviada pela própria página
                    const perfil = await getUserProfile(evt.sender.id);
                    
                    // 📢 MODO MEGAFONE: Manda para TODO MUNDO (io.emit)
                    // Isso garante que você recebe, não importa o UID
                    io.emit('nova_mensagem', {
                        id: evt.sender.id,
                        name: perfil.first_name,
                        avatar: perfil.profile_pic,
                        text: txt,
                        type: type,
                        timestamp: new Date().toISOString(),
                        ehMinha: false
                    });
                    console.log(`📨 Mensagem recebida de ${perfil.first_name} (Enviada para todos)`);
                }
            }
        }
        res.status(200).send('EVENT_RECEIVED');
    } else { res.sendStatus(404); }
});

// --- 6. API ENVIAR (MODO GLOBAL) ---
app.post('/api/enviar-instagram', async (req, res) => {
    const { recipientId, texto } = req.body;
    
    // 1. Tenta usar a variável global
    let token = GLOBAL_PAGE_TOKEN;

    // 2. Se a variável estiver vazia (crashou), tenta ler do Firebase Backup
    if (!token) {
        try {
            const doc = await admin.firestore().collection('config').doc('facebook_global').get();
            if (doc.exists) token = doc.data().token;
        } catch(e) {}
    }

    if (!token) return res.status(500).json({ error: "Servidor sem token conectado." });

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

// (MANTENHA AS ROTAS DO GOOGLE AQUI EMBAIXO IGUAL ESTAVA)
// ... Copie suas rotas do Google Calendar aqui ...
// app.get('/auth/google'...) etc

server.listen(PORT, () => console.log(`✅ Modo Resgate Online na porta ${PORT}`));