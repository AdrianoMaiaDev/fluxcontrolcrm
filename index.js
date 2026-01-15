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

// --- 3. SOCKET.IO (MODO HÍBRIDO) ---
const io = new Server(server, { cors: { origin: "*" } });

io.on('connection', (socket) => {
    console.log("⚡ Socket conectado:", socket.id);
    // Aceita entrar na sala, mas também vamos mandar no global
    socket.on('entrar_sala_privada', (uid) => { if(uid) socket.join(uid); });
});

// --- 4. ESTRATÉGIAS DE LOGIN (FACEBOOK & GOOGLE) ---
let GLOBAL_PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN; 

passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((u, d) => d(null, u));

// Estratégia Facebook
if (process.env.FACEBOOK_APP_ID) {
    passport.use(new FacebookStrategy({
        clientID: process.env.FACEBOOK_APP_ID,
        clientSecret: process.env.FACEBOOK_APP_SECRET,
        callbackURL: 'https://fluxcontrolcrm.onrender.com/auth/facebook/callback',
        profileFields: ['id', 'displayName', 'photos', 'email'],
        passReqToCallback: true
    }, (req, token, r, profile, done) => done(null, { profile, accessToken: token })));
}

// Estratégia Google (REINSERIDA AQUI)
if (process.env.GOOGLE_CLIENT_ID) {
    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: "https://fluxcontrolcrm.onrender.com/auth/google/callback"
      },
      function(accessToken, refreshToken, profile, done) {
        // Salva tokens na sessão
        return done(null, { profile, accessToken, refreshToken });
      }
    ));
}

// --- 5. ROTAS FACEBOOK ---

// Rota de Login FB
app.get('/auth/facebook', passport.authenticate('facebook', { scope: ['public_profile', 'pages_show_list', 'pages_messaging', 'instagram_basic', 'instagram_manage_messages'] }));

// Callback FB
app.get('/auth/facebook/callback', 
  passport.authenticate('facebook', { failureRedirect: '/login-falhou' }),
  async (req, res) => {
    try {
        const pagesUrl = `https://graph.facebook.com/me/accounts?access_token=${req.user.accessToken}`;
        const response = await fetch(pagesUrl);
        const data = await response.json();

        if (data.data && data.data.length > 0) {
            const pagina = data.data[0];
            
            // 1. Atualiza a variável GLOBAL
            GLOBAL_PAGE_TOKEN = pagina.access_token;
            console.log("✅ Token Global Atualizado via Login:", pagina.name);

            // 2. Tenta salvar no Firebase (Backup)
            try {
                await admin.firestore().collection('config').doc('facebook_global').set({
                    token: pagina.access_token,
                    pageId: pagina.id,
                    updatedAt: new Date().toISOString()
                });
            } catch(e) {}
        }
    } catch (error) { console.error("Erro Login FB:", error); }
    res.send('<script>window.close()</script>');
  }
);

// Status FB
app.get('/api/facebook/status', (req, res) => {
    res.json({ connected: !!GLOBAL_PAGE_TOKEN });
});

// --- 6. WEBHOOK FACEBOOK (MODO MEGAFONE) ---
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else { res.sendStatus(403); }
});

async function getUserProfile(psid) {
    try {
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
                
                if (txt && !evt.message.is_echo) { 
                    const perfil = await getUserProfile(evt.sender.id);
                    // Manda para TODOS (Megafone)
                    io.emit('nova_mensagem', {
                        id: evt.sender.id, name: perfil.first_name, avatar: perfil.profile_pic,
                        text: txt, type: type, timestamp: new Date().toISOString(), ehMinha: false
                    });
                    console.log(`📨 Msg de ${perfil.first_name} (Megafone)`);
                }
            }
        }
        res.status(200).send('EVENT_RECEIVED');
    } else { res.sendStatus(404); }
});

// --- 7. API ENVIAR FACEBOOK (COM RECUPERAÇÃO DE TOKEN) ---
app.post('/api/enviar-instagram', async (req, res) => {
    const { recipientId, texto } = req.body;
    console.log(`📤 Enviando para ${recipientId}: "${texto}"`);

    let token = GLOBAL_PAGE_TOKEN;

    if (!token) {
        console.log("⚠️ Memória vazia. Buscando no Firebase...");
        try {
            const db = admin.firestore();
            let doc = await db.collection('config').doc('facebook_global').get();
            if (doc.exists) token = doc.data().token;
            
            // Backup extra: pega de integrated_pages se não achar no global
            if (!token) {
                const snapshot = await db.collection('integrated_pages').limit(1).get();
                if (!snapshot.empty) token = snapshot.docs[0].data().pageAccessToken;
            }

            if (token) {
                GLOBAL_PAGE_TOKEN = token;
                console.log("✅ Token recuperado!");
            }
        } catch(e) { console.error("Erro busca token:", e); }
    }

    if (!token) return res.status(500).json({ error: "Servidor sem token." });

    try {
        const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${token}`;
        const response = await fetch(url, { 
            method: 'POST', headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ recipient: { id: recipientId }, message: { text: texto } }) 
        });
        const data = await response.json();
        if (data.error) return res.status(500).json({ error: `FB Error: ${data.error.message}` });
        
        console.log("✅ Enviado! ID:", data.message_id);
        res.json({ success: true, id: data.message_id });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// =================================================================
// --- 8. ROTAS GOOGLE CALENDAR (REINSERIDAS AQUI) ---
// =================================================================

// Login Google
app.get('/auth/google', (req, res, next) => {
    passport.authenticate('google', { 
        scope: ['profile', 'email', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'],
        accessType: 'offline', // Pede Refresh Token (Token Eterno)
        prompt: 'consent'
    })(req, res, next);
});

// Callback Google
app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login-falhou' }),
  function(req, res) {
    // Manda script para fechar janela e avisar o frontend
    res.send(`<html><body><script>if(window.opener){window.opener.postMessage("login_google_sucesso","*");}window.close();</script></body></html>`);
  }
);

// Middleware de Segurança Google
const checkGoogleAuth = (req, res, next) => {
    if (req.user && req.user.accessToken) return next();
    res.status(401).json({ error: 'Não conectado ao Google' });
};

// Status Google (Polling)
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

// --- 9. START ---
server.listen(PORT, () => console.log(`✅ Servidor Completo (FB+Google) na porta ${PORT}`));