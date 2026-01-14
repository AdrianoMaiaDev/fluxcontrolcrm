const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const passport = require('passport');
const FacebookStrategy = require('passport-facebook').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const admin = require('firebase-admin'); // Adicionado Firebase

// --- 1. INICIALIZAR O APP (O "CARRO" TEM QUE VIR PRIMEIRO) ---
const app = express();
app.set('trust proxy', 1); // <--- ADICIONE ISSO (Obrigatório para Render/Heroku)
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = 'fluxpro_token_seguro';

// --- 2. CONFIGURAÇÃO DE SEGURANÇA E CORS ---
app.use(cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true
}));

app.use(bodyParser.json());

app.use(session({
    secret: 'fluxpro_segredo',
    resave: false,
    saveUninitialized: true
}));

app.use(passport.initialize());
app.use(passport.session());

// --- 3. CONFIGURAÇÃO DO FIREBASE (NOVA) ---
// O Truque: O Render guarda o JSON inteiro dentro de uma variável
if (process.env.FIREBASE_CREDENTIALS) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            // Se tiver URL de database, coloque aqui, senão pode deixar sem se for só Firestore
            // databaseURL: "https://SEU-PROJETO.firebaseio.com" 
        });
        console.log("🔥 Firebase Conectado!");
    } catch (error) {
        console.error("⚠️ Erro ao conectar Firebase:", error.message);
    }
} else {
    console.log("⚠️ Pulei o Firebase (Faltam credenciais no Render)");
}

// --- 4. SERIALIZAÇÃO DE USUÁRIO ---
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// --- 5. ESTRATÉGIAS DE LOGIN (FACEBOOK & GOOGLE) ---

// Variaveis de Ambiente
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID; 
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET; 
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
let PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN; 

// Estratégia Facebook
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

// Estratégia Google (CORRIGIDA PARA SALVAR TOKEN)
if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: "https://fluxcontrolcrm.onrender.com/auth/google/callback"
      },
      function(accessToken, refreshToken, profile, done) {
        // 👇 AQUI ESTAVA O ERRO: Precisamos passar o accessToken junto!
        return done(null, { profile, accessToken, refreshToken });
      }
    ));
}

// --- 6. SOCKET.IO ---
const io = new Server(server, { cors: { origin: "*" } });

// --- 7. ROTAS (AGORA SIM, POIS 'app' JÁ EXISTE) ---

// Rota de Teste Inicial
app.get('/', (req, res) => {
    res.send('FluxPro Backend Online! 🚀');
});

// Login Google
app.get('/auth/google', (req, res, next) => {
    if (!GOOGLE_CLIENT_ID) return res.send('Erro: Google Client ID não configurado no Render.');
    passport.authenticate('google', { scope: ['profile', 'email', 'https://www.googleapis.com/auth/calendar'] })(req, res, next);
});

app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login-falhou' }),
  function(req, res) {
    res.send('<script>window.opener.postMessage("login_google_sucesso", "*"); window.close();</script>');
  }
);

// Login Facebook
app.get('/auth/facebook', (req, res, next) => {
    if (!FACEBOOK_APP_ID) return res.send('Erro: Facebook App ID não configurado no Render.');
    if (req.query.socketId) req.session.socketId = req.query.socketId;
    passport.authenticate('facebook', { 
        scope: ['public_profile', 'pages_show_list', 'pages_messaging', 'instagram_basic', 'instagram_manage_messages']
    })(req, res, next);
});

app.get('/auth/facebook/callback', 
  passport.authenticate('facebook', { failureRedirect: '/login-falhou' }),
  async (req, res) => {
    const socketId = req.session.socketId;
    const userAccessToken = req.user.accessToken;

    if (socketId) {
        try {
            const pagesUrl = `https://graph.facebook.com/me/accounts?access_token=${userAccessToken}`;
            const response = await fetch(pagesUrl);
            const data = await response.json();

            if (data.data && data.data.length > 0) {
                const pagina = data.data[0]; 
                PAGE_ACCESS_TOKEN = pagina.access_token; 
                console.log("✅ Token da Página ATUALIZADO!");

                io.to(socketId).emit('login_sucesso', {
                    nomePagina: pagina.name,
                    usuario: req.user.profile.displayName
                });
            }
        } catch (error) { console.error("Erro token:", error); }
    }
    res.send('<script>window.close()</script>');
  }
);

// Webhook (Receber Mensagens)
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
            const evt = entry.messaging ? entry.messaging[0] : null;
            if (evt) {
                let txt = evt.message.text || (evt.message.attachments ? evt.message.attachments[0].payload.url : '');
                let type = evt.message.attachments ? evt.message.attachments[0].type : 'text';
                
                if (txt) {
                    const perfil = await getUserProfile(evt.sender.id);
                    io.emit('nova_mensagem', {
                        id: evt.sender.id, name: perfil.first_name, avatar: perfil.profile_pic,
                        text: txt, type: type, timestamp: new Date().toISOString(), ehMinha: false
                    });
                }
            }
        }
        res.status(200).send('EVENT_RECEIVED');
    } else { res.sendStatus(404); }
});

// API Enviar Mensagem
app.post('/api/enviar-instagram', async (req, res) => {
    const { recipientId, texto } = req.body;
    try {
        const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
        const body = { recipient: { id: recipientId }, message: { text: texto } };
        
        const response = await fetch(url, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(body) 
        });
        const data = await response.json();

        if (data.error) {
            console.error('❌ Erro Facebook:', data.error);
            return res.status(500).json({ error: data.error.message });
        }
        res.json({ success: true, id: data.message_id });
    } catch (error) {
        console.error('Erro Servidor:', error);
        res.status(500).json({ error: error.message });
    }
});

// --- 8. INICIAR SERVIDOR ---
server.listen(PORT, () => {
    console.log(`✅ Servidor rodando na porta ${PORT}`);
    console.log("---------------------------------------------------");
    console.log("FB ID:", process.env.FACEBOOK_APP_ID ? "OK" : "Faltando");
    console.log("Google ID:", process.env.GOOGLE_CLIENT_ID ? "OK" : "Faltando");
    console.log("Firebase:", process.env.FIREBASE_CREDENTIALS ? "OK (JSON Presente)" : "Faltando");
    console.log("---------------------------------------------------");
});