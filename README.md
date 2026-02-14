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