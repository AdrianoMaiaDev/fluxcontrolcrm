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

// --- 1. INICIALIZAR O APP ---
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = 'fluxpro_token_seguro';

// --- 2. CONFIGURAÇÃO DE SEGURANÇA E CORS ---
app.set('trust proxy', 1); // Obrigatório para Render/Heroku

app.use(cors({
    origin: true, // Aceita qualquer origem (necessário para extensão)
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true // Permite cookies de sessão
}));

app.use(bodyParser.json());

app.use(session({
    secret: 'fluxpro_segredo',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true, // True porque o Render usa HTTPS
        sameSite: 'none', // Importante para o Chrome aceitar o cookie na extensão
        maxAge: 24 * 60 * 60 * 1000 // 24 horas
    }
}));

app.use(passport.initialize());
app.use(passport.session());

// --- 3. CONFIGURAÇÃO DO FIREBASE ---
if (process.env.FIREBASE_CREDENTIALS) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        // Verifica se já existe app inicializado para evitar erro de duplicidade
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log("🔥 Firebase Conectado!");
        }
    } catch (error) {
        console.error("⚠️ Erro ao conectar Firebase:", error.message);
    }
} else {
    console.log("⚠️ Pulei o Firebase (Faltam credenciais no Render)");
}

// --- 4. SERIALIZAÇÃO DE USUÁRIO ---
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// --- 5. ESTRATÉGIAS DE LOGIN ---
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID; 
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET; 
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
let PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN; 

if (FACEBOOK_APP_ID && FACEBOOK_APP_SECRET) {
    passport.use(new FacebookStrategy({
        clientID: FACEBOOK_APP_ID,
        clientSecret: FACEBOOK_APP_SECRET,
        callbackURL: 'https://fluxcontrolcrm.onrender.com/auth/facebook/callback',
        profileFields: ['id', 'displayName', 'photos', 'email'],
        passReqToCallback: true
      },
      function(req, accessToken, refreshToken, profile, done) {
        return done(null, { profile, accessToken });
      }
    ));
}

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: "https://fluxcontrolcrm.onrender.com/auth/google/callback"
      },
      function(accessToken, refreshToken, profile, done) {
        // Salva tokens na sessão
        return done(null, { profile, accessToken, refreshToken });
      }
    ));
}

// --- 6. SOCKET.IO ---
const io = new Server(server, { cors: { origin: "*" } });

// --- 7. ROTAS GERAIS ---
app.get('/', (req, res) => { res.send('FluxPro Backend Online! 🚀'); });

// --- 8. ROTAS DE AUTENTICAÇÃO ---

// Google
app.get('/auth/google', (req, res, next) => {
    passport.authenticate('google', { 
        scope: ['profile', 'email', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'] 
    })(req, res, next);
});

app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login-falhou' }),
  function(req, res) {
    res.send(`
      <html>
        <head>
          <title>Conectado!</title>
          <style>
            body { font-family: sans-serif; background: #111b21; color: white; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; text-align: center; }
            .btn { background: #00FF67; color: black; border: none; padding: 12px 25px; border-radius: 25px; font-weight: bold; cursor: pointer; margin-top: 30px; text-decoration: none; font-size: 16px; }
          </style>
        </head>
        <body>
          <h1>✅ Google Conectado!</h1>
          <p>Você pode fechar esta janela e voltar ao WhatsApp.</p>
          <p style="font-size:12px; color:#888;">(Se o botão verde não apareceu na extensão, clique abaixo)</p>
          <button class="btn" onclick="window.close()">Fechar Janela</button>
          <script>
            if(window.opener) { window.opener.postMessage("login_google_sucesso", "*"); }
          </script>
        </body>
      </html>
    `);
  }
);

// Facebook
app.get('/auth/facebook', (req, res, next) => {
    if (req.query.socketId) req.session.socketId = req.query.socketId;
    passport.authenticate('facebook', { scope: ['public_profile', 'pages_show_list', 'pages_messaging', 'instagram_basic', 'instagram_manage_messages'] })(req, res, next);
});

app.get('/auth/facebook/callback', 
  passport.authenticate('facebook', { failureRedirect: '/login-falhou' }),
  async (req, res) => {
    const socketId = req.session.socketId;
    if (socketId) {
        try {
            const pagesUrl = `https://graph.facebook.com/me/accounts?access_token=${req.user.accessToken}`;
            const response = await fetch(pagesUrl);
            const data = await response.json();
            if (data.data && data.data.length > 0) {
                PAGE_ACCESS_TOKEN = data.data[0].access_token; 
                io.to(socketId).emit('login_sucesso', { nomePagina: data.data[0].name });
            }
        } catch (error) { console.error("Erro token:", error); }
    }
    res.send('<script>window.close()</script>');
  }
);

// --- 9. WEBHOOK (INSTAGRAM/FACEBOOK) ---
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else { res.sendStatus(403); }
});

async function getUserProfile(psid) {
    try {
        const url = `https://graph.facebook.com/v21.0/${psid}?fields=name,profile_pic&access_token=${PAGE_ACCESS_TOKEN}`;
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
            const webhook_event = entry.messaging ? entry.messaging[0] : null;
            if (webhook_event && webhook_event.message) {
                let txt = webhook_event.message.text || (webhook_event.message.attachments ? webhook_event.message.attachments[0].payload.url : '');
                let type = webhook_event.message.attachments ? webhook_event.message.attachments[0].type : 'text';
                
                if (txt) {
                    const perfil = await getUserProfile(webhook_event.sender.id);
                    io.emit('nova_mensagem', {
                        id: webhook_event.sender.id, name: perfil.first_name, avatar: perfil.profile_pic,
                        text: txt, type: type, timestamp: new Date().toISOString(), ehMinha: false
                    });
                }
            }
        }
        res.status(200).send('EVENT_RECEIVED');
    } else { res.sendStatus(404); }
});

app.post('/api/enviar-instagram', async (req, res) => {
    const { recipientId, texto } = req.body;
    try {
        const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
        const response = await fetch(url, { 
            method: 'POST', headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ recipient: { id: recipientId }, message: { text: texto } }) 
        });
        const data = await response.json();
        if (data.error) return res.status(500).json({ error: data.error.message });
        res.json({ success: true, id: data.message_id });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- 10. API GOOGLE CALENDAR (Backend Proxy) ---
const checkGoogleAuth = (req, res, next) => {
    if (req.user && req.user.accessToken) return next();
    res.status(401).json({ error: 'Não conectado ao Google' });
};

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

// --- 11. START ---
server.listen(PORT, () => console.log(`✅ Rodando na porta ${PORT}`));