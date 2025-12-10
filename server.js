// =======================================================
// === 1. CONFIGURAÇÃO E DEPENDÊNCIAS ===
// =======================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Configuração de Porta e Host para o Fly.io
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // OBRIGATÓRIO no Fly.io

// Configuração de CORS (Origens Permitidas)
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || 'https://level-up-adilson.fly.dev,http://localhost:8080';
const allowedOrigins = allowedOriginsEnv.split(',').map(s => s.trim()).filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // Permite clientes sem cabeçalho 'Origin' (como clientes não-navegador)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('CORS policy: Origin not allowed'));
    },
    methods: ['GET', 'POST']
  }
});

// Configuração do Express para servir arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));


// =======================================================
// === 2. VARIÁVEIS DE ESTADO DO JOGO ===
// =======================================================
const TIP_TIME_LIMIT = 120; // Tempo limite para dicas em segundos
let timerInterval = null; // Variável para controlar o timer

let players = [];
let currentTips = [];
let roundData = {};
let matchData = { rounds: [], cumulativeScores: {} };

// =======================================================
// === 3. FUNÇÕES AUXILIARES (HELPERS) ===
// =======================================================

/** Formata segundos em MM:SS */
function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
}

/** Reseta as variáveis de estado de uma rodada */
function resetRoundState(total = null) {
  if (timerInterval) clearInterval(timerInterval);
  currentTips = [];
  roundData = {
    playerAttempts: {},
    playersWhoFinished: {},
    totalPlayers: total,
    roundScores: {},
    secretNumberMap: {}
  };
}

/** Envia mensagens de status para o monitor do jogo */
function broadcastMonitor(statusTexto, logMsg) {
  io.emit('atualiza-status-jogo', statusTexto);
  if (logMsg) {
    io.emit('log-evento', logMsg);
  }
}

/** Atualiza a lista de jogadores e pontuações no monitor */
function updateMonitor() {
  const rankedPlayers = [...players].sort((a, b) => b.score - a.score);
  
  io.emit('atualiza-jogadores', rankedPlayers.map(p => ({
      ...p,
      equipe: (players.indexOf(p) % 2) + 1, // Exemplo de atribuição de equipe
      conectado: true
    })));

  io.emit('atualiza-pontuacao', rankedPlayers.map(p => ({
      equipe: p.name,
      pontos: p.score
    })));
}


// =======================================================
// === 4. LÓGICA DO CRONÔMETRO (FUNÇÃO PRINCIPAL DE FLUXO) ===
// =======================================================

function startTipperTimer(player) {
  if (timerInterval) clearInterval(timerInterval); // Limpa qualquer timer anterior

  let remainingTime = TIP_TIME_LIMIT;

  // Envia o número secreto APENAS para o jogador da vez (CORREÇÃO BUG NÚMERO REPETIDO)
  const secretNumber = roundData.secretNumberMap[player.id];
  io.to(player.id).emit('receiveSecretNumber', secretNumber);

  // Inicia o turno
  io.emit('nextTipper', player);
  io.emit('atualiza-cronometro', formatTime(remainingTime));
  io.emit('atualiza-jogador-da-vez', player.name);
  broadcastMonitor(`Aguardando Dica`, `É a vez de ${player.name} dar a dica.`);

  // Inicia o contador
  timerInterval = setInterval(() => {
    remainingTime--;
    
    io.emit('atualiza-cronometro', formatTime(remainingTime));
    
    // Lógica de Tempo Esgotado
    if (remainingTime <= 0) {
      clearInterval(timerInterval);
      
      const fakeTip = { tip: "(Tempo Esgotado)", number: 0 };
      const playerInfo = { id: player.id, name: player.name };
      const number = roundData.secretNumberMap[player.id] || 0;
      currentTips.push({ ...fakeTip, number, player: playerInfo });
      
      io.emit('nova-dica', { jogador: player.name, texto: fakeTip.tip });
      broadcastMonitor('Tempo Esgotado', `Tempo de ${player.name} esgotou.`);
      
      // Próxima ação: Passar para o próximo jogador ou iniciar a ordenação
      if (currentTips.length < players.length) {
        startTipperTimer(players[currentTips.length]);
      } else {
        const shuffledTips = [...currentTips].sort(() => Math.random() - 0.5).map(t => t.tip);
        io.emit('startSortingPhase', shuffledTips);
        io.emit('atualiza-jogador-da-vez', 'Ninguém');
        io.emit('atualiza-cronometro', '--:--');
        broadcastMonitor('Fase de Ordenação', 'Todas as dicas foram dadas.');
      }
    }
  }, 1000);
}


// =======================================================
// === 5. EVENTOS SOCKET.IO (LÓGICA PRINCIPAL DO JOGO) ===
// =======================================================

io.on('connection', (socket) => {
  // Inicialização para novos clientes (Jogo e Monitor)
  socket.emit('updatePlayers', players);
  updateMonitor();
  broadcastMonitor('Aguardando Jogadores');
  io.emit('atualiza-cronometro', '--:--');

  // --- Eventos de Jogadores e Controle ---
  socket.on('addPlayer', ({ name }) => {
    if (players.length < 8 && !players.some(p => p.id === socket.id)) {
      const newPlayer = { id: socket.id, name, score: 0 };
      players.push(newPlayer);
      matchData.cumulativeScores[newPlayer.id] = matchData.cumulativeScores[newPlayer.id] || 0;
      io.emit('updatePlayers', players);
      updateMonitor();
      broadcastMonitor('Aguardando Jogadores', `Jogador ${newPlayer.name} entrou na sala.`);
    }
  });

  socket.on('resetPlayers', () => {
    if (timerInterval) clearInterval(timerInterval);
    players = [];
    resetRoundState();
    matchData = { rounds: [], cumulativeScores: {} };
    io.emit('resetGame');
    broadcastMonitor('Jogo Resetado', 'O jogo foi reiniciado pelo anfitrião.');
    io.emit('atualiza-cronometro', '--:--');
  });

  // --- Evento de Início da Rodada ---
  socket.on('startGame', (data) => {
    if (timerInterval) clearInterval(timerInterval);
    resetRoundState(players.length);
    players.forEach(p => {
      matchData.cumulativeScores[p.id] = matchData.cumulativeScores[p.id] || p.score || 0;
    });

    // Geração e Mapeamento de Números Secretos Únicos (CORREÇÃO BUG NÚMERO REPETIDO)
    let usedNumbers = new Set();
    for (const player of players) {
        let num;
        do {
            num = Math.floor(Math.random() * 100) + 1;
        } while (usedNumbers.has(num));
        usedNumbers.add(num);
        roundData.secretNumberMap[player.id] = num;
    }

    const gameInfo = (data.tema === 'aleatorio')
      ? temas[Math.floor(Math.random() * temas.length)]
      : { categoria: data.categoria, tema: data.tema };
    
    io.emit('gameStarted', gameInfo);
    
    const roundNumber = matchData.rounds.length + 1;
    io.emit('atualiza-rodada', { numero: roundNumber, tema: gameInfo.tema });
    broadcastMonitor(`Rodada ${roundNumber} Iniciada`, `Tema: ${gameInfo.tema}`);
  });

  // --- Eventos de Dicas e Ordenação ---
  socket.on('requestNextTipper', () => {
    if (currentTips.length < players.length) {
      startTipperTimer(players[currentTips.length]);
    } else {
      if (timerInterval) clearInterval(timerInterval);
      const shuffledTips = [...currentTips].sort(() => Math.random() - 0.5).map(t => t.tip);
      io.emit('startSortingPhase', shuffledTips);
      io.emit('atualiza-jogador-da-vez', 'Ninguém');
      io.emit('atualiza-cronometro', '--:--');
      broadcastMonitor('Fase de Ordenação', 'Todas as dicas foram dadas. Iniciando ordenação.');
    }
  });

  socket.on('sendTip', (tipData) => {
    // Parar o timer assim que a dica é recebida
    if (timerInterval) clearInterval(timerInterval);
    io.emit('atualiza-cronometro', '--:--');

    const player = players.find(p => p.id === socket.id);
    if (player) {
      const number = tipData.number;
      currentTips.push({ ...tipData, number, player: { id: socket.id, name: player.name } });

      io.emit('nova-dica', { jogador: player.name, texto: tipData.tip });
      broadcastMonitor('Dica Recebida', `Dica ${currentTips.length}/${players.length} recebida de ${player.name}.`);

      if (currentTips.length < players.length) {
        startTipperTimer(players[currentTips.length]);
      } else {
        const shuffledTips = [...currentTips].sort(() => Math.random() - 0.5).map(t => t.tip);
        io.emit('startSortingPhase', shuffledTips);
        io.emit('atualiza-jogador-da-vez', 'Ninguém');
        broadcastMonitor('Fase de Ordenação', 'Todas as dicas foram dadas. Iniciando ordenação.');
      }
    }
  });

  socket.on('checkOrder', ({ orderedTips }) => {
    const player = players.find(p => p.id === socket.id);
    if (!player || roundData.playersWhoFinished[player.id]) return;

    // Lógica de tentativas
    if (roundData.playerAttempts[player.id] === undefined) {
      roundData.playerAttempts[player.id] = 3;
    }
    roundData.playerAttempts[player.id]--;
    const attemptsLeft = roundData.playerAttempts[player.id];

    // Checagem da ordem
    const correctOrderObjects = [...currentTips].sort((a, b) => a.number - b.number);
    const correctOrderText = correctOrderObjects.map(t => t.tip);
    const normalize = s => (s || '').trim().normalize('NFC');
    const isCorrect = orderedTips.every((v, i) => normalize(v) === normalize(correctOrderText[i]));
    let points = 0;

    // Pontuação
    if (isCorrect) {
      if (attemptsLeft === 2) points = 30;
      else if (attemptsLeft === 1) points = 20;
      else if (attemptsLeft === 0) points = 10;
      player.score += points;
      roundData.roundScores[player.id] = (roundData.roundScores[player.id] || 0) + points;
      broadcastMonitor('Ordenação em Andamento', `${player.name} ACERTOU a ordem e ganhou ${points} pontos.`);
    } else {
      if (attemptsLeft === 0) {
        roundData.roundScores[player.id] = roundData.roundScores[player.id] || 0;
        broadcastMonitor('Ordenação em Andamento', `${player.name} esgotou as tentativas.`);
      } else {
        broadcastMonitor('Ordenação em Andamento', `${player.name} errou. ${attemptsLeft} tentativas restantes.`);
      }
    }

    // Finalização do jogador na rodada
    if (isCorrect || attemptsLeft === 0) {
      roundData.playersWhoFinished[player.id] = true;
    }

    updateMonitor();

    const everyoneFinished = Object.keys(roundData.playersWhoFinished).length === (roundData.totalPlayers || players.length);
    const resultPayload = { isCorrect, points, attemptsLeft, players: [...players].sort((a, b) => b.score - a.score) };

    // Fim da rodada
    if (everyoneFinished) {
      if (timerInterval) clearInterval(timerInterval);

      const historyObjects = correctOrderObjects.map(t => ({
        number: t.number,
        tip: t.tip,
        playerName: t.player.name
      }));
      const historyHtml = historyObjects.map(t =>
        `<li data-numero="${t.number}"><b>${t.tip}</b> <i>(Nº ${t.number} por ${t.playerName})</i></li>`
      ).join('');
      const roundNumber = matchData.rounds.length + 1;
      const roundResult = {
        roundNumber,
        historyObjects,
        roundScores: { ...roundData.roundScores },
        playersScreenshot: [...players].sort((a, b) => b.score - a.score).map(p => ({ id: p.id, name: p.name, score: p.score }))
      };

      // Atualiza score cumulativo
      Object.keys(roundData.roundScores).forEach(pid => {
        matchData.cumulativeScores[pid] = (matchData.cumulativeScores[pid] || 0) + roundData.roundScores[pid];
      });
      matchData.rounds.push(roundResult);

      // Dados do Resumo da Rodada para Monitor
      const dadosGabarito = correctOrderObjects.map(t => ({
          numero: t.number,
          texto: t.tip
      }));

      const dadosPlacar = players
          .map(player => ({
              name: player.name,
              roundScore: roundData.roundScores[player.id] || 0
          }))
          .sort((a, b) => b.roundScore - a.roundScore)
          .map(p => ({
              texto: `${p.name} — +${p.roundScore} (na rodada)`
          }));

      io.emit("exibir-resumo-rodada", { gabarito: dadosGabarito, placar: dadosPlacar });

      // Evento final de rodada
      io.emit('roundOver', {
        historyHtml,
        historyObjects,
        players: [...players].sort((a, b) => b.score - a.score),
        lastPlayerResult: { ...resultPayload, id: player.id },
        roundNumber,
        roundScores: roundData.roundScores,
        matchRoundsCount: matchData.rounds.length
      });
      broadcastMonitor('Fim da Rodada', `Rodada ${roundNumber} finalizada.`);
      io.emit('atualiza-cronometro', '--:--');

    } else {
      socket.emit('orderResult', resultPayload);
    }
  });

  socket.on('endMatch', () => {
    if (timerInterval) clearInterval(timerInterval);

    const finalRanking = [...players].sort((a, b) => b.score - a.score);
    io.emit('matchOver', {
      rounds: matchData.rounds,
      finalRanking: finalRanking.map(p => ({ id: p.id, name: p.name, score: p.score })),
      cumulativeScores: matchData.cumulativeScores
    });

    broadcastMonitor('Fim de Jogo', 'Partida finalizada. Exibindo ranking final.');
    io.emit('atualiza-cronometro', '--:--');
  });

  // --- Evento de Desconexão ---
  socket.on('disconnect', () => {
    if (timerInterval) clearInterval(timerInterval);

    const playerIndex = players.findIndex(p => p.id === socket.id);
    if (playerIndex > -1) {
        const playerName = players[playerIndex].name;
        players.splice(playerIndex, 1);
        // Lógica de ajuste de total de jogadores e scores
        if (roundData.totalPlayers) {
          roundData.totalPlayers = Math.max(0, roundData.totalPlayers - 1);
        }
        delete matchData.cumulativeScores[socket.id];
        
        io.emit('updatePlayers', players);
        updateMonitor();
        broadcastMonitor('Jogador Desconectado', `${playerName} saiu da sala.`);
    }
  });
});


// =======================================================
// === 6. INICIALIZAÇÃO DO SERVIDOR ===
// =======================================================

// Apenas uma chamada 'listen' (correção do problema anterior)
server.listen(PORT, HOST, () => {
    console.log(`[SERVIDOR] Level-Up rodando em http://${HOST}:${PORT}`);
    console.log(`[CONFIG] Origens CORS: ${allowedOriginsEnv}`);
    // O broadcastMonitor de 'Servidor Iniciado' foi movido para o io.on('connection')
    // para garantir que ele seja enviado assim que o Socket.IO estiver pronto.
});


// =======================================================
// === 7. BANCO DE DADOS DE TEMAS (MOVIDO PARA O FINAL) ===
// =======================================================
const temas = [
  { categoria: "CUSTOS OPERACIONAIS", tema: "Analisar o impacto da variação do preço do diesel nos custos logísticos" },
  { "categoria": "CUSTOS OPERACIONAIS", "tema": "Como comparar os resultados da manutenção preventiva vs. corretiva?" },
  { "categoria": "CUSTOS OPERACIONAIS", "tema": "Qual o custo total de pedágios em rotas de longa distância?" },
  { "categoria": "CUSTOS OPERACIONAIS", "tema": "Como controlar os gastos com pneus e peças de reposição?" },
  { "categoria": "CUSTOS OPERACIONAIS", "tema": "Como planejar a redução de consumo de combustível por rota?" },
  { "categoria": "GESTÃO FINANCEIRA", "tema": "Como determinar o ponto de equilíbrio operacional da frota?" },
  { "categoria": "GESTÃO FINANCEIRA", "tema": "Como gerenciar o fluxo de caixa nas operações logísticas?" },
  { "categoria": "GESTÃO FINANCEIRA", "tema": "Como avaliar o ROI (Retorno sobre Investimento) de novos veículos?" },
  { "categoria": "GESTÃO FINANCEIRA", "tema": "Como estimar os custos fixos e variáveis do transporte?" },
  { "categoria": "GESTÃO FINANCEIRA", "tema": "Como monitorar os indicadores de rentabilidade por cliente?" },
  { "categoria": "TRIBUTAÇÃO", "tema": "Qual o impacto real do ICMS no preço do frete?" },
  { "categoria": "TRIBUTAÇÃO", "tema": "Quais são (e como interpretar) os benefícios fiscais regionais?" },
  { "categoria": "TRIBUTAÇÃO", "tema": "Como planejar a recuperação de créditos tributários?" },
  { "categoria": "TRIBUTAÇÃO", "tema": "Como otimizar o controle de notas fiscais e obrigações acessórias?" },
  { "categoria": "TRIBUTAÇÃO", "tema": "Como reduzir o risco de autuações fiscais no transporte rodoviário?" },
  { "categoria": "GESTÃO DE PESSOAS", "tema": "Quais ações implementar para reduzir a rotatividade (turnover) de motoristas?" },
  { "categoria": "GESTÃO DE PESSOAS", "tema": "Como promover programas de capacitação contínua que funcionem?" },
  { "categoria": "GESTÃO DE PESSOAS", "tema": "Como motivar equipes em ambientes de alta pressão?" },
  { "categoria": "GESTÃO DE PESSOAS", "tema": "Como desenvolver novas lideranças operacionais no setor?" },
  { "categoria": "GESTÃO DE PESSOAS", "tema": "Como gerenciar conflitos entre a equipe administrativa e a operacional?" },
  { "categoria": "LEGISLAÇÃO TRABALHISTA", "tema": "Como cumprir a Lei do Descanso (Lei 13.103) de forma eficiente?" },
  { "categoria": "LEGISLAÇÃO TRABALHISTA", "tema": "Como adequar os contratos de trabalho às novas regras da CLT?" },
  { "categoria": "LEGISLAÇÃO TRABALHISTA", "tema": "Quais normas de segurança e saúde (SST) devem ser aplicadas?" },
  { "categoria": "LEGISLAÇÃO TRABALHISTA", "tema": "Qual o melhor sistema digital para controlar a jornada de motoristas?" },
  { "categoria": "LEGISLAÇÃO TRABALHISTA", "tema": "Como garantir a conformidade total com as normas do eSocial?" },
  { "categoria": "TECNOLOGIA", "tema": "Como usar telemetria para reduzir custos e aumentar a segurança?" },
  { "categoria": "TECNOLOGIA", "tema": "Quão mais eficiente é a entrega com roteirização inteligente?" },
  { "categoria": "TECNOLOGIA", "tema": "Quais os benefícios de integrar sistemas ERP e TMS/Logística?" },
  { "categoria": "TECNOLOGIA", "tema": "Onde aplicar Inteligência Artificial (IA) na gestão de frotas?" },
  { "categoria": "TECNologia", "tema": "Quais processos administrativos no transporte podem ser automatizados?" },
  { "categoria": "INOVAÇÃO", "tema": "Quais as tendências em veículos elétricos e híbridos para frotas?" },
  { "categoria": "INOVAÇÃO", "tema": "Quando será viável testar caminhões autônomos em rotas controladas?" },
  { "categoria": "INOVAÇÃO", "tema": "Como criar soluções práticas para a logística urbana inteligente?" },
  { "categoria": "INOVAÇÃO", "tema": "Como desenvolver aplicativos internos úteis para os motoristas?" },
  { "categoria": "INOVAÇÃO", "tema": "Como usar o 'Big Data' para tomar decisões estratégicas?" },
  { "categoria": "LEGISLAÇÃO", "tema": "Quais são as principais exigências da ANTT para transporte de cargas?" },
  { "categoria": "LEGISLAÇÃO", "tema": "Quais normas ambientais (CONAMA, IBAMA) se aplicam ao transporte?" },
  { "categoria": "LEGISLAÇÃO", "tema": "Como garantir o respeito aos regulamentos de produtos perigosos?" },
  { "categoria": "LEGISLAÇÃO", "tema": "Qual o processo para regularizar licenças e certificados operacionais?" },
  { "categoria": "LEGISLAÇÃO", "tema": "Como manter a conformidade documental nas fiscalizações de estrada?" },
  { "categoria": "SEGURANÇA", "tema": "Quais as medidas mais eficazes de prevenção contra roubo de cargas?" },
  { "categoria": "SEGURANÇA", "tema": "Como controlar a fadiga do motorista para evitar acidentes?" },
  { "categoria": "SEGURANÇA", "tema": "O que inspecionar (checklist) nos veículos antes de cada viagem?" },
  { "categoria": "SEGURANÇA", "tema": "Como capacitar as equipes para atuação em emergências na estrada?" },
  { "categoria": "SEGURANÇA", "tema": "Como gerenciar incidentes e 'quase-acidentes' (near misses)?" },
  { "categoria": "LOGÍSTICA VERDE", "tema": "Como aplicar os princípios de ESG (Ambiental, Social, Governança) no transporte?" },
  { "categoria": "LOGÍSTICA VERDE", "tema": "Como reduzir efetivamente as emissões de CO2 nas operações?" },
  { "categoria": "LOGÍSTICA VERDE", "tema": "Quais materiais e embalagens de transporte podem ser reaproveitados?" },
  { "categoria": "LOGÍSTICA VERDE", "tema": "Como implementar uma operação logística de baixo impacto ambiental?" },
  { "categoria": "LOGÍSTICA VERDE", "tema": "Como engajar motoristas e agregados em práticas sustentáveis?" },
  { "categoria": "LOGÍSTICA REVERSA", "tema": "Qual a forma mais eficiente de coletar e transportar produtos pós-consumo?" },
  { "categoria": "LOGÍSTICA REVERSA", "tema": "Como gerenciar devoluções e trocas de produtos danificados?" },
  { "categoria": "LOGÍSTICA REVERSA", "tema": "Como integrar sistemas de rastreio para o retorno de materiais?" },
  { "categoria": "LOGÍSTICA REVERSA", "tema": "Como aproveitar resíduos (sucata, etc.) como insumo para novas operações?" },
  { "categoria": "LOGÍSTICA REVERSA", "tema": "Qual o custo vs. benefício real da logística reversa?" },
  { "categoria": "INFRAESTRUTURA", "tema": "Qual o impacto real das condições das estradas na manutenção e custo?" },
  { "categoria": "INFRAESTRUTURA", "tema": "Como planejar rotas alternativas eficientes em períodos de obras?" },
  { "categoria": "INFRAESTRUTURA", "tema": "Quais são os principais gargalos logísticos regionais do Brasil?" },
  { "categoria": "INFRAESTRUTURA", "tema": "Quando (e onde) investir em bases e pátios de apoio para frotas?" },
  { "categoria": "ESTRATÉGIA", "tema": "O que é melhor: frota própria, terceirizada ou um modelo híbrido?" },
  { "categoria": "ESTRATÉGIA", "tema": "Como desenvolver planos de contingência para falhas operacionais críticas?" },
  { "categoria": "ESTRATÉGIA", "tema": "Quais as reais vantagens da logística de última milha (last mile)?" },
  { "categoria": "PLANEJAMENTO", "tema": "Qual o cronograma ideal de manutenção preventiva para a frota?" },
  { "categoria": "PLANEJAMENTO", "tema": "Como antecipar demandas de transporte em períodos sazonais (ex: Natal)?" },
  { "categoria": "PLANEJAMENTO", "tema": "Como dimensionar corretamente as equipes conforme o volume de entregas?" },
  { "categoria": "PLANEJAMENTO", "tema": "Quais investimentos logísticos de longo prazo devem ser planejados?" },
  { "categoria": "QUALIDADE", "tema": "Como padronizar (POP) os processos de carregamento e descarga?" },
  { "categoria": "QUALIDADE", "tema": "Quais indicadores de não conformidade devem ser monitorados?" },
  { "categoria": "QUALIDADE", "tema": "Como auditar eficientemente os fornecedores de transporte terceirizado?" },
  { "categoria": "QUALIDADE", "tema": "Como implementar a filosofia de melhoria contínua (Kaizen) na operação?" },
  { "categoria": "SUSTENTABILIDADE", "tema": "Como reutilizar recursos naturais (ex: água da lavagem) na operação?" },
  { "categoria": "SUSTENTABILIDADE", "tema": "Como gerenciar resíduos (óleo, pneus) com responsabilidade?" },
  { "categoria": "SUSTENTABILIDADE", "tema": "Como sensibilizar colaboradores para o uso consciente de energia e água?" },
  { "categoria": "SUSTENTABILIDADE", "tema": "Como integrar as políticas ambientais às metas corporativas?" },
  { "categoria": "CLIENTE E MERCADO", "tema": "Como garantir entregas pontuais (OTD) para satisfazer o cliente?" },
  { "categoria": "CLIENTE E MERCADO", "tema": "Qual a melhor forma de comunicar proativamente sobre prazos e atrasos?" },
  { "categoria": "CLIENTE E MERCADO", "tema": "Como identificar novas tendências de consumo no setor logístico?" },
  { "categoria": "CLIENTE E MERCADO", "tema": "Como personalizar serviços logísticos para nichos de mercado específicos?" },
  { "categoria": "CLIENTE E MERCADO", "tema": "Qual a forma estratégica de gerenciar reclamações de clientes?" },
  { "categoria": "PRODUTIVIDADE", "tema": "Como otimizar o tempo de carga e descarga (tempo de pátio/gate)?" },
  { "categoria": "PRODUTIVIDADE", "tema": "Como reduzir a ociosidade de veículos e operadores?" },
  { "categoria": "PRODUTIVIDADE", "tema": "Quais métodos 'Lean Logistics' aplicar na operação?"" },
  { "categoria": "LIDERANÇA", "tema": "Como o líder deve inspirar as equipes para o alto desempenho?" },
  { "categoria": "COMUNICAÇÃO", "tema": "Como melhorar a comunicação entre setores (Ex: Comercial x Operação)?" },
  { "categoria": "COMUNICAÇÃO", "tema": "Como padronizar as instruções de serviço (IS) para motoristas?" },
  { "categoria": "COMUNICAÇÃO", "tema": "Como usar a linguagem assertiva (e não agressiva) em reuniões?" },
  { "categoria": "COMUNICAÇÃO", "tema": "Como fortalecer a cultura de diálogo e transparência na empresa?" },
  { "categoria": "COMUNICAÇÃO", "tema": "Como evitar retrabalho causado por falhas de comunicação?" }
];
