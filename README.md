# SO://VM-vs-DOCKER

Uma demonstração educacional interativa de Sistemas Operacionais (foco em virtualização vs conteinerização). Projetada para professores exibirem em sala de aula (no telão) enquanto os alunos interagem simultaneamente pelo celular.

## Tabela de Gabarito Conceitual (Auditoria V8)

| AFIRMAÇÃO | VEREDITO | ONDE APARECE | CONTEXTO (MODELO/REAL) |
| :--- | :--- | :--- | :--- |
| **Container compartilha o kernel do host, limitando recursos com cgroups e namespaces** | VERDADEIRO | `index.html` (dicas de escolha) e `painel.html` (tabela e teoria) | Real |
| **1 container morrendo derruba só ele** | VERDADEIRO | `server.js` (CRASH_CTR) | Real |
| **KERNEL PANIC no host derruba TODOS os containers (Ponto único de falha)** | VERDADEIRO | `server.js` (KERNEL_PANIC) e Painel (Autópsia) | Real |
| **1 VM morrendo derruba só ela** | VERDADEIRO (com ressalva) | `server.js` (CRASH_VM) | Modelo (Nuance: no host físico real a falha do host derrubaria as VMs também. Na simulação, o domínio de falha modelado da VM é só ela mesma, isolando a falha). |
| **Watchdog previne travamento de software antes de acontecer** | FALSO | `server.js` (WD_COUNT) | Real (Ele atua como resposta pragmática da indústria à impossibilidade de decidir parada de Turing; ele detecta via hardware a falta do pulso e *reage* com reset forçado, não previne.) |
| **Escalonador decide tarefas em fatias chamadas Quantum** | VERDADEIRO | `painel.html` (Overlay de Teoria) | Real (A unidade de processamento no Kernel Linux se chama *task*). |
| **IRQ 1 = Teclado / IRQ 12 = Mouse** | VERDADEIRO | `painel.html` (Overlay de Teoria) | Real (Arquitetura Clássica / Legacy do PC IBM) |
| **Docker no Windows roda nativamente** | FALSO | `painel.html` (Overlay de Teoria) | Real (O Docker Desktop para Mac e Windows cria silenciosamente uma VM leve, tipo WSL2 ou HyperKit, para prover o kernel Linux) |
| **Hierarquia de Memória e Custos: SRAM é barata** | FALSO | `painel.html` (Overlay de Teoria) | Real (L1/SRAM ~1ns e caríssima; DRAM ~70ns e barata/GB; SSD NAND ~100µs e muito barata) |
| **Trits são a base da computação quântica** | FALSO | `painel.html` (Overlay de Teoria) | Real (Computação base 3 "Trits" existiu na URSS com o Setun, 1958, mas não é quântica. O quântico age como coprocessador orquestrado pelo SO clássico) |
| **OverlayFS copia toda a imagem a cada novo container** | FALSO | `painel.html` (Overlay de Teoria) | Real (Containers reusam o *page cache* e camadas de imagem. VMs duplicam tudo, gerando overhead massivo) |

## Como Testar a Estabilidade (Capacity Planning & Loadtest)

O sistema conta com um limitador rígido de `MAX_ALLOC_MB` para simular "Memory Leak Generalizado" ou limite do servidor. O limite é por padrão de 900MB.

### 1. Teste de Carga de Tráfego:
1. Abra um terminal e inicie o backend: `node --expose-gc server.js`
2. Em outro terminal, inicie o stress: `node scripts/loadtest.js` (Simula 20 bots acessando o servidor publicamente ao mesmo tempo).
3. Abra `http://localhost:3000/painel` e veja os bots serem processados, ganhando tarefas (`web`, `compilar`, etc.). O painel **não deve** exibir erros, e os heartbeats devem ser reportados na grade `[MODELO DE SALA]`.

### 2. Teste de Injeção & CAOS (Capacity Planning)
1. No painel, comece a ejetar VMs (+10) pelo botão de atalho.
2. Observe que cada VM pesa centenas de MB na carga da Sala. Eventualmente o servidor estourará e apresentará a mensagem visual `❌ Tarefa Recusada: Capacidade máxima da simulação estourou`.
3. Isso testa a robustez do backend e a capacidade de segurar vazamentos via limites explícitos de `REAL_SCALE`.

### 3. Teste de Watchdog Automático (Recuperação)
1. Com uma VM rodando, injete uma falha clicando em "💀 VM (Convidado)".
2. A vítima receberá uma tela vermelha no celular (`index.html`). O painel inicia contagem do Watchdog (5s).
3. Após o tempo, o Watchdog executa o Reset de Hardware Virtual e o container reinicia sozinho ("Boot em 8s"). A tela da vítima voltará ao ar, registrando o `MTTR` didático. A tela de "Autópsia" registrará que o vizinho não sofreu nenhum dano graças à conteinerização.
