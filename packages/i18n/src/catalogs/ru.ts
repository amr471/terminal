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
  'error.generic': 'Что-то пошло не так. Попробуйте ещё раз.',
};
