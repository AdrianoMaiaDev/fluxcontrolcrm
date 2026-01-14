const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session'); // <--- NOVO
const passport = require('passport');       // <--- NOVO
const FacebookStrategy = require('passport-facebook').Strategy; // <--- NOVO

// --- CONFIGURAÇÕES DE CHAVES (PREENCHA AQUI) ---
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = 'fluxpro_token_seguro'; 
const PAGE_ACCESS_TOKEN = 'EAAYnzQ7...'; // Seu Token Gigante da Página

// 👇 PEGUE ESSES DADOS NO SITE "FACEBOOK DEVELOPERS" -> CONFIGURAÇÕES -> BÁSICO
const FACEBOOK_APP_ID = '1732611531029371'; 
const FACEBOOK_APP_SECRET = '108d6d12657987a35b4ab9a63001359e';
const CALLBACK_URL = 'https://fluxcontrolcrm.onrender.com/auth/facebook/callback'; // Link exato do Render

const app = express();
const server = http.createServer(app);

// Configuração do CORS (Para aceitar conexões do seu site)
app.use(cors({
    origin: "*", 
    methods: ["GET", "POST"],
    credentials: true
}));

app.use(bodyParser.json());

// --- 1. CONFIGURAÇÃO DE SESSÃO (Necessário para o Login) ---
app.use(session({
    secret: 'fluxpro_segredo_super_secreto',
    resave: false,
    saveUninitialized: true
}));

app.use(passport.initialize());
app.use(passport.session());

// Configuração da Estratégia do Facebook
passport.use(new FacebookStrategy({
    clientID: FACEBOOK_APP_ID,
    clientSecret: FACEBOOK_APP_SECRET,
    callbackURL: CALLBACK_URL,
    profileFields: ['id', 'displayName', 'photos', 'email'],
    passReqToCallback: true // Permite acessar o req para pegar o socketId
  },
  function(req, accessToken, refreshToken, profile, done) {
    // Aqui recebemos o Token do Usuário. 
    // Guardamos o accessToken para usar depois na busca das páginas.
    return done(null, { profile, accessToken });
  }
));

// Serialização (Padrão do Passport)
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// --- CONFIGURAÇÃO DO SOCKET ---
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- 2. ROTAS DE AUTENTICAÇÃO (O QUE FALTAVA!) ---

// ROTA A: O botão do Frontend chama aqui
app.get('/auth/facebook', (req, res, next) => {
    // Salva o ID do Socket na sessão para saber quem chamou
    if (req.query.socketId) {
        req.session.socketId = req.query.socketId;
        console.log("🔌 Iniciando Login para Socket ID:", req.session.socketId);
    }
    
    // Inicia o Login no Facebook pedindo permissões
    passport.authenticate('facebook', { 
        scope: ['public_profile', 'pages_show_list', 'pages_messaging', 'instagram_basic', 'instagram_manage_messages']
    })(req, res, next);
});

// ROTA B: O Facebook devolve o usuário para cá
app.get('/auth/facebook/callback', 
  passport.authenticate('facebook', { failureRedirect: '/login-falhou' }),
  async (req, res) => {
    console.log("✅ Login no Facebook realizado com sucesso!");
    
    // Recupera o Socket ID que guardamos na ida
    const socketId = req.session.socketId;
    const userAccessToken = req.user.accessToken;

    if (socketId) {
        try {
            // Agora usamos o Token do Usuário para descobrir qual PÁGINA ele gerencia
            const pagesUrl = `https://graph.facebook.com/me/accounts?access_token=${userAccessToken}`;
            const response = await fetch(pagesUrl);
            const data = await response.json();

            if (data.data && data.data.length > 0) {
                // Pega a primeira página encontrada
                const pagina = data.data[0]; 
                const pageName = pagina.name;
                const pageToken = pagina.access_token; // Esse é o token que vale ouro!

                // AVISA O FRONTEND VIA SOCKET QUE DEU CERTO! 📡
                io.to(socketId).emit('login_sucesso', {
                    nomePagina: pageName,
                    tokenPagina: pageToken, // (Opcional enviar pro front, ideal é salvar no banco aqui)
                    usuario: req.user.profile.displayName
                });
                
                console.log(`📡 Avisei o socket ${socketId} sobre a página: ${pageName}`);
            } else {
                console.log("⚠️ Usuário logou, mas não tem páginas.");
                io.to(socketId).emit('erro_login', { msg: 'Nenhuma página encontrada.' });
            }

        } catch (error) {
            console.error("Erro ao buscar páginas:", error);
        }
    }

    // Fecha a janela do Popup automaticamente
    res.send(`
        <html>
            <body style="background:#111b21; color:white; display:flex; justify-content:center; alignItems:center; height:100vh; font-family:sans-serif;">
                <div style="text-align:center">
                    <h1>✅ Conectado com Sucesso!</h1>
                    <p>Pode fechar esta janela se ela não fechar sozinha.</p>
                </div>
                <script>
                    setTimeout(() => { window.close(); }, 1500);
                </script>
            </body>
        </html>
    `);
  }
);

app.get('/login-falhou', (req, res) => {
    res.send('❌ O login falhou ou foi cancelado.');
});


// --- 3. WEBHOOKS E API (MANTIDO DO SEU CÓDIGO) ---

async function getUserProfile(psid) {
  try {
    const url = `https://graph.facebook.com/v21.0/${psid}?fields=name,profile_pic&access_token=${PAGE_ACCESS_TOKEN}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.error) return { first_name: "Cliente (Meta)", profile_pic: "https://cdn-icons-png.flaticon.com/512/87/87390.png" };
    return { first_name: data.name || "Cliente", profile_pic: data.profile_pic || "https://cdn-icons-png.flaticon.com/512/149/149071.png" };
  } catch (error) { return { first_name: "Cliente", profile_pic: "https://cdn-icons-png.flaticon.com/512/149/149071.png" }; }
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ WEBHOOK VERIFICADO!');
      res.status(200).send(challenge);
    } else { res.sendStatus(403); }
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'page' || body.object === 'instagram') {
    for (const entry of body.entry) {
      const webhook_event = entry.messaging ? entry.messaging[0] : null;
      if (webhook_event) {
        const senderId = webhook_event.sender.id;
        let msgTexto = '';
        let msgTipo = 'text';

        if (webhook_event.message) {
            if (webhook_event.message.text) {
                msgTexto = webhook_event.message.text;
            } else if (webhook_event.message.attachments) {
                const attachment = webhook_event.message.attachments[0];
                msgTipo = attachment.type; 
                msgTexto = attachment.payload.url; 
                console.log(`📎 Anexo (${msgTipo}):`, msgTexto);
            }
        }

        if (msgTexto) {
            console.log(`💬 De ${senderId}: ${msgTexto}`);
            const perfil = await getUserProfile(senderId);
            const novaMsg = {
                id: senderId,
                name: perfil.first_name,
                avatar: perfil.profile_pic,
                text: msgTexto,
                timestamp: new Date().toISOString(),
                type: msgTipo,
                ehMinha: false
            };
            io.emit('nova_mensagem', novaMsg);
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
      const body = { recipient: { id: recipientId }, message: { text: texto } };
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (data.error) return res.status(500).json({ error: data.error.message });
      console.log(`✅ Resposta enviada para ${recipientId}`);
      res.json({ success: true, id: data.message_id });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// --- INICIAR SERVIDOR ---
server.listen(PORT, () => {
  console.log(`🚀 SERVIDOR RODANDO NA PORTA ${PORT}`);
});