# MapCidade Support Analytics

Anonymized, from-scratch reconstruction of a real internal tool's architecture, built for a portfolio. Fictional data only ("MapCidade") — no real company, city, or infrastructure is represented here.

## English

### Problem

Support managers need defensible per-analyst service metrics from a helpdesk API that splits current and archived tickets.

### Solution

An Express service maintains a SQLite mirror with overlapping incremental sync, ratings enrichment and a reconciliation audit. The web dashboard separates incoming and concluded flows and reports SLA against a consistent local calendar.

### Stack

TypeScript, Express, SQLite, Next.js, OData.

### How to run

With Node.js 22.13+, run `npm install`. Start the API with `npm run dev` and the UI with `npm run dev:web` in a second terminal. Run `npm test`, `npm run build` and `npm run lint` to verify the project.

### Demo

Open `http://localhost:4202` and sign in with `manager / demo-manager`. The API seeds its first sync on startup. Change the reporting window or team, open an analyst, and run an incremental sync or mirror audit.

### What I learned

Entry and exit periods answer different operational questions. An overlap window handles late updates and reconciliation checks each candidate against the source before applying a capped cleanup. A seeded OData simulator replaces the external ticketing service.

## Português

### Problema

Gestores de suporte precisam calcular indicadores por analista a partir de uma API que separa chamados recentes e arquivados.

### Solução

Um serviço Express mantém um espelho SQLite com sincronização incremental sobreposta, enriquecimento de avaliações e auditoria de reconciliação. O painel separa entradas e conclusões e calcula o SLA com um calendário local consistente.

### Stack

TypeScript, Express, SQLite, Next.js, OData.

### Como rodar

Com Node.js 22.13+, execute `npm install`. Inicie a API com `npm run dev` e a interface com `npm run dev:web` em outro terminal. Valide com `npm test`, `npm run build` e `npm run lint`.

### Demo

Abra `http://localhost:4202` e entre com `manager / demo-manager`. A primeira sincronização roda na inicialização. Altere o período ou a equipe, abra o detalhe de um analista e rode uma sincronização incremental ou auditoria do espelho.

### O que aprendi

Datas de entrada e saída respondem a perguntas operacionais diferentes. A janela sobreposta captura alterações tardias, e a reconciliação verifica cada candidato na fonte antes de aplicar uma limpeza com limite. Um simulador OData oferece dados sintéticos.
