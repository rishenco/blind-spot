# BLIND SPOT — dark warehouse (prototype)

Первый milestone: чёрный зал, лидар, тактильный контур, дебаг-оверлеи.
Концепт — `doc/proto/concept.md`, порядок работы — `doc/proto/process.md`.

## Запуск

Нужны только **Docker** (с `docker compose`, то есть Docker Desktop или Docker Engine 20.10+)
и **make**. Node на машине не нужен — он живёт в контейнере.

```sh
make up
```

Поднимает vite dev-сервер в контейнере, ждёт, пока он реально начнёт отвечать, и открывает
http://localhost:5173 в браузере. Если открыть нечем (headless-машина, ssh) — просто печатает URL.

Порт занят? `make up PORT=5180`.

| Цель | Что делает |
|---|---|
| `make up` | собрать образ (если нужно), поднять dev-сервер, дождаться и открыть страницу |
| `make down` | остановить контейнер (зависимости в volume остаются) |
| `make logs` | смотреть вывод vite |
| `make build` | продакшен-сборка (`tsc --noEmit` + vite) в `dist/` |
| `make shots` | перегенерировать ключевые кадры в `out/` (headless chromium внутри контейнера) |
| `make sh` | шелл внутри контейнера |
| `make reset` | снести контейнер и volume'ы с зависимостями |

Правки в `src/` подхватываются на лету. Если на macOS/Windows hot reload молчит (события
файловой системы через bind-mount там теряются) — `VITE_POLL=1 make up`, watcher переключится
на polling.

Зависимости ставятся внутрь именованного volume (`/app/node_modules`), а не в рабочую копию:
локальный `node_modules` хоста контейнер не видит и не трогает, а `npm install` при повторном
`make up` отрабатывает за секунду. Если первый `npm install` прервали на середине и дальше
он падает с `ENOTEMPTY` — `make reset && make up`.

## Без Docker

Работает и напрямую, если есть Node 22+:

```sh
npm install
npm run dev      # dev-сервер
npm run build    # dist/
npm run shots    # ключевые кадры в out/ (нужен `npx playwright install chromium`)
```
