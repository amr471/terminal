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

  // Status bar
  'status.ny_time': 'Нью-Йорк',
  'status.session.sydney': 'Сидней',
  'status.session.tokyo': 'Токио',
  'status.session.london': 'Лондон',
  'status.session.new_york': 'Нью-Йорк',
  'status.session.open': 'Открыта',
  'status.session.closed': 'Закрыта',
  'status.session.overlap': 'Пересечение',
  'status.next_event': 'Следующее важное событие через {hours}ч',

  // Data states
  'data.stale': 'Данные задерживаются на {age}',
  'data.feed_down': 'Источник недоступен — показаны последние данные',
  'data.loading': 'Загрузка…',
  'data.empty': 'Пока пусто',

  // Screener
  'screener.filter.add': 'Добавить фильтр',
  'screener.filter.and': 'И',
  'screener.filter.or': 'ИЛИ',
  'screener.save': 'Сохранить скрин',
  'screener.results': {
    one: '{count} результат',
    few: '{count} результата',
    many: '{count} результатов',
    other: '{count} результата',
  },

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

  // Terminal shell (P1.3)
  'terminal.command_placeholder': 'например, BTC HEAT',
  'terminal.resize_handle': 'Изменить размер панели',
  'terminal.panel.screener_body': 'Скринер в реальном времени скоро появится.',
  'terminal.panel.chart_body': 'Графики скоро появятся.',
  'terminal.panel.news_body': 'Лента новостей скоро появится.',
};
