# accounted-imap-intake

Automatiskt e-postintag för [Accounted](https://accounted.se) (self-hostad):
pollar ett IMAP-konto och laddar upp PDF- och bildbilagor till Accounteds
inkorg, där OCR och AI-extraktion körs. Mejlen lämnas orörda i INBOX.

**Flöde:**

```
IMAP (993/TLS, poll var 60:e sek)
   └─> extraherar bilagor (PDF, JPEG, PNG, HEIC, WebP, max 10 MB)
        └─> Accounted MCP: gnubok_create_document_upload → PUT → gnubok_complete_document_upload
             └─> dokument + inkorgspost med OCR (dubblettskydd på serversidan)
```

Egenheter:

- **Ingen exponerad port** — containern gör bara utgående anrop (IMAP + Accounted)
- **Restart-säkert** — UID-baserat state; inga dubbelladdningar efter omstart
- **Felkö** — misslyckade bilagor sparas på disk med metadata, tjänsten fortsätter
- **Minimal API-nyckel** — behöver bara `transactions:write`-scope, kan pin:as till ett företag

## Förutsättningar

- En self-hostad Accounted-installation som containern når över nätverket
  (t.ex. `http://192.168.x.x:3000` i samma LAN)
- Ett IMAP-konto som tar emot fakturor (t.ex. `faktura@dittforetag.se`)
- Docker + Docker Compose

## Installation

1. **Skapa en API-nyckel i Accounted:** Inställningar → API-nycklar → ny nyckel
   med scope `transactions:write` (och pin:a den till ditt företag). Kopiera
   `gnubok_sk_...`-värdet — det visas bara en gång.

2. **Klona repot och skapa din konfiguration:**

   ```bash
   git clone https://github.com/Forkliftx/accounted-imap-intake.git
   cd accounted-imap-intake
   cp .env.example .env
   ```

3. **Fyll i `.env`** med dina egna uppgifter (IMAP-konto + Accounted-URL + API-nyckel).

4. **Starta:**

   ```bash
   docker compose up -d --build
   docker logs -f imap-intake   # följ loggen
   ```

5. **Testa:** skicka ett mejl med en PDF-bilaga till inkorgs-adressen.
   Inom en minut dyker den upp i Accounteds inkorg.

## Konfiguration (.env)

| Variabel | Beskrivning | Standard |
|---|---|---|
| `IMAP_HOST` | IMAP-server (obligatorisk) | — |
| `IMAP_PORT` | IMAP-port | `993` |
| `IMAP_USER` | Inkorgens adress (obligatorisk) | — |
| `IMAP_PASS` | Inkorgens lösenord (obligatorisk) | — |
| `ACCOUNTED_URL` | Accounted-bas-URL (obligatorisk) | — |
| `ACCOUNTED_API_KEY` | `gnubok_sk_…` (obligatorisk) | — |
| `POLL_INTERVAL_MS` | Pollintervall i millisekunder | `60000` |

## Drift

- Omstart: `docker compose restart`
- Uppdatera kod: `docker compose up -d --build --force-recreate`
- Felkön: `ls ./data/errors/` — bilagor + JSON-metadata om orsak
- State: `./data/state.json` (radera för att börja om från UID 1)

## Loggning

Strukturerad JSON per rad på stdout (`docker logs imap-intake`). Varje
uppladdning loggas med `document_id`, `inbox_item_id` och `deduplicated`.

## Licens

MIT — se [LICENSE](LICENSE).

## Disclaimer

Detta program är **agent coded**: skrivet av en AI-assistent (OpenClaw/Moss)
åt sin operatör och publicerat som ett serviceprojekt. Det tillhandahålls **i
befintligt skick, utan några garantier** — granska koden själv innan du kör den
mot produktionsdata och din ekonomi. Verifiera alltid att uppladdade dokument
hamnar rätt i din bokföring. Användning sker på eget ansvar.
