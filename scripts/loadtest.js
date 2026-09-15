const io = require('socket.io-client');

const SERVER_URL = 'http://localhost:3000';
const CLIENT_COUNT = 20;
const DURATION_SEC = 60;
const TASKS = ['web', 'calc', 'video', 'db'];

let activeClients = 0;
let errors = 0;
let completedTasks = 0;
let stoppedTasks = 0;

console.log(`Iniciando teste de carga com ${CLIENT_COUNT} clientes por ${DURATION_SEC} segundos...`);

for (let i = 0; i < CLIENT_COUNT; i++) {
    setTimeout(() => {
        const socket = io(SERVER_URL, { reconnection: false });
        
        const mode = i < (CLIENT_COUNT / 2) ? 'docker' : 'vm';
        let hbInterval;

        socket.on('connect', () => {
            activeClients++;
            
            socket.emit('set_name', `Bot-${i}`);

            // 1. Escolher ambiente e SO
            const os = Math.random() > 0.5 ? 'win' : 'lin';
            socket.emit('choose', { mode, os });
            
            // 2. Escolher tarefa aleatória
            setTimeout(() => {
                const randomTask = TASKS[Math.floor(Math.random() * TASKS.length)];
                socket.emit('task', randomTask);
                
                // Iniciar heartbeat
                hbInterval = setInterval(() => {
                    socket.emit('hb');
                }, 1000);
            }, 500);
        });

        socket.on('returned', (data) => {
            if (data.reason === 'sucesso') {
                completedTasks++;
            } else {
                stoppedTasks++;
            }
            clearInterval(hbInterval);
            
            // Reassumir nova tarefa se ainda tiver tempo
            setTimeout(() => {
                 const randomTask = TASKS[Math.floor(Math.random() * TASKS.length)];
                 socket.emit('task', randomTask);
                 hbInterval = setInterval(() => { socket.emit('hb'); }, 1000);
            }, 1000);
        });

        socket.on('disconnect', () => {
            activeClients--;
            clearInterval(hbInterval);
        });

        socket.on('connect_error', (err) => {
            errors++;
            console.error(`Erro de conexão no cliente ${i}:`, err.message);
        });

    }, i * 200); // Stagger connection to avoid thunderous herd
}

let timeElapsed = 0;
const monitor = setInterval(() => {
    timeElapsed++;
    process.stdout.write(`\r[${timeElapsed}s / ${DURATION_SEC}s] Clientes Ativos: ${activeClients} | Tarefas Concluídas: ${completedTasks} | Paradas: ${stoppedTasks} | Erros: ${errors}`);
    
    if (timeElapsed >= DURATION_SEC) {
        clearInterval(monitor);
        console.log('\n\nTeste de carga finalizado.');
        process.exit(0);
    }
}, 1000);
