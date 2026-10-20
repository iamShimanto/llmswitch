# LLMSwitch — Run It (OmniRoute-style startup)

Goal: **clone/download kore 2 minute e running** — kono external DB, kono complex setup na.

## 4 ways to run

### 1) npm (easiest)

```bash
npm install -g llmswitch
llmswitch
```

or without installing:

```bash
npx llmswitch
```

### 2) Docker

```bash
docker run -d --name llmswitch --restart unless-stopped \
  -p 127.0.0.1:6000:6000 \
  -v llmswitch-data:/app/data \
  llmswitch/llmswitch:latest
```

### 3) From source (clone & run)

```bash
git clone https://github.com/<org>/llmswitch.git
cd llmswitch
pnpm install
pnpm dev
```

### 4) docker-compose

```bash
docker compose up -d
```

## First run (sob method e same)

1. Dashboard kholo: **http://localhost:6000**
2. **Providers** → provider choose koro → API key add koro (free-tier key diye shuru kora jay)
3. **Endpoints** theke gateway API key copy koro
4. Tomar coding tool e boshao:

```txt
Base URL: http://localhost:6000/v1
API Key:  [dashboard → Endpoints theke copy]
Model:    auto
```

## Local DB

- **SQLite**, zero config. First run e auto-create hoy:
  - npm/source: `./data/llmswitch.db`
  - docker: `/app/data/llmswitch.db` (volume e persist)
- Keys, provider config, usage logs, quotas — sob local DB te. Bahirer kichu lagbe na.
- Scale lagle `DATABASE_URL=postgres://...` dile Postgres e switch (P1).

## Verify

```bash
curl http://localhost:6000/v1/models -H "Authorization: Bearer <tomar-key>"
```

Connected model list dekhalei done 🎉 — ekhon tool theke request pathao, LLMSwitch auto route + fallback korbe.

## Notes

- Port default **`6000`** (mone rakha easy). Busy thakle auto next free port nebe (6001, 6002…) ar console e print korbe — Vite er moto behavior.
- Pin korte chaile: `PORT=4001 llmswitch`
- Data backup = `data/` folder copy korlei hoy
- Dashboard + API ekoi port e (OmniRoute er moto alada port na)
