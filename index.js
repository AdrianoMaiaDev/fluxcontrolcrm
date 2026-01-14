const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const passport = require('passport');
const FacebookStrategy = require('passport-facebook').Strategy;

// --- CONFIGURAÇÕES FIXAS ---
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = 'fluxpro_token_seguro';

// 👇 DADOS DO SEU APP (MANTENHA OS SEUS AQUI)
const FACEBOOK_APP_ID = '1732611531029371'; 
const FACEBOOK_APP_SECRET = '108d6d12657987a35b4ab9a63001359e'; 
const CALLBACK_URL = 'https://fluxcontrolcrm.onrender.com/auth/facebook/callback';

// 👇 VARIÁVEL DINÂMICA (COMEÇA COM O SEU FIXO, MAS MUDA NO LOGIN)
let PAGE_ACCESS_TOKEN = 'COLE_SEU_TOKEN_FIXO_AQUI_COMO_BACKUP'; 

const app = express();
const server = http.createServer(app);

// Configuração do CORS (CORRIGIDA)
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

passport.use(new FacebookStrategy({
    clientID: FACEBOOK_APP_ID,
    clientSecret: FACEBOOK_APP_SECRET,
    callbackURL: CALLBACK_URL,
    profileFields: ['id', 'displayName', 'photos', 'email'],
    passReqToCallback: true
  },
  function(req, accessToken, refreshToken, profile, done) {
    return done(null, { profile, accessToken });
  }
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

const io = new Server(server, { cors: { origin: "*" } });

// --- ROTA DE LOGIN (ATUALIZA O TOKEN) ---
app.get('/auth/facebook', (req, res, next) => {
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
            // Busca as páginas
            const pagesUrl = `https://graph.facebook.com/me/accounts?access_token=${userAccessToken}`;
            const response = await fetch(pagesUrl);
            const data = await response.json();

            if (data.data && data.data.length > 0) {
                const pagina = data.data[0]; 
                
                // 👇 A MÁGICA: ATUALIZA O TOKEN DO SISTEMA COM O TOKEN NOVO
                PAGE_ACCESS_TOKEN = pagina.access_token; 
                console.log("✅ Token da Página ATUALIZADO com sucesso!");

                io.to(socketId).emit('login_sucesso', {
                    nomePagina: pagina.name,
                    usuario: req.user.profile.displayName
                });
            }
        } catch (error) { console.error("Erro token:", error); }
    }
    
    // Fecha a janela
    res.send('<script>window.close()</script>');
  }
);

// --- FUNÇÕES AUXILIARES ---
async function getUserProfile(psid) {
    // Usa a variável PAGE_ACCESS_TOKEN que agora pode ter sido atualizada pelo login
    try {
        const url = `https://graph.facebook.com/v21.0/${psid}?fields=name,profile_pic&access_token=${PAGE_ACCESS_TOKEN}`;
        const response = await fetch(url);
        const data = await response.json();
        if (data.error) return { first_name: "Cliente", profile_pic: "https://cdn-icons-png.flaticon.com/512/149/149071.png" };
        return { first_name: data.name || "Cliente", profile_pic: data.profile_pic };
    } catch (e) { return { first_name: "Cliente", profile_pic: "https://cdn-icons-png.flaticon.com/512/149/149071.png" }; }
}

// --- WEBHOOK (RECEBER) ---
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else { res.sendStatus(403); }
});

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

// --- API ENVIAR (AGORA USA O TOKEN NOVO) ---
app.post('/api/enviar-instagram', async (req, res) => {
    const { recipientId, texto } = req.body;
    try {
        // Usa a variável PAGE_ACCESS_TOKEN atualizada
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

server.listen(PORT, () => console.log(`Rodando na ${PORT}`));