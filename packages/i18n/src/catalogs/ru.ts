/**
 * Russian message catalog. Must cover every MessageKey from en.ts —
 * enforced by the type below and by tests. Russian plurals use
 * one/few/many/other per CLDR (1 результат / 2 результата / 5 результатов).
 */
import type { Catalog } from './en.js';

export const ru: Catalog = {
  // App chrome
  'app.name': 'TERMINAL',
  'app.tagline': 'Бесплатный терминал уровня Bloomberg для крипты и акций',

  // Navigation rail
  'nav.screener': 'Скринер',
  'nav.charts': 'Графики',
  'nav.liq_map': 'Карта ликвидаций',
  'nav.news': 'Новости',
  'nav.calendar': 'Календарь',
  'nav.journal': 'Журнал',
  'nav.alerts': 'Алерты',
  'nav.marketplace': 'Маркетплейс',
  'nav.best_price': 'Лучшая цена',

  // Status bar
  'status.ny_time': 'Нью-Йорк',
  'status.session.sydney': 'Сидней',
  'status.session.tokyo': 'Токио',
  'status.session.london': 'Лондон',
  'status.session.new_york': 'Нью-Йорк',
  'status.session.open': 'Открыта',
  'status.session.closed': 'Закрыта',
  'status.session.overlap': 'Пересечение',
  'status.session.all_closed': 'Между сессиями',
  'status.session.weekend': 'Выходные — акции и форекс закрыты',
  'status.next_event': 'Следующее важное событие через {hours}ч',
  'status.secondary_clock.add': 'Добавить часы',
  'status.secondary_clock.change': 'Изменить часовой пояс',
  'status.secondary_clock.picker_label': 'Выберите часовой пояс',
  'status.secondary_clock.clear': 'Убрать часы',

  // Data states
  'data.stale': 'Данные задерживаются на {age}',
  'data.feed_down': 'Источник недоступен — показаны последние данные',
  'data.loading': 'Загрузка…',
  'data.empty': 'Пока пусто',

  // Screener (P1.6 движок, P1.7 интерфейс)
  'screener.filter.add': 'Добавить фильтр',
  'screener.filter.add_group': 'Добавить группу',
  'screener.filter.remove': 'Удалить фильтр',
  'screener.filter.and': 'И',
  'screener.filter.or': 'ИЛИ',
  'screener.save': 'Сохранить скрин',
  'screener.results': {
    one: '{count} результат',
    few: '{count} результата',
    many: '{count} результатов',
    other: '{count} результата',
  },
  'screener.apply': 'Применить',
  'screener.new_screen': 'Новый фильтр',
  'screener.save_as': 'Сохранить как…',
  'screener.save_as.placeholder': 'Название скрина',
  'screener.save_as.confirm': 'Сохранить',
  'screener.save_as.cancel': 'Отмена',
  'screener.delete': 'Удалить',
  'screener.delete_confirm': 'Удалить этот скрин?',
  'screener.export': 'Экспорт CSV',
  'screener.export.watermark': 'Экспортировано из TERMINAL — создайте бесплатный аккаунт: {url}',
  'screener.my_screens_label': 'Скрин',
  'screener.status.live': 'В реальном времени',
  'screener.columns_config': 'Колонки',
  'screener.columns_config_label': 'Показать/скрыть колонки',
  'screener.presets_label': 'Готовые фильтры',
  'screener.venue_priority': 'Приоритет бирж',
  'screener.venue_priority_label': 'Порядок приоритета бирж',
  'screener.venue_priority_hint':
    'Одна строка на монету. Цену и значения даёт самая верхняя биржа из списка, где есть эта монета.',
  'screener.venue_priority_reset': 'Сбросить по умолчанию',
  'screener.venue_move_up': 'Переместить вверх',
  'screener.venue_move_down': 'Переместить вниз',
  'screener.exchange_filter.all': 'Все биржи',
  'screener.asset_class_filter.label': 'Монеты и акции',
  'screener.asset_class_filter.all': 'Монеты + акции',
  'screener.asset_class_filter.coin': 'Только монеты',
  'screener.asset_class_filter.stock': 'Только акции',
  'screener.preset.high_volume_losers': 'Падение при высоком объёме',
  'screener.preset.negative_funding': 'Отрицательный фандинг',
  'screener.preset.unusual_oi': 'Необычный открытый интерес',
  'screener.column.symbol': 'Символ',
  'screener.field.exchange': 'Биржа',
  'screener.field.asset_class': 'Класс актива',
  'screener.field.price': 'Цена',
  'screener.field.change_1h': '1ч %',
  'screener.field.change_24h': '24ч %',
  'screener.field.change_7d': '7д %',
  'screener.field.volume_24h': 'Объём 24ч',
  'screener.field.market_cap': 'Капитализация',
  'screener.field.open_interest': 'Открытый интерес',
  'screener.field.funding_rate': 'Ставка фандинга',
  'screener.field.volatility_24h': 'Волатильность 24ч',
  'screener.field.spread': 'Спред',
  'screener.op.gt': '>',
  'screener.op.gte': '≥',
  'screener.op.lt': '<',
  'screener.op.lte': '≤',
  'screener.op.eq': '=',
  'screener.op.neq': '≠',
  'screener.op.between': 'между',
  'screener.op.in': 'один из',
  'screener.op.not_in': 'не один из',

  // Доска лучших цен (P1.7b) — консолидированный лучший бид/аск по биржам
  'bestprice.status.live': 'В реальном времени',
  'bestprice.column.symbol': 'Символ',
  'bestprice.column.bestBidVenue': 'Биржа (бид)',
  'bestprice.column.bestBid': 'Лучший бид',
  'bestprice.column.bestBidSize': 'Объём бида',
  'bestprice.column.bestAsk': 'Лучший аск',
  'bestprice.column.bestAskSize': 'Объём аска',
  'bestprice.column.bestAskVenue': 'Биржа (аск)',
  'bestprice.column.spread': 'Спред',
  'bestprice.column.venueCount': 'Бирж',
  'bestprice.symbol_detail.title': 'Цена по биржам — {symbol}',
  'bestprice.symbol_detail.back': '← Назад в терминал',
  'common.open_on_exchange': 'Открыть {symbol} на {exchange}',

  // Alerts
  'alerts.create': 'Создать алерт',
  'alerts.fired': {
    one: 'Сработал {count} алерт',
    few: 'Сработало {count} алерта',
    many: 'Сработало {count} алертов',
    other: 'Сработало {count} алерта',
  },
  'alerts.suppressed_stale': 'Алерт приостановлен: данные не в реальном времени',

  // Auth
  'auth.sign_up': 'Регистрация',
  'auth.sign_in': 'Вход',
  'auth.email': 'Эл. почта',
  'auth.password': 'Пароль',

  // Errors
  'error.GW-2001': 'Не удалось войти. Проверьте почту и пароль.',
  'error.GW-2004': 'Слишком много запросов — сбавьте темп.',
  'error.GW-2006': 'Этот email уже зарегистрирован — попробуйте войти.',
  'error.generic': 'Что-то пошло не так. Попробуйте ещё раз.',

  // Landing page (P1.2a)
  'landing.hero_kicker': 'Бесплатно · Без карты · RU/EN',
  'landing.hero_subtitle':
    'Скринер, графики, карты ликвидаций, новости и ИИ-стратег — единое тёмное плотное рабочее пространство для трейдеров, которые читают ленту, а не пресс-релизы.',
  'landing.seo_description':
    'TERMINAL — бесплатный торговый терминал уровня Bloomberg для крипты и акций: скринер в реальном времени, карты ликвидаций, новости, экономический календарь и ИИ-помощник по стратегиям — на русском и английском.',
  'landing.features_heading': 'Что вы получаете',
  'landing.features.screener_title': 'Скринер в реальном времени',
  'landing.features.screener_body':
    'Сортируйте тысячи инструментов по объёму, фандингу, открытому интересу и волатильности — с конструктором фильтров под ваши сетапы.',
  'landing.features.liq_title': 'Карты ликвидаций',
  'landing.features.liq_body':
    'Видно, где скапливается плечо и где оно ломается — формула-карта рядом с реальными ончейн-позициями.',
  'landing.features.ai_title': 'ИИ-стратег',
  'landing.features.ai_body':
    'Опишите стратегию простым языком и протестируйте на реальной истории — с вашим собственным ключом Anthropic, который никуда не передаётся и не логируется.',
  'landing.signup_heading': 'Создайте бесплатный аккаунт',
  'landing.signup.display_name': 'Имя (необязательно)',
  'landing.signup.submit': 'Создать бесплатный аккаунт',
  'landing.signup.error_invalid_email': 'Введите корректный email.',
  'landing.signup.error_password_too_short': 'Минимум 10 символов.',
  'landing.signup.or_continue_with': 'Или войдите через',
  'landing.signup.google': 'Войти через Google',
  'landing.signup.discord': 'Войти через Discord',
  'landing.signup.telegram': 'Войти через Telegram',

  // Terminal shell (P1.3)
  'terminal.command_placeholder': 'например, BTC HEAT',
  'terminal.resize_handle': 'Изменить размер панели',
  'terminal.command_not_available': 'Это пока не реализовано — появится на следующем этапе.',
  'terminal.panel.chart_body': 'Графики скоро появятся.',
  'terminal.panel.news_body': 'Лента новостей скоро появится.',

  // Terminal workspace tabs (P1.3a)
  'terminal.tab.list_label': 'Вкладки терминала',
  'terminal.tab.new': 'Новая вкладка',
  'terminal.tab.close': 'Закрыть вкладку',
};
