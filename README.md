# OpenClaw Glossary

Pair of bots:
- One of them is `alerter` - notifies the developer if CI/CD is failed
- Glossaryck - `smart dictionary` who has local memory with AI and Finance acronyms

## Deploy

Deployed on VDS (Cloud.ru) with TG channel, llm provider is BotHub.

Изменения едут только через git: PR в `master` → CI → **Promote to deploy**
в Actions. На сервере systemd-таймер каждые 5 минут приводит состояние
в соответствие с веткой `deploy`. Руками на VM ничего не правим —
реконсиляция затрёт.

## Подключение человека к боту

**Два действия, не одно.** Парринг даёт доступ только к переписке.
Команды и ссылки-кнопки (`/start term_ROE`) от отправителя, которого нет
в `channels.telegram.allowFrom`, канал **молча выбрасывает** — без ответа
и без ошибки в чате. Со стороны выглядит как «бот сломался».

1. Человек пишет боту, получает код парринга.
2. Одобряешь: `oc pairing approve telegram <КОД>`
3. Узнаёшь его numeric ID:
   ```
   sudo docker logs openclaw-gateway 2>&1 | grep 'Inbound message' | tail -3
   ```
   Число в `telegram:270887394 -> @glossary_ai_bot` и есть ID.
4. Добавляешь ID в `channels.telegram.allowFrom` в
   `config/openclaw.batch.json`, дальше обычный цикл через PR и Promote.

Без четвёртого шага человек сможет только переписываться текстом:
обычные сообщения дойдут, команды и кнопки — нет.

## Полезное

Алиас на сервере, чтобы не набирать длинный `docker compose`:

```bash
cat >> ~/.profile <<'EOF'
oc() {
  cd /opt/openclaw-glossary && \
  sudo docker compose --env-file /run/openclaw/env run --rm cli "$@"
}
EOF
. ~/.profile
```

Дальше: `oc skills list`, `oc memory status --agent main`,
`oc pairing list telegram`, `oc config get tools`.

## Бюджет инструкций

`config/workspace/*.md` уходят в **каждый** вызов модели, а вызовов
на один ответ бывает больше десяти. CI держит их суммарный размер
под 7000 байт.

Не влезает — переноси: подробности в `config/workspace/skills/<имя>/SKILL.md`
(читается только при вызове команды), справочные данные в
`config/knowledge/` (достаётся через `memory_search`).
