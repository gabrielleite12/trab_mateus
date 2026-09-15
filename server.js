// server.js — SO://VM-vs-DOCKER v4: threads com tarefas reais + mapa de memória
const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');
const fs = require('fs/promises');
const fsSync = require('fs');
const { Worker } = require('worker_threads');

const REAL_SCALE = parseInt(process.env.REAL_SCALE || '8', 10);
const SANDBOX_DIR = path.join(__dirname, 'sandbox');
if (!fsSync.existsSync(SANDBOX_DIR)) {
    fsSync.mkdirSync(SANDBOX_DIR, { recursive: true });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/painel', (_, r) => r.sendFile(path.join(__dirname, 'public', 'painel.html')));

/* tarefas com tamanhos reais de mercado e durações (segundos) */
const TASKS = {
    web: { name: 'servir página', icon: '🌐', ramMb: 32, cpu: 2, color: '#00e5ff', duration: 15, desc: 'E/S (Rede) Leve: responde rápido a clientes web.' },
    calc: { name: 'calcular primos', icon: '🧮', ramMb: 16, cpu: 25, color: '#39ff88', duration: 20, desc: 'CPU Bound: prende o processador fazendo muita matemática.' },
    video: { name: 'transcodar vídeo', icon: '🎬', ramMb: 256, cpu: 60, color: '#ff3d81', duration: 30, desc: 'Carga Extrema: muita RAM para frames e torra a CPU.' },
    db: { name: 'consultar banco', icon: '🗄️', ramMb: 128, cpu: 10, color: '#ffb020', duration: 25, desc: 'RAM Bound: exige blocos de memória para cache de dados.' },
};
const OVERHEAD = { host: 8 };   // fatia de kernel compartilhado
const OS_OVERHEAD = {
    vm: { win: { ramMb: 1024, cpu: 15 }, lin: { ramMb: 256, cpu: 5 } },
    ctr: { win: { ramMb: 128, cpu: 5 }, lin: { ramMb: 16, cpu: 1 } }
};
const BOOT = { vm: 8000, host: 1500, ctr: 1500 };   // ms
const CORES = 4;
const MAX_ALLOC_MB = parseInt(process.env.MAX_ALLOC_MB || '900', 10);
const WD_DETECT = 5;

const TEXTS = {
    CRASH_CTR: "💥 Falha no {id} (thread #{tid}). O isolamento funcionou: vizinhos intactos. O supervisor resetará o container em 5s. Boot rápido (~1,5s).",
    CRASH_VM_VICTIM: "⚠️ AVISO: Sua {id} teve falha fatal (Tela Azul). Você caiu, mas vizinhos estão seguros pelo isolamento da VM. Reboot em 5s (boot lento: ~8s).",
    CRASH_VM_NEIGHBOR_VM: "✅ Uma VM vizinha ({id}) caiu. Você não sentiu nada: isolamento total de máquina (Hardware).",
    CRASH_VM_NEIGHBOR_CTR: "👀 Uma VM caiu. Seu Container segue intacto (não compartilha nada com ela).",
    KERNEL_PANIC: "☢️ KERNEL PANIC no Servidor! O cérebro principal parou. TODOS os containers caíram juntos. As VMs seguem rodando (têm cérebros independentes).",
    WD_VM_COUNT: "<img src=\"/img/watchdog.png\" style=\"height:16px; vertical-align:middle\"> Watchdog da VM: {id} travou. Reset em {n}s.",
    WD_HOST_COUNT: "<img src=\"/img/watchdog.png\" style=\"height:16px; vertical-align:middle\"> Watchdog do Servidor: {id} travou. Reset em {n}s.",
    SUPERVISOR_THREAD_COUNT: "🩺 Supervisor: thread #{tid} sem pulso. Reset em {n}s.",
    SUPERVISOR_THREAD_ACT: "🩺 Supervisor: thread #{tid} reiniciada com sucesso.",
    WD_POST: "✅ {id} recuperado! Recuperação automática total em {t}s (Alta Disponibilidade na prática).",
    RETURNED: "🔁 Tarefas {icone} concluídas. Memória ({mb} MB) devolvida ao sistema. Desalocar evita vazamentos!",
    TECH: "Resumo: VMs isolam no hardware (pesado). Containers isolam no software (leve). Kernel Panic destrói quem compartilha o kernel."
};

let threadSeq = 0, vmSeq = 0, ctrSeq = 0;
const clients = new Map(); // socket.id -> { mode, os, threadId, machineId, tasks: [], state, lastHb, taskStartedAt, buffer, worker, sandboxFile, wdCd, name }
const machines = new Map(); // id -> { id,type,os,threads:Set,vthreads,state,cd,bootAt,reason,sched:Map,owner,anomaly,anomalyCd,ramAllocated }
const TOTAL_VM_RAM = 16384;

let ipCounterVM = 10, ipCounterCTR = 10;
const newMachine = (id, type, os = 'lin', owner = null) => { 
    let ip = '';
    if (type === 'vm') ip = `192.168.1.${ipCounterVM++}`;
    else if (type === 'ctr') ip = `172.17.0.${ipCounterCTR++}`;
    else ip = `10.0.0.1`;
    const m = { id, type, os, ip, threads: new Set(), vthreads: 0, state: 'running', cd: 0, bootAt: 0, reason: '', sched: new Map(), owner, anomaly: false, anomalyCd: 0 }; machines.set(id, m); return m; 
};
const host = () => machines.get('HOST-1') || newMachine('HOST-1', 'host');
const nThreads = m => m.threads.size + m.vthreads;
const log = (msg, type = 'info') => io.emit('log', { t: new Date().toLocaleTimeString('pt-BR'), msg, type });
function crash(m, why) { if (!m || m.state !== 'running') return; m.state = 'crashed'; m.cd = WD_DETECT; m.reason = why; log(`💥 ${m.id} CRASHOU (${why}) — ${nThreads(m)} thread(s) caíram`, 'warn'); }
function freeResources(c) {
    if (c.worker) {
        c.worker.postMessage({ type: 'stop' });
        c.worker = null;
    }
    if (c.buffer) {
        c.buffer = null; // Remove a referência
        if (global.gc) global.gc(); // Força coleta se possível (--expose-gc)
    }
    if (c.sandboxFile) {
        fs.unlink(c.sandboxFile).catch(() => {});
        c.sandboxFile = null;
    }
}

function leaveMachine(id) {
    const c = clients.get(id); if (!c || !c.machineId) return;
    freeResources(c);
    const m = machines.get(c.machineId);
    if (m) { 
        m.threads.delete(id); m.sched.delete(id); 
        if ((m.type === 'vm' || m.type === 'ctr') && m.id !== 'HOST-1' && nThreads(m) === 0) machines.delete(m.id); 
    }
    c.machineId = null;
    c.mode = null;
    c.tasks = [];
    c.state = 'OCIOSO';
}

const HISTORY = 180;
const history = { labels: [], ramDocker: [], ramVm: [], cpuDocker: [], cpuVm: [] };
let lastCpu = process.cpuUsage(), lastTs = Date.now(), realCpu = 0;
let totalSandboxBytes = 0; // Para rastrear uso real de disco

// Helpers de diretório para tamanho total
function getDiskUsageSync() {
    try {
        let size = 0;
        const files = fsSync.readdirSync(SANDBOX_DIR);
        for (const file of files) {
            size += fsSync.statSync(path.join(SANDBOX_DIR, file)).size;
        }
        return size;
    } catch { return 0; }
}


function computeStats(tick) {
    const now = Date.now();
    if (tick) {
        const dt = Math.max(.2, (now - lastTs) / 1000), cu = process.cpuUsage();
        realCpu = Math.min(100, (((cu.user - lastCpu.user) + (cu.system - lastCpu.system)) / 1e6 / dt) * 100);
        lastCpu = cu; lastTs = now;
        for (const m of machines.values()) {
            if (m.state === 'crashed') {
                if (m.cd === WD_DETECT) {
                    if (m.type === 'host') log(TEXTS.WD_HOST_COUNT.replace('{id}', m.id).replace('{n}', m.cd), 'hack');
                    else log(TEXTS.WD_VM_COUNT.replace('{id}', m.id).replace('{n}', m.cd), 'hack');
                }
                if (--m.cd <= 0) { m.state = 'booting'; m.bootAt = now + BOOT[m.type]; }
            }
            else if (m.state === 'booting' && now >= m.bootAt) { 
                m.state = 'running'; 
                log(TEXTS.WD_POST.replace('{id}', m.id).replace(/\{x\}/g, (BOOT[m.type] / 1000).toFixed(1)).replace('{t}', (3 + 5 + BOOT[m.type]/1000).toFixed(1)), 'ok'); 
            }
            
            /* escalonador: a cada 1s, cada thread com tarefa ganha fatia ou fila */
            if (m.state === 'running') {
                for (const sid of m.threads) {
                    const c = clients.get(sid); 
                    if (!c || !c.tasks || c.tasks.length === 0) continue;
                    
                    // Ciclo de vida da thread
                    const totalDuration = c.tasks.reduce((sum, tid) => sum + (TASKS[tid]?.duration || 0), 0);
                    const totalRam = c.tasks.reduce((sum, tid) => sum + (TASKS[tid]?.ramMb || 0), 0);
                    const icons = c.tasks.map(tid => TASKS[tid]?.icon || '').join('');
                    
                    if (c.state === 'COM_TAREFA' || c.state === 'PRONTA' || c.state === 'RODANDO') {
                        // Verifica Heartbeat (apenas se a máquina não estiver recém-bootada/congelada)
                        if (now - c.lastHb > 3000) {
                            c.state = 'PARADA';
                            c.wdCd = WD_DETECT; // Usa o mesmo tempo de contagem
                            log(`<span style="color:var(--cyan)">${TEXTS.SUPERVISOR_THREAD_COUNT.replace('{tid}', c.threadId).replace('{n}', c.wdCd)}</span>`, 'info');
                        } else {
                            // Verifica Conclusão
                            if (now - c.taskStartedAt >= totalDuration * 1000) {
                                c.state = 'CONCLUÍDA';
                                log(`✅ thread #${c.threadId} concluiu as tarefas ${icons} em ${totalDuration}s!`, 'ok');
                                leaveMachine(sid);
                                const s = io.sockets.sockets.get(sid);
                                const msg = TEXTS.RETURNED.replace('{icone}', icons).replace('{dur}', totalDuration).replace('{mb}', totalRam);
                                if(s) s.emit('returned', { reason: 'sucesso', msg, env: c.mode });
                                continue;
                            }

                            // Escalonamento Normal
                            const isRunning = Math.random() < .7;
                            m.sched.set(sid, isRunning ? { st: 'running', core: Math.floor(Math.random() * CORES) } : { st: 'ready' });
                            c.state = isRunning ? 'RODANDO' : 'PRONTA';
                        }
                    } else if (c.state === 'PARADA') {
                        c.wdCd--;
                        if (c.wdCd <= 0) {
                            log(`<span style="color:var(--cyan)">${TEXTS.SUPERVISOR_THREAD_ACT.replace('{tid}', c.threadId)}</span>`, 'info');
                            c.state = 'LIBERADA';
                            leaveMachine(sid);
                            const s = io.sockets.sockets.get(sid);
                            if(s) s.emit('returned', { reason: 'parada', msg: 'liveness probe falhou (sem heartbeat) — supervisor reiniciou processo', env: c.mode });
                            continue;
                        }
                    }
                }
            } else {
                m.sched.clear();
                for (const sid of m.threads) {
                    const c = clients.get(sid);
                    if (c) c.lastHb = Date.now();
                }
            }
        }
        
        totalSandboxBytes = getDiskUsageSync();
    }

    let ramD = 0, ramV = 0, cpuD = 0, cpuV = 0, dT = 0, vT = 0, idle = 0;
    for (const c of clients.values()) if (!c.mode) idle++;
    
    // Calcula RAM agregada e verifica limite (MAX_ALLOC_MB) se necessário
    // Por enquanto deixaremos a alocação passar
    
    const machinesOut = [];
    let hostUp = host().state === 'running';
    
    for (const m of machines.values()) {
        if (m.id === 'HOST-1') continue; // HOST-1 invisível, state usado pro kernel panic
        
        // Se host caiu, todos os CTRs devem cair.
        if (m.type === 'ctr' && !hostUp && m.state === 'running') {
            m.state = 'crashed';
            m.cd = host().cd;
            m.reason = 'kernel_panic';
        }

        const up = m.state === 'running';
        const baseRam = m.type === 'host' ? OVERHEAD.host : OS_OVERHEAD[m.type][m.os].ramMb;
        const baseCpu = m.type === 'host' ? 0 : OS_OVERHEAD[m.type][m.os].cpu;
        const osName = m.os === 'win' ? 'Janela' : 'Pinguim';
        
        const blocks = [{ who: m.type === 'vm' ? `SO convidado (${osName})` : m.type === 'ctr' ? `SO base (${osName})` : 'fatia kernel', ram: baseRam, color: '#4f9d76' }];
        let ram = baseRam, cpu = baseCpu;
        
        for (const sid of m.threads) {
            const c = clients.get(sid); if (!c || !c.tasks || c.tasks.length === 0) continue;
            let threadRam = 0;
            let icons = '';
            c.tasks.forEach(tid => {
                const t = TASKS[tid];
                if (t) { ram += t.ramMb; cpu += t.cpu; threadRam += t.ramMb; icons += t.icon; }
            });
            const whoName = c.name ? ` (${c.name})` : '';
            blocks.push({ who: `thread #${c.threadId}${whoName} ${icons}`, ram: threadRam, color: TASKS[c.tasks[0]]?.color || '#ffffff', tid: c.threadId });
        }
        if (m.vthreads) { ram += m.vthreads * (TASKS.web?.ramMb || 32); cpu += m.vthreads * (TASKS.web?.cpu || 5); blocks.push({ who: `+${m.vthreads} threads virtuais 🌐`, ram: m.vthreads * (TASKS.web?.ramMb || 32), color: '#2b6f52' }); }

        // Anomaly Override
        if (m.anomaly && up) {
            ram += 800; // Spike RAM
            cpu = 100; // Spike CPU
            blocks.push({ who: `🦠 PROCESSO ANÔMALO (SPAM)`, ram: 800, color: '#ff0000' });
            if (tick) {
                m.anomalyCd--;
                if (m.anomalyCd <= 0) {
                    m.anomaly = false;
                    crash(m, 'Comportamento Estranho (Pico de Uso)');
                    log(`🛡️ Monitor de Segurança desligou preventivamente a ${m.id} por anomalia de consumo.`, 'ok');
                }
            }
        }
        
        let isOOM = false;
        // Limites: VM Pinguim (500MB total), VM Janela (1500MB total), CTR Pinguim (150MB total), CTR Janela (300MB total)
        if (m.type === 'vm' && m.os === 'lin' && ram > 500) isOOM = true;
        if (m.type === 'vm' && m.os === 'win' && ram > 1500) isOOM = true;
        if (m.type === 'ctr' && m.os === 'lin' && ram > 150) isOOM = true;
        if (m.type === 'ctr' && m.os === 'win' && ram > 300) isOOM = true;
        
        if (isOOM && up) {
            crash(m, m.type === 'vm' ? 'OOM (Memória Esgotada no SO Convidado)' : 'OOM Killed (Limite do cgroup atingido)');
            // Expulsa as threads
            const tids = [...m.threads];
            tids.forEach(sid => {
                const c = clients.get(sid);
                if (c) {
                    const s = io.sockets.sockets.get(sid);
                    if (s) s.emit('returned', { reason: 'oom', msg: m.type === 'vm' ? 'Sua VM explodiu por falta de memória (Kernel Panic OOM).' : 'Seu processo consumiu mais que o limite do cgroup e foi morto (OOM Killed).', env: c.mode });
                    leaveMachine(sid);
                }
            });
        }
        
        cpu = Math.min(100, cpu);
        if (m.type === 'ctr') { dT += nThreads(m); if (up) { ramD += ram; cpuD += cpu; } }
        else { vT += nThreads(m); if (up) { ramV += ram; cpuV += cpu; } }
        machinesOut.push({ id: m.id, type: m.type, threads: nThreads(m), state: m.state, cd: m.cd, ram, cpu, blocks, reason: m.reason, owner: m.owner, anomaly: m.anomaly });
    }
    const threadsOut = [];
    for (const c of clients.values()) {
        if (!c.name) continue;
        let sc = null;
        if (c.machineId) {
            const m = machines.get(c.machineId);
            if (m && m.sched) sc = m.sched.get(c.socketId);
        }
        let stOut = sc ? sc.st : 'idle';
        if (c.state === 'PARADA' || c.state === 'LIBERADA') stOut = 'stopped';
        threadsOut.push({ id: c.threadId, name: c.name, tasks: c.tasks, machine: c.machineId, st: stOut, core: sc ? sc.core : null, threadState: c.state, wdCd: c.wdCd });
    }
    const usedVmRam = Array.from(machines.values()).filter(m => m.type === 'vm').reduce((sum, mx) => sum + (mx.ramAllocated || 0), 0);
    const s = {
        ts: now, tick,
        users: { online: clients.size, threads: dT + vT, docker: dT, vm: vT, idle },
        sim: { ramDocker: Math.round(ramD), ramVm: Math.round(ramV), cpuDocker: +Math.max(0, cpuD / CORES).toFixed(1), cpuVm: +Math.max(0, cpuV / CORES).toFixed(1) },
        machines: machinesOut, threads: threadsOut,
        watchdog: { alert: machinesOut.filter(m => m.state !== 'running').map(m => ({ id: m.id, type: m.type, state: m.state, cd: m.cd, reason: m.reason })) },
        real: { memMb: Math.round(process.memoryUsage().rss / 1048576), alocMb: Math.round((ramD + ramV) / REAL_SCALE), cpu: +realCpu.toFixed(1), uptime: Math.round(process.uptime()), diskKb: Math.round(totalSandboxBytes / 1024) },
        vmServer: { total: TOTAL_VM_RAM, used: usedVmRam }
    };
    if (tick) {
        history.labels.push(new Date(now).toLocaleTimeString('pt-BR'));
        history.ramDocker.push(s.sim.ramDocker); history.ramVm.push(s.sim.ramVm);
        history.cpuDocker.push(s.sim.cpuDocker); history.cpuVm.push(s.sim.cpuVm);
        if (history.labels.length > HISTORY) Object.values(history).forEach(a => a.shift());
    }
    return s;
}

io.on('connection', socket => {
    const threadId = ++threadSeq;
    clients.set(socket.id, { mode: null, os: null, threadId, machineId: null, tasks: [], socketId: socket.id, state: 'CONECTADO', lastHb: Date.now(), taskStartedAt: 0, buffer: null, worker: null, sandboxFile: null, wdCd: 0 });
    socket.emit('boot', { history, threadId, tasks: TASKS, env: { overhead: OS_OVERHEAD, boot: BOOT, cores: CORES, realScale: REAL_SCALE } });
    log(`🧵 thread #${threadId} conectou (${clients.size} online)`, 'ok');
    io.emit('stats', computeStats(false));

    socket.on('set_name', name => {
        const c = clients.get(socket.id); if (!c) return;
        c.name = name;
    });

    socket.on('choose', data => {
        const c = clients.get(socket.id); if (!c) return;
        leaveMachine(socket.id);
        const { mode, os } = data;
        const osName = os === 'win' ? 'win' : 'lin';

        if (mode === 'vm') {
            const usedVmRam = Array.from(machines.values()).filter(m => m.type === 'vm').reduce((sum, mx) => sum + (mx.ramAllocated || 0), 0);
            const available = TOTAL_VM_RAM - usedVmRam;
            if (available < 512) {
                return socket.emit('aviso_personalizado', `⚠️ Servidor Bare-Metal Lotado (100% dos ${TOTAL_VM_RAM}MB ocupados)! O hardware não aguenta subir essa máquina! Tente usar o Container (Docker) para ver como ele consegue alocar mais instâncias no mesmo hardware.`);
            }
            let alloc = Math.floor(available * (0.4 + Math.random() * 0.2));
            alloc = Math.max(512, alloc);
            
            c.mode = 'vm';
            c.os = osName;
            c.state = 'ALOCADO';
            const m = newMachine(`VM-${String(++vmSeq).padStart(2, '0')}`, 'vm', c.os, c.name);
            m.ramAllocated = alloc;
            m.threads.add(socket.id);
            c.machineId = m.id;
        } else if (mode === 'docker') {
            c.mode = 'docker';
            c.os = osName;
            c.state = 'ALOCADO';
            const m = newMachine(`CTR-${String(++ctrSeq).padStart(2, '0')}`, 'ctr', c.os, c.name);
            m.threads.add(socket.id);
            c.machineId = m.id;
        }

        const mx = machines.get(c.machineId);
        socket.emit('assign', c.mode ? { threadId: c.threadId, machineId: c.machineId, type: c.mode, tasks: c.tasks, state: c.state, os: c.os, ramAllocated: mx ? mx.ramAllocated : null, ip: mx ? mx.ip : null } : null);
        
        const threadName = c.name ? ` (${c.name})` : '';
        log(c.mode ? `🧵 thread #${c.threadId}${threadName} alocado → ${c.machineId}` : `🧵 thread #${c.threadId}${threadName} liberado`, c.mode === 'vm' ? 'warn' : 'ok');
        io.emit('stats', computeStats(false));
    });

    socket.on('task', async taskList => {
        const c = clients.get(socket.id); if (!c) return;
        if (c.tasks && c.tasks.length > 0) freeResources(c);
        
        c.tasks = [];
        if (Array.isArray(taskList)) {
            taskList.forEach(tid => {
                if (TASKS[tid]) c.tasks.push(tid);
            });
        } else if (typeof taskList === 'string' && TASKS[taskList]) {
            c.tasks.push(taskList);
        }
        
        if (c.tasks.length > 0 && c.machineId) {
            // Calcula total de RAM solicitada
            const totalRamRequested = c.tasks.reduce((sum, tid) => sum + TASKS[tid].ramMb, 0);
            
            const currentAloc = Math.round((Array.from(machines.values()).reduce((sum, mx) => sum + (mx.type === 'host' ? OVERHEAD.host : OS_OVERHEAD[mx.type][mx.os].ramMb) + (mx.vthreads * 32) + Array.from(mx.threads).reduce((s, sid) => s + (clients.get(sid)?.tasks?.reduce((s2, t2) => s2 + TASKS[t2].ramMb, 0) || 0), 0), 0)) / REAL_SCALE);
            if (currentAloc + (totalRamRequested / REAL_SCALE) > MAX_ALLOC_MB) {
                log(`❌ Tarefa Recusada: Capacidade máxima da simulação estourou. (Máx ${MAX_ALLOC_MB}MB).`, 'warn');
                c.tasks = [];
                return socket.emit('aviso_personalizado', `
                <div style="text-align: center; margin-bottom: 15px;">
                    <div style="font-size: 3rem; margin-bottom: 10px;">💥</div>
                    <h2 style="color: #ff3d81; margin: 0;">MEMÓRIA INSUFICIENTE</h2>
                </div>
                <p>O Servidor Físico não aguentou! A capacidade máxima da simulação (<b>${MAX_ALLOC_MB} MB</b>) estourou.</p>
                <p><b>O que aconteceu?</b> Você e seus colegas abriram tantas tarefas e ambientes que consumiram toda a memória RAM disponível no provedor físico.</p>
                <p><b>Lição:</b> A "Nuvem" não é mágica, é apenas o computador de outra pessoa. Todo ambiente virtual (VM ou Docker) compartilha de um limite físico inescapável (Capacity Planning).</p>
                `);
            }

            c.state = 'COM_TAREFA';
            c.taskStartedAt = Date.now();
            c.lastHb = Date.now();
            
            // 1. Alocar RAM Real
            const realBytes = Math.floor((totalRamRequested * 1024 * 1024) / REAL_SCALE);
            c.buffer = Buffer.alloc(realBytes); // Enche de zeros
            
            // 2. Alocar Disco Real
            const safeTaskName = c.tasks.slice(0, 3).join('-') + (c.tasks.length > 3 ? '-etc' : '');
            const filename = path.join(SANDBOX_DIR, `thread-${c.threadId}-${safeTaskName}.bin`);
            c.sandboxFile = filename;
            try {
                await fs.writeFile(filename, c.buffer); // Usa o buffer já alocado
            } catch(e) { console.error('Erro ao escrever arquivo sandbox', e); }
            
            // 3. Alocar CPU Worker
            let totalCpuRequested = c.tasks.reduce((sum, tid) => sum + TASKS[tid].cpu, 0);
            for(let cx of clients.values()) if (cx.tasks && cx.tasks.length > 0) totalCpuRequested += cx.tasks.reduce((sum, tid) => sum + TASKS[tid].cpu, 0);
            let duty = c.tasks.reduce((sum, tid) => sum + TASKS[tid].cpu, 0) / 100;
            if (totalCpuRequested > 200) {
                // Escala para baixo se passar do limite de 2 núcleos
                duty = duty * (200 / totalCpuRequested);
            }
            
            c.worker = new Worker(path.join(__dirname, 'scripts', 'cpu-worker.js'));
            c.worker.postMessage({ type: 'start', dutyCycle: duty });
            
        } else {
            c.state = 'ALOCADO';
            freeResources(c);
        }
        
        const mx = machines.get(c.machineId);
        socket.emit('assign', c.mode ? { threadId: c.threadId, machineId: c.machineId, type: c.mode, tasks: c.tasks, state: c.state, os: c.os, ramAllocated: mx ? mx.ramAllocated : null, ip: mx ? mx.ip : null } : null);
        
        const threadName = c.name ? ` (${c.name})` : '';
        const icons = c.tasks.map(tid => TASKS[tid]?.icon || '').join('');
        const names = c.tasks.map(tid => TASKS[tid]?.name || '').join(', ');
        const totalRam = c.tasks.reduce((sum, tid) => sum + (TASKS[tid]?.ramMb || 0), 0);
        log(c.tasks.length > 0 ? `🧵 thread #${c.threadId}${threadName} assumiu tarefas ${icons} ${names} (${totalRam} MB) — escala 1:${REAL_SCALE}` : `🧵 thread #${c.threadId}${threadName} largou a tarefa`, 'ok');
        io.emit('stats', computeStats(false));
    });

    socket.on('sameTask', () => {
        // Atribui tarefa leve padrão a todas as threads ociosas
        let assigned = 0;
        for (const c of clients.values()) {
            if (c.mode && (!c.tasks || c.tasks.length === 0) && c.machineId) {
                c.tasks = ['web'];
                c.task = 'web';
                c.state = 'COM_TAREFA';
                c.taskStartedAt = Date.now();
                c.lastHb = Date.now();
                const t = TASKS[c.task];
                const realBytes = Math.floor((t.ramMb * 1024 * 1024) / REAL_SCALE);
                c.buffer = Buffer.alloc(realBytes);
                const filename = path.join(SANDBOX_DIR, `thread-${c.threadId}-web.bin`);
                c.sandboxFile = filename;
                fs.writeFile(filename, c.buffer).catch(()=>{});
                let totalCpuRequested = 0;
                for(let cx of clients.values()) if (cx.tasks && cx.tasks.length > 0) totalCpuRequested += cx.tasks.reduce((sum, tid) => sum + TASKS[tid].cpu, 0);
                let duty = t.cpu / 100;
                if (totalCpuRequested > 200) duty = duty * (200 / totalCpuRequested);
                c.worker = new Worker(path.join(__dirname, 'scripts', 'cpu-worker.js'));
                c.worker.postMessage({ type: 'start', dutyCycle: duty });
                io.to(c.socketId).emit('assign', { threadId: c.threadId, machineId: c.machineId, type: c.mode, tasks: c.tasks, state: c.state, os: c.os });
                assigned++;
            }
        }
        if (assigned > 0) {
            log(`[PANEL] ${assigned} threads receberam a mesma tarefa via SAMETASK`, 'hack');
            io.emit('stats', computeStats(false));
        }
    });

    socket.on('hb', () => {
        const c = clients.get(socket.id);
        if (c && c.state !== 'PARADA') {
            c.lastHb = Date.now();
            if (c.state === 'OCIOSO') c.state = 'CONECTADO'; // Apenas para debug
        }
    });

    socket.on('disconnect', () => {
        const c = clients.get(socket.id);
        leaveMachine(socket.id); clients.delete(socket.id);
        log(`🧵 thread #${c?.threadId} desconectou (${clients.size} online)`, 'dim');
        io.emit('stats', computeStats(false));
    });

    socket.on('panel:inject', ({ mode, n, presenterName }) => {
        n = Math.max(1, Math.min(50, +n || 1));
        if (mode === 'docker') { 
            const h = host();
            h.vthreads += n; h.state = 'running';
            log(`[PANEL] ${presenterName || 'Professor'} injetou ${n} containers virtuais`, 'hack'); 
        }
        if (mode === 'vm') { 
            for (let i = 0; i < n; i++) {
                const usedVmRam = Array.from(machines.values()).filter(m => m.type === 'vm').reduce((sum, mx) => sum + (mx.ramAllocated || 0), 0);
                const available = TOTAL_VM_RAM - usedVmRam;
                if (available < 512) break;
                let alloc = Math.max(512, Math.floor(available * 0.4));
                const os = Math.random() > 0.5 ? 'win' : 'lin';
                const m = newMachine(`VM-V${String(++vmSeq).padStart(2, '0')}`, 'vm', os, presenterName); 
                m.ramAllocated = alloc;
                m.vthreads = 1;
            }
            log(`[PANEL] ${presenterName || 'Professor'} injetou ${n} VMs virtuais`, 'hack'); 
        }
        io.emit('stats', computeStats(false));
    });

    socket.on('panel:anomaly', (presenterName) => {
        const runningVMs = Array.from(machines.values()).filter(m => m.type === 'vm' && m.state === 'running' && !m.anomaly);
        if (!runningVMs.length) return log(`[PANEL] ${presenterName || 'Professor'} tentou injetar anomalia, mas nenhuma VM está rodando.`, 'dim');
        const m = runningVMs[Math.floor(Math.random() * runningVMs.length)];
        m.anomaly = true;
        m.anomalyCd = 6;
        log(`🦠 [PANEL] ${presenterName || 'Professor'} injetou comportamento estranho na ${m.id}.`, 'warn');
        io.emit('stats', computeStats(false));
    });
    socket.on('panel:crashCtr', () => {
        const v = [...machines.values()].filter(m => m.type === 'ctr' && m.state === 'running' && m.id !== 'HOST-1');
        if (!v.length) return log('[PANEL] nenhum container rodando', 'dim');
        const target = v[Math.floor(Math.random() * v.length)];
        crash(target, 'falha no processo');
        
        const tid = target.threads.values().next().value;
        const c = tid ? clients.get(tid) : null;
        const msg = TEXTS.CRASH_CTR.replace('{id}', target.id).replace('{tid}', c ? c.threadId : '(Virtual)');
        
        log(msg, 'hack');
        io.emit('autopsia', { dropped: target.id, who: c ? c.name || `Thread #${c.threadId}` : 'Bots Virtuais', isolated: 'Isolamento de processo conteve o dano', safe: 'Outros containers', recovery: '1.5s (Reset de Processo)' });
        io.emit('stats', computeStats(false));
    });

    socket.on('panel:crashVm', () => {
        const v = [...machines.values()].filter(m => m.type === 'vm' && m.state === 'running');
        if (!v.length) return log('[PANEL] nenhuma VM rodando', 'dim');
        const target = v[Math.floor(Math.random() * v.length)];
        
        io.emit('countdown', { type: 'crashVm', seconds: 3 });
        setTimeout(() => {
            crash(target, 'falha no SO convidado');
            const tid = target.threads.values().next().value;
            const c = tid ? clients.get(tid) : null;
            
            // Avisar Vítima
            if (c && c.socketId) io.to(c.socketId).emit('aviso_personalizado', `<div style="text-align:center"><div style="font-size:3rem; margin-bottom:10px">💥</div><h3 style="color:var(--magenta); margin:0 0 15px 0">VM DESTRUÍDA!</h3></div>
<p><b>O QUE É?</b> Uma Máquina Virtual (VM) emula todo o Hardware e tem seu próprio Kernel.</p>
<p><b>O QUE FAZ?</b> Garante que tudo o que acontece lá dentro fique isolado do servidor principal e dos vizinhos.</p>
<p><b>O QUE ACONTECEU AQUI?</b> O Professor destruiu a <b>sua</b> máquina (${target.id})! Mas como o isolamento é por hardware, só você caiu. A falha ficou contida.</p>`);
            
            // Avisar vizinhos
            for (const [sid, client] of clients.entries()) {
                if (sid !== (c?c.socketId:null) && client.mode) {
                    io.to(sid).emit('aviso_personalizado', `<div style="text-align:center"><div style="font-size:3rem; margin-bottom:10px">💥</div><h3 style="color:var(--magenta); margin:0 0 15px 0">VM VIZINHA DESTRUÍDA!</h3></div>
<p><b>O QUE É / O QUE FAZ?</b> A Máquina Virtual (VM) possui um isolamento forte (nível de hardware).</p>
<p><b>O QUE ACONTECEU AQUI?</b> O Professor explodiu a máquina virtual ${target.id}. Graças ao isolamento extremo da arquitetura de VM, a falha não se espalhou. Você continua rodando perfeitamente seguro!</p>`);
                }
            }

            io.emit('autopsia', { dropped: target.id, who: 'Professor (Painel)', isolated: 'Kernel próprio parou a falha', safe: 'Vizinhos VM e CTRs', recovery: '8s (Boot de SO completo)' });
            io.emit('stats', computeStats(false));
        }, 3000);
    });

    socket.on('panel:crashKernel', () => {
        log(TEXTS.KERNEL_PANIC, 'hack');
        host().state = 'crashed'; host().cd = WD_DETECT; host().reason = 'kernel_panic';
        
        // Todos os ctr caem juntos
        const ctrs = [...machines.values()].filter(m => m.type === 'ctr' && m.state === 'running');
        ctrs.forEach(m => { m.state = 'crashed'; m.cd = WD_DETECT; m.reason = 'kernel_panic'; });
        
        const msg = `<div style="text-align:center"><div style="font-size:3rem; margin-bottom:10px">☠️</div><h3 style="color:var(--amber); margin:0 0 15px 0">KERNEL PANIC!</h3></div>
<p><b>O QUE É?</b> O "Cérebro" do Sistema Operacional sofreu um erro crítico e travou.</p>
<p><b>O QUE FAZ?</b> Quando o Kernel trava, todo o hardware perde o gerente e nada mais processa.</p>
<p><b>O QUE ACONTECEU AQUI?</b> O Professor causou um Kernel Panic no HOST-1. Como os Containers <b>compartilham o Kernel</b>, TODOS eles morreram juntos! As VMs seguem intactas pois possuem seus próprios Kernels isolados.</p>`;
        io.emit('aviso_personalizado', msg);
        
        io.emit('autopsia', { dropped: 'HOST Kernel', who: 'Professor (Painel)', isolated: 'VMs têm kernels isolados', safe: 'VMs intactas', recovery: '1.5s (Reset de Kernel Host)' });
        io.emit('stats', computeStats(false));
    });

    socket.on('student:hack', (data) => {
        const hackerName = data.name || `Thread #${clients.get(socket.id)?.threadId || '?'}`;
        if (data.mode === 'docker') {
            const msg = `<div style="text-align:center"><div style="font-size:3rem; margin-bottom:10px">☠️</div><h3 style="color:var(--amber); margin:0 0 15px 0">KERNEL PANIC!</h3></div>
<p><b>O QUE É?</b> O "Cérebro" do Sistema Operacional sofreu um erro crítico.</p>
<p><b>O QUE FAZ?</b> Quando o Kernel trava, todo o hardware perde o gerente.</p>
<p><b>O QUE ACONTECEU AQUI?</b> O Hacker <b>${hackerName}</b> atacou o Kernel do Docker. Como os Containers compartilham o Kernel, TODOS caíram juntos! As VMs seguem intactas.</p>`;
            log(`☢️ KERNEL PANIC provocado pelo Hacker ${hackerName}! O cérebro principal parou. TODOS os containers caíram juntos. As VMs seguem rodando.`, 'hack');
            host().state = 'crashed'; host().cd = WD_DETECT; host().reason = 'kernel_panic';
            const ctrs = [...machines.values()].filter(m => m.type === 'ctr' && m.state === 'running');
            ctrs.forEach(m => { m.state = 'crashed'; m.cd = WD_DETECT; m.reason = 'kernel_panic'; });
            io.emit('autopsia', { dropped: 'HOST Kernel', who: hackerName, isolated: 'VMs têm kernels isolados', safe: 'VMs intactas', recovery: '1.5s (Reset Host)' });
            io.emit('aviso_personalizado', msg);
        } else if (data.mode === 'vm') {
            const target = machines.get(data.machineId);
            if (!target || target.state !== 'running') return;
            const msg = `<div style="text-align:center"><div style="font-size:3rem; margin-bottom:10px">⚠️</div><h3 style="color:var(--magenta); margin:0 0 15px 0">VM DESTRUÍDA!</h3></div>
<p><b>O QUE É?</b> A Máquina Virtual (VM) emula o hardware, possuindo um isolamento extremo.</p>
<p><b>O QUE ACONTECEU AQUI?</b> O Hacker <b>${hackerName}</b> destruiu a máquina virtual ${target.id}! O isolamento conteve o dano apenas na VM dele e não se espalhou para o servidor.</p>`;
            log(`⚠️ O Hacker ${hackerName} destruiu a própria máquina virtual (${target.id})! O isolamento da VM salvou o resto do sistema.`, 'warn');
            crash(target, 'ataque hacker isolado');
            io.emit('autopsia', { dropped: target.id, who: hackerName, isolated: 'Kernel próprio da VM conteve a falha', safe: 'Vizinhos', recovery: '8s (Boot VM)' });
            io.emit('aviso_personalizado', msg);
        }
        io.emit('stats', computeStats(false));
    });

    socket.on('student:nmap', () => {
        const c = clients.get(socket.id);
        if (!c || c.mode !== 'vm') return;
        const activeIPs = [...machines.values()].filter(m => m.state === 'running' && m.ip && m.id !== 'HOST-1').map(m => ({ ip: m.ip, type: m.type, os: m.os }));
        socket.emit('terminal:nmap_result', activeIPs);
    });

    socket.on('student:ddos', (targetIp) => {
        const hackerName = clients.get(socket.id)?.name || `Thread #${clients.get(socket.id)?.threadId || '?'}`;
        const target = [...machines.values()].find(m => m.ip === targetIp && m.state === 'running');
        if (!target) return socket.emit('terminal:log', `\nErro: Destino ${targetIp} inacessível (Host Down).`);

        if (target.type === 'ctr') {
            const msg = `<div style="text-align:center"><div style="font-size:3rem; margin-bottom:10px">☠️</div><h3 style="color:var(--amber); margin:0 0 15px 0">KERNEL PANIC!</h3></div>
<p><b>O QUE É?</b> O "Cérebro" do Sistema Operacional sofreu um erro crítico.</p>
<p><b>O QUE ACONTECEU AQUI?</b> O Hacker <b>${hackerName}</b> disparou um Ataque DDoS contra o Container ${target.ip}. A carga absurda de rede esgotou os Sockets do <b>Kernel do Host</b>! TODOS OS CONTAINERS caíram juntos! As VMs seguem isoladas e imunes.</p>`;
            log(`☢️ KERNEL PANIC provocado por DDoS do Hacker ${hackerName} contra o Container ${target.ip}!`, 'hack');
            host().state = 'crashed'; host().cd = WD_DETECT; host().reason = 'kernel_panic';
            const ctrs = [...machines.values()].filter(m => m.type === 'ctr' && m.state === 'running');
            ctrs.forEach(m => { m.state = 'crashed'; m.cd = WD_DETECT; m.reason = 'kernel_panic'; });
            io.emit('autopsia', { dropped: 'HOST Kernel', who: hackerName, isolated: 'VMs imunes', safe: 'VMs intactas', recovery: '1.5s (Reset Host)' });
            io.emit('aviso_personalizado', msg);
            socket.emit('terminal:log', `\n[!!!] Ataque DDoS ao IP ${targetIp} foi letal. O Kernel do servidor principal crashou e levou todos os containers junto!`);
        } else if (target.type === 'vm') {
            const msg = `<div style="text-align:center"><div style="font-size:3rem; margin-bottom:10px">⚠️</div><h3 style="color:var(--magenta); margin:0 0 15px 0">VM DESTRUÍDA POR DDOS!</h3></div>
<p><b>O QUE É?</b> A Máquina Virtual (VM) emula o hardware.</p>
<p><b>O QUE ACONTECEU AQUI?</b> O Hacker <b>${hackerName}</b> disparou um DDoS contra o IP ${target.ip}. Apenas esta VM superaqueceu e caiu. Graças ao isolamento da VM, os recursos e as outras máquinas da rede continuam perfeitamente intactos.</p>`;
            log(`⚠️ O Hacker ${hackerName} derrubou a VM ${target.id} com um DDoS massivo!`, 'warn');
            crash(target, 'ataque ddos');
            io.emit('autopsia', { dropped: target.id, who: hackerName, isolated: 'O ataque ficou confinado na VM', safe: 'Resto da Rede', recovery: '8s (Boot VM)' });
            io.emit('aviso_personalizado', msg);
            socket.emit('terminal:log', `\n[ OK ] Ataque DDoS bem-sucedido. A Máquina Virtual ${target.ip} foi destruída e está offline.`);
        }
        io.emit('stats', computeStats(false));
    });

    socket.on('student:malware', () => {
        const c = clients.get(socket.id);
        if (!c || !c.machineId) return;
        const target = machines.get(c.machineId);
        if (!target || target.state !== 'running') return;
        
        const hackerName = c.name || `Thread #${c.threadId}`;

        if (target.type === 'ctr') {
            const msg = `<div style="text-align:center"><div style="font-size:3rem; margin-bottom:10px">☠️</div><h3 style="color:var(--amber); margin:0 0 15px 0">CONTAINER ESCAPE!</h3></div>
<p><b>O QUE É?</b> Escalonamento de Privilégios. O malware explorou uma falha e "vazou" do Container para o Kernel do Servidor.</p>
<p><b>O QUE ACONTECEU AQUI?</b> O aluno <b>${hackerName}</b> rodou um vírus como ROOT num Container. Como os Containers não possuem um Kernel próprio, o vírus invadiu o Kernel Compartilhado do Servidor Físico! TODA A REDE DOCKER FOI INFECTADA E CAIU JUNTA!</p>`;
            log(`☢️ CONTAINER ESCAPE provocado por ${hackerName}! O malware vazou do container e destruiu o Host físico.`, 'hack');
            host().state = 'crashed'; host().cd = WD_DETECT; host().reason = 'container_escape';
            const ctrs = [...machines.values()].filter(m => m.type === 'ctr' && m.state === 'running');
            ctrs.forEach(m => { m.state = 'crashed'; m.cd = WD_DETECT; m.reason = 'kernel_panic'; });
            io.emit('autopsia', { dropped: 'HOST Kernel', who: hackerName, isolated: 'VMs imunes', safe: 'VMs intactas', recovery: '1.5s (Reset Host)' });
            io.emit('aviso_personalizado', msg);
            socket.emit('terminal:log', `\n[FATAL] O malware escapou do container e alcançou o ring 0 do Servidor Físico.\nKernel Panic provocado com sucesso.\nA conexão será perdida...`);
        } else if (target.type === 'vm') {
            const msg = `<div style="text-align:center"><div style="font-size:3rem; margin-bottom:10px">⚠️</div><h3 style="color:var(--magenta); margin:0 0 15px 0">VM INFECTADA E DESTRUÍDA!</h3></div>
<p><b>O QUE É?</b> Malware executado com nível de Administrador (Root).</p>
<p><b>O QUE ACONTECEU AQUI?</b> O aluno <b>${hackerName}</b> executou um malware com privilégios SUDO na própria máquina e destruiu sua VM! MAS, como a VM possui <b>isolamento de Hardware (Hypervisor)</b>, o vírus ficou 'preso' lá dentro. O Servidor Físico e os colegas estão 100% seguros.</p>`;
            log(`⚠️ O aluno ${hackerName} executou um malware (Root) na própria VM e a destruiu. O isolamento conteve o vírus.`, 'warn');
            crash(target, 'malware executado (isolado)');
            io.emit('autopsia', { dropped: target.id, who: hackerName, isolated: 'Vírus preso no Hardware Virtual da VM', safe: 'Resto do Servidor', recovery: '8s (Boot VM)' });
            io.emit('aviso_personalizado', msg);
            socket.emit('terminal:log', `\n[ ROOT ] Malware executado com sucesso!\nApagando sistema de arquivos...\nConexão perdida.`);
        }
        io.emit('stats', computeStats(false));
    });

    socket.on('panel:triggerWatchdog', () => {
        const running = Array.from(clients.values()).filter(c => c.state === 'COM_TAREFA' || c.state === 'PRONTA' || c.state === 'RODANDO');
        if (!running.length) return log('[PANEL] nenhuma thread em execução para acionar o supervisor', 'dim');
        const c = running[Math.floor(Math.random() * running.length)];
        c.state = 'PARADA';
        c.wdCd = WD_DETECT; 
        const threadName = c.name ? ` (${c.name})` : '';
        log(`[PANEL] <span style="color:var(--cyan)">🩺 Supervisor software acionado manualmente na thread #${c.threadId}${threadName}</span>`, 'info');
        io.emit('stats', computeStats(false));
    });

    socket.on('panel:chaos', () => {
        const n = 4 + Math.floor(Math.random() * 5);
        if (Math.random() > .5) { 
            for (let i = 0; i < n; i++) {
                const os = Math.random() > 0.5 ? 'win' : 'lin';
                const m = newMachine(`CTR-V${String(++ctrSeq).padStart(2, '0')}`, 'ctr', os); m.vthreads = 1;
            }
            log(`[PANEL] CAOS +${n} containers virtuais`, 'hack'); 
        } else { 
            for (let i = 0; i < n; i++) {
                const usedVmRam = Array.from(machines.values()).filter(mx => mx.type === 'vm').reduce((sum, mx) => sum + (mx.ramAllocated || 0), 0);
                const available = TOTAL_VM_RAM - usedVmRam;
                if (available < 512) break;
                let alloc = Math.max(512, Math.floor(available * 0.4));
                const os = Math.random() > 0.5 ? 'win' : 'lin';
                const m = newMachine(`VM-V${String(++vmSeq).padStart(2, '0')}`, 'vm', os); 
                m.ramAllocated = alloc;
                m.vthreads = 1;
            }
            log(`[PANEL] CAOS +${n} VMs virtuais`, 'hack'); 
        }
        io.emit('stats', computeStats(false));
    });
    socket.on('panel:reset', () => {
        for(let c of clients.values()) freeResources(c);
        machines.clear(); clients.forEach(c => { c.mode = null; c.machineId = null; c.tasks = []; c.state = 'OCIOSO'; });
        Object.values(history).forEach(a => a.length = 0);
        
        // Limpar diretório sandbox
        fs.readdir(SANDBOX_DIR).then(files => {
            for (const file of files) fs.unlink(path.join(SANDBOX_DIR, file)).catch(()=>{});
        });

        log('[PANEL] RESET', 'hack'); io.emit('assign', null);
        io.emit('boot', { history }); io.emit('stats', computeStats(false));
    });
});

setInterval(() => io.emit('stats', computeStats(true)), 1000);

process.on('exit', () => {
    for (const c of clients.values()) if (c.worker) c.worker.postMessage({ type: 'stop' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ v4 na porta ${server.address().port} — público / · painel /painel`));