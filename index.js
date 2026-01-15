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
    cookie: {
        secure: true,
        sameSite: 'none',
        maxAge: 24 * 60 * 60 * 1000 // 24 horas
    }
}));

app.use(passport.initialize());
app.use(passport.session());

// --- 3. CONFIGURAÇÃO DO FIREBASE ---
if (process.env.FIREBASE_CREDENTIALS) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
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

// --- 4. SERIALIZAÇÃO ---
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// --- 5. ESTRATÉGIAS DE LOGIN ---
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID; 
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET; 
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Variável global APENAS para fallback (ideal é usar o banco)
let GLOBAL_PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN; 

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
        return done(null, { profile, accessToken, refreshToken });
      }
    ));
}

// --- 6. SOCKET.IO COM SALAS PRIVADAS ---
const io = new Server(server, { cors: { origin: "*" } });

io.on('connection', (socket) => {
    // O Frontend envia o UID do Firebase para entrar na sala pessoal
    socket.on('entrar_sala_privada', (uid) => {
        if(uid) {
            socket.join(uid);
            console.log(`🔒 Socket ${socket.id} entrou na sala do usuário: ${uid}`);
        }
    });
});

// --- 7. ROTAS GERAIS ---
app.get('/', (req, res) => { res.send('FluxPro Backend Online (Multi-User) 🚀'); });

// --- 8. ROTAS GOOGLE (COM REFRESH TOKEN) ---
app.get('/auth/google', (req, res, next) => {
    passport.authenticate('google', { 
        scope: ['profile', 'email', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'],
        accessType: 'offline', // Pede Refresh Token
        prompt: 'consent'
    })(req, res, next);
});

app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login-falhou' }),
  function(req, res) {
    res.send(`<html><body><script>if(window.opener){window.opener.postMessage("login_google_sucesso","*");}window.close();</script></body></html>`);
  }
);

// --- 9. ROTAS FACEBOOK (COM SUPORTE A MULTI-USUÁRIO) ---

// Iniciar Login: Captura SocketID e UID do dono
app.get('/auth/facebook', (req, res, next) => {
    if (req.query.socketId) req.session.socketId = req.query.socketId;
    if (req.query.uid) req.session.uid = req.query.uid; 
    
    passport.authenticate('facebook', { 
        scope: ['public_profile', 'pages_show_list', 'pages_messaging', 'instagram_basic', 'instagram_manage_messages'] 
    })(req, res, next);
});

// Callback: Salva o Mapeamento no Banco
app.get('/auth/facebook/callback', 
  passport.authenticate('facebook', { failureRedirect: '/login-falhou' }),
  async (req, res) => {
    const socketId = req.session.socketId;
    const userUid = req.session.uid; 

    if (socketId && userUid) {
        try {
            const pagesUrl = `https://graph.facebook.com/me/accounts?access_token=${req.user.accessToken}`;
            const response = await fetch(pagesUrl);
            const data = await response.json();

            if (data.data && data.data.length > 0) {
                const pagina = data.data[0];
                const db = admin.firestore();
                
                // 1. Salva na conta do usuário (para referência visual)
                await db.collection('users').doc(userUid).collection('config').doc('facebook').set({
                    pageName: pagina.name,
                    pageId: pagina.id,
                    accessToken: pagina.access_token,
                    connectedAt: new Date().toISOString()
                });

                // 2. Salva no MAPA GLOBAL (Crucial para o Webhook saber rotear)
                // ID da Página -> Dono da Página
                await db.collection('integrated_pages').doc(pagina.id).set({
                    ownerUid: userUid,
                    pageAccessToken: pagina.access_token,
                    pageName: pagina.name
                });

                GLOBAL_PAGE_TOKEN = pagina.access_token; // Fallback temporário
                io.to(socketId).emit('login_sucesso', { nomePagina: pagina.name });
            }
        } catch (error) { console.error("Erro FB Token:", error); }
    }
    res.send('<script>window.close()</script>');
  }
);

// Status do Facebook
app.get('/api/facebook/status', async (req, res) => {
    // Simplificado: Se tiver token global ou lógica futura de UID
    res.json({ connected: !!GLOBAL_PAGE_TOKEN });
});

// --- 10. WEBHOOK INTELIGENTE (ROTEAMENTO POR PÁGINA) ---

// Validação do Token
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else { res.sendStatus(403); }
});

// Função auxiliar: Busca Perfil usando o Token DA PÁGINA ESPECÍFICA
async function getUserProfile(psid, pageToken) {
    try {
        const url = `https://graph.facebook.com/v21.0/${psid}?fields=name,profile_pic&access_token=${pageToken}`;
        const response = await fetch(url);
        const data = await response.json();
        if (data.error) return { first_name: "Cliente", profile_pic: "https://cdn-icons-png.flaticon.com/512/149/149071.png" };
        return { first_name: data.name || "Cliente", profile_pic: data.profile_pic };
    } catch (e) { return { first_name: "Cliente", profile_pic: "https://cdn-icons-png.flaticon.com/512/149/149071.png" }; }
}

// Função auxiliar: Busca quem é o dono da página
async function getPageConfig(pageId) {
    try {
        const doc = await admin.firestore().collection('integrated_pages').doc(pageId).get();
        if (doc.exists) return doc.data(); // Retorna { ownerUid, pageAccessToken }
    } catch(e) { console.error("Erro Firebase Config:", e); }
    return null;
}

app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'page' || body.object === 'instagram') {
        for (const entry of body.entry) {
            
            // 1. Descobrir para qual página foi a mensagem
            const pageId = entry.id; 
            const pageConfig = await getPageConfig(pageId);

            // Se não tem dono cadastrado, ignora para não misturar
            if (!pageConfig || !pageConfig.ownerUid) {
                console.log(`⚠️ Mensagem ignorada: Página ${pageId} sem dono no sistema.`);
                continue; 
            }

            const ownerUid = pageConfig.ownerUid;
            const tokenDaPagina = pageConfig.pageAccessToken;

            const evt = entry.messaging ? entry.messaging[0] : null;
            
            // 2. Verifica se é mensagem válida (evita crash com 'read receipts')
            if (evt && evt.message) {
                let txt = evt.message.text || (evt.message.attachments ? evt.message.attachments[0].payload.url : '');
                let type = evt.message.attachments ? evt.message.attachments[0].type : 'text';
                
                if (txt) {
                    // 3. Pega perfil do cliente
                    const perfil = await getUserProfile(evt.sender.id, tokenDaPagina);
                    
                    // 4. Envia APENAS para a sala do Dono
                    io.to(ownerUid).emit('nova_mensagem', {
                        id: evt.sender.id, 
                        name: perfil.first_name, 
                        avatar: perfil.profile_pic,
                        text: txt, 
                        type: type, 
                        timestamp: new Date().toISOString(), 
                        ehMinha: false
                    });
                    console.log(`✅ Mensagem roteada para usuário: ${ownerUid}`);
                }
            }
        }
        res.status(200).send('EVENT_RECEIVED');
    } else { res.sendStatus(404); }
});

// API Enviar Mensagem (Blindada contra reinicialização)
app.post('/api/enviar-instagram', async (req, res) => {
    const { recipientId, texto } = req.body;
    
    try {
        let tokenParaEnvio = process.env.PAGE_ACCESS_TOKEN; // Tenta o global primeiro

        // Se o global estiver vazio (servidor reiniciou), busca no banco de "Recuperação de Desastre"
        if (!tokenParaEnvio) {
            // OBS: Aqui estamos pegando um token "genérico" salvo. 
            // Para multi-contas real no envio, o ideal seria o frontend mandar o UID ou PageID.
            // Mas isso aqui já resolve o problema do servidor desligar.
            const doc = await admin.firestore().collection('integrated_pages').listDocuments();
            if (doc.length > 0) {
                const snapshot = await doc[0].get(); // Pega a primeira página que achar
                tokenParaEnvio = snapshot.data().pageAccessToken;
            }
        }

        if (!tokenParaEnvio) {
            return res.status(500).json({ error: "Nenhuma página conectada no servidor." });
        }

        const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${tokenParaEnvio}`;
        const response = await fetch(url, { 
            method: 'POST', headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ recipient: { id: recipientId }, message: { text: texto } }) 
        });
        
        const data = await response.json();
        if (data.error) {
            console.error('❌ Erro Facebook Envio:', data.error);
            return res.status(500).json({ error: data.error.message });
        }
        res.json({ success: true, id: data.message_id });

    } catch (error) { 
        console.error("Erro Servidor Envio:", error);
        res.status(500).json({ error: error.message }); 
    }
});
// --- 11. API GOOGLE CALENDAR ---
const checkGoogleAuth = (req, res, next) => {
    if (req.user && req.user.accessToken) return next();
    res.status(401).json({ error: 'Não conectado' });
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

// --- 12. START ---
server.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));