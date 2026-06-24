// i18n.mjs — tiny 3-language (RU/EN/UK) string table with live switching.
// t(key, params) looks up the current language, falls back to English, then the
// raw key. setLang() persists the choice and notifies subscribers to re-render.
const DICT = {
  en: {
    'common.back': 'BACK', 'common.balance': 'BALANCE', 'common.signOut': 'sign out',
    'common.staked': '{amount} staked',
    'login.tagline': 'Enter the grid. Stake. Conquer.',
    'login.callsign': 'CALLSIGN', 'login.placeholder': 'your name',
    'login.enter': 'ENTER', 'login.connecting': 'CONNECTING…',
    'login.virtual': 'Virtual balance · no real money',
    'menu.welcome': 'Welcome back, {name}', 'menu.play': 'PLAY',
    'menu.perLife': '{stake} / life · win {reward} per kill',
    'menu.notEnough': 'Not enough balance to stake.',
    'menu.needPlayers': 'Needs ≥{n} players — you may wait briefly.',
    'lb.title': 'LEADERBOARD', 'lb.earned': 'EARNED', 'lb.net': 'NET', 'lb.referrals': 'REFERRALS',
    'settings.theme': 'Theme', 'theme.dark': 'Dark', 'theme.light': 'Light', 'ref.empty': 'No referrals yet — share your link.',
    'lb.loading': 'Loading…', 'lb.empty': 'No games yet — be the first.', 'lb.error': 'Could not load.',
    'profile.title': 'PROFILE', 'profile.signInFirst': 'Sign in first.',
    'stat.games': 'Games', 'stat.kills': 'Kills', 'stat.deaths': 'Deaths', 'stat.kd': 'K/D',
    'stat.bestArea': 'Best area', 'stat.bestStreak': 'Best streak', 'stat.earned': 'Earned', 'stat.net': 'Net profit',
    'settings.title': 'SETTINGS', 'settings.language': 'Language', 'settings.version': 'Version',
    'death.title': 'ELIMINATED', 'death.respawn': 'RESPAWN', 'death.menu': 'MENU',
    'death.stakeLost': 'STAKE LOST', 'death.topUp': 'Top up to keep playing.',
    'death.territory': 'Territory', 'death.kills': 'Kills', 'death.survived': 'Survived',
    'reason.self': 'You crossed your own trail.', 'reason.wall': 'You hit the wall.',
    'reason.cut': 'A rival cut your trail.', 'reason.collision': 'You lost a head-to-head.',
    'reason.enclosed': 'A rival enclosed you.', 'reason.forfeit': 'You left the arena.',
    'reason.default': 'Your run has ended.',
    'hud.territory': 'Territory', 'hud.kills': 'Kills', 'hud.earned': 'Earned',
    'hud.cashout': 'CASH OUT', 'hud.menu': 'MENU',
    'hud.waiting': 'Waiting for players… {n}/{need}',
    'hud.returnLand': 'Return to your land first', 'hud.cashUnavail': 'Cash-out unavailable',
    'sb.title': 'TOP · KILLS', 'nav.play': 'Play', 'nav.ranks': 'Ranks', 'nav.me': 'Profile',
    'card.paidSub': '{stake} / life', 'card.paidNote': 'win {reward} per kill',
    'card.freeTitle': 'FREE PLAY', 'card.freeSub': 'vs bots', 'card.freeNote': 'practice · no stake',
    'card.soonTitle': 'NEW MAPS', 'card.soon': 'COMING SOON', 'death.playAgain': 'PLAY AGAIN',
    'death.earned': 'YOU EARNED', 'death.lost': 'YOU LOST', 'death.breakdown': '+{earned} from kills · −{stake} stake',
    'card.practice': 'PRACTICE', 'death.practice': 'PRACTICE', 'menu.refreshPractice': 'Refresh practice',
    'toast.practiceEmpty': 'Practice balance empty — refresh it', 'toast.refreshed': 'Practice balance refilled',
    'profile.referrals': 'REFERRALS', 'ref.invite': 'Invite friends — you earn 15% of every kill they make.',
    'topup.title': 'TOP UP', 'topup.soon': 'On-chain top-up is coming soon', 'topup.note': 'First via the TON blockchain, cards later.', 'ref.top': 'TOP REFERRERS',
    'fair.label': 'Provably fair', 'fair.hint': 'Each round the arena pre-commits a hashed random seed and reveals it afterwards — verify at /fairness.',
    'ref.copy': 'COPY LINK', 'ref.copied': 'Link copied!', 'ref.count': 'Invited', 'ref.earned': 'Ref. earned',
    'toast.loginFailed': 'Login failed', 'toast.cashedOut': 'Cashed out +{amount}',
    'toast.notEnough': 'Not enough balance to stake', 'toast.full': 'Arena is full — try again',
    'toast.alreadyInGame': "You're already in a game in another tab",
  },
  ru: {
    'common.back': 'НАЗАД', 'common.balance': 'БАЛАНС', 'common.signOut': 'выйти',
    'common.staked': '{amount} в ставке',
    'login.tagline': 'Заходи в сетку. Ставь. Захватывай.',
    'login.callsign': 'ПОЗЫВНОЙ', 'login.placeholder': 'твоё имя',
    'login.enter': 'ВОЙТИ', 'login.connecting': 'ПОДКЛЮЧЕНИЕ…',
    'login.virtual': 'Виртуальный баланс · не реальные деньги',
    'menu.welcome': 'С возвращением, {name}', 'menu.play': 'ИГРАТЬ',
    'menu.perLife': '{stake} / жизнь · +{reward} за килл',
    'menu.notEnough': 'Недостаточно баланса для ставки.',
    'menu.needPlayers': 'Нужно ≥{n} игроков — возможно небольшое ожидание.',
    'lb.title': 'ЛИДЕРБОРД', 'lb.earned': 'ЗАРАБОТАНО', 'lb.net': 'ПРИБЫЛЬ', 'lb.referrals': 'РЕФЕРАЛЫ',
    'settings.theme': 'Тема', 'theme.dark': 'Тёмная', 'theme.light': 'Светлая', 'ref.empty': 'Пока нет рефералов — поделись ссылкой.',
    'lb.loading': 'Загрузка…', 'lb.empty': 'Игр пока нет — будь первым.', 'lb.error': 'Не удалось загрузить.',
    'profile.title': 'ПРОФИЛЬ', 'profile.signInFirst': 'Сначала войди.',
    'stat.games': 'Игры', 'stat.kills': 'Киллы', 'stat.deaths': 'Смерти', 'stat.kd': 'У/С',
    'stat.bestArea': 'Лучший захват', 'stat.bestStreak': 'Лучшая серия', 'stat.earned': 'Заработано', 'stat.net': 'Чистая прибыль',
    'settings.title': 'НАСТРОЙКИ', 'settings.language': 'Язык', 'settings.version': 'Версия',
    'death.title': 'УНИЧТОЖЕН', 'death.respawn': 'ВОЗРОДИТЬСЯ', 'death.menu': 'МЕНЮ',
    'death.stakeLost': 'СТАВКА ПОТЕРЯНА', 'death.topUp': 'Пополни баланс, чтобы играть.',
    'death.territory': 'Территория', 'death.kills': 'Киллы', 'death.survived': 'Прожито',
    'reason.self': 'Ты пересёк свой след.', 'reason.wall': 'Ты врезался в стену.',
    'reason.cut': 'Соперник перерезал твой след.', 'reason.collision': 'Ты проиграл лобовое.',
    'reason.enclosed': 'Соперник окружил тебя.', 'reason.forfeit': 'Ты покинул арену.',
    'reason.default': 'Твой забег окончен.',
    'hud.territory': 'Территория', 'hud.kills': 'Киллы', 'hud.earned': 'Заработок',
    'hud.cashout': 'ЗАБРАТЬ', 'hud.menu': 'МЕНЮ',
    'hud.waiting': 'Ожидание игроков… {n}/{need}',
    'hud.returnLand': 'Вернись на свою землю', 'hud.cashUnavail': 'Забрать нельзя',
    'sb.title': 'ТОП · КИЛЛЫ', 'nav.play': 'Игра', 'nav.ranks': 'Топ', 'nav.me': 'Профиль',
    'card.paidSub': '{stake} / жизнь', 'card.paidNote': '+{reward} за килл',
    'card.freeTitle': 'ФРИ-ИГРА', 'card.freeSub': 'против ботов', 'card.freeNote': 'тренировка · без ставки',
    'card.soonTitle': 'НОВЫЕ КАРТЫ', 'card.soon': 'СКОРО', 'death.playAgain': 'ИГРАТЬ СНОВА',
    'death.earned': 'ВЫ ЗАРАБОТАЛИ', 'death.lost': 'ВЫ ПОТЕРЯЛИ', 'death.breakdown': '+{earned} за киллы · −{stake} ставка',
    'card.practice': 'ТРЕНИРОВКА', 'death.practice': 'ТРЕНИРОВКА', 'menu.refreshPractice': 'Обновить счёт',
    'toast.practiceEmpty': 'Практический счёт пуст — обнови', 'toast.refreshed': 'Счёт пополнен',
    'profile.referrals': 'РЕФЕРАЛЫ', 'ref.invite': 'Приглашай друзей — получай 15% с каждого их килла.',
    'topup.title': 'ПОПОЛНЕНИЕ', 'topup.soon': 'Пополнение скоро', 'topup.note': 'Сначала через блокчейн TON, позже — карты.', 'ref.top': 'ТОП РЕФЕРОВОДОВ',
    'fair.label': 'Честная игра', 'fair.hint': 'Каждый раунд арена заранее публикует хэш случайного сида и раскрывает его после — проверка на /fairness.',
    'ref.copy': 'КОПИРОВАТЬ ССЫЛКУ', 'ref.copied': 'Ссылка скопирована!', 'ref.count': 'Приглашено', 'ref.earned': 'С рефералов',
    'toast.loginFailed': 'Ошибка входа', 'toast.cashedOut': 'Забрано +{amount}',
    'toast.notEnough': 'Недостаточно баланса', 'toast.full': 'Арена заполнена — попробуй ещё',
    'toast.alreadyInGame': 'Ты уже в игре в другой вкладке',
  },
  uk: {
    'common.back': 'НАЗАД', 'common.balance': 'БАЛАНС', 'common.signOut': 'вийти',
    'common.staked': '{amount} у ставці',
    'login.tagline': 'Заходь у сітку. Став. Захоплюй.',
    'login.callsign': 'ПОЗИВНИЙ', 'login.placeholder': 'твоє ім’я',
    'login.enter': 'УВІЙТИ', 'login.connecting': 'З’ЄДНАННЯ…',
    'login.virtual': 'Віртуальний баланс · не реальні гроші',
    'menu.welcome': 'З поверненням, {name}', 'menu.play': 'ГРАТИ',
    'menu.perLife': '{stake} / життя · +{reward} за вбивство',
    'menu.notEnough': 'Недостатньо балансу для ставки.',
    'menu.needPlayers': 'Потрібно ≥{n} гравців — можливе невелике очікування.',
    'lb.title': 'ЛІДЕРБОРД', 'lb.earned': 'ЗАРОБЛЕНО', 'lb.net': 'ПРИБУТОК', 'lb.referrals': 'РЕФЕРАЛИ',
    'settings.theme': 'Тема', 'theme.dark': 'Темна', 'theme.light': 'Світла', 'ref.empty': 'Поки немає рефералів — поділись посиланням.',
    'lb.loading': 'Завантаження…', 'lb.empty': 'Ігор ще немає — стань першим.', 'lb.error': 'Не вдалося завантажити.',
    'profile.title': 'ПРОФІЛЬ', 'profile.signInFirst': 'Спершу увійди.',
    'stat.games': 'Ігри', 'stat.kills': 'Вбивства', 'stat.deaths': 'Смерті', 'stat.kd': 'В/С',
    'stat.bestArea': 'Найкращий захват', 'stat.bestStreak': 'Найкраща серія', 'stat.earned': 'Зароблено', 'stat.net': 'Чистий прибуток',
    'settings.title': 'НАЛАШТУВАННЯ', 'settings.language': 'Мова', 'settings.version': 'Версія',
    'death.title': 'ЗНИЩЕНО', 'death.respawn': 'ВІДРОДИТИСЯ', 'death.menu': 'МЕНЮ',
    'death.stakeLost': 'СТАВКУ ВТРАЧЕНО', 'death.topUp': 'Поповни баланс, щоб грати.',
    'death.territory': 'Територія', 'death.kills': 'Вбивства', 'death.survived': 'Прожито',
    'reason.self': 'Ти перетнув свій слід.', 'reason.wall': 'Ти врізався у стіну.',
    'reason.cut': 'Суперник перерізав твій слід.', 'reason.collision': 'Ти програв лобове.',
    'reason.enclosed': 'Суперник оточив тебе.', 'reason.forfeit': 'Ти залишив арену.',
    'reason.default': 'Твій забіг завершено.',
    'hud.territory': 'Територія', 'hud.kills': 'Вбивства', 'hud.earned': 'Заробіток',
    'hud.cashout': 'ЗАБРАТИ', 'hud.menu': 'МЕНЮ',
    'hud.waiting': 'Очікування гравців… {n}/{need}',
    'hud.returnLand': 'Повернись на свою землю', 'hud.cashUnavail': 'Забрати не можна',
    'sb.title': 'ТОП · ВБИВСТВА', 'nav.play': 'Гра', 'nav.ranks': 'Топ', 'nav.me': 'Профіль',
    'card.paidSub': '{stake} / життя', 'card.paidNote': '+{reward} за вбивство',
    'card.freeTitle': 'ФРІ-ГРА', 'card.freeSub': 'проти ботів', 'card.freeNote': 'тренування · без ставки',
    'card.soonTitle': 'НОВІ КАРТИ', 'card.soon': 'СКОРО', 'death.playAgain': 'ГРАТИ ЗНОВУ',
    'death.earned': 'ВИ ЗАРОБИЛИ', 'death.lost': 'ВИ ВТРАТИЛИ', 'death.breakdown': '+{earned} за вбивства · −{stake} ставка',
    'card.practice': 'ТРЕНУВАННЯ', 'death.practice': 'ТРЕНУВАННЯ', 'menu.refreshPractice': 'Оновити рахунок',
    'toast.practiceEmpty': 'Практичний рахунок порожній — онови', 'toast.refreshed': 'Рахунок поповнено',
    'profile.referrals': 'РЕФЕРАЛИ', 'ref.invite': 'Запрошуй друзів — отримуй 15% з кожного їх вбивства.',
    'topup.title': 'ПОПОВНЕННЯ', 'topup.soon': 'Поповнення скоро', 'topup.note': 'Спершу через блокчейн TON, пізніше — картки.', 'ref.top': 'ТОП РЕФЕРАЛІВ',
    'fair.label': 'Чесна гра', 'fair.hint': 'Щораунду арена заздалегідь публікує хеш випадкового сіда й розкриває його після — перевірка на /fairness.',
    'ref.copy': 'КОПІЮВАТИ ПОСИЛАННЯ', 'ref.copied': 'Посилання скопійовано!', 'ref.count': 'Запрошено', 'ref.earned': 'З рефералів',
    'toast.loginFailed': 'Помилка входу', 'toast.cashedOut': 'Забрано +{amount}',
    'toast.notEnough': 'Недостатньо балансу', 'toast.full': 'Арена заповнена — спробуй ще',
    'toast.alreadyInGame': 'Ти вже у грі в іншій вкладці',
  },
};

export const LANGS = [['ru', 'Русский'], ['en', 'English'], ['uk', 'Українська']];

function detect() {
  const tg = window.Telegram && window.Telegram.WebApp
    && window.Telegram.WebApp.initDataUnsafe
    && window.Telegram.WebApp.initDataUnsafe.user
    && window.Telegram.WebApp.initDataUnsafe.user.language_code;
  const code = String(tg || navigator.language || 'en').slice(0, 2).toLowerCase();
  return DICT[code] ? code : 'en';
}

let lang = localStorage.getItem('paper_lang') || detect();
if (!DICT[lang]) lang = 'en';

const subs = [];
export const getLang = () => lang;
export const onLangChange = (fn) => { subs.push(fn); };
export function setLang(l) {
  if (!DICT[l] || l === lang) return;
  lang = l;
  localStorage.setItem('paper_lang', l);
  for (const fn of subs) fn(l);
}
export function t(key, params) {
  let s = (DICT[lang] && DICT[lang][key]) || DICT.en[key] || key;
  if (params) for (const k of Object.keys(params)) s = s.replace(`{${k}}`, params[k]);
  return s;
}
