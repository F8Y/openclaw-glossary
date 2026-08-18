# OpenClaw Glossary

Pair of bots:
- One of them is `alerter` - notifies the developer if CI/CD is failed
- Glossaryck - `smart dictionary` who has local memory with AI and Finance acronyms

## Deploy

Deployed on VDS (Cloud.ru) with TG channel. Cloud.ru Foundation Models is the
primary LLM provider; BotHub remains the fallback and a session-scoped test
provider.

Изменения едут только через git: PR в `master` → CI → **Promote to deploy**
в Actions. На сервере systemd-таймер каждые 5 минут приводит состояние
в соответствие с веткой `deploy`. Руками на VM ничего не правим —
реконсиляция затрёт.

## Подключение человека к боту

**Только заранее.** С `dmPolicy: "allowlist"` парринг отключён: человек
не сможет отправить боту даже первое сообщение, пока его ID не окажется
в конфиге. Подключить кого-то на ходу во время встречи не получится —
нужен полный цикл PR → CI → Promote.

**ID добавляется в два списка.** Раз `commands.allowFrom` задан, он
становится единственным источником авторизации команд, и `channels.telegram.allowFrom`
его не заменяет.

| Ключ | Что даёт |
|---|---|
| `channels.telegram.allowFrom` | переписка обычным текстом |
| `commands.allowFrom.telegram` | команды `/about`, `/knowledge` и ссылки `/start ...` |
| `commands.ownerAllowFrom` | административные команды — **только владелец** |

Забыть второй список — получить ровно тот симптом, на котором мы
потеряли час: текст доходит, команды исчезают без ответа и без ошибки.

### Как узнать ID

Человек должен хоть раз написать боту — но при `allowlist` он не сможет.
Поэтому ID берётся заранее любым способом: через `@userinfobot`, либо
временно вернуть `dmPolicy: "pairing"`, принять сообщение, посмотреть лог:

```
sudo docker logs openclaw-gateway 2>&1 | grep 'Inbound message' | tail -3
```

Число в `telegram:270887394 -> @glossary_ai_bot` и есть ID.

### Коллег в `ownerAllowFrom` не добавлять

Там административные команды и доступ к конфигурации. Владелец один.

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

## Переключение LLM-провайдера

Для теста не нужно менять конфиг или перезапускать контейнер. В своём чате
с ботом отправьте одну команду:

| Команда | Результат |
|---|---|
| `/model gemini` | эта Telegram-сессия использует Gemini 3.1 Flash Lite через Cloud.ru |
| `/model cloudru` | эта Telegram-сессия использует резервный DeepSeek V4 Flash через Cloud.ru |
| `/model bothub` | эта Telegram-сессия использует DeepSeek V4 Flash через BotHub |
| `/model status` | показать активную модель и endpoint |
| `/model default` | убрать ручной выбор и вернуться к Gemini из GitOps-конфига |

Переключение относится только к текущей Telegram-сессии и не меняет GitOps-
конфиг для остальных пользователей. Если модель выбрана через `/model`, режим
строгий: при ошибке выбранного провайдера OpenClaw покажет ошибку, а не уйдёт
в fallback. Это удобно для честного сравнения моделей.

После деплоя выполните один live smoke-test Gemini:

```bash
sudo bash /opt/openclaw-glossary/deploy/check-gemini.sh
```

Затем отправьте `/model default` в старых Telegram-сессиях, где сохранился
ручной выбор модели. Для содержательной проверки запросите один термин и
`/digest`; при сбое primary автоматически используются Cloud.ru DeepSeek,
затем BotHub.

## Бюджет инструкций

`config/workspace/*.md` уходят в **каждый** вызов модели, а вызовов
на один ответ бывает больше десяти. CI держит их суммарный размер
под 7000 байт.

Не влезает — переноси: подробности в `config/workspace/skills/<имя>/SKILL.md`
(читается только при вызове команды), справочные данные в
`config/knowledge/` (достаётся через `memory_search`).
