# 🖥️ SO: Máquinas Virtuais vs Docker

Uma demonstração educacional interativa de Sistemas Operacionais! 

Este projeto foi projetado para professores exibirem no telão da sala de aula. Enquanto a simulação roda no telão (servidor), os alunos podem acessar pelo próprio celular para interagir em tempo real, enviando tarefas e visualizando conceitos de **virtualização** e **conteinerização** na prática.

## 🚀 Como Executar

### Opção 1: Via Windows (Mais fácil)
Basta dar dois cliques no arquivo `iniciar.bat`. O sistema irá baixar as dependências e abrir uma porta local automaticamente.

### Opção 2: Via Terminal (Linux/Mac)
1. Instale as dependências: `npm install`
2. Inicie o servidor: `npm start`
3. Abra no navegador: `http://localhost:3000`

---

## 📚 Gabarito Conceitual para Professores: "E no outro ambiente?"

Aqui detalhamos as principais diferenças e o "porquê" de cada comportamento quando comparamos Containers vs Máquinas Virtuais:

### 1. "Container compartilha o kernel do host, limitando recursos com cgroups e namespaces"
* **Veredito:** VERDADEIRO
* **E no outro ambiente (VM)?** Falso. Uma Máquina Virtual roda o seu PRÓPRIO kernel isolado.
* **O porquê da diferença:** Conteinerização é uma virtualização a *nível de sistema operacional* (compartilha o Kernel base para ser extremamente leve e rápido). VMs utilizam virtualização a *nível de hardware* (via Hypervisor), onde cada VM precisa dar boot em um Sistema Operacional completo inteiro, o que consome muita memória e tempo.

### 2. "1 container/VM morrendo derruba só ele mesmo"
* **Veredito:** VERDADEIRO (Para ambos)
* **O porquê da diferença:** Ambos oferecem isolamento contra falhas de aplicação. Um app crashando no Docker não afeta os vizinhos. Na VM também não. A diferença é que a VM oferece uma barreira mais forte e pesada, enquanto o Docker oferece uma barreira ágil baseada em processos.

### 3. "KERNEL PANIC no host derruba TODOS os containers"
* **Veredito:** VERDADEIRO
* **E no outro ambiente (VM)?** Se o Host físico sofrer KERNEL PANIC, todas as VMs caem também. **Mas**, um KERNEL PANIC *dentro do SO convidado (Guest)* afeta apenas aquela VM. Um KERNEL PANIC *dentro* do container não existe (pois ele não tem kernel próprio).
* **O porquê da diferença:** Como todos os containers compartilham o Kernel do Host físico, o Host físico se torna o "Ponto Único de Falha" do SO. Se o Kernel hospedeiro quebrar, nenhum container sobrevive. Na VM, como cada uma tem seu SO independente, uma falha crítica de driver ou Kernel dentro da VM #1 não vaza para a VM #2.

### 4. "Docker no Windows ou Mac roda nativamente"
* **Veredito:** FALSO
* **E no outro ambiente (Linux)?** Verdadeiro, roda de forma 100% nativa.
* **O porquê da diferença:** O motor do Docker baseia-se em recursos exclusivos e primitivos do Kernel Linux (`cgroups` e `namespaces`). O Windows e o macOS possuem seus próprios Kernels incompatíveis. Por isso, ao instalar o Docker Desktop no Windows, ele precisa iniciar silenciosamente uma Máquina Virtual leve nos bastidores (como o **WSL2** ou Hyper-V) apenas para rodar um Kernel Linux invisível e, dentro dele, rodar os seus containers.

---
*(Nota: Para testes de estresse e capacity planning em sala, o servidor backend deste projeto possui um limite fixo de memória (ex: 900MB) para estourar propositalmente e demonstrar gargalos de hardware para a turma).*
