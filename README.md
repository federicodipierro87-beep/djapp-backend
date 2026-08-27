# DJ Request — backend

## Migrazioni del database

Railway **non** applica le migrazioni al deploy. Vanno eseguite a mano, prima di
promuovere il backend che le richiede:

```bash
DATABASE_URL="<url di produzione>" npx prisma migrate deploy
```

In sviluppo si usa `npx prisma migrate dev --name <nome>`. **Non** usare
`prisma db push`: è così che la history si è disallineata dal database reale.

### Baseline del 06/01/2026

Fino a `20260105010056_add_dj_profile_fields` la history era incompleta. La
tabella `events`, l'enum `EventStatus`, `requests.spotifyTrackId`,
`requests.albumCover` e le colonne `eventId` su `requests` e `queue_items` erano
state applicate con `db push` e non comparivano in nessuna migrazione: un
database creato da zero con `migrate deploy` non sarebbe stato avviabile.

`20260106000000_baseline_events_and_track_metadata` colma il buco. Ogni
istruzione è protetta (`IF NOT EXISTS`, `EXCEPTION WHEN duplicate_object`,
controlli su `pg_constraint`), quindi in produzione non fa nulla se non
registrarsi come applicata, mentre su un database vuoto crea davvero gli oggetti.

È l'unica migrazione scritta in questo stile. Da qui in avanti la history è
allineata allo schema e le migrazioni nuove vanno generate normalmente con
`migrate dev`, verificandole con:

```bash
npx prisma migrate diff \
  --from-migrations ./prisma/migrations \
  --to-schema-datamodel ./prisma/schema.prisma \
  --shadow-database-url "<url di un database usa e getta>"
```

che deve restituire "No difference detected".

Lo schema autorevole è `prisma/schema.prisma`. Il duplicato che viveva in
`src/prisma/schema.prisma` era fermo a mesi prima, non era referenziato da
nulla ed è stato rimosso.

## Verifica

```bash
npm run typecheck
npm test
```
