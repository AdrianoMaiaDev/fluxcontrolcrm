const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

// ⚠️ COLOQUE SEUS DADOS AQUI
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = 'fluxpro_token_seguro'; // O mesmo que você colocou no Painel da Meta
const PAGE_ACCESS_TOKEN = 'EAAYnzQ7XO3sBQYm6VyKfh4mVdaqzd2hsNGHepZCjnyT3u2DxsdqxQ6qbz5osO3do2v5Wh2vIDxHoGndjFu7fBqrBwuEDhZA4T21Gs86GiGwBZAbv9aqAeju9i6nHtl5IsSwSv9SZAcVAZBXDAkpEzasOksKQPQ3sTXfA4f3ZB9NYEq291ZCKIyM2OsO75OBxhQQfZCvGDk6NNZBU7ZBIILzkH8LOzvLVysAPwMufRZCDdGyvshAlxxOBYA5wgZDZD'; // Token com permissões (instagram_basic, pages_messaging, etc)

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Permite conexão do React
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(bodyParser.json());

// --- 1. FUNÇÃO PARA PEGAR NOME E FOTO (BLINDADA) ---
async function getUserProfile(psid) {
  try {
    // Tenta pegar dados do usuário via Graph API
    const url = `https://graph.facebook.com/v21.0/${psid}?fields=name,profile_pic&access_token=${PAGE_ACCESS_TOKEN}`;
    const response = await fetch(url);
    const data = await response.json();
    
    // Se der erro (ex: falta de permissão Advanced Access), usa dados genéricos
    if (data.error) {
      console.log(`⚠️ Aviso: Perfil restrito ou erro de permissão para ID ${psid}. Usando genérico.`);
      return {
          first_name: "Cliente (Meta)",
          profile_pic: "https://cdn-icons-png.flaticon.com/512/87/87390.png" // Ícone Insta/Face
      };
    }
    
    return {
        first_name: data.name || "Cliente",
        profile_pic: data.profile_pic || "https://cdn-icons-png.flaticon.com/512/149/149071.png"
    };

  } catch (error) {
    console.error("❌ Erro de conexão ao buscar perfil:", error.message);
    return { first_name: "Cliente", profile_pic: "https://cdn-icons-png.flaticon.com/512/149/149071.png" };
  }
}

// --- 2. ROTA DE VERIFICAÇÃO (Para o Facebook aceitar o Webhook) ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ WEBHOOK VERIFICADO!');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// --- 3. O CÉREBRO: RECEBER MENSAGENS (TEXTO, FOTO, ÁUDIO) ---
app.post('/webhook', async (req, res) => {
  const body = req.body;

  // Log para ver o que está chegando
  // console.log("📨 Payload Bruto:", JSON.stringify(body, null, 2));

  // Verifica se é evento de Página ou Instagram
  if (body.object === 'page' || body.object === 'instagram') {
    
    for (const entry of body.entry) {
      // Pega o evento de mensagem (pode vir como messaging ou changes, mas messaging é o padrão de chat)
      const webhook_event = entry.messaging ? entry.messaging[0] : null;

      if (webhook_event) {
        const senderId = webhook_event.sender.id;
        
        // -- LÓGICA DE DETECÇÃO DE MÍDIA --
        let msgTexto = '';
        let msgTipo = 'text';

        if (webhook_event.message) {
            if (webhook_event.message.text) {
                // É TEXTO
                msgTexto = webhook_event.message.text;
            } 
            else if (webhook_event.message.attachments) {
                // É MÍDIA (Foto, Áudio, Vídeo)
                const attachment = webhook_event.message.attachments[0];
                msgTipo = attachment.type; // ex: 'image', 'audio', 'video'
                msgTexto = attachment.payload.url; // O texto vira o Link da mídia
                console.log(`📎 Anexo recebido (${msgTipo}):`, msgTexto);
            }
        }

        // Se encontrou conteúdo válido, processa
        if (msgTexto) {
            console.log(`💬 De ${senderId} [${msgTipo}]: ${msgTexto}`);

            // 1. Pega Perfil
            const perfil = await getUserProfile(senderId);

            // 2. Cria objeto padrão para o React
            const novaMsg = {
                id: senderId,
                name: perfil.first_name,
                avatar: perfil.profile_pic,
                text: msgTexto,
                timestamp: new Date().toISOString(),
                type: msgTipo, // 'text', 'image', 'audio'
                ehMinha: false
            };

            // 3. Envia pro React
            io.emit('nova_mensagem', novaMsg);
        }
      }
    }

    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// --- 4. API PARA ENVIAR RESPOSTA (DO SISTEMA PRO CLIENTE) ---
app.post('/api/enviar-instagram', async (req, res) => {
    const { recipientId, texto } = req.body;
  
    try {
      const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
      
      const body = {
        recipient: { id: recipientId },
        message: { text: texto }
      };
  
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
  
      const data = await response.json();
  
      if (data.error) {
        console.error('❌ Erro ao enviar:', data.error);
        return res.status(500).json({ error: data.error.message });
      }
  
      console.log(`✅ Resposta enviada para ${recipientId}`);
      res.json({ success: true, id: data.message_id });
  
    } catch (error) {
      console.error('Erro no servidor:', error);
      res.status(500).json({ error: error.message });
    }
});

// --- INICIAR SERVIDOR ---
server.listen(PORT, () => {
  console.log(`🚀 SERVIDOR RODANDO NA PORTA ${PORT}`);
  console.log(`📡 Aguardando mensagens do Facebook e Instagram...`);
});

