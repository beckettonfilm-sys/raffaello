# Raffaello Electron App

## Overview
This project packages the previous browser/Flask interface into a standalone Electron desktop application that works on Windows and macOS. The renderer still loads `index.html` plus the existing JS/CSS assets, but all data access now flows through the Electron main process.

## Data source (zamiast pliku `ZAJEBISTE_DANE.xlsx`)
- Aplikacja **nie czyta już** bezpośrednio arkusza XLSX. Zamiast tego, `ui.js` wywołuje metody z `api.js`, które korzystają z kanałów IPC `fetch-workbook` oraz `update-workbook`.
Kanały IPC są obsługiwane w `main.js`, a tamtejsze funkcje używają modułu `db.js`.
- `db.js` korzysta z **SQLite** i zapisuje plik bazy danych w katalogu `BACKUP_DB` (np. `music_database_14-12-2025_11-23-36.sqlite`). Z tej tabeli ładowane są rekordy, które wcześniej znajdowały się w `ZAJEBISTE_DANE.xlsx`.
- Jeżeli tabela jest pusta, interfejs nadal się uruchomi, a przycisk „ODŚWIEŻ” spróbuje pobrać zawartość z bazy; zapis poprzez „SAVE” aktualizuje rekordy w SQLite.

## Konfiguracja
1. Sklonuj repo i zainstaluj zależności: `npm install`.
2. Skopiuj `db.config.example.json` do `db.config.json` i w razie potrzeby zmień nazwę tabeli.
3. Przy pierwszym uruchomieniu aplikacja utworzy plik SQLite w `BACKUP_DB`, a potem będzie go używać przy kolejnych startach.

## Uruchomienie
```bash
npm start
```
Aplikacja otworzy okno Electron i załaduje dotychczasowy interfejs. Wszystkie odczyty/zapisy danych będą trafiały do bazy SQLite, więc plik `ZAJEBISTE_DANE.xlsx` jest już potrzebny jedynie jako archiwum referencyjne.

## Checklista testów manualnych po migracji `FILES/`
1. Czy wyświetlają się ikony UI (lock, gwiazdki, booklet, etykiety)?
2. Czy wyświetlają się labelki z `APP_DIR/FILES/LABELS`?
3. Czy wyświetlają się ikony formatów z `APP_DIR/FILES/FORMAT`?
4. Czy działają mini i max okładki (w tym pliki `mini_default.jpg` / `max_default.jpg`)?
5. Czy działa generowanie mini okładek (mockup CD) z template w `APP_DIR/FILES/CD_TEMPLATE`?
6. Czy działa CD BACK (template + własny back w `APP_DIR/FILES/CD_BACK`)?
7. Czy działa booklet PDF z `APP_DIR/FILES/BOOKLET`?
8. Czy import DB (XLSX) działa z `APP_DIR/FILES/DATABASE/MUSIC_DATABASE`?
9. Czy import JSON działa z `APP_DIR/FILES/DATABASE/UPDATE_JSON`?
10. Czy update DB działa z `APP_DIR/FILES/DATABASE/UPDATE_DATABASE`?
11. Czy eksport DB i „download” zapisują do `APP_DIR/FILES/DATABASE/EXPORT_DATABASE`?
12. Czy kasowanie assetów albumu usuwa właściwe pliki w `APP_DIR/FILES/pic_*` oraz `APP_DIR/FILES/CD_BACK`?
